# RAG Management Guide

## How RAG Enablement Works

RAG (Retrieval Augmented Generation) can be enabled in three ways:

### 1. Agent Model Policy (Recommended - Now Default)

**New agents automatically have RAG enabled**. When you create an agent, the model policy now includes `"retrieval"` in the `enabledTools` array by default.

```typescript
enabledTools: ["retrieval"] // RAG enabled by default
```

#### To Toggle RAG for an Agent:

Use the new tRPC mutation:

```typescript
// Enable RAG
await trpc.agent.updateModelPolicy.mutate({
  agentId: "your-agent-id",
  enabledTools: ["retrieval"],
});

// Disable RAG
await trpc.agent.updateModelPolicy.mutate({
  agentId: "your-agent-id",
  enabledTools: [],
});
```

### 2. Per-Request Basis (Client-Side)

The chat component now automatically includes RAG configuration in all requests:

```typescript
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: `/api/chat/${agent.slug}`,
    body: {
      rag: {
        topK: 6, // Number of relevant chunks to retrieve
      },
    },
  }),
});
```

You can customize per request:

```typescript
sendMessage({ 
  text: "What is the implementation plan?",
  rag: {
    topK: 10, // Override default
    query: "custom query", // Optional: override query
  }
});
```

### 3. Direct API Call

When calling the chat API directly:

```bash
curl -X POST http://localhost:5173/api/chat/your-agent-slug \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is the implementation plan?"}
    ],
    "rag": {
      "topK": 6
    }
  }'
```

## How the RAG Check Works

The chat handler checks for RAG enablement like this:

```typescript
const ragEnabled = Boolean(
  request.rag ||  // Explicit request
  (Array.isArray(policy.enabledTools) && policy.enabledTools.includes("retrieval"))
);
```

**Priority:**
1. If `request.rag` is provided → RAG is enabled
2. If policy has `"retrieval"` in `enabledTools` → RAG is enabled
3. Otherwise → RAG is disabled (but tool is still available)

## Understanding the Logs

When you see these logs:

```
[Chat] RAG config - request.rag: { topK: 6 } policy.enabledTools: ['retrieval'] ragEnabled: true
[Chat] Performing initial RAG retrieval for: "What is the implementation plan?"
[RAG] Searching for: "What is the implementation plan?" in agent namespace: cIwzFtYSNId8ICtXBvWjc
[RAG] Vectorize returned 12 results
[RAG] Returning 6 filtered matches (scores: 0.572, 0.572, 0.522, 0.522, 0.474, 0.474)
```

This means:
- ✅ RAG is enabled
- ✅ Initial retrieval is working
- ✅ Tool is available and functioning
- ✅ Results are being returned to the LLM

## Tool Behavior

The `getInformation` tool is **always available** regardless of initial RAG settings. This allows the LLM to:
1. Use initial context if RAG is enabled
2. Call the tool explicitly when it needs more information
3. Search for specific topics dynamically

## Troubleshooting

### RAG shows as disabled but tool works
- This is NORMAL behavior
- The tool is available even if initial retrieval is disabled
- The LLM can still call `getInformation` when needed

### No results found
Check:
1. Is knowledge uploaded and indexed? (`status: 'indexed'`)
2. Is there an index pin? (optional but recommended)
3. Are embeddings generated correctly?
4. Is the query semantically similar to indexed content?

### Tool not being called
- Ensure the system prompt includes tool usage instructions
- Check that `stopWhen: stepCountIs(5)` allows enough steps
- Verify LLM is receiving tool definitions

## Best Practices

1. **Always enable RAG by default** (now the default behavior)
2. **Use initial retrieval for general context** - provides background for all queries
3. **Let LLM call tool for specific questions** - allows dynamic information gathering
4. **Monitor relevance scores** - scores below 0.3 may indicate poor matches
5. **Adjust topK based on content** - more for broad topics, fewer for specific queries

## UI Integration

To show RAG status in the UI, query the agent's policy:

```typescript
const { data: agent } = useSuspenseQuery(
  trpc.agent.get.queryOptions({ id: agentId })
);

// Get current policy
const { data: policy } = useQuery({
  queryKey: ['modelPolicy', agentId],
  queryFn: async () => {
    // Implement getModelPolicy query
    // Example:
    // const policy = await trpc.agent.getModelPolicy.query({ agentId });
    // Policy includes modelAlias, temperature, topP, maxTokens, enabledTools
  }
});

const ragEnabled = policy?.enabledTools?.includes('retrieval');
```

Then add a toggle in your agent settings UI to enable/disable RAG.

## Future Enhancements

Consider adding:
- UI toggle for RAG in agent settings
- Per-conversation RAG settings
- RAG analytics (retrieval quality, tool usage frequency)
- Custom retrieval strategies per agent
- Re-ranking for better result quality
