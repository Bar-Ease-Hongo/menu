import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { MenuItem, RecommendRequestBody, RecommendResponseBody } from '@bar-ease/core';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_EMBEDDING as string;
const MENU_BUCKET_NAME = process.env.MENU_BUCKET_NAME as string;
const EMBEDDING_KEY = process.env.EMBEDDING_KEY ?? 'embeddings.json';

const s3Client = new S3Client({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

interface EmbeddingRecord {
  id: string;
  vector: number[];
}

async function fetchJsonFromS3<T>(key: string): Promise<T> {
  const command = new GetObjectCommand({ Bucket: MENU_BUCKET_NAME, Key: key });
  const response = await s3Client.send(command);
  const body = await response.Body?.transformToString('utf-8');
  if (!body) {
    throw new Error(`S3オブジェクト ${key} の読み取りに失敗しました`);
  }
  return JSON.parse(body) as T;
}

async function fetchEmbeddings(): Promise<EmbeddingRecord[]> {
  return fetchJsonFromS3<EmbeddingRecord[]>(EMBEDDING_KEY);
}

async function fetchMenu(): Promise<MenuItem[]> {
  const menu = await fetchJsonFromS3<{ items: MenuItem[] }>('menu.json');
  return menu.items;
}

async function createEmbedding(text: string) {
  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputText: text
    })
  });

  const response = await bedrockClient.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    embedding: number[];
  };

  return payload.embedding;
}

function cosineSimilarity(a: number[], b: number[]) {
  const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (normA * normB);
}

function applyFilters(item: MenuItem, filters?: RecommendRequestBody['filters']) {
  if (!filters) return true;
  if (filters.maker && filters.maker.length > 0 && !filters.maker.includes(item.maker)) {
    return false;
  }
  if (filters.category && filters.category.length > 0 && !filters.category.includes(item.category)) {
    return false;
  }
  if (filters.abv && item.abvClass !== filters.abv) {
    return false;
  }
  if (filters.priceRange && item.priceClass !== filters.priceRange) {
    return false;
  }
  return true;
}

export async function handler(event: APIGatewayProxyEventV2) {
  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'body is required' })
    };
  }

  const body = JSON.parse(event.body) as RecommendRequestBody;
  if (!body.text || body.text.trim().length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'text is required' })
    };
  }

  const [menuItems, embeddings] = await Promise.all([fetchMenu(), fetchEmbeddings()]);
  const approvedItems = menuItems.filter((item) => item.status === 'Published' && item.aiStatus === 'Approved');

  const userVector = await createEmbedding(body.text);
  const itemsWithVectors = approvedItems
    .map((item) => {
      const record = embeddings.find((embedding) => embedding.id === item.id);
      if (!record) return undefined;
      return {
        item,
        vector: record.vector,
        similarity: cosineSimilarity(userVector, record.vector)
      };
    })
    .filter((value): value is { item: MenuItem; vector: number[]; similarity: number } => Boolean(value))
    .filter(({ item }) => applyFilters(item, body.filters))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, body.limit ?? 5);

  const response: RecommendResponseBody = {
    items: itemsWithVectors.map(({ item, similarity }) => ({
      id: item.id,
      score: similarity,
      name: item.name,
      maker: item.maker,
      imageUrl: item.imageUrl,
      reason: item.description
    }))
  };

  return {
    statusCode: 200,
    body: JSON.stringify(response)
  };
}
