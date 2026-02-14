/**
 * AI Model Constants
 * Centralized configuration for default model IDs used across the application
 */

/**
 * Default model IDs
 * These are used as fallbacks when no specific model is configured
 */
export const DEFAULT_MODELS = {
  /** Model used for intent classification (determining if RAG is needed) */
  INTENT_CLASSIFICATION: "@cf/meta/llama-3.1-8b-instruct-fast",

  /** Model used for query rewriting to improve search coverage
   * Using 3B model since rewriting is a simple task (rephrasing + keyword extraction)
   * and 8B was causing 3-5s latency on Workers AI */
  QUERY_REWRITE: "@cf/meta/llama-3.2-3b-instruct",

  /** Model used for conversational query reformulation (CQR)
   * Resolves pronouns, references, and ellipsis in follow-up questions
   * Using 3B model — same as rewrite, simple reformulation task */
  CONVERSATIONAL_REFORMULATION: "@cf/meta/llama-3.2-3b-instruct",

  /** Embedding model for vector search (768 Matryoshka dimensions) - OpenAI */
  EMBEDDING: "text-embedding-3-small",

  /** Cross-encoder model for reranking search results */
  RERANKER: "@cf/baai/bge-reranker-base",

  /** Model used to generate contextual embeddings during ingestion */
  CONTEXTUAL_EMBEDDING: "@cf/meta/llama-3.1-8b-instruct-fast",
} as const;

/**
 * Embedding configuration
 * Platform-wide constant - all agents use the same embedding model
 */
export const EMBEDDING_CONFIG = {
  /**
   * Dimensions for OpenAI text-embedding-3-small (Matryoshka reduction)
   * Native: 1536, reduced to 768 for ~20-40% faster Vectorize queries
   * with <0.5% accuracy loss on MTEB (62.3 -> ~62.0)
   */
  DIMENSIONS: 768,

  /** Cloudflare Vectorize metadata size limit (bytes) with buffer */
  VECTORIZE_METADATA_LIMIT: 2800,
} as const;

/**
 * Chunking configuration defaults
 */
export const CHUNKING_CONFIG = {
  /** Default chunk size in characters */
  CHUNK_SIZE: 1024,

  /** Overlap between chunks to maintain context */
  CHUNK_OVERLAP: 200,

  /** Minimum chunk size to filter out tiny fragments */
  MIN_CHUNK_SIZE: 100,

  /** Maximum chunk size for Vectorize metadata limits */
  MAX_CHUNK_SIZE: 2000,
} as const;

/**
 * RAG search configuration defaults
 */
export const RAG_CONFIG = {
  /** Default number of results to return */
  TOP_K: 6,

  /**
   * Minimum absolute similarity score for vector search results
   * OpenAI text-embedding-3-small produces lower scores than BGE models
   * Typical range: 0.15-0.40 for relevant content
   */
  MIN_SIMILARITY: 0.15,

  /**
   * Relative score threshold - results must be within this ratio of the top score
   * E.g., 0.6 means results must have score >= topScore * 0.6
   * This adapts to the query's natural score distribution
   */
  RELATIVE_SCORE_THRESHOLD: 0.6,

  /** K parameter for reciprocal rank fusion */
  RRF_K: 60,
} as const;

/**
 * Provider type constants
 */
export type ProviderType =
  | "openai"
  | "openrouter"
  | "huggingface"
  | "cloudflare-workers-ai";

export const DEFAULT_PROVIDER: ProviderType = "cloudflare-workers-ai";
