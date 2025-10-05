import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

interface InvokeClaudeOptions {
  modelId: string;
  input: string;
  maxTokens?: number;
  temperature?: number;
}

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

export async function invokeClaude({ modelId, input, maxTokens = 1024, temperature = 0 }: InvokeClaudeOptions) {
  const command = new InvokeModelCommand({
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: input
            }
          ]
        }
      ]
    }),
    contentType: 'application/json',
    accept: 'application/json',
    modelId
  });

  const response = await client.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    content: Array<{ text: string }>;
  };

  return payload.content.map((item) => item.text).join('\n');
}
