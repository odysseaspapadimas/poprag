# Quick Fix Guide - Incomplete RAG Results

## Immediate Actions

### 1️⃣ Run Diagnostics First
```typescript
// In your app or via tRPC mutation
const diagnostics = await trpc.agent.runVectorizeDiagnostics.mutate({ 
  agentId: "your-agent-id" 
});

// Check the output for issues
console.log(diagnostics.summary.issues);
```

### 2️⃣ Common Issues & Fixes

| Issue | Quick Fix | Long-term Solution |
|-------|-----------|-------------------|
| **No results returned** | Lower `minSimilarity` to 0.1 | Re-index content, check namespace not empty |
| **Results missing text** | Check metadata in diagnostics | Re-index with updated ingestion code |
| **Wrong dimensions error** | Delete vectors, re-index | Ensure consistent 1536 dimensions |
| **Namespace empty** | Upload and index documents | Verify indexing completes successfully |
| **Chunks too large** | Already fixed in code | Re-index existing content |

### 3️⃣ Verify Vectorize Index

```bash
# Check your Vectorize index configuration
wrangler vectorize list

# If index doesn't exist or wrong dimensions, recreate:
wrangler vectorize delete rag
wrangler vectorize create rag --dimensions=1536 --metric=cosine
```

### 4️⃣ Re-index Content

If you have existing content with issues:

1. Delete knowledge sources via UI
2. Re-upload documents
3. Wait for indexing to complete
4. Run diagnostics again

### 5️⃣ Test Query

```typescript
import { findRelevantContent } from "@/lib/ai/embedding";

const results = await findRelevantContent(
  "your test query",
  "agent-id",
  {
    topK: 6,
    minSimilarity: 0.1,  // Lower for testing
  }
);

console.log("Results:", results.matches.length);
console.log("First match:", results.matches[0]);
```

## Monitoring Checklist

Check these in your logs:

- ✅ `[RAG] Query embedding generated: 1536 dimensions`
- ✅ `[RAG] Vectorize returned X raw results` (X > 0)
- ✅ `[RAG] First raw match sample: { hasText: true, ... }`
- ✅ `[RAG] Returning X matches` (X > 0)
- ✅ Content lengths show non-zero values

## Troubleshooting Decision Tree

```
No results from query?
├─ Is namespace empty? (diagnostics step 4)
│  ├─ YES → Upload and index documents
│  └─ NO → Continue
├─ Are vectors missing text metadata? (diagnostics step 4)
│  ├─ YES → Re-index with new ingestion code
│  └─ NO → Continue
├─ Is minSimilarity too high?
│  ├─ TRY → Lower to 0.1 temporarily
│  └─ Still no results? → Check dimensions match
└─ Wrong dimensions? (diagnostics step 1)
   └─ YES → Delete vectors, re-index with 1536
```

## Performance Tuning

### For More Results
```typescript
{
  topK: 10,            // Increase from 6
  minSimilarity: 0.2,  // Lower from 0.3
}
```

### For Better Quality
```typescript
{
  topK: 3,             // Decrease from 6
  minSimilarity: 0.5,  // Raise from 0.3
}
```

### For Debugging
```typescript
{
  topK: 1,
  minSimilarity: 0.0,  // Get ANYTHING that matches
}
```

## Contact Points in Code

### Query Logic
- `src/lib/ai/embedding.ts` - `findRelevantContent()`
- Check logs for `[RAG]` prefix

### Indexing Logic
- `src/lib/ai/ingestion.ts` - `processKnowledgeSource()`
- Check logs during upload

### Diagnostics
- `src/lib/ai/vectorize-diagnostics.ts` - `runVectorizeDiagnostics()`
- Run via tRPC: `agent.runVectorizeDiagnostics`

## Still Having Issues?

1. Check Cloudflare dashboard for Vectorize errors
2. Verify environment has OPENAI_API_KEY set
3. Check wrangler.jsonc has correct bindings
4. Review full logs for error stack traces
5. Ensure network access to OpenAI API

## Success Indicators

✅ Diagnostics show "All checks passed"
✅ Test query returns multiple results
✅ Results have complete text content
✅ Similarity scores are reasonable (0.3+)
✅ Chat responses include retrieved context
