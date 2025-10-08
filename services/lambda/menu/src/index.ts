import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, ScheduledEvent } from 'aws-lambda';
import { invokeClaude as invokeClaudeCommon, logBedrockEnv, createEmbedding } from '@bar-ease/common';
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

import type { 
  MenuItem, MenuResponse, SheetRow, 
  SourceData, PublishedData, ItemFlags, SheetEntity 
} from '@bar-ease/core';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const MENU_BUCKET_NAME = process.env.MENU_BUCKET_NAME as string;
const STAGING_BUCKET_NAME = process.env.STAGING_IMAGE_BUCKET_NAME as string;
const PUBLIC_BUCKET_NAME = process.env.PUBLIC_IMAGE_BUCKET_NAME as string;
const CLAUDE_MODEL_ID = process.env.BEDROCK_MODEL_CLAUDE as string;
const TABLE_NAME = process.env.SHEET_TABLE_NAME as string;
const EMBEDDING_MODEL_ID = process.env.BEDROCK_MODEL_EMBEDDING as string | undefined;
const EMBEDDING_KEY = process.env.EMBEDDING_KEY ?? 'embeddings.json';
const GAS_CALLBACK_URL = process.env.GAS_CALLBACK_URL; // AI完了通知用

const s3Client = new S3Client({ region: REGION });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SHEET_PK = 'sheet#menu';
const SHEET_SK_PREFIX = 'item#';

function buildSortKey(id: string) {
  return `${SHEET_SK_PREFIX}${id}`;
}

function extractIdFromSortKey(sk: string): string {
  // sk の形式: "item#1" -> "1"
  const match = sk.match(/^item#(.+)$/);
  return match ? match[1] : sk;
}

function parseTags(input?: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.filter(Boolean);
  }
  if (!input) return [];
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function buildPublicImageUrl(key: string) {
  const encoded = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://${PUBLIC_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${encoded}`;
}

function toPercentageNumber(value?: string | number) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!text) return undefined;
  const cleaned = text.replace(/[^0-9.]/g, '');
  if (!cleaned) return undefined;
  const numeric = Number(cleaned);
  if (Number.isNaN(numeric)) return undefined;
  
  // 0.43形式（小数）の場合は43に変換、43形式（整数）の場合はそのまま
  const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  
  // 小数点以下2桁で統一（43.5なども許容）
  return Number(percent.toFixed(2));
}

function computeHash(data: Record<string, unknown>): string {
  const json = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

async function findEntityById(id: string): Promise<SheetEntity | undefined> {
  const sk = buildSortKey(id);
  const result = await dynamoClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: SHEET_PK, sk }
    })
  );
  return result.Item as SheetEntity | undefined;
}

async function queryAllEntities(): Promise<SheetEntity[]> {
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': SHEET_PK }
    })
  );
  return (result.Items as SheetEntity[]) ?? [];
}

// ========================================
// AI補完依頼ハンドラ（POST /ai/request）
// ========================================
export async function aiRequestHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ message: 'missing body' }) };
  }

  const signature = event.headers['x-signature'];
  const timestamp = event.headers['x-timestamp'];
  
  // API Gateway v2では body がBase64エンコードされている可能性がある
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  
  if (!signature || !(await verifySignature(signature, body, timestamp))) {
    return { statusCode: 401, body: JSON.stringify({ message: 'invalid signature' }) };
  }

  const payload = JSON.parse(body) as { itemId: string; source: SourceData };
  const { itemId, source } = payload;

  if (!itemId || !source) {
    return { statusCode: 400, body: JSON.stringify({ message: 'itemId and source required' }) };
  }

  console.log('[aiRequest] start', { itemId });

  try {
    const entity = await findEntityById(itemId);
    const sourceHash = computeHash(source);

    // ハッシュ最適化: 前回と同じなら再実行スキップ
    if (entity?.flags?.sourceHash === sourceHash && entity?.flags?.aiCompleted) {
      console.log('[aiRequest] skipped (same source hash)', { itemId, sourceHash });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, itemId, skipped: true })
      };
    }

    // AI補完実行
    logBedrockEnv();
    const prompt = buildAiPrompt(source);
    const response = await invokeClaude(prompt);
    
    let aiJson;
    try {
      aiJson = parseClaudeJson(response);
    } catch (error) {
      console.error('[aiRequest] JSON parse failed:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          message: 'AI response parsing failed', 
          error: error instanceof Error ? error.message : 'Unknown error',
          response: response.substring(0, 500) // デバッグ用に最初の500文字
        })
      };
    }

    // published に保存
    const published: PublishedData = {
      name: aiJson.name,
      maker: aiJson.maker,
      category: aiJson.category,
      tags: Array.isArray(aiJson.tags) ? aiJson.tags.join(', ') : aiJson.tags,
      description: aiJson.description,
      alcoholVolume: aiJson.alcoholVolume,
      imageUrl: aiJson.imageUrl,
      country: aiJson.country,
      type: aiJson.type,
      caskType: aiJson.caskType,
      maturationPeriod: aiJson.maturationPeriod
    };

  const now = new Date().toISOString();
  const pk = SHEET_PK;
    const sk = buildSortKey(itemId);

    // Dynamo更新
  await dynamoClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
        UpdateExpression: `SET 
          #id = :id,
          #source = :source,
          #published = :published,
          #aiSuggested = :aiSuggested,
          #flags = :flags,
          #updatedAt = :updatedAt,
          #createdAt = if_not_exists(#createdAt, :createdAt)
        `,
        ExpressionAttributeNames: {
          '#id': 'id',
          '#source': 'source',
          '#published': 'published',
          '#aiSuggested': 'aiSuggested',
          '#flags': 'flags',
          '#updatedAt': 'updatedAt',
          '#createdAt': 'createdAt'
        },
        ExpressionAttributeValues: {
          ':id': itemId,
          ':source': source,
          ':published': published,
          ':aiSuggested': published, // 参考用に候補も保存
          ':flags': {
            aiRequested: true,
            aiCompleted: true,
            sourceHash,
            publishedHash: computeHash(published)
          } as ItemFlags,
          ':updatedAt': now,
          ':createdAt': entity?.createdAt ?? now
        }
      })
    );

    console.log('[aiRequest] AI completed', { itemId });

    // GAS Callback通知（AI完了）
    if (GAS_CALLBACK_URL) {
      await notifyGasCallback({
        type: 'ai_completed',
        itemId,
        published
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, itemId, published })
    };
  } catch (error) {
    console.error('[aiRequest] error', { itemId, error });
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'internal error', error: (error as Error).message })
    };
  }
}

// ========================================
// AI補完結果取得（GET /ai/result）
// ========================================
export async function aiResultHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const signature = event.headers['x-signature'];
  const timestamp = event.headers['x-timestamp'];
  if (!signature || !(await verifySignature(signature, 'GET', timestamp))) {
    return { statusCode: 401, body: JSON.stringify({ message: 'invalid signature' }) };
  }

  const ids = event.queryStringParameters?.ids?.split(',').map(id => id.trim()).filter(Boolean) ?? [];

  try {
    let entities: SheetEntity[];

    if (ids.length > 0) {
      // 指定IDのみ取得
      const results = await Promise.all(ids.map(id => findEntityById(id)));
      entities = results.filter((e): e is SheetEntity => Boolean(e));
    } else {
      // 全件取得
      entities = await queryAllEntities();
    }

    const items = entities.map(entity => ({
      id: entity.id || extractIdFromSortKey(entity.sk),
      flags: entity.flags,
      published: entity.published,
      aiSuggested: entity.aiSuggested
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ items, total: items.length })
    };
  } catch (error) {
    console.error('[aiResult] error', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'internal error' })
    };
  }
}

// ========================================
// Webhook（公開状態・表示情報制御）
// ========================================
export async function webhookHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ message: 'missing body' }) };
  }

  const signature = event.headers['x-signature'];
  const timestamp = event.headers['x-timestamp'];
  
  // API Gateway v2では body がBase64エンコードされている可能性がある
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  
  if (!signature || !(await verifySignature(signature, body, timestamp))) {
    return { statusCode: 401, body: JSON.stringify({ message: 'invalid signature' }) };
  }

  const payload = JSON.parse(body) as {
    itemId: string;
    source: SourceData;
    published?: PublishedData;
    publishStatus: string;  // '公開' | '非公開'
    displayInfo: string;    // '元情報' | '優先公開情報(AI補完情報)' | ''
  };

  const { itemId, source, published, publishStatus, displayInfo } = payload;

  if (!itemId || !source) {
    return { statusCode: 400, body: JSON.stringify({ message: 'itemId and source required' }) };
  }

  console.log('[webhook] start', { itemId, publishStatus, displayInfo });

  try {
    const now = new Date().toISOString();
    const pk = SHEET_PK;
    const sk = buildSortKey(itemId);

    const entity = await findEntityById(itemId);

    // 表示情報の判定
    const displaySource = displayInfo === '元情報';

    // Dynamo更新
  await dynamoClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
        Key: { pk, sk },
        UpdateExpression: `SET 
          #source = :source,
          #published = :published,
          #flags = :flags,
          #updatedAt = :updatedAt,
          #createdAt = if_not_exists(#createdAt, :createdAt)
        `,
        ExpressionAttributeNames: {
          '#source': 'source',
          '#published': 'published',
          '#flags': 'flags',
          '#updatedAt': 'updatedAt',
          '#createdAt': 'createdAt'
        },
        ExpressionAttributeValues: {
          ':source': source,
          ':published': published ?? {},
          ':flags': {
            ...entity?.flags,
            publishApproved: publishStatus === '公開',
            displaySource: displaySource,
            sourceHash: computeHash(source),
            publishedHash: published ? computeHash(published) : undefined
          } as ItemFlags,
          ':updatedAt': now,
          ':createdAt': entity?.createdAt ?? now
        }
      })
    );

    // menu.json 再生成
    await generateMenuHandler();

    console.log('[webhook] completed', { itemId, publishStatus, displayInfo });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, itemId })
    };
  } catch (error) {
    console.error('[webhook] error', { itemId, error });
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'internal error', error: (error as Error).message })
    };
  }
}

// ========================================
// menu.json 生成（published優先）
// ========================================
export async function generateMenuHandler() {
  console.log('[generateMenu] start');
  const entities = await queryAllEntities();
  console.log('[generateMenu] entities fetched', entities.length);

  const items = entities
    .filter(entity => entity.flags?.publishApproved === true)
    .map(entity => convertEntityToMenuItem(entity));

  console.log('[generateMenu] filtered items', items.length);
  await putMenuJson(items);
  await generateEmbeddings(items);
  console.log('[generateMenu] put complete');
  return { statusCode: 200, body: JSON.stringify({ total: items.length }) };
}

function convertEntityToMenuItem(entity: SheetEntity): MenuItem {
  const { source, published, flags } = entity;
  
  // 表示情報の選択（displaySource=trueなら元情報、falseなら優先公開情報）
  const useSource = flags?.displaySource === true;
  const data = useSource ? source : published;
  
  const name = data?.name ?? source.name ?? 'No name';
  const maker = data?.maker ?? source.maker ?? '';
  const category = data?.category ?? source.category ?? 'その他';
  const tags = parseTags(data?.tags ?? source.tags);
  const description = data?.description ?? source.description ?? '';
  const alcoholVolume = toPercentageNumber(data?.alcoholVolume ?? source.alcoholVolume);
  const imageUrl = data?.imageUrl ?? source.imageUrl ?? '';
  const country = data?.country ?? source.country;
  const type = data?.type ?? source.type;
  const caskType = data?.caskType ?? source.caskType;
  const maturationPeriod = data?.maturationPeriod ?? source.maturationPeriod;

  return {
    id: entity.id || extractIdFromSortKey(entity.sk),
    status: 'Published',
    name,
    maker,
    makerSlug: slugify(maker),
    category,
    tags,
    description,
    imageUrl,
    aiStatus: entity.flags?.aiCompleted ? 'Approved' : 'None',
    approveFlag: 'Approved',
    updatedAt: entity.updatedAt,
    country,
    manufacturer: source.manufacturer,
    distributor: source.distributor,
    distillery: source.distillery,
    type,
    caskNumber: source.caskNumber,
    caskType,
    maturationPlace: source.maturationPlace,
    maturationPeriod,
    alcoholVolume,
    availableBottles: source.availableBottles ? Number(source.availableBottles) : undefined,
    price30ml: source.price30ml ? Number(source.price30ml) : undefined,
    price15ml: source.price15ml ? Number(source.price15ml) : undefined,
    price10ml: source.price10ml ? Number(source.price10ml) : undefined,
    notes: source.notes,
    abvClass: classifyAbv(alcoholVolume),
    priceClass: classifyPrice(source.price30ml)
  };
}

function classifyAbv(alcoholVolume?: number) {
  if (alcoholVolume === undefined) return undefined;
  if (alcoholVolume < 40) return 'low';
  if (alcoholVolume <= 46) return 'mid';
  return 'high';
}

function classifyPrice(price?: string | number) {
  if (!price) return undefined;
  const value = typeof price === 'number' ? price : Number(String(price).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(value)) return undefined;
  if (value < 1200) return 'low';
  if (value <= 2000) return 'mid';
  return 'high';
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function putMenuJson(items: MenuItem[]) {
  const payload: MenuResponse = {
    items,
    total: items.length,
    updatedAt: new Date().toISOString()
  };
  console.log('[generateMenu] putMenuJson start', payload.total);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: MENU_BUCKET_NAME,
      Key: 'menu.json',
      Body: JSON.stringify(payload, null, 2),
      ContentType: 'application/json',
      CacheControl: 'max-age=60, s-maxage=300'
    })
  );
  console.log('[generateMenu] putMenuJson done');
}

async function generateEmbeddings(items: MenuItem[]) {
  console.log('[generateMenu] embeddings start');
  const records: { id: string; vector: number[] }[] = [];
  for (const item of items) {
    if (!item.id) continue;
    const text = [item.name, item.description, (item.tags || []).join(', ')]
      .filter(Boolean)
      .join(' \n ')
      .slice(0, 4000);
    try {
      const vector = await createEmbedding({ modelId: EMBEDDING_MODEL_ID, text });
      records.push({ id: item.id, vector });
    } catch (error) {
      console.error('[generateMenu] embedding failed', { id: item.id, error });
    }
  }
  await s3Client.send(
    new PutObjectCommand({
      Bucket: MENU_BUCKET_NAME,
      Key: EMBEDDING_KEY,
      Body: JSON.stringify(records),
      ContentType: 'application/json',
      CacheControl: 'max-age=300, s-maxage=600'
    })
  );
  console.log('[generateMenu] embeddings done', { total: records.length });
}

// ========================================
// AI補完プロンプト
// ========================================
function buildAiPrompt(source: SourceData) {
  return `以下の「お酒（酒類）アイテム」の情報について、公式情報（メーカー公式サイト、正規輸入元、公式資料）を最優先に、欠損値または明らかに間違っている情報のみを補完・修正してください。

補完対象:
- 空欄・未入力のフィールド
- 明らかに間違っている情報（例：存在しないメーカー名、不整合な度数、誤った国名など）
- 整合性のない情報（例：商品名とメーカーが一致しない、不可能な熟成年数など）

既存値が妥当で正確な場合は変更せず、欠損または誤りがあるフィールドのみを返してください。

JSONスキーマ（補完が必要なフィールドのみ返す）:
{
  "name": "商品名",
  "maker": "メーカー名（正規表記）",
  "category": "カテゴリ（例：ウイスキー／ラム／ジン／ビール 等）",
  "description": "50〜80文字程度の説明（宣伝文句ではなく中立・簡潔）",
  "tags": ["3〜5個の味わい・特徴タグ（例：smoky, fruity）"],
  "country": "生産国（必ず和名で統一。例：スコットランド、アイルランド、アメリカ、日本）",
  "type": "タイプ（銘柄の種別。例：シングルモルト、ブレンデッド、IPA など）",
  "maturationPeriod": "熟成年数／期間（該当しない場合は 'N/A' 等）",
  "caskType": "樽種／熟成容器（該当しない場合は 'N/A' 等）",
  "alcoholVolume": "度数 (整数値、例: 43, 43.5)",
  "imageUrl": "候補画像URL（公式に準拠：可能なら公式画像のURLを優先）",
  "imageAlt": "画像の代替テキスト（商品名＋簡潔な説明）"
}

前提・ポリシー:
- 公式情報を最優先。非公式情報しか見つからない場合は一般に妥当な定説を用いる。
- 事実と推定が混同しないよう、description は断定的表現を避け簡潔に。
- 既存値が正確な場合は変更しない。
- 必ず有効なJSONのみを返してください。説明文やコメントは一切含めないでください。

重要: レスポンスは必ず以下の形式で返してください:
\`\`\`json
{
  "name": "商品名",
  "maker": "メーカー名",
  ...
}
\`\`\`

既存の値:
${JSON.stringify(source, null, 2)}
`;
}

async function invokeClaude(prompt: string) {
  return invokeClaudeCommon({ modelId: CLAUDE_MODEL_ID, input: prompt, temperature: 0.3, maxTokens: 1024 });
}

function parseClaudeJson(text: string) {
  console.log('[parseClaudeJson] raw response:', text);
  
  // 1. ```json``` ブロックを探す
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  if (fenced) {
    try {
      const jsonText = fenced[1].trim();
      console.log('[parseClaudeJson] extracted JSON:', jsonText);
      return JSON.parse(jsonText);
    } catch (error) {
      console.error('[parseClaudeJson] JSON parse error in fenced block:', error);
    }
  }
  
  // 2. ``` ブロックを探す（json指定なし）
  const codeBlock = text.match(/```\s*([\s\S]+?)```/i);
  if (codeBlock) {
    try {
      const jsonText = codeBlock[1].trim();
      console.log('[parseClaudeJson] extracted from code block:', jsonText);
      return JSON.parse(jsonText);
    } catch (error) {
      console.error('[parseClaudeJson] JSON parse error in code block:', error);
    }
  }
  
  // 3. { で始まる部分を探す
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const jsonText = text.substring(jsonStart);
      console.log('[parseClaudeJson] extracted from text:', jsonText);
      return JSON.parse(jsonText);
    } catch (error) {
      console.error('[parseClaudeJson] JSON parse error from text:', error);
    }
  }
  
  // 4. 全て失敗した場合
  console.error('[parseClaudeJson] Failed to parse JSON from response:', text);
  throw new Error(`Invalid JSON response from Claude: ${text.substring(0, 200)}...`);
}

// ========================================
// GAS Callback通知
// ========================================
async function notifyGasCallback(payload: { type: string; itemId: string; published?: PublishedData }) {
  if (!GAS_CALLBACK_URL) {
    console.log('[gasCallback] GAS_CALLBACK_URL not set, skipping');
    return;
  }

  try {
    const timestamp = Date.now();
    const secret = process.env.GAS_WEBHOOK_SECRET ?? '';
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const response = await fetch(GAS_CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Timestamp': String(timestamp),
        'X-Signature': signature
      },
      body
    });

    if (!response.ok) {
      console.error('[gasCallback] failed', { status: response.status, body: await response.text() });
    } else {
      console.log('[gasCallback] success', { itemId: payload.itemId });
    }
  } catch (error) {
    console.error('[gasCallback] error', error);
  }
}

// ========================================
// 署名検証
// ========================================
async function verifySignature(signature: string, body: string, timestampHeader?: string) {
  if (!timestampHeader) {
    console.log('[verifySignature] no timestamp header');
    return false;
  }
  
  const secret = (process.env.GAS_WEBHOOK_SECRET ?? '').trim();
  const timestamp = Number(timestampHeader);
  
  if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    console.log('[verifySignature] invalid timestamp', { timestamp, now: Date.now(), diff: Math.abs(Date.now() - timestamp) });
    return false;
  }

  const message = `${timestamp}.${body}`;
  
  // secretをBufferとして明示的に処理
  const secretBuffer = Buffer.from(secret, 'utf-8');
  const hmac = crypto.createHmac('sha256', secretBuffer);
  hmac.update(message, 'utf-8');
  const computedBytes = hmac.digest();
  const computed = computedBytes.toString('hex');
  
  return signature.toLowerCase() === computed;
}

// ========================================
// 夜間バッチ（既存維持・バックアップ用）
// ========================================
export async function nightlyCompletionHandler(event: ScheduledEvent) {
  console.log('nightlyCompletionHandler invoked', JSON.stringify(event));
  logBedrockEnv();
  const entities = await queryAllEntities();
  const targets = entities.filter(entity => !entity.flags?.aiCompleted);

  for (const entity of targets) {
    const prompt = buildAiPrompt(entity.source);
    const response = await invokeClaude(prompt);
    const json = parseClaudeJson(response);
    try {
      // AI候補として保存（published は上書きしない）
      await dynamoClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: entity.pk, sk: entity.sk },
          UpdateExpression: 'SET #aiSuggested = :aiSuggested, #updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#aiSuggested': 'aiSuggested',
            '#updatedAt': 'updatedAt'
          },
          ExpressionAttributeValues: {
            ':aiSuggested': json,
            ':updatedAt': new Date().toISOString()
          }
        })
      );
    } catch (error) {
      console.error('[nightly] failed to save suggestion', { id: entity.id, error });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ processed: targets.length })
  };
}

export type Handlers =
  | typeof aiRequestHandler
  | typeof aiResultHandler
  | typeof webhookHandler
  | typeof generateMenuHandler
  | typeof nightlyCompletionHandler;

