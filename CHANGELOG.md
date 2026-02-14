# Changelog

All notable changes to PopRAG will be documented in this file.

## [Unreleased]

### Added (2026-02-14)
- **Source metadata in RAG context**: Each chunk now includes `[Source: filename, Excerpt N of M]` headers in the system prompt, helping the LLM resolve conflicts between sources while not exposing raw filenames to users (`prompt.ts`)
- **Chunk deduplication on re-upload**: SHA-256 checksums computed client-side and checked server-side to automatically delete old versions when the same file is re-uploaded to an agent (`knowledge-upload-dialog.tsx`, `knowledge.ts`)

### Changed (2026-02-14)
- **Removed FTS skip threshold optimization**: FTS now always runs when keywords are available. The previous 0.95 threshold was ineffective due to normalized scores, causing FTS to be skipped in all cases and degrading hybrid search recall. ~5-15ms latency cost for meaningful accuracy improvement (`rag-pipeline.ts`)
- **AI Gateway caching enabled**: Configured via Cloudflare dashboard for instant responses on cached queries (no code changes required)

### Previous Releases
- ✅ Conversational query reformulation (condense-question pattern) - 2026-02-13
- ✅ Consolidated FTS queries into compound OR - 2026-02-13
- ✅ Fixed double D1 fetch in enrichment - 2026-02-13
- ✅ Added grounding instructions to RAG prompt - 2026-02-13
