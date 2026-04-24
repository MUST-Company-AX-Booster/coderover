import { existsSync } from 'fs';
import { registerAs } from '@nestjs/config';

export type LlmProvider = 'openai' | 'openrouter' | 'local';
export type LlmCapability = 'chat' | 'embeddings' | 'generic';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_LOCAL_BASE_URL = 'http://localhost:1234';

type ChatMessageContent =
  | string
  | null
  | undefined
  | Array<{ type?: string; text?: string; input_text?: string }>;

interface LocalChatMessage {
  role: string;
  content: ChatMessageContent;
}

interface LocalChatCompletionParams {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  messages: LocalChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

interface LocalChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface LocalEmbeddingParams {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  input: string | string[];
}

interface LocalEmbeddingsResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

function normalizeStringValue(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unwrapQuotedString(value?: string | null): string | undefined {
  const normalized = normalizeStringValue(value);
  if (!normalized) {
    return undefined;
  }

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    const unwrapped = normalized.slice(1, -1).trim();
    return unwrapped || undefined;
  }

  return normalized;
}

export function normalizeLlmApiKey(value?: string | null): string | undefined {
  return unwrapQuotedString(value);
}

export function getLlmCredentialError(
  provider: LlmProvider,
  apiKey?: string | null,
): string | undefined {
  const normalizedApiKey = normalizeLlmApiKey(apiKey);
  if (!normalizedApiKey) {
    return 'OPENAI_API_KEY is not configured';
  }

  if (provider === 'openrouter' && !normalizedApiKey.startsWith('sk-or-')) {
    return 'OPENAI_API_KEY must be an OpenRouter API key starting with sk-or- when LLM_PROVIDER=openrouter';
  }

  return undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isDockerRuntime(): boolean {
  return existsSync('/.dockerenv');
}

function remapLocalOriginForDocker(origin: string): string {
  if (!isDockerRuntime()) {
    return origin;
  }

  try {
    const url = new URL(origin);
    if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) {
      return origin;
    }
    url.hostname = 'host.docker.internal';
    return stripTrailingSlashes(url.toString());
  } catch {
    return origin;
  }
}

function resolveLocalOrigin(configuredBaseUrl?: string | null): string {
  const trimmed = unwrapQuotedString(configuredBaseUrl) ?? DEFAULT_LOCAL_BASE_URL;
  const withoutSuffix = stripTrailingSlashes(trimmed)
    .replace(/\/api\/v1\/chat$/i, '')
    .replace(/\/v1\/embeddings$/i, '')
    .replace(/\/api\/v1$/i, '')
    .replace(/\/v1$/i, '');
  return remapLocalOriginForDocker(withoutSuffix || DEFAULT_LOCAL_BASE_URL);
}

function flattenMessageContent(content: ChatMessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.input_text === 'string') return item.input_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function flattenResponseContent(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenResponseContent(item))
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    return [value.text, value.content, value.output_text, value.input_text]
      .map((item) => flattenResponseContent(item))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractLocalChatText(payload: any): string {
  const candidates = [
    payload?.output,
    payload?.output_text,
    payload?.response,
    payload?.content,
    payload?.text,
    payload?.answer,
    payload?.message?.content,
    payload?.message,
    payload?.choices?.[0]?.message?.content,
    payload?.choices?.[0]?.message,
    payload?.choices?.[0]?.text,
    payload?.data?.content,
  ];

  for (const candidate of candidates) {
    const content = flattenResponseContent(candidate).trim();
    if (content) {
      return content;
    }
  }

  return '';
}

export function resolveLlmProvider(
  configured: string | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): LlmProvider {
  const normalized = (unwrapQuotedString(configured) || 'auto').toLowerCase();
  if (normalized === 'openai' || normalized === 'openrouter' || normalized === 'local') {
    return normalized;
  }

  const normalizedBaseUrl = unwrapQuotedString(baseUrl);
  const base = (normalizedBaseUrl || '').toLowerCase();
  if (base.includes('openrouter.ai')) return 'openrouter';
  if (base.includes('api.openai.com')) return 'openai';
  if (normalizedBaseUrl) return 'local';
  if (unwrapQuotedString(apiKey)?.startsWith('sk-or-')) return 'openrouter';
  return 'openai';
}

export function resolveLlmBaseUrl(
  provider: LlmProvider,
  configuredBaseUrl: string | undefined,
  apiKey: string | undefined,
  capability: LlmCapability = 'generic',
): string | undefined {
  const trimmed = unwrapQuotedString(configuredBaseUrl);

  if (provider === 'local') {
    const origin = resolveLocalOrigin(trimmed);
    if (capability === 'chat') {
      return `${origin}/api/v1/chat`;
    }
    return `${origin}/v1`;
  }

  if (trimmed) {
    return trimmed;
  }

  if (unwrapQuotedString(apiKey)?.startsWith('sk-or-')) {
    return OPENROUTER_BASE_URL;
  }

  return undefined;
}

export async function createLocalChatCompletion(
  params: LocalChatCompletionParams,
): Promise<LocalChatCompletionResponse> {
  const endpoint = resolveLlmBaseUrl('local', params.baseUrl, undefined, 'chat');
  const systemPrompt = params.messages
    .filter((message) => message.role === 'system')
    .map((message) => flattenMessageContent(message.content))
    .filter(Boolean)
    .join('\n\n');

  const input = params.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const content = flattenMessageContent(message.content);
      if (!content) return '';
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const body: Record<string, unknown> = {
    model: params.model,
    input,
  };

  if (systemPrompt) {
    body.system_prompt = systemPrompt;
  }
  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  const response = await fetch(endpoint!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(unwrapQuotedString(params.apiKey) ? { Authorization: `Bearer ${unwrapQuotedString(params.apiKey)}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let payload: any = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = { content: rawText };
  }

  if (!response.ok) {
    throw new Error(`Local chat request failed with status ${response.status}: ${rawText}`);
  }

  const content = extractLocalChatText(payload);
  if (!content) {
    throw new Error('Local chat response did not include any content');
  }

  return {
    choices: [{ message: { content } }],
    usage: payload?.usage,
  };
}

export async function createLocalEmbeddings(
  params: LocalEmbeddingParams,
): Promise<LocalEmbeddingsResponse> {
  const baseUrl = resolveLlmBaseUrl('local', params.baseUrl, undefined, 'embeddings');
  const endpoint = `${baseUrl}/embeddings`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(unwrapQuotedString(params.apiKey) ? { Authorization: `Bearer ${unwrapQuotedString(params.apiKey)}` } : {}),
    },
    body: JSON.stringify({
      model: params.model,
      input: params.input,
    }),
  });

  const rawText = await response.text();
  let payload: any = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`Local embeddings request failed with status ${response.status}: ${rawText}`);
  }

  const rawItems = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.embeddings)
      ? payload.embeddings
      : [];

  const data = rawItems.map((item: any, index: number) => {
    if (Array.isArray(item)) {
      return { index, embedding: item.map((value) => Number(value)) };
    }

    const embedding = Array.isArray(item?.embedding)
      ? item.embedding.map((value: unknown) => Number(value))
      : [];

    return {
      index: typeof item?.index === 'number' ? item.index : index,
      embedding,
    };
  });

  if (!data.length || !Array.isArray(data[0]?.embedding) || data[0].embedding.length === 0) {
    throw new Error(`Local embeddings response did not include embeddings: ${rawText}`);
  }

  return { data };
}

export const openaiConfig = registerAs('openai', () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const provider = resolveLlmProvider(process.env.LLM_PROVIDER, apiKey, process.env.OPENAI_BASE_URL);

  return {
    apiKey,
    baseUrl: resolveLlmBaseUrl(provider, process.env.OPENAI_BASE_URL, apiKey, 'generic'),
    chatModel:
      process.env.OPENAI_CHAT_MODEL ||
      (apiKey?.startsWith('sk-or-') ? 'openai/gpt-4o' : 'gpt-4o'),
    embeddingModel:
      process.env.OPENAI_EMBEDDING_MODEL ||
      (apiKey?.startsWith('sk-or-')
        ? 'openai/text-embedding-3-large'
        : 'text-embedding-3-large'),
    embeddingDimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS || '1536', 10),
  };
});
