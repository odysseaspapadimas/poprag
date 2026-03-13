# Vectorize Experience Filter Checklist

Repo-specific checklist for making experience-scoped retrieval reliable with Cloudflare Vectorize.

Current repo facts:
- Vectorize binding: `VECTORIZE`
- Vectorize index name: `rag`
- Embedding dimensions: `768`
- Vector namespace strategy: `namespace = agentId`
- Experience scoping field: `metadata.sourceId`
- Existing fallback logic lives in `src/lib/ai/embedding.ts`
- Existing queue-based reindex flow already exists via `src/integrations/trpc/router/knowledge.ts`

---

## Phase 0 - Verify current state

- [ ] Confirm the current Vectorize index exists:
  ```bash
  npx wrangler vectorize list
  ```
- [ ] Confirm the repo is still bound to index `rag` in `wrangler.jsonc`.
- [ ] Check whether `sourceId` already has a metadata index:
  ```bash
  npx wrangler vectorize list-metadata-index rag
  ```
- [ ] If the command shows no `sourceId` index, mark metadata filtering as unavailable.
- [ ] If the command fails because the index is too old / incompatible, plan a new index migration instead of relying on filters.

---

## Phase 1 - Stabilize runtime behavior

### `src/lib/ai/embedding.ts`

- [ ] Keep the current unfiltered fallback for experience-scoped retrieval.
- [ ] Add a cached capability flag for `sourceId` filtering so the app does not blindly issue filtered queries every time.
- [ ] When capability is unknown or unavailable, skip direct filter queries and go straight to broad namespace search + app-side `sourceId` filtering.
- [ ] Increase fallback candidate count only for experience-scoped broad queries.
- [ ] Replace `returnMetadata: "all"` with `returnMetadata: "indexed"` or `"none"` where full metadata is not required.
- [ ] Update logs to distinguish these cases clearly:
  - `vector_filter_applied`
  - `vector_filter_skipped_no_metadata_index`
  - `vector_filter_zero_results_fallback_used`

### `src/lib/ai/rag-pipeline.ts`

- [ ] Keep passing `experienceKnowledgeIds` into vector retrieval.
- [ ] Make fallback over-fetch size explicit and configurable.
- [ ] Log whether final vector candidates came from:
  - direct filtered query
  - broad namespace query
  - broad query plus app-side post-filtering

### Acceptance check

- [ ] A vague first-turn query like `τι περιεχομενο εχει το βιβλιο;` returns candidates even when `sourceId` metadata indexing is not ready.

---

## Phase 2 - Enable proper metadata filtering

### Cloudflare setup

- [ ] Create a metadata index on `sourceId` for the `rag` index:
  ```bash
  npx wrangler vectorize create-metadata-index rag --property-name=sourceId --type=string
  ```
- [ ] Wait a few seconds, then verify it exists:
  ```bash
  npx wrangler vectorize list-metadata-index rag
  ```
- [ ] Document the exact output in an ops note or runbook.

### Important constraint

- [ ] Assume existing vectors are not filterable yet even after metadata index creation.
- [ ] Plan a re-upsert / reindex pass for all knowledge sources whose vectors were inserted before the metadata index existed.

---

## Phase 3 - Backfill existing vectors

### Existing repo capabilities

- [ ] Use the existing reindex path in `src/integrations/trpc/router/knowledge.ts`.
- [ ] Reuse `bulkReindex` for admin-triggered backfill through the UI where possible.
- [ ] Confirm queue processing still deletes old vectors and rebuilds fresh ones in `src/lib/ai/queue-consumer.ts` and `src/lib/ai/ingestion.ts`.

### Recommended additions

- [ ] Add a dedicated admin script or runbook for reindexing all knowledge sources after metadata-index creation.
- [ ] If needed, add a bulk reindex-by-agent action so one agent can be backfilled without selecting every source manually.
- [ ] Prefer `upsert` semantics for future-proof backfill paths when overwriting existing vector IDs is desired.

### Backfill validation

- [ ] Pick one experience with a single knowledge source.
- [ ] Reindex that source.
- [ ] Run the same filtered query again and verify Vectorize now returns non-zero raw results before fallback.
- [ ] Confirm logs no longer show the fallback path for that source.

---

## Phase 4 - Improve diagnostics and health checks

### `src/lib/ai/vectorize-utils.ts`

- [ ] Add helper to document or infer whether metadata filtering is configured.
- [ ] Add helper output for current index name and `processedUpToMutation`.
- [ ] Add optional diagnostic query mode for:
  - namespace-only query
  - filtered query by `sourceId`
  - broad query followed by app-side filter

### Admin / ops workflow

- [ ] Add a short Vectorize ops runbook under `docs/` covering:
  - list index
  - list metadata indexes
  - create metadata index
  - backfill existing vectors
  - validate filtered queries
- [ ] Surface a warning in admin tooling when `sourceId` metadata filtering is expected but not configured.

### Nice-to-have

- [ ] Add a lightweight health endpoint or admin mutation that reports:
  - current index name
  - metadata index presence for `sourceId`
  - whether fallback mode is currently active

---

## Phase 5 - Decide long-term partitioning strategy

### Option A: Stay with current design

- [ ] Keep `namespace = agentId`.
- [ ] Keep experiences as metadata/D1-level scoping by `sourceId`.
- [ ] Use metadata indexing for precise source-level filtering.

Use this if:
- one agent can have many sources
- experiences are dynamic
- future filtering may involve more than one attribute

### Option B: Introduce stricter namespace partitioning

- [ ] Evaluate whether experience-specific namespaces would reduce fallback needs.
- [ ] Prototype a namespace scheme like `agentId:experienceId` only if each vector belongs to exactly one experience.
- [ ] Check namespace count and operational complexity before migrating.

Use this if:
- nearly every query is scoped to a single experience
- hard isolation matters more than flexible filtering

---

## Suggested code tasks by file

### `src/lib/ai/embedding.ts`
- [ ] Add filter capability cache.
- [ ] Add clearer search mode logging.
- [ ] Reduce metadata return payload.
- [ ] Keep fallback over-fetch logic bounded.

### `src/lib/ai/rag-pipeline.ts`
- [ ] Track retrieval mode in debug info.
- [ ] Expose whether experience filtering was direct or fallback-based.

### `src/lib/ai/ingestion.ts`
- [ ] Review whether insert vs upsert is the right default for future backfills.
- [ ] Keep Vectorize metadata minimal: `sourceId`, `chunkId`, maybe `fileName` only if operationally useful.

### `src/integrations/trpc/router/knowledge.ts`
- [ ] Add bulk reindex-by-agent or backfill helper if manual selection is too slow.
- [ ] Consider an admin-only mutation that triggers metadata-filter backfill after index changes.

### `src/lib/ai/vectorize-utils.ts`
- [ ] Add metadata-index diagnostics.
- [ ] Add experience-filter test helper.

---

## Command checklist

- [ ] List indexes:
  ```bash
  npx wrangler vectorize list
  ```
- [ ] List metadata indexes:
  ```bash
  npx wrangler vectorize list-metadata-index rag
  ```
- [ ] Create `sourceId` metadata index:
  ```bash
  npx wrangler vectorize create-metadata-index rag --property-name=sourceId --type=string
  ```
- [ ] Reindex affected knowledge sources through existing UI / tRPC bulk reindex flow.

---

## Done criteria

- [ ] Generic first-turn experience questions retrieve relevant chunks.
- [ ] Filtered Vectorize queries work for reindexed sources without fallback.
- [ ] Logs clearly show whether retrieval used direct filter or fallback mode.
- [ ] Admins can verify metadata-index presence without reading source code.
- [ ] The reindex/backfill workflow is documented and repeatable.
