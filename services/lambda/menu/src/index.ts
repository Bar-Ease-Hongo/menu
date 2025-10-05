import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, ScheduledEvent } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { CopyObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import type { MenuItem, MenuResponse, SheetRow } from '@bar-ease/core';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const MENU_BUCKET_NAME = process.env.MENU_BUCKET_NAME as string;
const STAGING_BUCKET_NAME = process.env.STAGING_IMAGE_BUCKET_NAME as string;
const PUBLIC_BUCKET_NAME = process.env.PUBLIC_IMAGE_BUCKET_NAME as string;
const CLAUDE_MODEL_ID = process.env.BEDROCK_MODEL_CLAUDE as string;
const TABLE_NAME = process.env.SHEET_TABLE_NAME as string;

const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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

async function invokeClaude(prompt: string) {
  const command = new InvokeModelCommand({
    modelId: CLAUDE_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]
    })
  });

  const response = await bedrockClient.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    content: Array<{ text: string }>;
  };

  return payload.content.map((item) => item.text).join('\n');
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
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': 'sheet#menu' }
    })
  );

  return (result.Items as SheetRow[]) ?? [];
}

function convertRowToMenuItem(row: SheetRow): MenuItem {
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
    alcoholVolume: row.alcoholVolume ? Number(row.alcoholVolume) : undefined,
    availableBottles: row.availableBottles ? Number(row.availableBottles) : undefined,
    price30ml: row.price30ml ? Number(row.price30ml) : undefined,
    price15ml: row.price15ml ? Number(row.price15ml) : undefined,
    price10ml: row.price10ml ? Number(row.price10ml) : undefined,
    notes: row.notes,
    abvClass: classifyAbv(row.alcoholVolume),
    priceClass: classifyPrice(row.price30ml)
  };
}

function classifyAbv(alcoholVolume?: string) {
  if (!alcoholVolume) return undefined;
  const numericText = alcoholVolume.toString().replace('%', '');
  const value = Number(numericText);
  if (Number.isNaN(value)) return undefined;
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

  await s3Client.send(
    new PutObjectCommand({
      Bucket: MENU_BUCKET_NAME,
      Key: 'menu.json',
      Body: JSON.stringify(payload, null, 2),
      ContentType: 'application/json',
      CacheControl: 'max-age=60, s-maxage=300'
    })
  );
}

export async function nightlyCompletionHandler(event: ScheduledEvent) {
  console.log('nightlyCompletionHandler invoked', JSON.stringify(event));
  const rows = await querySheetRows();
  const targets = rows.filter((row) => row.aiStatus !== 'Approved');

  for (const row of targets) {
    const prompt = buildPrompt(row);
    const response = await invokeClaude(prompt);
    const json = parseClaudeJson(response);
    // TODO: DynamoDB 更新ロジックを追加（AppSync/AppFlow などと統合）
    console.log('AI suggestion generated', { id: row.id, suggestion: json });
  }

  return { statusCode: 200, body: JSON.stringify({ processed: targets.length }) };
}

export async function generateMenuHandler() {
  const rows = await querySheetRows();
  const items = rows
    .map(convertRowToMenuItem)
    .filter((item) => item.status === 'Published' && item.approveFlag === 'Approved');

  await putMenuJson(items);
  return { statusCode: 200, body: JSON.stringify({ total: items.length }) };
}

export async function webhookHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return { statusCode: 400, body: 'missing body' };
  }

  const signature = event.headers['x-signature'];
  if (!signature || !(await verifySignature(signature, event.body, event.headers['x-timestamp']))) {
    return { statusCode: 401, body: 'invalid signature' };
  }

  const payload = JSON.parse(event.body) as {
    stagingKey: string;
    publicKey: string;
    itemId: string;
  };

  await s3Client.send(
    new CopyObjectCommand({
      Bucket: PUBLIC_BUCKET_NAME,
      CopySource: `${STAGING_BUCKET_NAME}/${payload.stagingKey}`,
      Key: payload.publicKey,
      ACL: 'public-read',
      MetadataDirective: 'REPLACE',
      CacheControl: 'max-age=31536000'
    })
  );

  await generateMenuHandler();
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

async function verifySignature(signature: string, body: string, timestampHeader?: string) {
  if (!timestampHeader) return false;
  const secret = process.env.GAS_WEBHOOK_SECRET ?? '';
  const timestamp = Number(timestampHeader);
  if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return false;
  }

  const crypto = await import('crypto');
  const computed = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const expected = Buffer.from(computed, 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

export type Handlers = typeof nightlyCompletionHandler | typeof generateMenuHandler | typeof webhookHandler;
