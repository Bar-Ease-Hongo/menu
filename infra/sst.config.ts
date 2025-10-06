// 最小構成（原因切り分け用）: Ion v3 で API(health) のみを定義
export default {
  app(input: { stage?: string }) {
    return {
      name: "bar-ease-hongo",
      stage: input.stage ?? process.env.SST_STAGE ?? "dev",
      home: "aws",
      providers: {
        aws: { region: process.env.AWS_REGION ?? "ap-northeast-1" },
      },
    } as const;
  },
  async run() {
    // @ts-ignore Ion がグローバルに注入
    const { aws, Secret } = sst as any;
    const api = new aws.ApiGatewayV2("MenuApi");
    // sst.config.ts のある "infra" ディレクトリが解決ルートのため相対パスに修正
    api.route("GET /health", "src/health.handler");

    // ステップ1: DynamoDB テーブル（最小）を追加
    const table = new aws.Dynamo("MenuTable", {
      fields: { pk: "string", sk: "string" },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
    });

    // ステップ2: S3 バケット群（最小）を追加
    const menuBucket = new aws.Bucket("MenuAssets", {
      cors: true,
      versioning: true,
      access: "public", // CloudFront/Next.js から直接取得できるよう公開
    });

    const publicBucket = new aws.Bucket("PublicImageBucket", {
      cors: true,
      access: "public",
    });

    const stagingBucket = new aws.Bucket("StagingImageBucket", {
      cors: true,
    });

    // ステップ4: GenerateMenu 関数（手動実行で menu.json を S3 に出力）
    const generateMenu = new aws.Function("GenerateMenu", {
      handler: "../services/lambda/menu/src/index.generateMenuHandler",
      runtime: "nodejs20.x",
      timeout: "60 seconds",
      nodejs: {
        install: [
          "@aws-sdk/client-bedrock-runtime",
          "@aws-sdk/client-s3",
          "@aws-sdk/client-dynamodb",
          "@aws-sdk/lib-dynamodb"
        ],
      },
      link: [menuBucket, publicBucket, stagingBucket, table],
      environment: {
        MENU_BUCKET_NAME: menuBucket.name,
        PUBLIC_IMAGE_BUCKET_NAME: publicBucket.name,
        STAGING_IMAGE_BUCKET_NAME: stagingBucket.name,
        SHEET_TABLE_NAME: table.name,
        BEDROCK_MODEL_CLAUDE:
          process.env.BEDROCK_MODEL_CLAUDE ?? "anthropic.claude-3-haiku-20240307-v1:0",
      },
    });

    // ステップ5: Nightly Cron（AI 補完/メニュー再生成の定期実行）
    const cronSchedule =
      process.env.MENU_COMPLETION_SCHEDULE ?? "cron(0 15 * * ? *)"; // 00:15 UTC(=09:15 JST)
    new aws.Cron("NightlyMenuCompletion", {
      schedule: cronSchedule,
      function: {
        handler: "../services/lambda/menu/src/index.nightlyCompletionHandler",
        runtime: "nodejs20.x",
        timeout: "60 seconds",
        nodejs: {
          install: [
            "@aws-sdk/client-bedrock-runtime",
            "@aws-sdk/client-s3",
            "@aws-sdk/client-dynamodb",
            "@aws-sdk/lib-dynamodb"
          ],
        },
        link: [menuBucket, stagingBucket, publicBucket, table],
        environment: {
          MENU_BUCKET_NAME: menuBucket.name,
          PUBLIC_IMAGE_BUCKET_NAME: publicBucket.name,
          STAGING_IMAGE_BUCKET_NAME: stagingBucket.name,
          SHEET_TABLE_NAME: table.name,
          BEDROCK_MODEL_CLAUDE:
            process.env.BEDROCK_MODEL_CLAUDE ?? "anthropic.claude-3-haiku-20240307-v1:0",
        },
      },
    });
    // ステップ3.5: Webhook Lambda とルート（最小）
    // Secret 未設定時に例外で落ちないよう、開発用のプレースホルダを設定
    const gasEnvFallback = process.env.GAS_WEBHOOK_SECRET ?? "dev-placeholder";
    const gasSecret = new Secret("GasWebhookSecret", gasEnvFallback);
    const webhookFn = new aws.Function("Webhook", {
      handler: "../services/lambda/menu/src/index.webhookHandler",
      runtime: "nodejs20.x",
      nodejs: {
        install: [
          "@aws-sdk/client-bedrock-runtime",
          "@aws-sdk/client-s3",
          "@aws-sdk/client-dynamodb",
          "@aws-sdk/lib-dynamodb"
        ],
      },
      link: [menuBucket, publicBucket, stagingBucket, gasSecret],
      environment: {
        MENU_BUCKET_NAME: menuBucket.name,
        PUBLIC_IMAGE_BUCKET_NAME: publicBucket.name,
        STAGING_IMAGE_BUCKET_NAME: stagingBucket.name,
        GAS_WEBHOOK_SECRET: gasSecret.value,
      },
    });

    // ステップ3: Recommend Lambda とルート（最小）
    const recommendEnv = {
      MENU_BUCKET_NAME: menuBucket.name,
      BEDROCK_MODEL_EMBEDDING:
        process.env.BEDROCK_MODEL_EMBEDDING ?? "amazon.titan-embed-text-v2:0",
    } as const;

    const recommendFn = new aws.Function("Recommend", {
      handler: "../services/lambda/recommend/src/index.handler",
      runtime: "nodejs20.x",
      nodejs: {
        install: [
          "@aws-sdk/client-bedrock-runtime",
          "@aws-sdk/client-s3"
        ],
      },
      link: [menuBucket],
      environment: recommendEnv,
    });

    // 既存 API に POST /recommend /webhook を追加（既存関数を呼び出し）
    api.route("POST /recommend", recommendFn.arn);
    api.route("POST /webhook", webhookFn.arn);

    // ステップ6: Next.js サイト（CloudFront 配信）
    const menuJsonUrl = menuBucket.domain.apply(
      (domain) => `https://${domain}/menu.json`,
    );
    const recommendUrl = api.url.apply((url) => `${url}/recommend`);

    const site = new aws.Nextjs("Frontend", {
      path: "../apps/frontend",
      environment: {
        NEXT_PUBLIC_MENU_JSON_URL: menuJsonUrl,
        NEXT_PUBLIC_RECOMMEND_API: recommendUrl,
        NEXT_PUBLIC_MAKERS_JSON_URL: menuBucket.domain.apply(
          (domain) => `https://${domain}/makers.json`
        ),
      },
    });

    return {
      ApiUrl: api.url,
      TableName: table.name,
      MenuBucket: menuBucket.name,
      PublicImageBucket: publicBucket.name,
      StagingImageBucket: stagingBucket.name,
      RecommendFunction: recommendFn.arn,
      WebhookFunction: webhookFn.arn,
      GenerateMenuFunction: generateMenu.arn,
      FrontendUrl: site.url,
    } as const;
  },
};
