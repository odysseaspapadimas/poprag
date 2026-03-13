# Vectorize Retrieval Fix Plan

## Context

Current setup:
- vectors are inserted with metadata: `sourceId`, `chunkId`, `fileName`
- `namespace = agentId`
- experience scoping tries to filter by `sourceId`
- filtered Vectorize queries return `0` results
- app currently falls back to broad namespace query + post-filtering in code

Key doc takeaways:
- Metadata filtering only works for fields that have a metadata index.
- Those metadata indexes should be created before vectors are inserted.
- Vectors inserted before a metadata index exists are not retroactively filterable; they must be re-upserted.
- Some older Vectorize indexes cannot support metadata filtering at all and must be replaced.
- Namespace filtering is built-in and is applied before vector search.
- Metadata filtering is also applied before `topK`, so over-restrictive or unsupported filters can wipe out results entirely.
- `returnMetadata: "all"` increases query cost and lowers the practical `topK` ceiling compared with lighter return modes.
- Vector writes become query-visible asynchronously, so ingestion and immediate querying can briefly disagree.

---

## Dynamic fixes

These are short-term runtime fixes that keep the app working even when the Vectorize index is not fully configured.

### 1. Capability-gate metadata filtering
- Do not assume `sourceId` filtering is available.
- Treat filtered Vectorize search as an optimization only when the index is confirmed to support it.
- Otherwise, skip the filter and use broad namespace search plus app-side filtering.

### 2. Keep the current fallback, but make it intentional
- If filtered search returns `0`, retry with a larger unfiltered `topK`.
- Post-filter those results in application code by `sourceId`.
- Log this as `metadata_filter_unavailable_or_unindexed`, not as "no semantic matches".

### 3. Over-fetch only when needed
- For unfiltered experience searches, fetch a larger candidate pool before filtering.
- Keep normal `topK` small for direct namespace-only searches.
- This preserves latency for common cases and improves recall for vague queries.

### 4. Reduce Vectorize payload cost
- Stop using `returnMetadata: "all"` unless it is truly required.
- Prefer `returnMetadata: "indexed"` or `returnMetadata: "none"` if D1 already provides chunk text and filenames.
- This should improve query performance and avoid unnecessary limits.

### 5. Handle write visibility lag
- After ingestion or reindexing, expect a short delay before vectors are queryable.
- Add retries or a temporary "index warming" state in admin/debug flows.

---

## Long-term fixes

These are the durable architectural fixes recommended by the docs.

### 1. Verify whether the current index can support metadata filtering
- Check whether the existing Vectorize index supports metadata filtering at all.
- If it is an older incompatible index, create a new V2 index and reingest everything.

### 2. Create a metadata index for `sourceId`
- Add a Vectorize metadata index on `sourceId`.
- This is the field your experience scoping actually depends on.
- Wait until the metadata index is active before relying on filtered queries.

### 3. Re-upsert existing vectors
- Creating the metadata index is not enough for existing data.
- Re-upsert all existing vectors so their `sourceId` values become filterable.
- This is the step most likely missing right now.

### 4. Formalize scoping strategy
Choose one of these approaches explicitly:

#### Option A: Keep `namespace = agentId` and filter by `sourceId`
Best when:
- one agent contains many knowledge sources
- experience scoping is optional
- you want flexible multi-dimensional filtering later

#### Option B: Use composite namespaces for stricter partitioning
Example:
- `namespace = agentId`
- or `namespace = agentId:experienceId`

Best when:
- queries almost always target a single experience
- hard partitioning is more important than flexible filtering

Tradeoff:
- a vector can only be in one namespace
- metadata is more flexible than namespaces for overlapping groupings

### 5. Add operational checks
- Add admin checks for:
  - metadata indexes present
  - vectors present in expected namespaces
  - vectors re-upserted after metadata index creation
- This turns hidden infra issues into visible health checks.

---

## Recommended implementation in this repo

### `src/lib/ai/embedding.ts`
- Add a cached capability check for whether `sourceId` metadata filtering is enabled.
- Only send `filter: { sourceId: ... }` when that capability is confirmed.
- Keep fallback-to-broad-query behavior for unsupported or empty filtered queries.
- Switch away from `returnMetadata: "all"` if retrieval only needs `id` and maybe indexed fields.

### `src/lib/ai/ingestion.ts`
- Add a re-upsert/backfill path for existing vectors after metadata index creation.
- Ensure this path uses `upsert`, not `insert`, so old vectors become indexed on `sourceId`.

### `src/lib/ai/rag-pipeline.ts`
- Continue passing experience knowledge source IDs into retrieval.
- When broad fallback is used, increase candidate count enough to preserve recall after post-filtering.
- Log whether the result came from:
  - direct filtered Vectorize query
  - namespace-only Vectorize query
  - app-side filtered fallback

### Admin / ops tooling
- Add a maintenance script or runbook for:
  - `wrangler vectorize list-metadata-index <index>`
  - `wrangler vectorize list-vectors <index>`
  - metadata-index creation
  - bulk re-upsert / reindex
- Surface this in the knowledge health UI if possible.

---

## Proposed rollout

### Phase 1: Stabilize behavior
- keep runtime fallback
- improve logs
- reduce metadata return cost
- avoid false "no results" situations

### Phase 2: Enable proper filtering
- create `sourceId` metadata index
- verify availability
- re-upsert vectors
- validate filtered queries on a test experience

### Phase 3: Harden operations
- add health checks and admin diagnostics
- document reindex/backfill steps
- optionally migrate to a new Vectorize index if the current one cannot support metadata filtering

---

## Success criteria

- Generic experience-scoped questions return relevant chunks on the first turn.
- Logs distinguish search-quality misses from infrastructure/configuration misses.
- Filtered Vectorize queries work without fallback once `sourceId` is indexed.
- Reindex/backfill is documented and repeatable.
