import { StackContext, Api, Bucket, Config, NextjsSite, Table, Function } from 'sst/constructs';

export function MenuStack({ stack }: StackContext) {
  const stage = stack.stage;

  const gasSecret = new Config.Secret(stack, 'GAS_WEBHOOK_SECRET');
  const sheetId = new Config.Parameter(stack, 'SHEET_ID', process.env.SHEET_ID ?? '');

  const menuBucket = new Bucket(stack, 'MenuBucket', {
    bucketName: `bar-ease-menu-${stage}`,
    cors: true
  });

  const publicBucket = new Bucket(stack, 'PublicImageBucket', {
    bucketName: `bar-ease-menu-public-${stage}`,
    cors: true
  });

  const stagingBucket = new Bucket(stack, 'StagingImageBucket', {
    bucketName: `bar-ease-menu-staging-${stage}`,
    cors: true
  });

  const sheetTable = new Table(stack, 'SheetTable', {
    fields: {
      pk: 'string',
      sk: 'string'
    },
    primaryIndex: { partitionKey: 'pk', sortKey: 'sk' }
  });

  const menuLambda = new Function(stack, 'MenuLambda', {
    handler: 'services/lambda/menu/src/index.generateMenuHandler',
    environment: {
      MENU_BUCKET_NAME: menuBucket.bucketName,
      PUBLIC_IMAGE_BUCKET_NAME: publicBucket.bucketName,
      STAGING_IMAGE_BUCKET_NAME: stagingBucket.bucketName,
      BEDROCK_MODEL_CLAUDE: process.env.BEDROCK_MODEL_CLAUDE ?? 'anthropic.claude-3-haiku-20240307-v1:0',
      SHEET_TABLE_NAME: sheetTable.tableName
    },
    permissions: [menuBucket, publicBucket, stagingBucket, sheetTable]
  });

  const webhookLambda = new Function(stack, 'WebhookLambda', {
    handler: 'services/lambda/menu/src/index.webhookHandler',
    environment: {
      MENU_BUCKET_NAME: menuBucket.bucketName,
      PUBLIC_IMAGE_BUCKET_NAME: publicBucket.bucketName,
      STAGING_IMAGE_BUCKET_NAME: stagingBucket.bucketName,
      GAS_WEBHOOK_SECRET: gasSecret.value
    },
    permissions: [menuBucket, publicBucket, stagingBucket]
  });

  const recommendLambda = new Function(stack, 'RecommendLambda', {
    handler: 'services/lambda/recommend/src/index.handler',
    environment: {
      MENU_BUCKET_NAME: menuBucket.bucketName,
      BEDROCK_MODEL_EMBEDDING: process.env.BEDROCK_MODEL_EMBEDDING ?? 'amazon.titan-embed-text-v2:0'
    },
    permissions: [menuBucket]
  });

  const api = new Api(stack, 'Api', {
    routes: {
      'POST /recommend': recommendLambda,
      'POST /webhook': webhookLambda
    }
  });

  const site = new NextjsSite(stack, 'Frontend', {
    path: 'apps/frontend',
    environment: {
      NEXT_PUBLIC_MENU_JSON_URL: menuBucket.bucketUrl + '/menu.json',
      NEXT_PUBLIC_RECOMMEND_API: api.url + '/recommend'
    }
  });

  stack.addOutputs({
    ApiEndpoint: api.url,
    FrontendUrl: site.url,
    MenuBucket: menuBucket.bucketName
  });
}
