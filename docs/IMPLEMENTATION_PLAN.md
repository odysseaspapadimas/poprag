## implementation blueprint
### D1 schema (SQLite semantics on Cloudflare)
| Table | Key fields & notes |
| --- | --- |
| `Agent` | `id (uuid pk)`, `name`, `slug UNIQUE`, `description`, `status enum('draft','active','archived')`, `visibility enum('private','workspace','public')`, `createdBy`, `createdAt`, `updatedAt`, `lastDeployedAt`. Index slug, status, visibility. |
| `ModelAlias` | `alias PK`, `provider enum('openai','openrouter','huggingface','workers-ai')`, `modelId`, `gatewayRoute NULLABLE`, `caps JSON`, `updatedAt`. Add covering index on `(provider, modelId)` for audits. |
| `AgentModelPolicy` | `id`, `agentId FK`, `modelAlias FK`, generation knobs (`temperature`, `topP`, `presencePenalty`, `frequencyPenalty`, `maxTokens`), `responseFormat JSON`, `enabledTools JSON`, `effectiveFrom`, `effectiveTo`. Composite index on `(agentId, effectiveFrom DESC)` for temporal queries. |
| `Prompt` | `id`, `agentId`, `key ENUM('system','user','tool','other')`, `description`. Unique constraint `(agentId, key)`. |
| `PromptVersion` | `id`, `promptId`, `version INT`, `label ENUM('dev','staging','prod','none')`, `content TEXT`, `variables JSON`, `createdBy`, `createdAt`, `changelog TEXT`. Composite unique `(promptId, version)`. Secondary index on `(promptId, label)` for quick label lookups. Versions immutable. |
| `KnowledgeSource` | `id`, `agentId`, `type ENUM('r2-file','url','manual','dataset')`, `r2Bucket`, `r2Key`, `fileName`, `mime`, `bytes`, `checksum`, `status ENUM('uploaded','parsed','indexed','failed')`, `parserErrors JSON`, `createdAt`, `updatedAt`. Index `(agentId, status)`. |
| `Chunk` | `id`, `agentId`, `sourceId`, `text TEXT`, `meta JSON`, `embeddingDim INT`, `indexVersion INT`, `vectorizeId`, `createdAt`. Index `(agentId, indexVersion)`, and `(sourceId)`. |
| `AgentIndexPin` | `id`, `agentId`, `indexVersion`, `pinnedAt`, `pinnedBy`. Unique `(agentId, indexVersion)`; latest per agent drives runtime. |
| `EvalDataset` | `id`, `name`, `description`, `items JSONL pointer`, `createdAt`. |
| `AuditLog` | `id`, `actorId`, `eventType`, `targetType`, `targetId`, `diff JSON`, `createdAt`. Index `(targetType, targetId, createdAt DESC)`. |
| `Transcript` (add) | `id`, `agentId`, `conversationId`, `runId`, `initiatedBy`, `request JSON`, `response JSON`, `usage JSON`, `latencyMs`, `createdAt`. Partition analytics. |
| `RunMetric` (optional) | Flattened metrics per run for graphing (tokens, cost microcents, queue latency). |

Versioning: Prompt labels are pointers to immutable versions; `AgentModelPolicy` uses valid-time intervals. `AgentIndexPin` locks retrieval materialization.

### R2 layout & lifecycle
- Buckets per environment: `agents-admin-{env}` with path `agents/{agentSlug}/{sourceId}/{filename}`.
- Upload flow: issue presigned PUT (or direct upload via R2 multipart) → once complete call `knowledge.confirm`.
- Lifecycle states: `uploaded` (raw), `parsed` (JSON chunk cache stored in R2 in `parsed/{sourceId}.json`), `indexed` (vectorize success). Failed parsing moves file to `quarantine/` with reason.
- Retention: raw files kept (for re-chunking). Parsed artifacts bucket with 30-day lifecycle after superseded indexVersion. Provide nightly consistency check verifying checksum vs D1 metadata.

### Cloudflare Vectorize strategy
- Index per agent or per workspace? Use per-agent namespace to simplify ACLs: `vectorize.createIndex(name=agent-{id}-v{version}, dimensions=<embeddingDim>, metric='cosine')`.
- `indexVersion` increments per ingestion batch; previous indexes stay immutable (supports rollback).
- Default top-k retrieval: 6 (tunable per request). Use metadata filter for `sourceId`/tags.
- Maintain mapping (D1 `Chunk.vectorizeId`) to support deletes when re-ingesting a source.
- On reindex: create new index, batch upsert using Workers queue or Durable Object to throttle; once complete update `KnowledgeSource.status='indexed'` and optionally soft-delete obsolete index after 30 days.

### AI Gateway & provider routing
- Model aliases map to provider + model or Gateway route. When `gatewayRoute` present, set AI SDK provider baseURL to `https://<account>.workers.dev/v1/routes/<routeName>` (OpenAI-compatible). Include per-agent headers (e.g., `x-agent-slug`) for analytics segmentation.
- Fallbacks: configure Gateway to failover provider list (e.g., `gpt-4o`→`gpt-4o-mini`). Cache: enable semantic caching for deterministic prompts; set TTL via Gateway rule.
- Logging: capture `x-ai-gateway-request-id`, cost, cache hit/miss in `RunMetric`.
- Workers AI path: `provider='workers-ai'` uses binding (e.g., `env.AI.run("@cf/meta/llama-3.1-8b-instruct", payload)`). Wrap in AI SDK custom provider adapter while still exposing alias.

### Runtime chat sequence (Cloudflare Worker/Pages Function)
1. Client call `POST /api/chat` (SSE). Payload: `{ agentSlug, messages[], modelAlias?, variables?, rag?: { query?, topK?, filters? }, conversationId? }`.
2. Worker resolves agent from D1 (cache in KV for 60s). Validate status `active` and optional RBAC.
3. Fetch active PromptVersion labelled `prod`; load AgentModelPolicy effective now; merge default variables with request overrides (validate via prompt template engine).
4. Determine generation provider: if request-specified `modelAlias` allowed in policy, otherwise default.
5. Retrieval gating: if `AgentIndexPin` exists and prompt metadata demands retrieval (flag in `AgentModelPolicy.enabledTools`), run retrieval:
   - Compose query (explicit query or last user message).
   - Embed via chosen embedding model alias (likely separate alias). Support using Workers AI embedding fallback.
   - Call Vectorize `query` with `topK` (policy default 6). Filter by pinned `indexVersion`.
   - Post-process hits: de-duplicate by source, compact context (structured JSON with `sourceId`, `excerpt`, `score`, `meta`).
6. Assemble prompt:
   - System message = template with agent metadata (include guardrails toggles) + citations instructions.
   - Append context block (structured bullet list or `tool` metadata for AI SDK).
7. Invoke AI SDK `streamText` with provider, knobs, `tools` (if any) and `onFinish` handler capturing usage. Use `result.toAIStreamResponse()` to stream to client with incremental tokens and `citations[]`.
8. Moderation: if policy enabled, run post-generation check (Workers AI moderation or provider-specific). If violated, stop stream and return sanitized message; log event.
9. Persist `Transcript` & `RunMetric` after stream closes. Include retrieval references for analytics.
10. Return SSE to caller; client UI (TanStack Query + useChat) handles streaming/citations.

Sequence sketch:
```
Client -> Worker API -> D1 (agent/policy) -> Prompt Renderer
        -> Embedding Provider -> Vectorize -> Context Assembler
        -> AI Gateway/Model -> Stream -> Client
        -> Analytics sink (Queues/Logs) & D1 Transcript
```

### RAG ingestion pipeline (Workers + queues)
1. **Upload**: Admin UI obtains upload URL, pushes file to R2 (`agents/slug/sourceId/original.ext`). D1 record `KnowledgeSource` inserted as `uploaded`.
2. **Parse** (background Worker or Cron-triggered Durable Object):
   - Download from R2, route to parser based on MIME (Workers + WASM libs for PDF/XLSX; for larger jobs offload to queue workers).
   - Extract plain text + metadata (sheet names, row numbers). Store parsed output JSON back to R2 `parsed/sourceId.json`. Update `KnowledgeSource.status='parsed'`.
3. **Chunk**: Apply cookbook pattern (sentence/semantic chunking + smart overlap). Configurable chunk size per agent (store in agent config). Persist to D1 `Chunk` table with `indexVersion = currentPin + 1`.
4. **Embed**: Batch embed via AI SDK `embedMany`. Support provider alias `embedding-default`. Persist `embeddingDim`. Handle rate-limiting with concurrency control (AI Gateway policies). Cache embeddings temporarily in R2 if job fragmented.
5. **Vectorize Upsert**: Create new Vectorize index if version changed or reuse existing `vX`. Upsert (with metadata). Save `vectorizeId` returned.
6. **Pin/Activate**: After all source chunks indexed, admin can `agent.pinIndexVersion(version)` to swap runtime retrieval. Maintain audit entry.
7. **Rollback**: Re-pin previous version (Vectorize index still intact). `AgentIndexPin` update triggers invalidation of retrieval cache.

### Admin experience (tRPC + TanStack Query)
- **Agents List**: sortable table with filters (status, visibility, owner). Columns: name, slug, status pill, last deploy, active prompt version, 24h tokens/cost/latency/error rate from analytics (Gateway + log aggregator). Include CTA “Create agent”, quick actions (duplicate, archive).
- **Create Agent wizard**:
  1. Basic info (name, slug, visibility).
  2. Choose base model alias from allow list; optionally attach default guardrails and embeddings alias.
  3. Create initial prompt (prefill with template).
  4. Save as draft (status `draft`, `PromptVersion` label `dev`).
- **Agent Detail (tabbed)**:
  - *Overview*: current status, pinned index version, last runtime metrics, audit feed.
  - *Prompts*: list of `Prompt` keys; selecting one shows version timeline with diff viewer (two-pane). Buttons: create version, promote to dev/staging/prod, rollback label, compare. Staging/prod promote requires confirmation and audit log entry.
  - *Models & Knobs*: dropdown of allowed `ModelAlias`, sliders for temperature/topP, numeric inputs for maxTokens, JSON schema selector (pull from config). Tool toggles (web search, calculator, custom). Secrets mapped server-side; UI shows placeholder.
  - *Knowledge*: table of sources with status & ingestion timestamps. Upload button (supports drag/drop). Show index progress bar (read from background job). Actions: reparse, reindex, detach, download original, view parsed preview. Index pins timeline highlight currently active `indexVersion`.
  - *Guardrails*: toggles for moderation (Workers AI `moderate`), denylist regex management, rate limit slider (req/min + tokens/min), budget cap (daily or monthly). Connect to Gateway policies.
  - *Sandbox*: Chat panel selecting `dev/staging/prod` prompt + index version. Display retrieval debug view (top-k with scores), token + cost estimate, streaming latency graph. Option to override model alias for quick testing.
  - *Analytics*: charts (24h & 7d) for tokens, cost, latency, error type. Data from analytics pipeline (see Observability).
  - *Audit*: timeline showing prompt promotions, model changes, guardrail edits.

### API & tRPC contracts
**Public runtime (Worker route)**  
`POST /api/chat` → SSE  
Request body:
```json
{
  "agentSlug": "support-bot",
  "messages": [...],            // AI SDK UIMessage format
  "modelAlias": "gpt4o-primary",// optional, validated
  "variables": { "brand": "Nescafé" },
  "rag": { "topK": 4, "filters": { "tags": ["coffee"] } },
  "conversationId": "session:abc"
}
```
Response stream frames: `{ textDelta?, toolCalls?, citations: [{sourceId, chunkId, ref, score}], finishReason?, usage, warnings? }`.

**Admin tRPC modules**  
- `agent.list({ filter })` → array (RBAC aware).  
- `agent.create({ name, slug, visibility, modelAlias, promptTemplate })`.  
- `agent.update({ id, patch })` (restricted fields).  
- `agent.archive({ id })`.  
- `prompt.createVersion({ promptId, content, variables, changelog })`.  
- `prompt.assignLabel({ promptId, version, label })`.  
- `prompt.rollbackLabel({ promptId, label, toVersion })`.  
- `modelAlias.list()` / `modelAlias.setCaps({ alias, caps })`.  
- `knowledge.uploadStart({ agentId, fileName, mime, bytes })` → presigned URL + `sourceId`.  
- `knowledge.confirm({ sourceId, checksum })`.  
- `knowledge.index({ sourceId, reindex?: boolean })` → enqueues pipeline job, returns jobId.  
- `knowledge.status({ sourceId })`.  
- `agent.pinIndexVersion({ agentId, indexVersion })`.  
- `eval.run({ datasetId, configId })` → kicks off evaluation (optional).  
- `audit.list({ agentId, cursor? })`.  
- `metrics.summary({ agentId, range })` for dashboards.

All admin routes enforce RBAC (Owner can manage everything, Editor except RBAC, Viewer read-only, Analyst metrics-only). Secrets (API keys, embeddings) stored in Workers KV/Secrets; client never sees raw keys.

### Security, tenancy, governance
- Auth handled by existing frontend; server verifies session + role before hitting D1.
- Row-level isolation in queries by tenant/workspace.
- Rate limiting: Cloudflare Gateway for LLM calls; Worker middleware for additional per-agent quotas (store counters in Durable Object). On exceeded budgets, short-circuit with informative message.
- PII scanning: run on parsed chunks (Workers Durable Object calling DLP service or Cloudflare CASB). Flagged sources marked `quarantine`.
- AuditLog appended on every admin mutation; include before/after payload snippet.
- Secrets (tool credentials) resolved server-side; clients only toggle features.

### Observability & cost
- Use Cloudflare AI Gateway analytics API + Workers logs (structured logging to R2 or Logpush) to compute per-agent stats (requests, tokens, cost, error codes).
- Set up analytics aggregator Worker scheduled every 5 min to compute rollups into D1 `RunMetric`.
- Ingestion pipeline metrics: measure parse/ embed / upsert durations; store in job log (KV or D1). Surface in UI.
- Dashboard views: 24h charts plus sparklines for error rate, avg latency, cache hit %.
- Alerts: integrate with Cloudflare Alert policies for spend thresholds and error spikes.

### Testing & rollout
- **Unit tests**: prompt renderer (variable substitution + escaping), chunker, embedding adaptor (mocks provider), guardrail regex validator, RBAC enforcement.
- **Integration**: end-to-end ingestion in staging (upload sample Excel → parse → Vectorize). Mock provider via AI SDK test adapter; real provider smoke nightly with budget guard.
- **Runtime**: contract tests for `/api/chat` SSE, verifying citations structure, guardrail responses.
- **Admin E2E**: Cypress/Playwright script covering create agent → promote prompt → upload knowledge → sandbox chat shows citations.
- **Rollout**: Phase 0 internal (OpenAI via Gateway). Phase 1 add OpenRouter route. Phase 2 optional Workers AI for lightweight agents. Each phase validated with load test (Cloudflare Load Testing) to ensure concurrency.

### Acceptance criteria
1. Admin can create agent, assign ModelAlias, tweak knobs, promote prompt to prod with audit trail.
2. Excel uploaded → R2, parsed, indexed into Vectorize, pinned index used in runtime; chat returns citations referencing source IDs.
3. Switching providers accomplished by updating ModelAlias or Gateway route without client changes; Gateway fallback verified.
4. Per-agent dashboard displays last 24h cost/latency/errors sourced from Gateway analytics + run logs.
5. Prompt rollback instantly reflects in runtime; corresponding AuditLog entry available.

### Risk register & mitigations
| Risk | Impact | Mitigation |
| --- | --- | --- |
| Provider outage / latency spike | Runtime failures | Gateway fallback chain + retry with backoff; expose status banner in admin. |
| Index drift (retrieval using stale version) | Incorrect answers | `AgentIndexPin` gating + auto-invalidate caches after re-pin. |
| Embedding dimension change | Query errors | Store `embeddingDim` per indexVersion; validate compatibility before upsert/query. Provide migration path (re-embed). |
| Cost spikes | Budget overruns | Rate limits + budget caps at Gateway and Worker; alerting on spend anomalies; per-agent daily cap enforcement (fail fast with message). |
| Parser failure on large files | Blocking ingestion | Chunk pipeline with retries; fallback to manual review. Keep raw in R2 for reprocess. |
| Data leakage via prompts | Compliance | Moderation + denylist guardrails; redaction pipeline for sensitive data before chunk store. |
| Multi-tenant isolation bug | Security breach | Add unit tests for tenant scoping; enforce tenantId column on D1 tables; apply `WHERE agent.workspaceId=?` in all queries. |
| Workers AI model drift | Output inconsistency | Pin model version; run nightly eval dataset comparing to reference provider. |

## todo status
- [x] Analyze requirements & product context  
- [x] Fetch AI SDK RAG reference material  
- [x] Gather supporting docs on streaming/embeddings  
- [x] Draft comprehensive Cloudflare-based implementation plan

That’s the full plan—ready for engineering breakdowns, sprint sizing, and cross-team reviews. Let me know if you’d like diagrams rendered formally or deeper dives on any subsystem!
