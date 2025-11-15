# Quick Start - Testing Your Fixes

## 1️⃣ Immediate Test (2 minutes)

### Option A: Using tRPC (Recommended)
```typescript
// In your browser console or React component
const diagnostics = await trpc.agent.runVectorizeDiagnostics.mutate({ 
  agentId: "your-agent-id" 
});

console.log(diagnostics.summary);
// Should show: { status: "healthy", issues: [] }
```

### Option B: Using API Route
Create a test file or use existing API route:
```typescript
import { runVectorizeDiagnostics } from "@/lib/ai/vectorize-diagnostics";

export async function GET(request: Request) {
  const agentId = new URL(request.url).searchParams.get("agentId");
  const result = await runVectorizeDiagnostics(agentId!);
  return Response.json(result);
}

// Then visit: /api/test-diagnostics?agentId=your-agent-id
```

## 2️⃣ Test a Query (5 minutes)

```typescript
import { findRelevantContent } from "@/lib/ai/embedding";

// Test with a simple query
const results = await findRelevantContent(
  "implementation plan",
  "your-agent-id",
  {
    topK: 5,
    minSimilarity: 0.2,  // Lower threshold for testing
  }
);

console.log(`Found ${results.matches.length} results`);
console.log("First result:", results.matches[0]);

// ✅ SUCCESS if:
// - matches.length > 0
// - matches[0].content has actual text (not empty)
// - matches[0].score > 0.2
```

## 3️⃣ Check Logs (immediate)

After running a query, check your console/terminal for:

```
✅ [RAG] Query embedding generated: 1536 dimensions
✅ [RAG] Vectorize returned 8 raw results
✅ [RAG] First raw match sample: { hasText: true, ... }
✅ [RAG] Returning 5 matches after filtering
```

**❌ If you see warnings:**
```
⚠️  [RAG] Match has no text content
⚠️  [RAG] All results filtered out
⚠️  [RAG] No matches found - namespace may be empty
```
→ See "Common Issues" below

## 4️⃣ Re-index Content (if needed)

If diagnostics show issues with existing content:

1. **Delete old sources** (via UI or API)
2. **Re-upload documents** 
3. **Wait for indexing** (check status = "indexed")
4. **Run diagnostics again**

## Common Issues & Quick Fixes

### Issue: "Namespace empty"
```bash
# Check if vectors exist
wrangler vectorize list

# If empty or wrong config, recreate:
wrangler vectorize delete rag
wrangler vectorize create rag --dimensions=1536 --metric=cosine
```

### Issue: "No text in metadata"
**Fix:** Re-index with updated code (already applied)
```typescript
// New code ensures text is always stored
metadata: {
  text: content.substring(0, 2800),  // ✅ Now respects limits
  // ... other fields
}
```

### Issue: "Wrong dimensions"
**Fix:** Already fixed in code - ensures 1536 everywhere
```typescript
// Both indexing and querying now use:
dimensions: 1536
```

### Issue: "Results but no content"
**Cause:** Old vectors indexed without text field
**Fix:** Re-index content using updated ingestion code

## 5️⃣ Test in Chat (end-to-end)

Try asking your agent questions:

**Good test questions:**
- "What is in the implementation plan?"
- "Tell me about the project timeline"
- "Explain the architecture"

**Expected behavior:**
1. Tool calls `getInformation` with your question
2. Logs show `[RAG Tool] Searching knowledge base for: "..."`
3. Returns results with content
4. Agent uses context in response

**Success indicators:**
- Agent mentions specific details from your documents
- Cites sources in response
- Provides accurate, context-aware answers

## 6️⃣ Add UI Component (optional)

Add diagnostics button to your agent page:

```typescript
import { VectorizeDiagnostics } from "@/components/vectorize-diagnostics";

function AgentDetailsPage({ agentId }: { agentId: string }) {
  return (
    <div>
      <h1>Agent Management</h1>
      
      {/* Add diagnostics section */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold mb-4">RAG Diagnostics</h2>
        <VectorizeDiagnostics agentId={agentId} />
      </section>
    </div>
  );
}
```

## Verification Checklist

- [ ] Diagnostics runs without errors
- [ ] Diagnostics shows "All checks passed" or identifies specific issues
- [ ] Test query returns results with content
- [ ] Logs show 1536 dimensions consistently
- [ ] Content lengths are non-zero in logs
- [ ] Chat responses include retrieved context
- [ ] No "incomplete results" warnings

## Still Having Issues?

1. **Check Vectorize index exists:**
   ```bash
   wrangler vectorize list
   ```

2. **Verify bindings in wrangler.jsonc:**
   ```jsonc
   "vectorize": [{ "binding": "VECTORIZE", "index_name": "rag" }]
   ```

3. **Check environment variables:**
   ```bash
   echo $OPENAI_API_KEY
   ```

4. **Review full error logs:**
   - Look for stack traces
   - Check Cloudflare dashboard
   - Verify API quotas

5. **Test with minimal query:**
   ```typescript
   // Should return SOMETHING even with low threshold
   findRelevantContent("test", agentId, { 
     topK: 1, 
     minSimilarity: 0.0 
   })
   ```

## Need Help?

Check these files:
- `VECTORIZE_IMPROVEMENTS.md` - Full documentation
- `VECTORIZE_QUICKFIX.md` - Troubleshooting guide
- `IMPLEMENTATION_SUMMARY.md` - What changed and why

All diagnostic logs are prefixed with `[RAG]` for easy filtering.
