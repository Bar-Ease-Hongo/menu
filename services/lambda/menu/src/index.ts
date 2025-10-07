import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, ScheduledEvent } from 'aws-lambda';
// @ts-ignore Node types are provided via root config
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'; // kept if future streaming needed
import { invokeClaude as invokeClaudeCommon, logBedrockEnv, createEmbedding } from '@bar-ease/common';
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import type { MenuItem, MenuResponse, SheetRow } from '@bar-ease/core';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const MENU_BUCKET_NAME = process.env.MENU_BUCKET_NAME as string;
const STAGING_BUCKET_NAME = process.env.STAGING_IMAGE_BUCKET_NAME as string;
const PUBLIC_BUCKET_NAME = process.env.PUBLIC_IMAGE_BUCKET_NAME as string;
const CLAUDE_MODEL_ID = process.env.BEDROCK_MODEL_CLAUDE as string;
const TABLE_NAME = process.env.SHEET_TABLE_NAME as string;
const EMBEDDING_MODEL_ID = process.env.BEDROCK_MODEL_EMBEDDING as string | undefined;
const EMBEDDING_KEY = process.env.EMBEDDING_KEY ?? 'embeddings.json';

// Bedrock client removed – handled in common wrapper
const s3Client = new S3Client({ region: REGION });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SHEET_PK = 'sheet#menu';
const SHEET_SK_PREFIX = 'item#';

type SheetEntity = SheetRow & {
  pk?: string;
  sk?: string;
  createdAt?: string;
  publicKey?: string;
  stagingKey?: string;
};

type SyncItemInput = SheetRow & {
  stagingKey?: string;
  publicKey?: string;
};

const SYNC_FIELD_NAMES = [
  'name',
  'status',
  'maker',
  'makerSlug',
  'category',
  'tags',
  'description',
  'aiSuggestedDescription',
  'aiSuggestedImageUrl',
  'imageUrl',
  'aiStatus',
  'approveFlag',
  'approvedBy',
  'approvedAt',
  'updatedAt',
  'country',
  'manufacturer',
  'distributor',
  'distillery',
  'type',
  'caskNumber',
  'caskType',
  'maturationPlace',
  'maturationPeriod',
  'alcoholVolume',
  'availableBottles',
  'price30ml',
  'price15ml',
  'price10ml',
  'notes',
  'stagingKey',
  'publicKey'
] as const;

type SyncFieldName = typeof SYNC_FIELD_NAMES[number];

function buildSortKey(id: string) {
  return `${SHEET_SK_PREFIX}${id}`;
}

function parseTags(input?: string | string[]) {
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
  const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Number(percent.toFixed(2));
}

async function findSheetEntityById(id: string): Promise<SheetEntity | undefined> {
  const sk = buildSortKey(id);
  const byKey = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk AND #sk = :sk',
      ExpressionAttributeNames: {
        '#pk': 'pk',
        '#sk': 'sk'
      },
      ExpressionAttributeValues: {
        ':pk': SHEET_PK,
        ':sk': sk
      },
      Limit: 1
    })
  );

  const keyHit = (byKey.Items as SheetEntity[]) ?? [];
  if (keyHit[0]) {
    return keyHit[0];
  }

  const legacy = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      FilterExpression: '#id = :id',
      ExpressionAttributeNames: {
        '#pk': 'pk',
        '#id': 'id'
      },
      ExpressionAttributeValues: {
        ':pk': SHEET_PK,
        ':id': id
      },
      Limit: 1
    })
  );

  const legacyItems = (legacy.Items as SheetEntity[]) ?? [];
  return legacyItems[0];
}

function extractKeyFromUrl(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

async function deleteObjectIfExists(bucket: string, key?: string) {
  if (!key) return;
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    console.log('[sync] deleted object', { bucket, key });
  } catch (error) {
    const code = (error as { name?: string }).name;
    if (code === 'NoSuchKey') {
      console.log('[sync] delete skipped (not found)', { bucket, key });
      return;
    }
    console.warn('[sync] delete failed', { bucket, key, error });
  }
}

async function upsertSheetItem(item: SyncItemInput) {
  if (!item.id) {
    throw new Error('missing id');
  }

  const now = new Date().toISOString();
  const pk = SHEET_PK;
  const sk = buildSortKey(item.id);
  const existing = await findSheetEntityById(item.id);

  const names: Record<string, string> = {
    '#id': 'id',
    '#syncedAt': 'syncedAt',
    '#createdAt': 'createdAt'
  };

  const values: Record<string, unknown> = {
    ':id': item.id,
    ':syncedAt': now,
    ':createdAt': existing?.createdAt ?? now
  };

  const setClauses = [
    '#id = :id',
    '#syncedAt = :syncedAt',
    '#createdAt = if_not_exists(#createdAt, :createdAt)'
  ];
  const removeClauses: string[] = [];

  const wasPublished = existing?.status === 'Published' && existing?.approveFlag === 'Approved';
  const isPublished = item.status === 'Published' && item.approveFlag === 'Approved';
  let shouldRegenerate = wasPublished || isPublished;

  let previousPublicKey: string | undefined;
  let previousStagingKey: string | undefined;

  const clearImage = (() => {
    if (!existing) return false;
    if (item.publicKey && existing.publicKey && item.publicKey !== existing.publicKey) {
      previousPublicKey = existing.publicKey;
      previousStagingKey = existing.stagingKey ?? extractKeyFromUrl(existing.aiSuggestedImageUrl);
      return true;
    }
    if (!item.publicKey && existing.publicKey) {
      previousPublicKey = existing.publicKey;
      previousStagingKey = existing.stagingKey ?? extractKeyFromUrl(existing.aiSuggestedImageUrl);
      return true;
    }
    return false;
  })();

  for (const field of SYNC_FIELD_NAMES) {
    const fieldName = field;
    if (!Object.prototype.hasOwnProperty.call(item, fieldName)) continue;
    const nameKey = `#${fieldName}`;
    const valueKey = `:${fieldName}`;
    names[nameKey] = fieldName;
  let value: unknown = (item as unknown as Record<string, unknown>)[fieldName];
    if (fieldName === 'imageUrl' && clearImage) {
      value = '';
      shouldRegenerate = true;
    }
    if (value === undefined || value === null || value === '') {
      removeClauses.push(nameKey);
      continue;
    }
    if (fieldName === 'tags') {
      value = Array.isArray(value) ? value : parseTags(String(value));
    } else if (['price30ml', 'price15ml', 'price10ml'].includes(fieldName)) {
      value = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.]/g, ''));
    } else if (['availableBottles', 'alcoholVolume'].includes(fieldName)) {
      value = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.]/g, ''));
    }
    values[valueKey] = value;
    setClauses.push(`${nameKey} = ${valueKey}`);
  }

  await dynamoClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      UpdateExpression: [
        setClauses.length ? `SET ${setClauses.join(', ')}` : undefined,
        removeClauses.length ? `REMOVE ${removeClauses.join(', ')}` : undefined
      ]
        .filter(Boolean)
        .join(' '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    })
  );

  if (previousPublicKey) {
    await deleteObjectIfExists(PUBLIC_BUCKET_NAME, previousPublicKey);
  }
  if (previousStagingKey && previousStagingKey !== item.stagingKey) {
    await deleteObjectIfExists(STAGING_BUCKET_NAME, previousStagingKey);
  }

  return { shouldRegenerate };
}

async function deleteSheetItem(itemId: string) {
  const entity = await findSheetEntityById(itemId);
  if (!entity) {
    console.warn('[sync] delete skipped (entity not found)', { itemId });
    return { removed: false, shouldRegenerate: false };
  }

  const pk = entity.pk ?? SHEET_PK;
  const sk = entity.sk ?? buildSortKey(itemId);

  await dynamoClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk }
    })
  );

  const publicKey = entity.publicKey ?? extractKeyFromUrl(entity.imageUrl);
  const stagingKey = entity.stagingKey ?? extractKeyFromUrl(entity.aiSuggestedImageUrl);

  await Promise.all([
    deleteObjectIfExists(PUBLIC_BUCKET_NAME, publicKey),
    deleteObjectIfExists(STAGING_BUCKET_NAME, stagingKey)
  ]);

  const wasPublished = entity.status === 'Published' && entity.approveFlag === 'Approved';
  return { removed: true, shouldRegenerate: wasPublished };
}

async function reconcileDataConsistency(rows: SheetEntity[]) {
  const tasks: Promise<unknown>[] = [];
  for (const row of rows) {
    if (!row.id) continue;

    const pk = row.pk ?? SHEET_PK;
    const sk = row.sk ?? buildSortKey(row.id);

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setClauses: string[] = [];

    if (row.publicKey && row.imageUrl && row.imageUrl !== buildPublicImageUrl(row.publicKey)) {
      names['#imageUrl'] = 'imageUrl';
      values[':imageUrl'] = buildPublicImageUrl(row.publicKey);
      setClauses.push('#imageUrl = :imageUrl');
    }

    if (setClauses.length === 0) {
      continue;
    }

    tasks.push(
      dynamoClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk },
          UpdateExpression: `SET ${setClauses.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values
        })
      )
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

async function updateApprovedItem({
  itemId,
  publicKey
}: {
  itemId: string;
  publicKey?: string;
}) {
  if (!itemId) {
    return;
  }

  const entity = await findSheetEntityById(itemId);
  if (!entity || !entity.pk || !entity.sk) {
    console.warn('[webhook] skip Dynamo update (entity missing pk/sk)', { itemId });
    return;
  }

  const names: Record<string, string> = {
    '#updatedAt': 'updatedAt'
  };
  const values: Record<string, unknown> = {
    ':updatedAt': new Date().toISOString()
  };
  const sets: string[] = ['#updatedAt = :updatedAt'];

  if (publicKey) {
    names['#imageUrl'] = 'imageUrl';
    values[':imageUrl'] = buildPublicImageUrl(publicKey);
    sets.push('#imageUrl = :imageUrl');
    names['#publicKey'] = 'publicKey';
    values[':publicKey'] = publicKey;
    sets.push('#publicKey = :publicKey');
  }

  if (entity.aiSuggestedDescription) {
    names['#description'] = 'description';
    values[':description'] = entity.aiSuggestedDescription;
    sets.push('#description = :description');
  }

  if (entity.aiStatus !== 'Approved') {
    names['#aiStatus'] = 'aiStatus';
    values[':aiStatus'] = 'Approved';
    sets.push('#aiStatus = :aiStatus');
  }

  if (sets.length === 1) {
    console.log('[webhook] Dynamo update skipped (no changes)', { itemId });
    return;
  }

  await dynamoClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: entity.pk, sk: entity.sk },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    })
  );

  console.log('[webhook] Dynamo update complete', { itemId });
}

function buildPrompt(row: SheetRow) {
  return `以下のウイスキー情報を補完してください。欠損値は推定で構いませんが、真実味のある内容にしてください。

JSONスキーマ:
{
  "name": "商品名",
  "maker": "メーカー名",
  "category": "カテゴリ",
  "description": "50〜80文字程度の説明",
  "tags": ["3〜5個の味わいタグ"],
  "country": "生産国",
  "type": "タイプ",
  "maturationPeriod": "熟成年数",
  "caskType": "熟成樽",
  "alcoholVolume": "度数 (数値)",
  "imageUrl": "S3署名URL",
  "imageAlt": "画像説明文"
}

既存の値:
${JSON.stringify(row, null, 2)}
`;
}

// Legacy inline invokeClaude replaced with common wrapper for consistency & error handling
async function invokeClaude(prompt: string) {
  return invokeClaudeCommon({ modelId: CLAUDE_MODEL_ID, input: prompt, temperature: 0.3, maxTokens: 1024 });
}

function parseClaudeJson(text: string) {
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  const jsonText = fenced ? fenced[1] : text;
  return JSON.parse(jsonText);
}

function mergeRowWithAi(row: SheetRow, aiJson: Record<string, unknown>): Partial<MenuItem> {
  return {
    name: (row.name ?? aiJson.name) as string,
    maker: (row.maker ?? aiJson.maker) as string,
    makerSlug: ((row.makerSlug as string) ?? slugify(aiJson.maker as string)) as string,
    category: (row.category ?? aiJson.category) as string,
    tags: normalizeTags(row.tags ?? (aiJson.tags as string[]) ?? []),
    description: (row.description ?? aiJson.description) as string,
    country: (row.country ?? aiJson.country) as string,
    type: (row.type ?? aiJson.type) as string,
    maturationPeriod: (row.maturationPeriod ?? aiJson.maturationPeriod) as string,
    caskType: (row.caskType ?? aiJson.caskType) as string,
    alcoholVolume: row.alcoholVolume ? Number(row.alcoholVolume) : Number(aiJson.alcoholVolume),
    aiSuggestedDescription: typeof aiJson.description === 'string' ? (aiJson.description as string) : undefined,
    aiSuggestedImageUrl: typeof aiJson.imageUrl === 'string' ? (aiJson.imageUrl as string) : undefined
  };
}

async function saveAiSuggestion(row: SheetRow, aiJson: Record<string, unknown>) {
  if (!row.id) {
    return;
  }

  const entity = await findSheetEntityById(row.id);
  if (!entity || !entity.pk || !entity.sk) {
    console.warn('[nightly] skip AI save (missing pk/sk)', { id: row.id });
    return;
  }

  const description = typeof aiJson.description === 'string' ? aiJson.description.trim() : undefined;
  const imageUrl = typeof aiJson.imageUrl === 'string' ? aiJson.imageUrl.trim() : undefined;

  const names: Record<string, string> = {
    '#aiStatus': 'aiStatus',
    '#updatedAt': 'updatedAt'
  };
  const values: Record<string, unknown> = {
    ':aiStatus': 'NeedsReview',
    ':updatedAt': new Date().toISOString()
  };
  const sets: string[] = ['#aiStatus = :aiStatus', '#updatedAt = :updatedAt'];

  if (description) {
    names['#aiSuggestedDescription'] = 'aiSuggestedDescription';
    values[':aiSuggestedDescription'] = description;
    sets.push('#aiSuggestedDescription = :aiSuggestedDescription');
  }

  if (imageUrl) {
    names['#aiSuggestedImageUrl'] = 'aiSuggestedImageUrl';
    values[':aiSuggestedImageUrl'] = imageUrl;
    sets.push('#aiSuggestedImageUrl = :aiSuggestedImageUrl');
  }

  await dynamoClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: entity.pk, sk: entity.sk },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    })
  );

  console.log('[nightly] AI suggestion saved', {
    id: row.id,
    hasDescription: Boolean(description),
    hasImage: Boolean(imageUrl)
  });
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalizeTags(tags: string | string[]) {
  if (Array.isArray(tags)) {
    return tags;
  }
  if (!tags) return [];
  return tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function querySheetRows(): Promise<SheetRow[]> {
  console.log('[generateMenu] query start');
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': 'sheet#menu' }
    })
  );

  const rows = (result.Items as SheetRow[]) ?? [];
  console.log('[generateMenu] query done', rows.length);
  return rows;
}

function convertRowToMenuItem(row: SheetRow): MenuItem {
  const alcoholVolume = toPercentageNumber(row.alcoholVolume);
  return {
    id: row.id,
    status: (row.status as MenuItem['status']) ?? 'Draft',
    name: row.name ?? 'No name',
    maker: row.maker ?? '',
    makerSlug: row.makerSlug ?? slugify(row.maker ?? ''),
    category: row.category ?? 'その他',
    tags: normalizeTags(row.tags ?? []),
    description: row.description ?? row.aiSuggestedDescription ?? '',
    aiSuggestedDescription: row.aiSuggestedDescription,
    aiSuggestedImageUrl: row.aiSuggestedImageUrl,
    imageUrl: row.imageUrl ?? '',
    aiStatus: (row.aiStatus as MenuItem['aiStatus']) ?? 'None',
    approveFlag: (row.approveFlag as MenuItem['approveFlag']) ?? '-',
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    updatedAt: row.updatedAt,
    country: row.country,
    manufacturer: row.manufacturer,
    distributor: row.distributor,
    distillery: row.distillery,
    type: row.type,
    caskNumber: row.caskNumber,
    caskType: row.caskType,
    maturationPlace: row.maturationPlace,
    maturationPeriod: row.maturationPeriod,
    alcoholVolume,
    availableBottles: row.availableBottles ? Number(row.availableBottles) : undefined,
    price30ml: row.price30ml ? Number(row.price30ml) : undefined,
    price15ml: row.price15ml ? Number(row.price15ml) : undefined,
    price10ml: row.price10ml ? Number(row.price10ml) : undefined,
    notes: row.notes,
    abvClass: classifyAbv(row.alcoholVolume),
    priceClass: classifyPrice(row.price30ml)
  };
}

function classifyAbv(alcoholVolume?: string | number) {
  const value = toPercentageNumber(alcoholVolume);
  if (value === undefined) return undefined;
  if (value < 40) return 'low';
  if (value <= 46) return 'mid';
  return 'high';
}

function classifyPrice(price?: string) {
  if (!price) return undefined;
  const numericText = price.toString().replace(/[^0-9.]/g, '');
  const value = Number(numericText);
  if (Number.isNaN(value)) return undefined;
  if (value < 1200) return 'low';
  if (value <= 2000) return 'mid';
  return 'high';
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
    const text = [item.name, item.description, (item.tags || []).join(',' )]
      .filter(Boolean)
      .join(' \n ')
      .slice(0, 4000); // safety truncate
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

export async function nightlyCompletionHandler(event: ScheduledEvent) {
  console.log('nightlyCompletionHandler invoked', JSON.stringify(event));
  logBedrockEnv();
  const rows = await querySheetRows();
  const targets = rows.filter((row) => row.aiStatus !== 'Approved');

  for (const row of targets) {
    const prompt = buildPrompt(row);
    const response = await invokeClaude(prompt);
    const json = parseClaudeJson(response);
    try {
      await saveAiSuggestion(row, json);
    } catch (error) {
      console.error('[nightly] failed to save suggestion', { id: row.id, error });
    }
  }

  await reconcileDataConsistency(rows as SheetEntity[]);

  return {
    statusCode: 200,
    body: JSON.stringify({ processed: targets.length })
  };
}

export async function generateMenuHandler() {
  console.log('[generateMenu] start');
  const rows = await querySheetRows();
  console.log('[generateMenu] rows fetched', rows.length);
  const items = rows
    .map(convertRowToMenuItem)
    .filter((item) => item.status === 'Published' && item.approveFlag === 'Approved');

  console.log('[generateMenu] filtered items', items.length);
  await putMenuJson(items);
  await generateEmbeddings(items);
  console.log('[generateMenu] put complete');
  return { statusCode: 200, body: JSON.stringify({ total: items.length }) };
}

export async function webhookHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return { statusCode: 400, body: 'missing body' };
  }

  console.log('[webhook] received body', event.body);

  const signature = event.headers['x-signature'];
  const timestamp = event.headers['x-timestamp'];

  if (!signature || !(await verifySignature(signature, event.body, timestamp))) {
    console.warn('[webhook] invalid signature');
    return { statusCode: 401, body: 'invalid signature' };
  }

  const payload = JSON.parse(event.body) as {
    stagingKey: string;
    publicKey: string;
    itemId: string;
  };
  console.log('[webhook] payload', payload);

  try {
    if (payload.stagingKey && payload.publicKey) {
      console.log('[webhook] copy start', {
        sourceBucket: STAGING_BUCKET_NAME,
        sourceKey: payload.stagingKey,
        targetBucket: PUBLIC_BUCKET_NAME,
        targetKey: payload.publicKey
      });

      await s3Client.send(
        new CopyObjectCommand({
          Bucket: PUBLIC_BUCKET_NAME,
          CopySource: `${STAGING_BUCKET_NAME}/${payload.stagingKey}`,
          Key: payload.publicKey,
          MetadataDirective: 'REPLACE',
          CacheControl: 'max-age=31536000'
        })
      );

      console.log('[webhook] copy done');
    } else {
      console.log('[webhook] copy skipped (missing keys)');
    }

    await updateApprovedItem({ itemId: payload.itemId, publicKey: payload.publicKey });

    const result = await generateMenuHandler();
    console.log('[webhook] menu regenerate result', result);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    console.error('[webhook] error', error);
    return { statusCode: 500, body: JSON.stringify({ error: (error as Error).message }) };
  }
}

export async function syncMenuHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return { statusCode: 400, body: 'missing body' };
  }

  const signature = event.headers['x-signature'] ?? event.headers['X-Signature'];
  const timestamp = event.headers['x-timestamp'] ?? event.headers['X-Timestamp'];

  if (!signature || !(await verifySignature(signature, event.body, timestamp))) {
    console.warn('[sync] invalid signature');
    return { statusCode: 401, body: 'invalid signature' };
  }

  try {
    const payload = JSON.parse(event.body) as {
      action?: 'upsert' | 'batch' | 'delete';
      item?: SyncItemInput;
      items?: SyncItemInput[];
      itemId?: string;
      itemIds?: string[];
    };

    const action = payload.action ?? (payload.items ? 'batch' : 'upsert');
    let shouldRegenerate = false;
    const processed: string[] = [];

    if (action === 'delete') {
      const ids = payload.itemIds ?? (payload.itemId ? [payload.itemId] : []);
      if (ids.length === 0) {
        return { statusCode: 400, body: 'missing itemId' };
      }
      for (const id of ids) {
        const result = await deleteSheetItem(id);
        shouldRegenerate = shouldRegenerate || result.shouldRegenerate;
        if (result.removed) {
          processed.push(id);
        }
      }
    } else {
      const items = payload.items ?? (payload.item ? [payload.item] : []);
      if (items.length === 0) {
        return { statusCode: 400, body: 'missing item payload' };
      }

      for (const item of items) {
        const result = await upsertSheetItem(item);
        shouldRegenerate = shouldRegenerate || result.shouldRegenerate;
        if (item.id) {
          processed.push(item.id);
        }
      }
    }

    if (shouldRegenerate) {
      await generateMenuHandler(); // includes embeddings
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, processed })
    };
  } catch (error) {
    console.error('[sync] error', error);
    return { statusCode: 500, body: JSON.stringify({ error: (error as Error).message }) };
  }
}

// === AI候補一覧取得 (GAS Pull 用) ===
export async function aiSuggestionsHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const signature = event.headers['x-signature'] ?? event.headers['X-Signature'];
    const timestamp = event.headers['x-timestamp'] ?? event.headers['X-Timestamp'];
    if (!signature || !(await verifySignature(signature, 'GET', timestamp))) {
      return { statusCode: 401, body: JSON.stringify({ message: 'invalid signature' }) };
    }

    const rows = await querySheetRows();
    const suggestions = rows
      .filter((r) => (r as any).aiStatus !== 'Approved')
      .map((r) => ({
        id: (r as any).id,
        aiSuggestedDescription: (r as any).aiSuggestedDescription || null,
        aiSuggestedImageUrl: (r as any).aiSuggestedImageUrl || null,
        aiStatus: (r as any).aiStatus || 'None'
      }))
      .filter((s) => s.id);

    return {
      statusCode: 200,
      body: JSON.stringify({ items: suggestions, total: suggestions.length })
    };
  } catch (error) {
    console.error('[aiSuggestions] error', error);
    return { statusCode: 500, body: JSON.stringify({ message: 'internal error' }) };
  }
}

async function verifySignature(signature: string, body: string, timestampHeader?: string) {
  if (!timestampHeader) return false;
  const secret = (process.env.GAS_WEBHOOK_SECRET ?? '').trim();
  const timestamp = Number(timestampHeader);
  if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return false;
  }

  const crypto = await import('crypto');
  const computed = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const expected = Buffer.from(computed, 'hex');
  let actual: Buffer;
  try {
    actual = Buffer.from(signature.toLowerCase(), 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length) {
    return false;
  }
  // Normalize to Uint8Array for typings compatibility under NodeNext
  const a = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
  return crypto.timingSafeEqual(a, b);
}

export type Handlers =
  | typeof nightlyCompletionHandler
  | typeof generateMenuHandler
  | typeof webhookHandler
  | typeof syncMenuHandler;
