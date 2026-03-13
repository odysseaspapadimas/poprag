# Vectorize Ops Runbook

Use this runbook when experience-scoped retrieval depends on `metadata.sourceId`
filtering in the `rag` Vectorize index.

## Current repo settings

- Binding: `VECTORIZE`
- Index: `rag`
- Dimensions: `768`
- Namespace strategy: `agentId`
- Experience filter field: `sourceId`
- Runtime readiness flag: `VECTORIZE_SOURCE_ID_FILTER_READY`

## 1. Verify the index exists

```bash
npx wrangler vectorize list
```

Expected: an index named `rag` with `768` dimensions.

## 2. Check metadata indexes

```bash
npx wrangler vectorize list-metadata-index rag
```

Expected: an entry for `sourceId` with type `string`.

If this command cannot run locally, make sure `CLOUDFLARE_API_TOKEN` is set for
Wrangler.

## 3. Create the `sourceId` metadata index

```bash
npx wrangler vectorize create-metadata-index rag --property-name=sourceId --type=string
```

Wait a few seconds, then verify again with `list-metadata-index`.

After the metadata index is confirmed, set:

```bash
VECTORIZE_SOURCE_ID_FILTER_READY=true
```

Do not enable that flag before the metadata index exists.

## 4. Backfill existing vectors

Existing vectors inserted before the metadata index may still miss direct filter
support. Reindex them after index creation.

### Reindex selected sources

- Use the Knowledge health page bulk reindex action.
- Or call the existing `knowledge.bulkReindex` mutation.

### Reindex an entire agent

- Use `knowledge.bulkReindexByAgent`.
- Optionally pass `experienceId` to reindex only one experience's sources.

Queue processing already deletes old vectors, clears D1 chunks, and rebuilds the
source from R2.

## 5. Validate filtered queries

Use the admin diagnostic query `knowledge.vectorizeDiagnostics` with:

- `namespace`: agent id
- `query`: sample user query
- `sourceId`: optional knowledge source id

It reports:

- namespace-only query
- direct filtered query by `sourceId`
- broad query plus app-side filtering

Healthy post-backfill behavior:

- filtered query returns non-zero results
- broad fallback is no longer needed
- knowledge health page shows metadata filtering as configured

## 6. Runtime fallback behavior

If `VECTORIZE_SOURCE_ID_FILTER_READY` is unset or false:

- the app skips direct filtered Vectorize queries
- retrieval falls back to broad namespace search plus app-side `sourceId`
  filtering

Relevant logs:

- `vector_filter_applied`
- `vector_filter_skipped_no_metadata_index`
- `vector_filter_zero_results_fallback_used`

## 7. Troubleshooting

- `list-metadata-index` fails in CLI: export `CLOUDFLARE_API_TOKEN`
- filtered query returns zero but broad post-filter finds matches: reindex the
  affected sources
- no results from any mode: confirm namespace, embeddings, and queue ingestion
  succeeded
