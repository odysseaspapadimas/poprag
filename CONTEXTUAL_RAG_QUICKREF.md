# Contextual RAG Quick Reference

## What Changed?

### 1. Better Chunking
```typescript
// OLD: Custom paragraph-based splitting
// NEW: LangChain RecursiveCharacterTextSplitter
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1024,
  chunkOverlap: 200,
});
```

### 2. Query Rewriting
```typescript
// Automatically expands queries for better retrieval
const { queries, keywords } = await rewriteQuery(model, "What's in the docs?");
// queries: ["documentation content", "doc features", "documentation structure", ...]
// keywords: ["docs", "documentation", "content", ...]
```

### 3. Reciprocal Rank Fusion
```typescript
// Merges results from multiple searches intelligently
const fusedResults = reciprocalRankFusion(
  [vectorResults1, vectorResults2, vectorResults3],
  60 // k constant
);
```

## How to Use

### During Document Upload
Nothing changes! The new chunking happens automatically:
```typescript
await processKnowledgeSource(sourceId, content);
// ↓ Uses RecursiveCharacterTextSplitter internally
```

### During Chat
Query rewriting happens automatically if RAG is enabled:
```typescript
const response = await handleChatRequest({
  agentSlug: "my-agent",
  messages: [...],
  rag: {
    topK: 6, // Will be distributed across query variations
  }
});
```

### In the getInformation Tool
The AI can call this tool, which now uses query rewriting:
```typescript
// The tool will:
// 1. Rewrite "implementation details" into multiple queries
// 2. Search for each variation
// 3. Merge results using RRF
// 4. Return top 6 matches
```

## Configuration Options

### Chunking (in embedding.ts)
```typescript
await generateChunks(text, {
  chunkSize: 1024,       // Larger = more context per chunk
  chunkOverlap: 200,     // Larger = more context preservation
  maxChunkSize: 2000,    // Hard limit for Vectorize metadata
});
```

### Query Rewriting (in chat.ts)
```typescript
// Adjust number of query variations in the prompt:
"rewrite it into 3-5 distinct queries"
// Change to "2-3" for speed or "5-7" for coverage
```

### RRF Merging (in utils.ts)
```typescript
reciprocalRankFusion(resultSets, k);
// k=60: Standard (Microsoft recommendation)
// k=40: More aggressive (favors top results)
// k=80: Conservative (smoother distribution)
```

### Retrieval (in embedding.ts)
```typescript
findRelevantContent(query, agentId, {
  topK: 6,              // Results to return
  minSimilarity: 0.3,   // Lower = more results
  useHybridSearch: true // Enable query variations
});
```

## Monitoring

### Console Logs to Watch
```bash
# Query rewriting
[Query Rewriting] Original: "..."
[Query Rewriting] Generated 4 query variations
[Query Rewriting] Extracted 6 keywords

# RAG retrieval
[Chat] Query variations used: 4, Keywords: implementation, plan, ...
[Chat] Score range: 0.823 to 0.567

# Tool usage
[RAG Tool] Searching knowledge base for: "..."
[RAG Tool] Query rewritten into 3 variations with 5 keywords
[RAG Tool] Found 6 results after fusion
```

## Troubleshooting

### "No results found"
1. Check if documents are indexed: Look for vectorizeIds in knowledge_source table
2. Lower minSimilarity threshold: Try 0.2 instead of 0.3
3. Check console for query variations: Are they relevant?

### "Query rewriting failed"
- System falls back to original query automatically
- Check OpenAI API key and rate limits
- Model will log warning but continue

### "Results are not relevant"
1. Try adjusting RRF k constant (lower = favor top results)
2. Increase topK to get more candidates before fusion
3. Check if query variations make sense (console logs)

## Performance Tips

### Speed Optimizations
```typescript
// 1. Reduce query variations (faster)
"rewrite it into 2-3 distinct queries"

// 2. Reduce topK for each variation
topK: Math.ceil(6 / queries.length)  // Fewer results per query

// 3. Skip query rewriting for simple queries
if (query.length < 10) {
  // Use original query only
}
```

### Quality Optimizations
```typescript
// 1. More query variations (slower but better coverage)
"rewrite it into 5-7 distinct queries"

// 2. Higher topK (more candidates for fusion)
topK: 10

// 3. Lower similarity threshold (cast wider net)
minSimilarity: 0.2
```

## What's Next?

### Easy Additions
- **BM25 Full-Text Search**: Add FTS5 to D1 for keyword matching
- **Cache query rewrites**: Store common query variations
- **Tune k constant**: Experiment with different values for your data

### Advanced Features (from guide)
- **Contextual chunk enhancement**: Add LLM-generated context during ingestion
- **Reranking model**: Add final reranking step after RRF
- **Query classification**: Route queries to different strategies

## Key Files

- `src/lib/ai/embedding.ts` - Chunking, embeddings, retrieval
- `src/lib/ai/chat.ts` - Query rewriting, RAG orchestration, tool definition
- `src/lib/utils.ts` - RRF algorithm, utility functions
- `src/lib/ai/ingestion.ts` - Document processing pipeline

## Package Added

```json
{
  "dependencies": {
    "@langchain/textsplitters": "^0.1.0"
  }
}
```

Install with: `pnpm add @langchain/textsplitters`
