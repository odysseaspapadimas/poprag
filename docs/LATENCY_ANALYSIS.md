# Chat API Latency Analysis

## The Problem
- RAG timing shows ~5 seconds (intent + vector search + DB enrichment)
- Time to first token (TTFT) is ~20 seconds
- **~15 seconds of unexplained latency**

---

## Chat Flow: Full Sequential Breakdown

Here's every `await` that happens **BEFORE the LLM starts streaming**:

### 1. API Endpoint (`src/routes/api/chat.$agentSlug.ts`)
```
await request.json()                    ~0ms
await import("cloudflare:workers")      ~0ms (cached after first call)
```

### 2. Chat Handler (`src/lib/ai/chat.ts`)

```
┌─ SEQUENTIAL ─────────────────────────────────────────────────────────┐
│                                                                       │
│  await resolveAgent(slug)                         ~50-100ms (DB)     │
│                                                                       │
│  ┌─ PARALLEL (Promise.all) ──────────────────────────────────────┐   │
│  │  await loadPromptConfig()                      ~100-200ms (2 DB) │ │
│  │  await loadModelPolicy()                       ~50-100ms (DB)    │ │
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  await performRAGRetrieval()                      ~5000ms (reported) │
│                                                                       │
│  await resolveModelForChat()                      🔴 ~50-100ms (DB) │
│                                                                       │
│  await Promise.all(processMessageParts())         🔴 POTENTIAL ISSUE │
│    └─ For EACH message with images:                                  │
│       └─ await fetchImageAsBase64()               ~200-500ms per img │
│                                                                       │
│  await convertToModelMessages()                   ~0ms (sync-like)   │
│                                                                       │
│  streamText({ ... }) ← STREAMING STARTS HERE                         │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 3. RAG Pipeline (`src/lib/ai/rag-pipeline.ts`)

```
┌─ performRAGRetrieval() ──────────────────────────────────────────────┐
│                                                                       │
│  ┌─ PARALLEL (Promise.all) ──────────────────────────────────────────┐
│  │                                                                    │
│  │  Intent Classification:                                            │
│  │  ├─ await resolveAndCreateModel()        🔴 ~50-100ms (DB query)  │
│  │  └─ await generateText() (Llama 70B)     🔴 ~2-4 seconds          │
│  │                                                                    │
│  │  Query Rewriting (if enabled):                                     │
│  │  ├─ await resolveAndCreateModel()        🔴 ~50-100ms (DB query)  │
│  │  └─ await generateText() (Llama 70B)     🔴 ~2-4 seconds          │
│  │                                                                    │
│  └───────────────────────────────────────────────────────────────────┘
│                                                                       │
│  await hybridSearch()                                                 │
│  ├─ await generateEmbeddings()              ~200-500ms (Workers AI)  │
│  ├─ await Promise.all(vectorSearchPromises) ~100-300ms (Vectorize)   │
│  └─ await searchDocumentChunksFTS()         ~50-100ms (D1 FTS)       │
│                                                                       │
│  await rerankResults() (if enabled)         ~500-1000ms              │
│                                                                       │
│  await enrichWithFullText()                 ~100-200ms (DB batch)    │
│  await expandWithNeighborChunks()           ~100-200ms (DB batch)    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 🔴 Root Causes Identified

### 1. **Intent Classification Model is SLOW** (~2-4 seconds)
```typescript
// src/lib/ai/constants.ts
INTENT_CLASSIFICATION: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
```

Using **Llama 70B** just to decide "does this need RAG?" is overkill.

- Llama 70B cold start: ~2-5 seconds on Workers AI
- For a simple yes/no classification, this is excessive

### 2. **Query Rewriting Uses Another 70B Call** (~2-4 seconds)
```typescript
QUERY_REWRITE: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
```

Even running in parallel with intent, this adds to total RAG time.

### 3. **Model Alias Resolution = DB Query EVERY TIME** (~50-100ms each)

```typescript
// Called 3-4 times in the flow:
// 1. resolveAndCreateModel(intentModelId)
// 2. resolveAndCreateModel(rewriteModelId)  
// 3. resolveModelForChat(selectedAlias)
// Each does: SELECT * FROM modelAlias WHERE alias = ?
```

That's 3-4 DB round trips just for model lookups.

### 4. **Message Processing with Images** (variable, potentially huge)
```typescript
const processedMessages = await Promise.all(
  request.messages.map(async (msg) => ({
    ...msg,
    parts: await processMessageParts(msg.parts, capabilities, ...)
  }))
);
```

If messages contain images, each one triggers:
```typescript
// image-service.ts
const r2Object = await env.R2.get(imageRecord.r2Key);
const arrayBuffer = await r2Object.arrayBuffer();
// Convert to base64...
```

With multiple images, this adds up fast.

### 5. **OpenAI/GPT-4o Network Latency**

GPT-4o via OpenAI API from Cloudflare Workers adds:
- Network latency to OpenAI servers: ~100-300ms
- Model queue time (varies by load): ~100-500ms
- First token generation: ~500ms-2s

Total OpenAI overhead: **~1-3 seconds** before first token.

---

## Time Budget Analysis

| Step | Est. Time | Notes |
|------|-----------|-------|
| Agent resolution (DB) | ~100ms | |
| Prompt + Policy load (parallel DB) | ~150ms | |
| **Intent classification (70B)** | **~2-4s** | 🔴 Main culprit |
| Query rewrite (70B, parallel) | ~2-4s | (parallel with intent) |
| Embedding generation | ~300ms | |
| Vector + FTS search (parallel) | ~200ms | |
| DB enrichment | ~200ms | |
| Model resolution (DB) | ~100ms | |
| Message processing | ~100ms | (more if images) |
| **OpenAI network + model load** | **~1-3s** | 🔴 External |
| **TOTAL** | **~5-9s typical** | |

Your reported 5s for RAG + 20s TTFT suggests:
- RAG is working as designed (~5s with 70B intent/rewrite)
- The remaining ~15s is likely:
  1. OpenAI cold start / queue time
  2. Network latency
  3. Possibly image processing if images in messages

---

## 💡 Recommended Solutions

### Quick Wins (High Impact, Low Effort)

#### 1. **Use a Smaller Model for Intent Classification**
```typescript
// src/lib/ai/constants.ts - BEFORE
INTENT_CLASSIFICATION: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

// AFTER - Use 8B model (10x faster, ~200-400ms)
INTENT_CLASSIFICATION: "@cf/meta/llama-3.1-8b-instruct-fast"
```

**Expected savings: ~2-3 seconds**

The intent classification prompt is simple:
```
"Return requiresRAG=true/false"
```

An 8B model handles this perfectly. No need for 70B.

#### 2. **Use Smaller Model for Query Rewriting**
```typescript
// BEFORE
QUERY_REWRITE: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

// AFTER
QUERY_REWRITE: "@cf/meta/llama-3.1-8b-instruct-fast"
```

**Expected savings: ~1-2 seconds** (parallel, but reduces total RAG time)

#### 3. **Cache Model Alias Resolutions**

Currently, every model lookup hits the DB:
```typescript
// helpers.ts - resolveAndCreateModel
const [aliasRecord] = await db
  .select()
  .from(modelAlias)
  .where(eq(modelAlias.alias, alias))
  .limit(1);
```

**Solution**: Add in-memory cache with short TTL:
```typescript
const modelAliasCache = new Map<string, { record: any; timestamp: number }>();
const CACHE_TTL = 60000; // 1 minute

export async function resolveAndCreateModel(alias: string): Promise<LanguageModel> {
  const now = Date.now();
  const cached = modelAliasCache.get(alias);
  
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return createModel({
      alias,
      provider: cached.record?.provider || DEFAULT_PROVIDER,
      modelId: cached.record?.modelId || alias,
    });
  }
  
  const [aliasRecord] = await db.select()...
  modelAliasCache.set(alias, { record: aliasRecord, timestamp: now });
  // ... rest
}
```

**Expected savings: ~100-200ms** (removes 2-3 DB queries)

### Medium Effort Optimizations

#### 4. **Skip Intent Classification for Obvious RAG Queries**

Add a fast heuristic before calling the LLM:
```typescript
// Fast pre-check (no LLM call)
function fastIntentCheck(query: string): 'rag' | 'skip' | 'unknown' {
  const q = query.toLowerCase().trim();
  
  // Definite skips (greetings, etc.)
  const skipPatterns = [
    /^(hi|hello|hey|sup|yo)[\s!?.]*$/,
    /^(thanks|thank you|bye|goodbye|ok|okay|sure|yes|no)[\s!?.]*$/,
    /^how are you/,
  ];
  if (skipPatterns.some(p => p.test(q))) return 'skip';
  
  // Definite RAG (question words, specific topics)
  if (q.includes('?') || /^(what|how|why|when|where|who|which|explain|describe|tell me)/i.test(q)) {
    return 'rag';
  }
  
  return 'unknown'; // Fall back to LLM classification
}
```

Only call the LLM intent classifier for ambiguous queries.

**Expected savings: ~2-4 seconds** for obvious cases

#### 5. **Lazy Load Model Resolution in Parallel**

Move model resolution to happen in parallel with RAG:
```typescript
// BEFORE (sequential)
const ragResult = await performRAGRetrieval(...);
const { model } = await resolveModelForChat(...);

// AFTER (parallel)
const [ragResult, { model }] = await Promise.all([
  performRAGRetrieval(...),
  resolveModelForChat(...),
]);
```

**Expected savings: ~50-100ms**

### Structural Improvements (Higher Effort)

#### 6. **Make Intent Classification Optional**

Add an agent-level setting to bypass intent classification:
```typescript
// In agent table
skipIntentClassification: boolean
```

For agents with highly focused knowledge bases, you know every query needs RAG. Skip the check entirely.

#### 7. **Use Streaming for RAG Context Injection**

Instead of waiting for full RAG completion before streaming:
1. Start streaming immediately with a placeholder
2. Inject RAG context mid-stream
3. Or use a two-phase approach: initial response + refined response

This is complex but provides perceived performance improvement.

#### 8. **Consider OpenRouter or Self-Hosted for Chat Model**

If GPT-4o latency is consistently high:
- OpenRouter may have better routing
- Claude via OpenRouter often has lower TTFT
- Self-hosted Llama on dedicated GPU has predictable latency

---

## Immediate Action Items

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 🔴 P0 | Change intent model to 8B | -2-3s | 1 line change |
| 🔴 P0 | Change rewrite model to 8B | -1-2s | 1 line change |
| 🟡 P1 | Add fast intent heuristic | -2-4s for obvious cases | ~50 lines |
| 🟡 P1 | Cache model alias lookups | -100-200ms | ~30 lines |
| 🟢 P2 | Parallelize model resolution | -50-100ms | ~10 lines |
| 🟢 P2 | Add skipIntentClassification flag | Variable | Schema + UI |

---

## Verification

After implementing fixes, check the timing metrics in the RAG debug info:
```typescript
debugInfo.timing = {
  intentClassificationMs: number,  // Should be ~200-400ms after fix
  queryRewriteMs: number,          // Should be ~200-400ms after fix
  vectorSearchMs: number,
  ftsSearchMs: number,
  enrichmentMs: number,
  totalRagMs: number,              // Target: <2s total
}
```

Also check `runMetric.timeToFirstTokenMs` in the database to track TTFT improvements over time.

---

## Summary

The 20-second TTFT breaks down approximately as:
- **~5s**: RAG pipeline (mostly due to 70B model calls)
- **~1-3s**: OpenAI network latency + model queue
- **~12s**: Potentially cold starts, network variability, or image processing

**Quick fixes (changing to 8B models) should reduce TTFT to ~8-12 seconds.**

Further optimization with caching and heuristics can push it to **~4-6 seconds**.
