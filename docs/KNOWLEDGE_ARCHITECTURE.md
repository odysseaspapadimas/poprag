# Knowledge Management Architecture

## Overview

This document describes the production-ready implementation of the knowledge upload and indexing system with proper agent-based isolation across both R2 (object storage) and Vectorize (vector database).

## Multi-Tenant Isolation Strategy

### Agent-Based Namespacing

All knowledge sources are isolated by agent using two complementary approaches:

1. **R2 (Object Storage)**: Key prefix-based organization
2. **Vectorize (Vector Database)**: Native namespace support

This ensures complete isolation between agents, preventing cross-agent data leakage in both storage and retrieval operations.

## Architecture Components

### 1. R2 Key Structure

Knowledge files are stored in R2 with an agent-scoped key structure:

```
agents/{agentId}/sources/{sourceId}/{fileName}
```

**Example:**
```
agents/clx123abc/sources/src_456def/document.pdf
agents/clx123abc/sources/src_789ghi/spreadsheet.xlsx
```

**Benefits:**
- Natural hierarchical organization
- Easy filtering by agent prefix
- Clear ownership and lifecycle management
- Supports efficient batch operations per agent

**Implementation:**
- Location: `src/integrations/trpc/router/knowledge.ts` - `uploadStart` procedure
- Generates sourceId using nanoid for collision-free IDs
- Uses agentId directly (not slug) for consistency

### 2. Vectorize Namespace Strategy

Each agent has its own namespace in Vectorize:

```typescript
namespace: agentId  // e.g., "clx123abc"
```

**Limits:**
- Free tier: 1,000 namespaces per index
- Paid tier: 50,000 namespaces per index

**Benefits:**
- Native isolation at database level
- Namespace filtering applied before metadata filters (more efficient)
- No risk of cross-agent contamination in vector queries
- Clean separation of vector spaces

**Implementation:**
- Location: `src/lib/ai/ingestion.ts` - `processKnowledgeSource` function
- Namespace parameter passed to all Vectorize operations:
  - `insert()` - when creating vectors
  - `query()` - when searching (in knowledge router)
  - `deleteByIds()` - when cleaning up

### 3. Database Schema

The `knowledgeSource` table tracks metadata:

```typescript
{
  id: string;              // Unique source ID
  agentId: string;         // Owner agent ID (FK)
  type: "r2-file" | "url" | "manual" | "dataset";
  r2Bucket: string;        // "poprag"
  r2Key: string;           // Agent-scoped key
  fileName: string;
  mime: string;
  bytes: number;
  checksum: string;        // SHA-256 hash
  status: "uploaded" | "parsed" | "indexed" | "failed";
  parserErrors: string[];
  createdAt: Date;
  updatedAt: Date;
}
```

The `chunk` table stores processed text chunks:

```typescript
{
  id: string;              // Unique chunk ID
  agentId: string;         // Owner agent ID (FK)
  sourceId: string;        // Parent source ID (FK)
  text: string;            // Chunk text content
  meta: JSON;              // Additional metadata
  embeddingDim: number;    // Vector dimensions (1536)
  indexVersion: number;    // Version control
  vectorizeId: string;     // ID in Vectorize (matches chunk.id)
  createdAt: Date;
}
```

## Upload Flow

### Complete Pipeline

```
Client → uploadStart → R2 Upload → confirm → index → Vectorize
```

### Step-by-Step Process

#### 1. Upload Initialization (`uploadStart`)

**Location:** `src/integrations/trpc/router/knowledge.ts`

```typescript
// Client calls with agent and file info
trpc.knowledge.uploadStart.mutate({
  agentId: "clx123abc",
  fileName: "document.pdf",
  mime: "application/pdf",
  bytes: 1024000
});
```

**Server Actions:**
1. Verify agent exists and user has access
2. Generate unique sourceId
3. Create agent-scoped R2 key: `agents/{agentId}/sources/{sourceId}/{fileName}`
4. Insert record into `knowledgeSource` table with status "uploaded"
5. Return uploadUrl and sourceId to client

**R2 Key Generation:**
```typescript
const sourceId = nanoid();
const r2Key = `agents/${input.agentId}/sources/${sourceId}/${input.fileName}`;
```

#### 2. File Upload to R2

**Location:** `src/routes/api/upload-knowledge.$.ts`

**Client Actions:**
1. Receives uploadUrl from uploadStart
2. Creates FormData with file and sourceId
3. POSTs to `/api/upload-knowledge`

**Server Actions:**
1. Validate sourceId exists and status is "uploaded"
2. Read file buffer
3. Calculate SHA-256 checksum
4. Upload to R2 with metadata:
   ```typescript
   await env.R2.put(r2Key, fileBuffer, {
     httpMetadata: {
       contentType: file.type
     },
     customMetadata: {
       sourceId,
       fileName: file.name,
       checksum,
       uploadedAt: new Date().toISOString()
     }
   });
   ```
5. Update database with checksum
6. Return success with checksum and metadata

#### 3. Upload Confirmation (`confirm`)

**Optional step for client-side validation.**

**Location:** `src/integrations/trpc/router/knowledge.ts`

```typescript
trpc.knowledge.confirm.mutate({
  sourceId: "src_456def",
  checksum: "abc123..."  // Optional client-side verification
});
```

**Server Actions:**
1. Verify source exists
2. Update checksum if provided
3. Create audit log entry
4. Return success

#### 4. Indexing (`index`)

**Location:** `src/integrations/trpc/router/knowledge.ts` → `src/lib/ai/ingestion.ts`

```typescript
trpc.knowledge.index.mutate({
  sourceId: "src_456def",
  reindex: false
});
```

**Server Actions:**

1. **Fetch from R2:**
   ```typescript
   const r2Object = await env.R2.get(source.r2Key);
   const content = await r2Object.text();
   ```

2. **Parse Document:**
   - Location: `src/lib/ai/ingestion.ts` - `parseDocument`
   - Handles text/plain, spreadsheets, CSV
   - Returns content and metadata

3. **Generate Embeddings:**
   - Location: `src/lib/ai/embedding.ts` - `generateEmbeddings`
   - Uses OpenAI text-embedding-3-small (1536 dimensions)
   - Chunks text appropriately for embedding limits

4. **Create Chunk Records:**
   ```typescript
   const chunkRecords = embeddings.map((emb, idx) => ({
     id: nanoid(),
     agentId: source.agentId,
     sourceId: source.id,
     text: emb.content.substring(0, 1000), // Store preview only in DB
     meta: {
       ...parsed.metadata,
       sourceId,
       fileName,
       chunkIndex: idx,
       textLength: emb.content.length  // Store full length for reference
     },
     embeddingDim: emb.embedding.length,
     indexVersion: newVersion,
     vectorizeId: chunkId,  // Same as chunk.id
     createdAt: new Date()
   }));
   ```

5. **Batch Insert into Database:**
   ```typescript
   // Batch insert chunks (previews only) to avoid SQLite limits
   const MAX_ROWS_PER_BATCH = 50;
   for (const batch of chunkArray(chunkRecords, MAX_ROWS_PER_BATCH)) {
     await db.insert(chunk).values(batch);
   }
   ```

6. **Insert into Vectorize (Full Text in Metadata):**
   ```typescript
   const vectors = embeddings.map((emb, idx) => ({
     id: chunkRecords[idx].vectorizeId,
     values: emb.embedding,
     namespace: source.agentId,  // AGENT-BASED NAMESPACE
     metadata: {
       sourceId: source.id,
       chunkId: chunkRecords[idx].id,
       agentId: source.agentId,
       fileName: source.fileName,
       indexVersion: newVersion,
       chunkIndex: idx,
       textLength: emb.content.length,
       text: emb.content  // FULL TEXT stored in Vectorize metadata
     }
   }));
   
   await env.VECTORIZE.insert(vectors);
   ```

7. **Update Status:**
   ```typescript
   await db.update(knowledgeSource)
     .set({ status: "indexed" })
     .where(eq(knowledgeSource.id, sourceId));
   ```

8. **Return Results:**
   ```typescript
   return {
     success: true,
     chunksCreated: chunkRecords.length,
     vectorsInserted: vectorizeResult.ids.length,
     vectorIds: vectorizeResult.ids,
     indexVersion: newVersion
   };
   ```

## Query Operations

### Vector Similarity Search

**Location:** `src/integrations/trpc/router/knowledge.ts` - `query` procedure

```typescript
trpc.knowledge.query.mutate({
  agentId: "clx123abc",
  query: "What is the sales policy?",
  topK: 5
});
```

**Server Actions:**

1. **Verify Access:**
   - Check agent exists
   - Verify user has permission

2. **Generate Query Embedding:**
   ```typescript
   const embeddings = await generateEmbeddings(query, {
     model: "text-embedding-3-small",
     dimensions: 1536
   });
   ```

3. **Query Vectorize with Namespace:**
   ```typescript
   const results = await env.VECTORIZE.query(
     embeddings[0].embedding,
     {
       topK: input.topK,
       namespace: input.agentId,  // AGENT-SCOPED
       returnMetadata: true
     }
   );
   ```

4. **Return Formatted Results:**
   ```typescript
   return {
     matches: results.matches.map(match => ({
       id: match.id,
       score: match.score,
       text: match.metadata?.text,  // FULL TEXT from Vectorize metadata
       fileName: match.metadata?.fileName,
       sourceId: match.metadata?.sourceId
     }))
   };
   ```

**Key Point:** The `namespace` parameter ensures the query only searches within the specified agent's vectors, providing complete isolation.

### List Knowledge Sources

**Location:** `src/integrations/trpc/router/knowledge.ts` - `list` procedure

```typescript
trpc.knowledge.list.query({
  agentId: "clx123abc",
  status: "indexed"  // optional filter
});
```

**Returns all knowledge sources for an agent, optionally filtered by status.**

## Delete Operations

### Complete Cleanup

**Location:** `src/lib/ai/ingestion.ts` - `deleteKnowledgeSource`

```typescript
await deleteKnowledgeSource(sourceId);
```

**Actions:**

1. **Fetch Source Record:**
   ```typescript
   const [source] = await db.select()
     .from(knowledgeSource)
     .where(eq(knowledgeSource.id, sourceId));
   ```

2. **Get Associated Chunks:**
   ```typescript
   const chunks = await db.select()
     .from(chunk)
     .where(eq(chunk.sourceId, sourceId));
   ```

3. **Delete from Vectorize:**
   ```typescript
   const vectorIds = chunks
     .map(c => c.vectorizeId)
     .filter(id => id !== null);
   
   if (vectorIds.length > 0) {
     await env.VECTORIZE.deleteByIds(vectorIds);
     // Note: namespace parameter not needed for deleteByIds in beta API
   }
   ```

4. **Delete from R2:**
   ```typescript
   if (source.r2Key) {
     await env.R2.delete(source.r2Key);
   }
   ```

5. **Delete from Database:**
   ```typescript
   await db.delete(knowledgeSource)
     .where(eq(knowledgeSource.id, sourceId));
   // Cascade delete will remove chunks automatically
   ```

**Error Handling:** If Vectorize or R2 deletion fails, the operation logs the error but continues to ensure database cleanup happens.

## Environment Bindings

### Wrangler Configuration

**Location:** `wrangler.jsonc`

```json
{
  "d1_databases": [{
    "binding": "DB",
    "database_name": "poprag",
    "database_id": "61d8695d-37c8-483c-b46d-7e840958b1b0"
  }],
  "r2_buckets": [{
    "binding": "R2",
    "bucket_name": "poprag"
  }],
  "vectorize": [{
    "binding": "VECTORIZE",
    "index_name": "poprag"
  }],
  "ai": {
    "binding": "AI"
  }
}
```

### TypeScript Types

**Location:** `src/lib/types/cloudflare.ts`

```typescript
export interface CloudflareEnv {
  DB: D1Database;
  R2: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  OPENAI_API_KEY?: string;
  // ... other env vars
}
```

**Vectorize Interface includes namespace support:**

```typescript
export interface VectorizeIndex {
  query(vector: number[], options?: {
    topK?: number;
    namespace?: string;  // Agent-based isolation
    filter?: Record<string, unknown>;
    returnMetadata?: boolean | "indexed" | "all";
  }): Promise<VectorizeQueryResult>;

  insert(vectors: Array<{
    id: string;
    values: number[];
    namespace?: string;  // Agent-based isolation
    metadata?: Record<string, unknown>;
  }>): Promise<VectorizeUpsertResult>;

  deleteByIds(ids: string[]): Promise<VectorizeDeleteResult>;
}
```

## Security & Access Control

### Authorization Checks

All operations verify:

1. **Agent Exists:** Query database to confirm agent record
2. **User Has Access:** 
   - Admin users can access all agents
   - Non-admin users can only access agents they created
   ```typescript
   if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
     throw new Error("Access denied");
   }
   ```

### Audit Logging

All mutations create audit log entries:

```typescript
await db.insert(auditLog).values({
  id: nanoid(),
  actorId: ctx.session.user.id,
  eventType: "knowledge.uploaded" | "knowledge.indexed" | "knowledge.deleted",
  targetType: "knowledge_source",
  targetId: sourceId,
  diff: { /* operation-specific data */ },
  createdAt: new Date()
});
```

## Error Handling

### Status Tracking

Knowledge sources track status through lifecycle:

```
uploaded → parsed → indexed
         ↓
       failed
```

### Error Capture

```typescript
try {
  // Processing logic
} catch (error) {
  await db.update(knowledgeSource)
    .set({
      status: "failed",
      parserErrors: [error.message],
      updatedAt: new Date()
    })
    .where(eq(knowledgeSource.id, sourceId));
  
  throw error;  // Re-throw for client
}
```

## Best Practices

### 1. Consistent ID Usage

- Use agentId (not slug) in R2 keys and Vectorize namespaces
- Use same ID for chunk and vectorizeId to simplify lookups
- Generate IDs with nanoid() for collision resistance

### 2. Metadata Management

**R2 Custom Metadata:**
```typescript
customMetadata: {
  sourceId,
  fileName,
  checksum,
  uploadedAt: timestamp
}
```

**Vectorize Metadata (Full Text Storage):**
```typescript
metadata: {
  sourceId,
  chunkId,
  agentId,
  fileName,
  indexVersion,
  chunkIndex,
  textLength,
  text: fullChunkText  // Complete chunk content
}
```

### 3. Namespace Isolation

**Always use namespace parameter in Vectorize operations:**
- `insert()` - set namespace: agentId
- `query()` - set namespace: agentId
- This ensures complete vector space isolation

### 4. Transaction Safety

- Update database status before/after each operation
- Log errors without blocking cleanup operations
- Use cascade deletes in schema for referential integrity

### 5. Performance Optimization

- Batch vector inserts (single call for all chunks)
- Use metadata filtering in Vectorize for refined searches
- Index database columns used in queries (agentId, status)

## Scaling Considerations

### R2 Limits
- Max object size: 5TB
- Max single PUT: 5GB
- Unlimited buckets per account
- No bandwidth egress charges

### Vectorize Limits (Per Index)
- Free: 1,000 namespaces, 100,000 vectors
- Paid: 50,000 namespaces, 5M vectors
- Max dimensions: 1536 (matches text-embedding-3-small)
- Max metadata per vector: 10 KiB

### D1 Database
- Max database size: 10GB (can increase)
- Max query size: 1MB
- Connection pooling handled by Cloudflare

## Testing Multi-Tenant Isolation

### Verification Steps

1. **Create two agents** (Agent A, Agent B)

2. **Upload knowledge to Agent A:**
   ```typescript
   await trpc.knowledge.uploadStart.mutate({
     agentId: agentA.id,
     fileName: "doc-a.txt",
     // ...
   });
   // Complete upload + indexing
   ```

3. **Upload knowledge to Agent B:**
   ```typescript
   await trpc.knowledge.uploadStart.mutate({
     agentId: agentB.id,
     fileName: "doc-b.txt",
     // ...
   });
   // Complete upload + indexing
   ```

4. **Query Agent A:**
   ```typescript
   const resultsA = await trpc.knowledge.query.mutate({
     agentId: agentA.id,
     query: "test query"
   });
   // Should ONLY return matches from Agent A's vectors
   ```

5. **Query Agent B:**
   ```typescript
   const resultsB = await trpc.knowledge.query.mutate({
     agentId: agentB.id,
     query: "test query"
   });
   // Should ONLY return matches from Agent B's vectors
   ```

6. **Verify R2 Keys:**
   ```
   agents/agentA-id/sources/... (Agent A files)
   agents/agentB-id/sources/... (Agent B files)
   ```

7. **Delete Agent A knowledge:**
   ```typescript
   await trpc.knowledge.delete.mutate({
     sourceId: agentA_sourceId
   });
   ```
   - Verify R2 object deleted
   - Verify Vectorize vectors removed
   - Verify database records removed
   - Verify Agent B knowledge unaffected

## Monitoring & Observability

### Console Logging

Key operations log to console:

```typescript
console.log(`Inserted ${count} vectors into namespace: ${agentId}`);
console.log(`Deleted ${count} vectors from namespace: ${agentId}`);
console.log(`Deleted R2 object: ${r2Key}`);
```

### Audit Logs

All mutations tracked in `audit_log` table with:
- Actor (user who performed action)
- Event type
- Target resource
- Diff (operation-specific changes)
- Timestamp

### Metrics to Track

- Upload success/failure rates
- Indexing duration by file size
- Vector query latency
- R2 storage usage per agent
- Vectorize namespace utilization

## Future Enhancements

### 1. Batch Operations
- Bulk upload multiple files
- Batch delete multiple sources

### 2. Reindexing
- Version control for embeddings
- Ability to reindex with different embedding models
- Pin specific index versions

### 3. Advanced Parsing
- PDF parsing with WASM libraries
- DOCX/Excel parsing
- Image text extraction (OCR)

### 4. Metadata Indexing
- Configure Vectorize indexed metadata fields
- Use metadata filters for refined searches

### 5. Chunking Strategies
- Configurable chunk size
- Overlapping chunks
- Semantic chunking

### 6. Presigned URLs
- Direct client uploads to R2 (bypassing server)
- Improved upload performance for large files

## Conclusion

This implementation provides a production-ready, multi-tenant knowledge management system with:

✅ Complete agent-based isolation in R2 and Vectorize  
✅ Proper error handling and status tracking  
✅ Full CRUD operations for knowledge sources  
✅ Vector similarity search with namespace scoping  
✅ Comprehensive audit logging  
✅ Type-safe implementations  
✅ Scalable architecture following Cloudflare best practices  

All operations respect agent boundaries, ensuring no cross-agent data leakage in uploads, queries, or deletions.
