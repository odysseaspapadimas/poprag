import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { extractText, getDocumentProxy } from "unpdf";
import { db } from "@/db";
import {
  documentChunks,
  type InsertKnowledgeSource,
  knowledgeSource,
} from "@/db/schema";
import { CHUNKING_CONFIG, DEFAULT_MODELS } from "@/lib/ai/constants";
import { generateChunks, generateEmbeddings } from "@/lib/ai/embedding";

/**
 * Utility to split an array into chunks of specified size
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const VECTORIZE_DELETE_BATCH_SIZE = 100;
const D1_INSERT_BATCH_SIZE = 10; // D1 has ~100 param limit; 10 chunks * 7 fields = 70 params
const EMBEDDING_BATCH_SIZE = 20;
const LARGE_DOCUMENT_STREAMING_THRESHOLD_CHARS = 1_000_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
const INDEXING_PROGRESS = {
  PARSING: 5,
  PARSING_COMPLETE: 12,
  CHUNKS_READY: 20,
  INDEXING_START: 25,
  INDEXING_END: 92,
  FINALIZING: 97,
  COMPLETE: 100,
} as const;

type KnowledgeSourceIndexStatus =
  | "uploaded"
  | "parsed"
  | "processing"
  | "indexed"
  | "failed";

const RESOURCE_ERROR_HINTS = [
  "out of memory",
  "memory limit",
  "memory quota",
  "insufficient memory",
  "resource exhausted",
  "resources exhausted",
  "worker exceeded memory",
  "heap out of memory",
  "allocation failed",
  "oom",
];

const RETRYABLE_ERROR_HINTS = [
  "terminated",
  "abort",
  "aborted",
  "timeout",
  "timed out",
  "socket",
  "network",
  "connection reset",
  "econnreset",
  "temporarily unavailable",
  "service unavailable",
  "internal error",
  "rate limit",
  "too many requests",
  "429",
  "503",
  ...RESOURCE_ERROR_HINTS,
];

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function getBatchIndexingProgress(
  processedChunks: number,
  totalChunksEstimate: number,
): number {
  const denominator = Math.max(totalChunksEstimate, processedChunks, 1);
  const ratio = processedChunks / denominator;

  return (
    INDEXING_PROGRESS.INDEXING_START +
    ratio * (INDEXING_PROGRESS.INDEXING_END - INDEXING_PROGRESS.INDEXING_START)
  );
}

function describeRetryableFailure(error: unknown): string {
  const message = getErrorMessage(error).toLowerCase();

  if (isResourceExhaustionError(error)) {
    return "resource pressure";
  }

  if (message.includes("timeout") || message.includes("timed out")) {
    return "a timeout";
  }

  if (
    message.includes("socket") ||
    message.includes("network") ||
    message.includes("connection reset") ||
    message.includes("econnreset")
  ) {
    return "a network issue";
  }

  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429")
  ) {
    return "rate limiting";
  }

  return "a transient failure";
}

async function updateKnowledgeSourceIndexState(
  sourceId: string,
  update: {
    status?: KnowledgeSourceIndexStatus;
    progress?: number;
    progressMessage?: string | null;
    parserErrors?: string[];
    vectorizeIds?: string[] | null;
    retryCount?: number;
  },
): Promise<void> {
  const payload: {
    status?: KnowledgeSourceIndexStatus;
    progress?: number;
    progressMessage?: string | null;
    parserErrors?: string[];
    vectorizeIds?: string[] | null;
    retryCount?: number;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };

  if (update.status !== undefined) {
    payload.status = update.status;
  }

  if (update.progress !== undefined) {
    payload.progress = Math.round(clampProgress(update.progress));
  }

  if (update.progressMessage !== undefined) {
    payload.progressMessage = update.progressMessage;
  }

  if (update.parserErrors !== undefined) {
    payload.parserErrors = update.parserErrors;
  }

  if (update.vectorizeIds !== undefined) {
    payload.vectorizeIds = update.vectorizeIds;
  }

  if (update.retryCount !== undefined) {
    payload.retryCount = update.retryCount;
  }

  await db
    .update(knowledgeSource)
    .set(payload)
    .where(eq(knowledgeSource.id, sourceId));
}

function estimateChunkCount(
  inputLength: number,
  chunkSize: number,
  chunkOverlap: number,
): number {
  const safeChunkSize = Math.max(1, chunkSize);
  const safeOverlap = Math.max(0, Math.min(chunkOverlap, safeChunkSize - 1));
  const step = Math.max(1, safeChunkSize - safeOverlap);

  if (inputLength <= 0) return 0;

  return Math.max(1, Math.ceil((inputLength - safeChunkSize) / step) + 1);
}

function* streamChunkBatches(
  input: string,
  options: {
    chunkSize: number;
    chunkOverlap: number;
    minChunkSize: number;
    batchSize: number;
  },
): Generator<string[]> {
  const safeChunkSize = Math.max(1, options.chunkSize);
  const safeOverlap = Math.max(
    0,
    Math.min(options.chunkOverlap, safeChunkSize - 1),
  );
  const step = Math.max(1, safeChunkSize - safeOverlap);

  let cursor = 0;
  let batch: string[] = [];

  while (cursor < input.length) {
    const end = Math.min(input.length, cursor + safeChunkSize);
    const chunk = input.slice(cursor, end).trim();

    if (chunk.length >= options.minChunkSize) {
      batch.push(chunk);
      if (batch.length >= options.batchSize) {
        yield batch;
        batch = [];
      }
    }

    if (end >= input.length) {
      break;
    }

    cursor += step;
  }

  if (batch.length > 0) {
    yield batch;
  }
}

export function isResourceExhaustionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return RESOURCE_ERROR_HINTS.some((hint) => message.includes(hint));
}

export function isRetryableIngestionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return RETRYABLE_ERROR_HINTS.some((hint) => message.includes(hint));
}

export function normalizeKnowledgeIngestionError(error: unknown): string {
  const errorMessage = getErrorMessage(error);
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes("maximum context length")) {
    return `${errorMessage} Try reindexing after reducing chunk size.`;
  }

  if (isResourceExhaustionError(error)) {
    return `${errorMessage} Automatic retries were exhausted; try reindexing again or split the file into smaller parts.`;
  }

  return errorMessage;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    throw abortError;
  }
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options?: {
    retries?: number;
    baseDelayMs?: number;
    label?: string;
    abortSignal?: AbortSignal;
    onRetry?: (details: {
      failedAttempt: number;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      error: unknown;
      label?: string;
    }) => Promise<void> | void;
  },
): Promise<T> {
  const retries = options?.retries ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    assertNotAborted(options?.abortSignal);

    try {
      return await operation();
    } catch (error) {
      if (!isRetryableIngestionError(error) || attempt >= retries) {
        throw error;
      }

      const backoff =
        baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
      console.warn(
        `[Ingestion] ${options?.label ?? "operation"} failed (attempt ${
          attempt + 1
        }/${retries + 1}). Retrying in ${backoff}ms...`,
        error,
      );
      await options?.onRetry?.({
        failedAttempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts: retries + 1,
        delayMs: backoff,
        error,
        label: options?.label,
      });
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new Error("Retry attempts exhausted");
}

export async function deleteVectorizeIds(
  vectorize: {
    deleteByIds: (ids: string[]) => Promise<{ mutationId: string }>;
  },
  ids: string[],
  options?: {
    namespace?: string;
    logPrefix?: string;
  },
): Promise<void> {
  const batches = chunkArray(ids, VECTORIZE_DELETE_BATCH_SIZE);
  // Run deletion batches concurrently - they are independent operations
  await Promise.all(
    batches.map(async (batch, i) => {
      if (batch.length === 0) return;

      const deleteResult = await vectorize.deleteByIds(batch);
      console.log(
        `${options?.logPrefix ?? "Vectorize"} deleted batch ${i + 1}/${batches.length} (${batch.length} ids)` +
          (options?.namespace ? ` in namespace ${options.namespace}` : "") +
          `, mutationId: ${deleteResult.mutationId}`,
      );
    }),
  );
}

/**
 * Stream response callback type for progress updates
 */
export type StreamResponseCallback = (message: {
  message?: string;
  progress?: number;
  error?: string;
  [key: string]: unknown;
}) => Promise<void>;

/**
 * Wait for a Vectorize mutation to be processed
 */
export async function waitForMutation(
  vectorize: { describe: () => Promise<{ processedUpToMutation: number }> },
  mutationId: string,
  maxWaitMs: number = 30000,
  pollIntervalMs: number = 1000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const status = await vectorize.describe();
      if (status.processedUpToMutation >= Number.parseInt(mutationId, 10)) {
        console.log(`Mutation ${mutationId} processed successfully`);
        return;
      }
    } catch (error) {
      console.warn(`Error checking mutation status: ${error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Mutation ${mutationId} did not complete within ${maxWaitMs}ms`,
  );
}
export async function checkMutationStatus(
  vectorize: { describe: () => Promise<{ processedUpToMutation: number }> },
  mutationId: string,
): Promise<boolean> {
  try {
    const status = await vectorize.describe();
    return status.processedUpToMutation >= Number.parseInt(mutationId, 10);
  } catch (error) {
    console.error(`Error checking mutation status: ${error}`);
    return false;
  }
}

export interface ParsedDocument {
  content: string;
  metadata: Record<string, unknown>;
  chunks?: Array<{
    text: string;
    metadata: Record<string, unknown>;
  }>;
}

type DelimitedFormat = "csv" | "tsv";

function parseDelimitedRows(input: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function cleanDelimitedCell(value: string): string {
  const trimmed = value.replaceAll("\u0000", "").replaceAll("\r", "").trim();
  if (!trimmed) return "";

  const normalized = trimmed
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lower = normalized.replace(/\s+/g, " ").toLowerCase();
  if (lower === "n/a" || lower === "na" || lower === "null") {
    return "";
  }

  return normalized;
}

function containsLetter(value: string): boolean {
  return /\p{L}/u.test(value);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function splitLongDelimitedSection(
  value: string,
  maxSectionLength: number = 900,
): string[] {
  if (value.length <= maxSectionLength) {
    return [value];
  }

  const stepParts = value
    .split(/(?=\b\d+\.\s)/)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidateParts = stepParts.length > 1 ? stepParts : [value];

  const chunks: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
  };

  for (const part of candidateParts) {
    if (part.length > maxSectionLength) {
      flushCurrent();
      let cursor = 0;
      while (cursor < part.length) {
        const end = Math.min(cursor + maxSectionLength, part.length);
        chunks.push(part.slice(cursor, end).trim());
        cursor = end;
      }
      continue;
    }

    if (!current) {
      current = part;
      continue;
    }

    if (current.length + 1 + part.length <= maxSectionLength) {
      current = `${current}\n${part}`;
      continue;
    }

    flushCurrent();
    current = part;
  }

  flushCurrent();

  return chunks.filter(Boolean);
}

type DelimitedColumn = {
  index: number;
  label: string;
};

function buildDelimitedColumns(headerRow: string[]): DelimitedColumn[] {
  const labelCounts = new Map<string, number>();

  return headerRow.map((rawHeader, index) => {
    const cleaned = cleanDelimitedCell(rawHeader).replace(/\n+/g, " ").trim();
    const baseLabel = cleaned || `Column ${index + 1}`;
    const key = baseLabel.toLowerCase();
    const seen = labelCounts.get(key) ?? 0;
    labelCounts.set(key, seen + 1);

    return {
      index,
      label: seen === 0 ? baseLabel : `${baseLabel} (${seen + 1})`,
    };
  });
}

function toDelimitedFieldKey(label: string): string {
  const normalized = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "column";
}

function splitDelimitedSections(value: string): string[] {
  const normalized = value
    .replaceAll("\r", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return [];

  const sections = normalized
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections.length > 0 ? sections : [normalized];
}

function parseDelimitedDocument(
  text: string,
  format: DelimitedFormat,
  mimeType: string,
): ParsedDocument {
  const delimiter = format === "tsv" ? "\t" : ",";
  const rows = parseDelimitedRows(text, delimiter);

  if (rows.length <= 1) {
    return {
      content: text,
      metadata: {
        mimeType,
        type: "text",
        format,
        originalLength: text.length,
        structuredRows: 0,
      },
    };
  }

  const columns = buildDelimitedColumns(rows[0]);

  const structuredChunks: ParsedDocument["chunks"] = [];

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx += 1) {
    const row = rows[rowIdx];
    if (!row || row.length === 0) continue;

    const rowCells = columns
      .map((column) => {
        const rawValue = row[column.index] || "";
        const value = cleanDelimitedCell(rawValue);
        return {
          index: column.index,
          label: column.label,
          value,
          fieldKey: toDelimitedFieldKey(column.label),
          compactValue: value.replace(/\s+/g, " ").trim(),
        };
      })
      .filter((cell) => cell.value.length > 0);

    const meaningfulCells = rowCells.filter((cell) => {
      if (!cell.compactValue) return false;
      if (/^https?:\/\//i.test(cell.compactValue)) return false;

      const alnumCount = (cell.compactValue.match(/[\p{L}\p{N}]/gu) || [])
        .length;
      return containsLetter(cell.compactValue) || alnumCount >= 10;
    });

    if (meaningfulCells.length === 0) continue;

    const anchorCell =
      meaningfulCells.find(
        (cell) =>
          containsLetter(cell.compactValue) && cell.compactValue.length <= 140,
      ) ||
      meaningfulCells.find((cell) => containsLetter(cell.compactValue)) ||
      meaningfulCells[0];

    const anchorValue = truncateSingleLine(anchorCell.compactValue, 140);
    const recordAnchor = `${anchorCell.label}: ${anchorValue}`;

    const pushChunk = (
      text: string,
      field: string,
      sectionIndex?: number,
    ): void => {
      const chunkText = text.trim();
      if (!chunkText) return;
      structuredChunks.push({
        text: chunkText,
        metadata: {
          rowIndex: rowIdx,
          format,
          field,
          sectionIndex,
        },
      });
    };

    const overviewCandidates = meaningfulCells
      .filter((cell) => cell.index !== anchorCell.index)
      .sort((a, b) => a.compactValue.length - b.compactValue.length)
      .slice(0, 2);

    const overviewParts = [`Record: ${recordAnchor}`];
    overviewCandidates.forEach((cell) => {
      overviewParts.push(
        `${cell.label}: ${truncateSingleLine(cell.compactValue, 220)}`,
      );
    });
    pushChunk(overviewParts.join("\n"), "overview");

    meaningfulCells.forEach((cell) => {
      if (cell.index === anchorCell.index && cell.compactValue.length <= 120) {
        return;
      }

      const sections = splitDelimitedSections(cell.value).flatMap((section) =>
        splitLongDelimitedSection(section),
      );

      sections.forEach((segment, sectionIndex) => {
        const chunkText = `Record: ${recordAnchor}\n${cell.label}: ${segment}`;
        pushChunk(chunkText, cell.fieldKey, sectionIndex);
      });
    });
  }

  const structuredContent = structuredChunks
    .map((chunk) => chunk.text)
    .join("\n\n---\n\n");

  return {
    content: structuredContent || text,
    metadata: {
      mimeType,
      type: "text",
      format,
      originalLength: text.length,
      structuredRows: structuredChunks.length,
      parsedRows: rows.length - 1,
    },
    chunks: structuredChunks,
  };
}

/**
 * Decode binary content to a UTF-8 string.
 * Deferred to avoid eagerly decoding large binary files that don't need text.
 */
function decodeToText(
  content: string | ArrayBuffer | Buffer | Uint8Array,
): string {
  if (typeof content === "string") return content;
  const decoder = new TextDecoder();
  if (content instanceof ArrayBuffer) return decoder.decode(content);
  if (ArrayBuffer.isView(content)) return decoder.decode(content);
  return String(content);
}

function toUint8Array(
  content: string | ArrayBuffer | Buffer | Uint8Array,
): Uint8Array {
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }

  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(
      content.buffer,
      content.byteOffset,
      content.byteLength,
    );
  }

  return new TextEncoder().encode(content);
}

function normalizePdfPageText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasMeaningfulPdfText(text: string): boolean {
  const normalized = text
    .replace(/page\s+\d+/gi, "")
    .replace(/\s+/g, "")
    .trim();
  const letters = normalized.match(/\p{L}/gu) ?? [];
  return letters.length >= 10;
}

async function parsePdfDocument(
  content: ArrayBuffer | Buffer | Uint8Array,
  mimeType: string,
): Promise<ParsedDocument> {
  const pdf = await getDocumentProxy(toUint8Array(content));
  const { totalPages, text } = await extractText(pdf);

  const pageChunks: Array<{
    text: string;
    metadata: Record<string, unknown>;
  }> = [];
  const mergedPages: string[] = [];

  text.forEach((pageText, index) => {
    const normalizedPageText = normalizePdfPageText(pageText);
    if (!hasMeaningfulPdfText(normalizedPageText)) {
      return;
    }

    const pageNumber = index + 1;
    pageChunks.push({
      text: normalizedPageText,
      metadata: {
        pageNumber,
      },
    });
    mergedPages.push(`### Page ${pageNumber}\n${normalizedPageText}`);
  });

  const mergedText = mergedPages.join("\n\n").trim();

  if (!mergedText) {
    throw new Error("PDF text extraction returned no meaningful text");
  }

  return {
    content: mergedText,
    metadata: {
      mimeType,
      type: "text",
      originalLength: mergedText.length,
      totalPages,
      extractedPages: pageChunks.length,
      extractionMethod: "unpdf",
    },
    chunks: pageChunks,
  };
}

async function expandStructuredChunks(
  chunks: NonNullable<ParsedDocument["chunks"]>,
  options: {
    chunkSize: number;
    chunkOverlap: number;
    minChunkSize: number;
    contentType: "markdown" | "text";
  },
): Promise<string[]> {
  const expanded: string[] = [];

  for (const chunk of chunks) {
    const baseText = chunk.text.trim();
    if (!baseText) continue;

    const pageNumber =
      typeof chunk.metadata?.pageNumber === "number"
        ? chunk.metadata.pageNumber
        : undefined;
    const prefix = pageNumber ? `### Page ${pageNumber}` : "";

    if (baseText.length <= options.chunkSize) {
      expanded.push(prefix ? `${prefix}\n${baseText}` : baseText);
      continue;
    }

    const splitChunkSize = Math.max(
      CHUNKING_CONFIG.MIN_CHUNK_SIZE,
      options.chunkSize - prefix.length - (prefix ? 1 : 0),
    );
    const splitOverlap = Math.min(options.chunkOverlap, splitChunkSize - 1);
    const splitChunks = await generateChunks(baseText, {
      chunkSize: splitChunkSize,
      chunkOverlap: splitOverlap,
      minChunkSize: options.minChunkSize,
      contentType: options.contentType,
    });

    expanded.push(
      ...splitChunks.map((part) => (prefix ? `${prefix}\n${part}` : part)),
    );
  }

  return expanded;
}

/**
 * Parse text content from uploaded file
 * Handles plain text, markdown, and various document formats using Cloudflare's toMarkdown service
 */
export async function parseDocument(
  content: string | ArrayBuffer | Buffer | Uint8Array,
  mimeType: string,
  filename?: string,
): Promise<ParsedDocument> {
  const lowerFilename = filename?.toLowerCase();

  if (
    (mimeType === "application/pdf" || lowerFilename?.endsWith(".pdf")) &&
    typeof content !== "string"
  ) {
    try {
      return await parsePdfDocument(content, mimeType);
    } catch (error) {
      console.warn(
        "[Ingestion] unpdf extraction failed for PDF, falling back to toMarkdown:",
        error,
      );
    }
  }

  // Handle CSV/TSV as plain text to preserve original encoding and row layout.
  // Sending delimited text through toMarkdown can corrupt non-Latin characters.
  if (
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values" ||
    lowerFilename?.endsWith(".csv") ||
    lowerFilename?.endsWith(".tsv")
  ) {
    const text = decodeToText(content).replace(/^\uFEFF/, "");
    const format: DelimitedFormat = lowerFilename?.endsWith(".tsv")
      ? "tsv"
      : "csv";
    return parseDelimitedDocument(text, format, mimeType);
  }

  // Handle markdown files — decode to text only when needed
  if (
    mimeType === "text/markdown" ||
    filename?.endsWith(".md") ||
    filename?.endsWith(".markdown")
  ) {
    const text = decodeToText(content);
    return {
      content: text,
      metadata: { mimeType, type: "markdown", originalLength: text.length },
    };
  }

  // Handle plain text — decode to text only when needed
  if (mimeType.startsWith("text/")) {
    const text = decodeToText(content);
    return {
      content: text,
      metadata: { mimeType, type: "text", originalLength: text.length },
    };
  }

  // For binary formats supported by toMarkdown, use Cloudflare's toMarkdown service
  const supportedMimeTypes = [
    // PDF
    "application/pdf",
    // Images
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/svg+xml",
    // HTML
    "text/html",
    // XML
    "application/xml",
    // Microsoft Office
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // Open Document Format
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    // Apple Documents
    "application/vnd.apple.numbers",
  ];

  const supportedExtensions = [
    // PDF
    ".pdf",
    // Images
    ".jpeg",
    ".jpg",
    ".png",
    ".webp",
    ".svg",
    // HTML
    ".html",
    // XML
    ".xml",
    // Microsoft Office
    ".xlsx",
    ".xlsm",
    ".xlsb",
    ".xls",
    ".et",
    ".docx",
    // Open Document Format
    ".ods",
    ".odt",
    // Apple Documents
    ".numbers",
  ];

  const isSupportedFormat =
    supportedMimeTypes.includes(mimeType) ||
    (filename &&
      supportedExtensions.some((ext) => filename.toLowerCase().endsWith(ext)));

  if (isSupportedFormat && typeof content !== "string") {
    try {
      const { env } = await import("cloudflare:workers");
      // Create Blob directly from content — avoids unnecessary Buffer→Uint8Array→slice copies
      // For ArrayBuffer: pass directly. For Buffer/Uint8Array: create a view without copying.
      const blobData =
        content instanceof ArrayBuffer
          ? content
          : new Uint8Array(
              content.buffer as ArrayBuffer,
              content.byteOffset,
              content.byteLength,
            );
      const blob = new Blob([blobData], { type: mimeType });
      const file = { name: filename || "document", blob };

      const result = await env.AI.toMarkdown(file);

      if (result.format === "markdown") {
        return {
          content: result.data,
          metadata: {
            mimeType,
            type: "markdown",
            originalLength: result.data.length,
            tokens: result.tokens,
          },
        };
      } else {
        throw new Error(`toMarkdown failed: ${result.error}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to convert document to markdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // For unsupported formats, treat as text
  const text = decodeToText(content);
  return {
    content: text,
    metadata: { mimeType, type: "text", originalLength: text.length },
  };
}

/**
 * Process and index a knowledge source with streaming updates
 * Full pipeline: parse → chunk → embed → store in Vectorize and D1
 */
export async function processKnowledgeSource(
  sourceId: string,
  content: string | ArrayBuffer | Buffer | Uint8Array,
  options?: {
    chunkSize?: number;
    embeddingBatchSize?: number;
    retryCount?: number;
    persistFailureState?: boolean;
    streamResponse?: StreamResponseCallback;
    abortSignal?: AbortSignal;
  },
) {
  // Get source from database
  const [source] = await db
    .select()
    .from(knowledgeSource)
    .where(eq(knowledgeSource.id, sourceId))
    .limit(1);

  if (!source) {
    throw new Error(`Knowledge source ${sourceId} not found`);
  }

  // Platform-wide embedding model - no per-agent override
  const embeddingModel = DEFAULT_MODELS.EMBEDDING;

  const streamResponse = options?.streamResponse || (async () => {});
  const abortSignal = options?.abortSignal;
  const retryCount = options?.retryCount ?? source.retryCount ?? 0;
  const persistFailureState = options?.persistFailureState ?? true;

  const reportProgress = async (update: {
    status?: KnowledgeSourceIndexStatus;
    progress?: number;
    message?: string;
    parserErrors?: string[];
    vectorizeIds?: string[] | null;
    retryCount?: number;
    chunksProcessed?: number;
    vectorsInserted?: number;
  }) => {
    await updateKnowledgeSourceIndexState(sourceId, {
      status: update.status,
      progress: update.progress,
      progressMessage: update.message,
      parserErrors: update.parserErrors,
      vectorizeIds: update.vectorizeIds,
      retryCount: update.retryCount ?? retryCount,
    });

    await streamResponse({
      status: update.status,
      progress:
        update.progress !== undefined
          ? clampProgress(update.progress)
          : undefined,
      message: update.message,
      parserErrors: update.parserErrors,
      retryCount: update.retryCount ?? retryCount,
      chunksProcessed: update.chunksProcessed,
      vectorsInserted: update.vectorsInserted,
    });
  };

  try {
    const parseMessage =
      retryCount > 0
        ? `Retry ${retryCount}: parsing document with lighter settings`
        : "Parsing document";
    await reportProgress({
      status: "processing",
      progress: INDEXING_PROGRESS.PARSING,
      message: parseMessage,
      parserErrors: [],
    });

    assertNotAborted(abortSignal);
    // Parse document
    const parsed = await parseDocument(
      content,
      source.mime || "text/plain",
      source.fileName || undefined,
    );
    await reportProgress({
      status: "processing",
      progress: INDEXING_PROGRESS.PARSING_COMPLETE,
      message: "Document parsed successfully",
    });

    const contentType =
      parsed.metadata.type === "markdown" ? "markdown" : "text";
    const chunkSize = options?.chunkSize || CHUNKING_CONFIG.CHUNK_SIZE;
    const chunkOverlap = Math.min(
      CHUNKING_CONFIG.CHUNK_OVERLAP,
      Math.max(chunkSize - 1, 0),
    );
    const minChunkSize = CHUNKING_CONFIG.MIN_CHUNK_SIZE;
    const embeddingBatchSize = Math.max(
      1,
      options?.embeddingBatchSize || EMBEDDING_BATCH_SIZE,
    );
    const structuredChunks = parsed.chunks
      ? await expandStructuredChunks(parsed.chunks, {
          chunkSize,
          chunkOverlap,
          minChunkSize,
          contentType,
        })
      : [];
    const hasStructuredChunks = structuredChunks.length > 0;
    const useStreamingChunker =
      !hasStructuredChunks &&
      parsed.content.length >= LARGE_DOCUMENT_STREAMING_THRESHOLD_CHARS;

    let chunkBatchIterator: Iterable<string[]>;
    let totalChunksEstimate = 0;

    assertNotAborted(abortSignal);
    if (hasStructuredChunks) {
      totalChunksEstimate = structuredChunks.length;
      chunkBatchIterator = chunkArray(structuredChunks, embeddingBatchSize);
      await reportProgress({
        status: "processing",
        progress: INDEXING_PROGRESS.CHUNKS_READY,
        message: `Prepared ${structuredChunks.length} structured rows`,
      });
      console.log(
        `[Ingestion] Using structured row chunks for source ${sourceId}: ${structuredChunks.length} rows`,
      );
    } else if (useStreamingChunker) {
      totalChunksEstimate = estimateChunkCount(
        parsed.content.length,
        chunkSize,
        chunkOverlap,
      );
      chunkBatchIterator = streamChunkBatches(parsed.content, {
        chunkSize,
        chunkOverlap,
        minChunkSize,
        batchSize: embeddingBatchSize,
      });

      await reportProgress({
        status: "processing",
        progress: INDEXING_PROGRESS.CHUNKS_READY,
        message: `Large document detected. Streaming chunking (~${totalChunksEstimate} chunks)`,
      });
      console.log(
        `[Ingestion] Using streaming chunker for source ${sourceId}: ${parsed.content.length} chars, estimated ${totalChunksEstimate} chunks`,
      );
    } else {
      const chunks = await generateChunks(parsed.content, {
        chunkSize,
        chunkOverlap,
        minChunkSize,
        contentType,
      });
      totalChunksEstimate = chunks.length;
      await reportProgress({
        status: "processing",
        progress: INDEXING_PROGRESS.CHUNKS_READY,
        message: `Split into ${chunks.length} chunks`,
      });
      console.log(`Generated ${chunks.length} chunks for source ${sourceId}`);
      chunkBatchIterator = chunkArray(chunks, embeddingBatchSize);
    }

    const totalBatchEstimate = Math.max(
      1,
      Math.ceil(Math.max(totalChunksEstimate, 1) / embeddingBatchSize),
    );

    const vectorizeIds: string[] = [];
    const { env } = await import("cloudflare:workers");
    let processedChunks = 0;
    let batchIdx = 0;

    await reportProgress({
      status: "processing",
      progress: INDEXING_PROGRESS.INDEXING_START,
      message:
        totalChunksEstimate > 0
          ? `Starting embeddings for ${totalChunksEstimate} chunks`
          : "Starting embeddings",
    });

    // Process each batch
    for (const batch of chunkBatchIterator) {
      batchIdx += 1;
      assertNotAborted(abortSignal);

      const batchProgress = getBatchIndexingProgress(
        processedChunks,
        totalChunksEstimate,
      );

      // Generate embeddings for this batch using platform-wide model
      const startTime = Date.now();
      const embeddingBatch: number[][] = await withRetry(
        () =>
          generateEmbeddings(batch, {
            model: embeddingModel,
            abortSignal,
          }),
        {
          label: `embedding batch ${batchIdx}`,
          abortSignal,
          onRetry: async ({ nextAttempt, maxAttempts, delayMs, error }) => {
            await reportProgress({
              status: "processing",
              progress: batchProgress,
              message: `Embedding batch ${batchIdx}/${totalBatchEstimate} hit ${describeRetryableFailure(error)}. Retrying ${nextAttempt}/${maxAttempts} in ${Math.ceil(delayMs / 1000)}s`,
            });
          },
        },
      );
      const embeddingTime = Date.now() - startTime;

      console.log(
        `Batch ${batchIdx} embedding took ${embeddingTime}ms for ${batch.length} chunks`,
      );

      // Insert chunks into database in smaller batches to respect D1 parameter limits
      // D1 has a limit of ~100 parameters per query
      // With 7 fields per chunk, we can safely insert 10 chunks at a time (70 params)
      const chunkInsertData = batch.map((chunk, idx) => {
        const chunkId = ulid();
        return {
          id: chunkId,
          text: chunk,
          sessionId: source.agentId,
          documentId: source.id,
          chunkIndex: processedChunks + idx,
          vectorizeId: chunkId, // Set vectorizeId to the chunk ID (used as vector ID)
          createdAt: new Date(),
        };
      });

      const d1Batches = chunkArray(chunkInsertData, D1_INSERT_BATCH_SIZE);

      // Run D1 sub-batch inserts concurrently (they are independent writes)
      const d1InsertResults = await Promise.all(
        d1Batches.map((d1Batch) =>
          db
            .insert(documentChunks)
            .values(d1Batch)
            .returning({ insertedChunkId: documentChunks.id }),
        ),
      );
      const chunkIds = d1InsertResults.flatMap((r) =>
        r.map((row) => row.insertedChunkId),
      );

      vectorizeIds.push(...chunkIds);

      // Insert vectors into VECTORIZE_INDEX with lightweight metadata only
      // Full chunk text is stored in D1 (documentChunks table) and fetched during retrieval
      // by enrichWithFullText() — keeping Vectorize metadata small avoids the 3KB limit
      // and removes the artificial chunk size ceiling
      const vectorizeStartTime = Date.now();
      await withRetry(
        () =>
          env.VECTORIZE.insert(
            embeddingBatch.map((embedding, index) => ({
              id: chunkIds[index],
              values: embedding,
              namespace: source.agentId, // Use agentId for namespace isolation
              metadata: {
                sourceId: source.id,
                chunkId: chunkIds[index],
                fileName: source.fileName || "Unknown source",
              },
            })),
          ),
        {
          label: `vectorize insert batch ${batchIdx}`,
          abortSignal,
          onRetry: async ({ nextAttempt, maxAttempts, delayMs, error }) => {
            await reportProgress({
              status: "processing",
              progress: batchProgress,
              message: `Writing vector batch ${batchIdx}/${totalBatchEstimate} hit ${describeRetryableFailure(error)}. Retrying ${nextAttempt}/${maxAttempts} in ${Math.ceil(delayMs / 1000)}s`,
            });
          },
        },
      );
      const vectorizeTime = Date.now() - vectorizeStartTime;

      console.log(`Batch ${batchIdx} vectorize insert took ${vectorizeTime}ms`);

      processedChunks += batch.length;
      const progressPercent = getBatchIndexingProgress(
        processedChunks,
        totalChunksEstimate,
      );
      const indexedChunkGoal = Math.max(
        totalChunksEstimate,
        processedChunks,
        1,
      );
      await reportProgress({
        status: "processing",
        message: `Indexed ${processedChunks}/${indexedChunkGoal} chunks (batch ${batchIdx}/${totalBatchEstimate})`,
        progress: progressPercent,
        chunksProcessed: processedChunks,
      });

      console.log(
        `Processed batch ${batchIdx}/${totalBatchEstimate}, embedded ${processedChunks} chunks`,
      );
    }

    await reportProgress({
      status: "processing",
      progress: INDEXING_PROGRESS.FINALIZING,
      message: "Finalizing indexed data",
      chunksProcessed: processedChunks,
    });

    // Store vectorize IDs and mark as indexed in a single update
    await reportProgress({
      status: "indexed",
      progress: INDEXING_PROGRESS.COMPLETE,
      message: `Indexed ${processedChunks} chunk${processedChunks === 1 ? "" : "s"}`,
      vectorizeIds: vectorizeIds,
      parserErrors: [],
      chunksProcessed: processedChunks,
      vectorsInserted: vectorizeIds.length,
    });

    return {
      success: true,
      vectorsInserted: vectorizeIds.length,
      chunksProcessed: processedChunks,
    };
  } catch (error) {
    // Log detailed error for debugging
    console.error("Indexing failed - detailed error:", {
      error: error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      sourceId,
      agentId: source?.agentId,
    });

    // Update status to failed
    const normalizedErrorMessage = normalizeKnowledgeIngestionError(error);

    if (persistFailureState) {
      await reportProgress({
        status: "failed",
        message: normalizedErrorMessage,
        parserErrors: [normalizedErrorMessage],
        retryCount,
      });

      await streamResponse({
        error: normalizedErrorMessage,
        retryCount,
      });
    }

    throw error;
  }
}

/**
 * Create knowledge source record
 */
export async function createKnowledgeSource(
  data: Omit<InsertKnowledgeSource, "createdAt" | "updatedAt">,
): Promise<string> {
  const id = data.id || ulid();
  await db.insert(knowledgeSource).values({
    ...data,
    id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * Delete knowledge source from DB, R2, and Vectorize
 */
export async function deleteKnowledgeSource(sourceId: string): Promise<void> {
  // Get source to access R2 key and agent ID
  const [source] = await db
    .select()
    .from(knowledgeSource)
    .where(eq(knowledgeSource.id, sourceId))
    .limit(1);

  if (!source) {
    throw new Error(`Knowledge source ${sourceId} not found`);
  }

  // Delete from Vectorize using stored vectorizeIds
  if (source.vectorizeIds && source.vectorizeIds.length > 0) {
    const { env } = await import("cloudflare:workers");
    try {
      // Delete vectors from agent's namespace
      await deleteVectorizeIds(env.VECTORIZE, source.vectorizeIds, {
        namespace: source.agentId,
        logPrefix: "Vectorize",
      });
    } catch (error) {
      console.error("Failed to delete vectors from Vectorize:", error);
      // Continue with deletion even if Vectorize fails
    }
  }

  // Delete from R2
  if (source.r2Key) {
    try {
      const { env } = await import("cloudflare:workers");
      await env.R2.delete(source.r2Key);
      console.log(`Deleted R2 object: ${source.r2Key}`);
    } catch (error) {
      console.error("Failed to delete from R2:", error);
      // Continue with deletion even if R2 fails
    }
  }

  // Delete from database
  await db.delete(knowledgeSource).where(eq(knowledgeSource.id, sourceId));
}
