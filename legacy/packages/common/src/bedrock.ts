import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// ===== Types =====
export interface InvokeClaudeOptions {
  modelId?: string; // optional -> falls back to env / default
  input: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CreateEmbeddingOptions {
  modelId?: string; // optional -> env / default
  text: string;
}

// ===== Constants / Defaults =====
const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const DEFAULT_CLAUDE_ID = process.env.BEDROCK_MODEL_CLAUDE ?? 'anthropic.claude-3-haiku-20240307-v1:0';
const DEFAULT_EMBED_ID = process.env.BEDROCK_MODEL_EMBEDDING ?? 'amazon.titan-embed-text-v2:0';

// Allow-list pattern – helps early detection of misconfiguration
const ALLOWED_MODEL_PREFIXES = [
  'anthropic.claude-3-haiku',
  'anthropic.claude-3-sonnet',
  'amazon.titan-embed-text'
];

const client = new BedrockRuntimeClient({ region: REGION });

export class BedrockModelAccessError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BedrockModelAccessError';
  }
}

function validateModelId(modelId: string) {
  if (!modelId) throw new BedrockModelAccessError('modelId is empty (ENV not set?)');
  const ok = ALLOWED_MODEL_PREFIXES.some((p) => modelId.startsWith(p));
  if (!ok) console.warn('[bedrock] modelId not in allow-list (continuing but flagged)', { modelId });
  return modelId;
}

function safeParseBody(body: unknown): any {
  try {
    return JSON.parse(Buffer.from(body as any).toString('utf-8'));
  } catch {
    throw new Error('Failed to parse Bedrock response body');
  }
}

export function logBedrockEnv() {
  console.info('[bedrock] env', { region: REGION, claude: DEFAULT_CLAUDE_ID, embedding: DEFAULT_EMBED_ID });
}

export async function invokeClaude({
  modelId = DEFAULT_CLAUDE_ID,
  input,
  maxTokens = 1024,
  temperature = 0
}: InvokeClaudeOptions) {
  const resolved = validateModelId(modelId);
  console.info('[bedrock] invokeClaude start', { modelId: resolved, tokens: maxTokens });
  const command = new InvokeModelCommand({
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'user', content: [{ type: 'text', text: input }] }
      ]
    }),
    contentType: 'application/json',
    accept: 'application/json',
    modelId: resolved
  });
  try {
    const response = await client.send(command);
    const payload = safeParseBody(response.body) as { content: Array<{ text: string }> };
    const text = payload.content.map((c) => c.text).join('\n');
    console.info('[bedrock] invokeClaude success', { modelId: resolved, length: text.length });
    return text;
  } catch (error: any) {
    if (error?.name === 'AccessDeniedException') {
      throw new BedrockModelAccessError('Access denied to model (IAM/SCP mismatch or wrong modelId)', error);
    }
    console.error('[bedrock] invokeClaude error', { error });
    throw error;
  }
}

export async function createEmbedding({ modelId = DEFAULT_EMBED_ID, text }: CreateEmbeddingOptions) {
  const resolved = validateModelId(modelId);
  console.info('[bedrock] createEmbedding start', { modelId: resolved, textLen: text.length });
  const command = new InvokeModelCommand({
    modelId: resolved,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: text })
  });
  try {
    const response = await client.send(command);
    const payload = safeParseBody(response.body) as { embedding: number[] };
    console.info('[bedrock] createEmbedding success', { modelId: resolved, dim: payload.embedding.length });
    return payload.embedding;
  } catch (error: any) {
    if (error?.name === 'AccessDeniedException') {
      throw new BedrockModelAccessError('Access denied to embedding model (IAM/SCP mismatch or wrong modelId)', error);
    }
    console.error('[bedrock] createEmbedding error', { error });
    throw error;
  }
}
