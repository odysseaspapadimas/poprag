# Vectorize RAG Improvements - Implementation Summary

## Problem
You were experiencing **incomplete results** when querying Vectorize for RAG (Retrieval-Augmented Generation). Embeddings were being saved but queries weren't returning the expected content.

## Root Causes Identified

1. **Embedding Dimensions Mismatch**
   - Indexing and querying must use the EXACT same dimensions
   - Previously: dimensions were optional and could differ between index/query
   - Fix: Enforced consistent `EMBEDDING_DIMENSIONS = 1536` throughout

2. **Metadata Size Limits**
   - Cloudflare Vectorize has a **3KB limit per vector metadata**
   - Large chunks could exceed this, causing truncation or errors
   - Fix: Added validation and truncation with warnings

3. **Query Logic Issues**
   - Insufficient error handling and logging
   - No validation of metadata structure in results
   - Fix: Enhanced filtering, validation, and comprehensive logging

4. **Chunking Strategy**
   - Chunks were potentially too large for metadata limits
   - Default was 1000 chars, but needed buffer for JSON overhead
   - Fix: Reduced to 800 chars with 2000 hard cap

## Changes Made

### 1. `src/lib/ai/embedding.ts` - Core Improvements

#### Constants Added
```typescript
const EMBEDDING_DIMENSIONS = 1536; // Must match between indexing and querying
const VECTORIZE_METADATA_LIMIT = 2800; // 3KB limit with buffer
```

#### Chunking Improvements
- Reduced default chunk size: 1000 → 800 characters
- Added `maxChunkSize` parameter (default 2000)
- Automatic truncation with warnings for oversized chunks
- Better chunk size statistics in logs

#### Embedding Generation
- **Always** uses consistent dimensions (1536)
- Added logging for dimension confirmation
- Both `generateEmbeddings()` and `generateEmbedding()` enforce consistency

#### Query Logic (`findRelevantContent`)
**Enhanced validation:**
- Check if query is empty
- Validate VECTORIZE binding exists
- Verify metadata structure before processing
- Check for `text` field presence in results

**Better error handling:**
- Detailed error logging with context
- Returns empty results instead of crashing
- Logs first match sample for debugging

**Improved filtering:**
- Fetches `topK * 3` (capped at 50) for better filtering
- Validates metadata structure before filtering
- Checks text field exists and has content
- Logs content lengths and score ranges

### 2. `src/lib/ai/ingestion.ts` - Indexing Improvements

#### Metadata Size Validation
- Added MAX_TEXT_SIZE constant (2800 bytes)
- Truncates text content if exceeds limit with warning
- Ensures metadata stays within Vectorize 3KB limit

#### Consistent Dimensions
- Defaults to 1536 dimensions if not specified
- Logs embedding count after generation

### 3. New Utility Files

#### `src/lib/ai/vectorize-utils.ts`
Diagnostic utilities for debugging:

- `checkVectorizeHealth()` - Validates index accessibility and configuration
- `testVectorizeQuery()` - Runs sample queries to test retrieval
- `validateMetadataSize()` - Checks metadata before insertion
- `listNamespaceVectors()` - Lists vectors in a namespace for inspection

#### `src/lib/ai/vectorize-diagnostics.ts`
Comprehensive diagnostic script:

- Checks Vectorize health
- Validates agent exists
- Lists knowledge sources
- Inspects namespace vectors
- Tests sample queries
- Provides actionable summary

### 4. tRPC Endpoint

Added `agent.runVectorizeDiagnostics` mutation:
```typescript
trpc.agent.runVectorizeDiagnostics.mutate({ agentId: "..." })
```

## How to Use

### 1. Run Diagnostics

From your frontend or API:

```typescript
// Via tRPC
const diagnostics = await trpc.agent.runVectorizeDiagnostics.mutate({ 
  agentId: "your-agent-id" 
});

console.log(diagnostics);
```

This will:
- ✅ Check Vectorize is accessible
- ✅ Verify dimensions (should be 1536)
- ✅ List knowledge sources and their status
- ✅ Inspect vectors in namespace
- ✅ Run test query
- ✅ Validate text metadata exists

### 2. Re-index Existing Content

If you have existing content that was indexed with wrong dimensions or large chunks:

1. **Delete existing vectors** (optional but recommended):
   ```typescript
   // Via your knowledge source management UI
   // Or manually delete from Vectorize
   ```

2. **Re-upload and re-index** your documents:
   - The new chunking and validation will automatically apply
   - Chunks will respect metadata limits
   - Consistent dimensions will be enforced

### 3. Monitor Logs

Enhanced logging shows:
```
[RAG] Searching for: "..." in namespace: agent-123
[RAG] Query params: topK=6, minSimilarity=0.3
[RAG] Query embedding generated: 1536 dimensions
[RAG] Vectorize returned 12 raw results
[RAG] First raw match sample: {...}
[RAG] Returning 6 matches after filtering from 12 raw results
[RAG] Score range: 0.842 to 0.654
[RAG] Content lengths: 654, 723, 891, 512, 678, 445
```

### 4. Check Common Issues

#### Issue: "No matches found"
**Possible causes:**
- Namespace is empty (no vectors indexed)
- All results filtered out by `minSimilarity` threshold
- Query embedding dimensions don't match indexed vectors

**Solution:**
1. Run diagnostics to check namespace has vectors
2. Lower `minSimilarity` (try 0.1) temporarily to test
3. Re-index content with consistent dimensions

#### Issue: "Match has no text content"
**Possible causes:**
- Old vectors indexed without `text` field
- Metadata exceeded 3KB and was truncated
- Text field name mismatch

**Solution:**
1. Re-index content with updated ingestion code
2. Check metadata structure in diagnostics
3. Ensure text field is being set during insertion

#### Issue: "Incomplete results" (returns fewer than expected)
**Possible causes:**
- Results filtered out by similarity threshold
- Insufficient vectors in namespace
- Query too specific

**Solution:**
1. Lower `minSimilarity` in `findRelevantContent` options
2. Increase `topK` to fetch more results
3. Check diagnostics to see total vector count

## Configuration Options

### When Calling `findRelevantContent`

```typescript
const results = await findRelevantContent(query, agentId, {
  topK: 6,              // Number of results to return (default: 6)
  minSimilarity: 0.3,   // Minimum cosine similarity (default: 0.3, range: 0-1)
  indexVersion: 1,      // Optional: specific index version
});
```

### When Generating Chunks

```typescript
const chunks = generateChunks(content, {
  chunkSize: 800,          // Target chunk size (default: 800)
  overlapPercentage: 0.2,  // 20% overlap (default: 0.2)
  minChunkSize: 100,       // Min chunk size (default: 100)
  maxChunkSize: 2000,      // Hard cap (default: 2000)
});
```

### When Generating Embeddings

```typescript
const embeddings = await generateEmbeddings(content, {
  model: "text-embedding-3-small",  // Model name
  dimensions: 1536,                  // MUST match query dimensions
});
```

## Vectorize Configuration

Ensure your `wrangler.jsonc` has:

```jsonc
{
  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "rag",
      "remote": true
    }
  ]
}
```

And your Vectorize index was created with:
```bash
wrangler vectorize create rag --dimensions=1536 --metric=cosine
```

## Testing Checklist

- [ ] Run diagnostics on an agent with indexed content
- [ ] Verify dimensions are 1536
- [ ] Check that vectors have `text` metadata field
- [ ] Test query returns results with content
- [ ] Upload new document and verify indexing succeeds
- [ ] Check chunk sizes are within limits in logs
- [ ] Verify query results have complete text content
- [ ] Test with different similarity thresholds

## Next Steps

1. **Run diagnostics** on your existing agents to identify issues
2. **Re-index content** if dimensions were incorrect or chunks too large
3. **Monitor logs** during queries to see detailed information
4. **Adjust thresholds** if getting too few/many results
5. **Test with various queries** to ensure retrieval quality

## Performance Notes

- **Chunking**: 800 char chunks with 20% overlap provides good balance
- **Query topK**: Fetching `topK * 3` allows better filtering without performance hit
- **Similarity threshold**: 0.3 is reasonable starting point
  - Lower (0.1-0.2): More results, potentially less relevant
  - Higher (0.5-0.7): Fewer results, more precise
- **Metadata size**: Stay under 2800 bytes to avoid issues

## Debugging Commands

```typescript
// 1. Check index health
const health = await checkVectorizeHealth();

// 2. List vectors in namespace
const vectors = await listNamespaceVectors("agent-id", 10);

// 3. Test query
const test = await testVectorizeQuery("agent-id", "test query");

// 4. Full diagnostics
const diag = await runVectorizeDiagnostics("agent-id");
```

## Key Takeaways

✅ **Consistency is critical**: Always use same dimensions for indexing and querying
✅ **Respect limits**: Vectorize has 3KB metadata limit - stay under 2800 bytes
✅ **Validate metadata**: Always check `text` field exists before using
✅ **Log extensively**: Detailed logging helps diagnose issues quickly
✅ **Filter intelligently**: Fetch extra results then filter for quality
