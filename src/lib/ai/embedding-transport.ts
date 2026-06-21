export type EmbeddingProvider =
  | "openai"
  | "cloudflare-workers-ai"
  | (string & {});

export type EmbeddingFailureCode =
  | "empty_input"
  | "provider_unsupported"
  | "provider_unavailable"
  | "request_failed"
  | "request_headers_too_large"
  | "invalid_response"
  | "response_ordering"
  | "dimension_mismatch";

export interface EmbeddingDiagnostics {
  provider: EmbeddingProvider;
  modelId: string;
  expectedDimensions: number;
  requestedDimensions?: number;
  inputCount: number;
  batchInputCount?: number;
  batchStart?: number;
  batchSize?: number;
  attempt?: number;
  maxAttempts?: number;
  status?: number;
  retryable?: boolean;
  requestHeaderBytes?: number;
  requestBodyChars?: number;
  responseItemCount?: number;
  responseTextPreview?: string;
}

export class EmbeddingFailure extends Error {
  readonly code: EmbeddingFailureCode;
  readonly diagnostics: EmbeddingDiagnostics;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: EmbeddingFailureCode,
    message: string,
    diagnostics: EmbeddingDiagnostics,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = "EmbeddingFailure";
    this.code = code;
    this.diagnostics = {
      ...diagnostics,
      retryable: options?.retryable ?? diagnostics.retryable,
    };
    this.retryable = options?.retryable ?? diagnostics.retryable ?? false;
    this.cause = options?.cause;
  }
}

export interface EmbeddingAdapterRequest {
  inputs: string[];
  modelId: string;
  dimensions?: number;
  abortSignal?: AbortSignal;
  diagnostics: EmbeddingDiagnostics;
}

export interface EmbeddingAdapterItem {
  index: number;
  embedding: number[];
}

export interface EmbeddingAdapterResponse {
  items: EmbeddingAdapterItem[];
  diagnostics?: Partial<EmbeddingDiagnostics>;
}

export interface EmbeddingAdapter {
  provider: EmbeddingProvider;
  maxBatchSize: number;
  embedBatch(
    request: EmbeddingAdapterRequest,
  ): Promise<EmbeddingAdapterResponse>;
}

export interface OrderedEmbeddingRequest {
  inputs: string[];
  modelId: string;
  expectedDimensions: number;
  requestedDimensions?: number;
  abortSignal?: AbortSignal;
}

export interface OrderedEmbeddingTransportOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const MIN_BATCH_SIZE = 1;

export function normalizeEmbeddingInputs(values: string[]): string[] {
  const inputs = values.map((value) => value.replaceAll("\n", " ").trim());
  if (inputs.some((input) => input.length === 0)) {
    throw new EmbeddingFailure(
      "empty_input",
      "Cannot generate embeddings for empty text",
      {
        provider: "openai",
        modelId: "unknown",
        expectedDimensions: 0,
        inputCount: values.length,
      },
      { retryable: false },
    );
  }
  return inputs;
}

export async function requestOrderedEmbeddings(
  adapter: EmbeddingAdapter,
  request: OrderedEmbeddingRequest,
  options: OrderedEmbeddingTransportOptions = {},
): Promise<number[][]> {
  if (request.inputs.length === 0) return [];

  const batchSize = Math.max(MIN_BATCH_SIZE, adapter.maxBatchSize);
  const embeddings: number[][] = [];

  for (let start = 0; start < request.inputs.length; start += batchSize) {
    const batch = request.inputs.slice(start, start + batchSize);
    const batchEmbeddings = await requestBatchWithPolicy(
      adapter,
      request,
      batch,
      start,
      batch.length,
      options,
    );
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

async function requestBatchWithPolicy(
  adapter: EmbeddingAdapter,
  request: OrderedEmbeddingRequest,
  batch: string[],
  batchStart: number,
  batchSize: number,
  options: OrderedEmbeddingTransportOptions,
): Promise<number[][]> {
  const actualBatch = batch.slice(0, batchSize);
  const diagnostics: EmbeddingDiagnostics = {
    provider: adapter.provider,
    modelId: request.modelId,
    expectedDimensions: request.expectedDimensions,
    requestedDimensions: request.requestedDimensions,
    inputCount: request.inputs.length,
    batchInputCount: actualBatch.length,
    batchStart,
    batchSize: actualBatch.length,
  };

  try {
    return await requestBatchWithRetries(
      adapter,
      request,
      actualBatch,
      diagnostics,
      options,
    );
  } catch (error) {
    if (
      error instanceof EmbeddingFailure &&
      error.code === "request_headers_too_large" &&
      actualBatch.length > MIN_BATCH_SIZE
    ) {
      const midpoint = Math.ceil(actualBatch.length / 2);
      const first = await requestBatchWithPolicy(
        adapter,
        request,
        actualBatch.slice(0, midpoint),
        batchStart,
        midpoint,
        options,
      );
      const second = await requestBatchWithPolicy(
        adapter,
        request,
        actualBatch.slice(midpoint),
        batchStart + midpoint,
        actualBatch.length - midpoint,
        options,
      );
      return [...first, ...second];
    }
    throw error;
  }
}

async function requestBatchWithRetries(
  adapter: EmbeddingAdapter,
  request: OrderedEmbeddingRequest,
  batch: string[],
  diagnostics: EmbeddingDiagnostics,
  options: OrderedEmbeddingTransportOptions,
): Promise<number[][]> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = options.sleep ?? ((delayMs) => wait(delayMs));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await adapter.embedBatch({
        inputs: batch,
        modelId: request.modelId,
        dimensions: request.requestedDimensions,
        abortSignal: request.abortSignal,
        diagnostics: {
          ...diagnostics,
          attempt,
          maxAttempts,
        },
      });
      return orderAndValidateEmbeddingItems(response.items, {
        ...diagnostics,
        ...response.diagnostics,
        attempt,
        maxAttempts,
        responseItemCount: response.items.length,
      });
    } catch (error) {
      const failure = normalizeEmbeddingFailure(error, {
        ...diagnostics,
        attempt,
        maxAttempts,
      });
      if (!failure.retryable || attempt >= maxAttempts) {
        throw failure;
      }
      if (failure.code === "request_headers_too_large") {
        throw failure;
      }

      await sleep(getBackoffDelay(options.baseDelayMs, attempt));
    }
  }

  throw new EmbeddingFailure(
    "request_failed",
    "Embedding request failed after all retry attempts",
    diagnostics,
    { retryable: false },
  );
}

function orderAndValidateEmbeddingItems(
  items: EmbeddingAdapterItem[],
  diagnostics: EmbeddingDiagnostics,
): number[][] {
  if (!Array.isArray(items) || items.length !== diagnostics.batchInputCount) {
    throw new EmbeddingFailure(
      "invalid_response",
      `Invalid embeddings response: expected ${diagnostics.batchInputCount} embeddings, got ${Array.isArray(items) ? items.length : "non-array"}`,
      diagnostics,
      { retryable: false },
    );
  }

  const seen = new Set<number>();
  const ordered = new Array<number[]>(items.length);
  for (const item of items) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= items.length ||
      seen.has(item.index)
    ) {
      throw new EmbeddingFailure(
        "response_ordering",
        `Invalid embeddings response ordering: received index ${String(item.index)}`,
        diagnostics,
        { retryable: false },
      );
    }
    seen.add(item.index);
    ordered[item.index] = item.embedding;
  }

  ordered.forEach((embedding, index) => {
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new EmbeddingFailure(
        "invalid_response",
        `Invalid embedding ${index}: expected array with ${diagnostics.expectedDimensions} dimensions, got ${Array.isArray(embedding) ? embedding.length : "non-array"}`,
        diagnostics,
        { retryable: false },
      );
    }
    if (embedding.length !== diagnostics.expectedDimensions) {
      throw new EmbeddingFailure(
        "dimension_mismatch",
        `Invalid embedding ${index} dimensions: expected ${diagnostics.expectedDimensions}, got ${embedding.length}`,
        diagnostics,
        { retryable: false },
      );
    }
  });

  return ordered;
}

function normalizeEmbeddingFailure(
  error: unknown,
  diagnostics: EmbeddingDiagnostics,
): EmbeddingFailure {
  if (error instanceof EmbeddingFailure) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EmbeddingFailure("request_failed", message, diagnostics, {
    retryable: isRetryableEmbeddingMessage(message),
    cause: error,
  });
}

function getBackoffDelay(baseDelayMs: number | undefined, attempt: number) {
  const base = baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  return base * 2 ** Math.max(0, attempt - 1);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableEmbeddingFailure(error: unknown): boolean {
  if (error instanceof EmbeddingFailure) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return isRetryableEmbeddingMessage(message);
}

function isRetryableEmbeddingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "timeout",
    "timed out",
    "network",
    "socket",
    "connection reset",
    "econnreset",
    "rate limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
  ].some((hint) => lower.includes(hint));
}

export interface OpenAIEmbeddingAdapterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  url?: string;
  maxBatchSize?: number;
}

type OpenAIEmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
};

type OpenAIErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    param?: string | null;
    code?: string | null;
  };
};

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_API_KEY_MAX_SAFE_LENGTH = 512;
const OPENAI_DEFAULT_MAX_BATCH_SIZE = 64;

export function createOpenAIEmbeddingAdapter(
  options: OpenAIEmbeddingAdapterOptions,
): EmbeddingAdapter {
  const apiKey = normalizeOpenAIApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? OPENAI_EMBEDDINGS_URL;

  return {
    provider: "openai",
    maxBatchSize: options.maxBatchSize ?? OPENAI_DEFAULT_MAX_BATCH_SIZE,
    async embedBatch(request) {
      const requestHeaders = new Headers({
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      });
      const requestBody = JSON.stringify({
        model: request.modelId,
        input: request.inputs,
        encoding_format: "float",
        ...(request.dimensions ? { dimensions: request.dimensions } : {}),
      });

      const response = await fetchImpl(url, {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
        signal: request.abortSignal,
      });
      const responseText = await response.text();
      const parsed = parseJson(responseText);
      const requestHeaderBytes = estimateHeaderByteSize(requestHeaders);

      if (!response.ok) {
        const error = (parsed as OpenAIErrorResponse | undefined)?.error;
        const code =
          response.status === 431
            ? "request_headers_too_large"
            : "request_failed";
        throw new EmbeddingFailure(
          code,
          [
            `OpenAI embeddings request failed with status ${response.status}`,
            error?.code ? `code=${error.code}` : undefined,
            error?.type ? `type=${error.type}` : undefined,
            `message=${error?.message ?? responseText.slice(0, 500)}`,
          ]
            .filter(Boolean)
            .join("; "),
          {
            ...request.diagnostics,
            status: response.status,
            requestHeaderBytes,
            requestBodyChars: requestBody.length,
            responseTextPreview: responseText.slice(0, 500),
          },
          { retryable: isRetryableStatus(response.status) },
        );
      }

      const data = (parsed as OpenAIEmbeddingResponse | undefined)?.data;
      if (!Array.isArray(data)) {
        throw new EmbeddingFailure(
          "invalid_response",
          "Invalid OpenAI embeddings response: data is not an array",
          {
            ...request.diagnostics,
            requestHeaderBytes,
            requestBodyChars: requestBody.length,
            responseTextPreview: responseText.slice(0, 500),
          },
          { retryable: false },
        );
      }

      return {
        items: data.map((item, index) => ({
          index: item.index ?? index,
          embedding: item.embedding ?? [],
        })),
        diagnostics: {
          requestHeaderBytes,
          requestBodyChars: requestBody.length,
        },
      };
    },
  };
}

export function normalizeOpenAIApiKey(apiKey: string | undefined): string {
  const trimmed = apiKey?.trim();

  if (!trimmed) {
    throw new EmbeddingFailure(
      "provider_unavailable",
      "OPENAI_API_KEY is required for OpenAI embeddings",
      {
        provider: "openai",
        modelId: "unknown",
        expectedDimensions: 0,
        inputCount: 0,
      },
      { retryable: false },
    );
  }

  if (!trimmed.startsWith("sk-")) {
    throw new EmbeddingFailure(
      "provider_unavailable",
      "OPENAI_API_KEY appears malformed: expected an OpenAI key starting with 'sk-'. Check the Worker secret/local .env value.",
      {
        provider: "openai",
        modelId: "unknown",
        expectedDimensions: 0,
        inputCount: 0,
      },
      { retryable: false },
    );
  }

  if (/\s/.test(trimmed) || trimmed.length > OPENAI_API_KEY_MAX_SAFE_LENGTH) {
    throw new EmbeddingFailure(
      "provider_unavailable",
      `OPENAI_API_KEY appears malformed (${trimmed.length} characters). Oversized or multiline API keys can cause OpenAI 431 request_headers_too_large errors.`,
      {
        provider: "openai",
        modelId: "unknown",
        expectedDimensions: 0,
        inputCount: 0,
      },
      { retryable: false },
    );
  }

  return trimmed;
}

function estimateHeaderByteSize(headers: Headers): number {
  let size = 0;
  headers.forEach((value, key) => {
    size += key.length + value.length + 4;
  });
  return size;
}

function parseJson(responseText: string): unknown {
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 431 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export interface WorkersAIEmbeddingAdapterOptions {
  ai: {
    run: (
      modelId: string,
      input: { text: string[] },
      options?: Record<string, unknown>,
    ) => Promise<{ data?: number[][] } | unknown>;
  };
  gatewayId?: string;
  maxBatchSize?: number;
}

export function createWorkersAIEmbeddingAdapter(
  options: WorkersAIEmbeddingAdapterOptions,
): EmbeddingAdapter {
  return {
    provider: "cloudflare-workers-ai",
    maxBatchSize: options.maxBatchSize ?? 64,
    async embedBatch(request) {
      const aiOptions = options.gatewayId
        ? { gateway: { id: options.gatewayId } }
        : undefined;
      const response = await options.ai.run(
        request.modelId,
        { text: request.inputs },
        aiOptions,
      );
      const data = (response as { data?: number[][] }).data;
      if (!Array.isArray(data)) {
        throw new EmbeddingFailure(
          "invalid_response",
          "Invalid Workers AI embeddings response: data is not an array",
          request.diagnostics,
          { retryable: false },
        );
      }
      return {
        items: data.map((embedding, index) => ({ index, embedding })),
      };
    },
  };
}
