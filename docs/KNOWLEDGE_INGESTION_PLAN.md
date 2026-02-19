# Knowledge Ingestion Pipeline Plan

## Goal

Build a production-ready knowledge ingestion pipeline that:

1. Fixes a critical binary file corruption bug affecting all non-PDF files > 1MB
2. Raises the file size limit from 10MB to 50MB
3. Moves ingestion to async processing via Cloudflare Queues (to handle large files without Worker CPU timeouts)
4. Updates the UI to reflect new limits and show async indexing progress
5. **(Deferred)** Extracts and vision-describes images embedded in Excel product catalog files so users can photo-search products by visual appearance

### Broader Context

Product catalog use case: Excel files contain rows of products (name, description, calories, etc.) with embedded product images. End goal: a user takes a photo of a product and asks "how many calories does this have?" and the RAG system answers correctly. This requires a multimodal ingestion + retrieval pipeline (Option A: vision-described text embeddings).

---

## Phases

### Phase 0 — Bug Fixes (implement now)

#### Phase 0.1 — Fix Binary File Corruption

**Bug:** In `src/integrations/trpc/router/knowledge.ts`, three procedures use `r2Object.text()` for all non-PDF files:

- `index` procedure (~lines 247–252)
- `reindex` procedure (~lines 425–430)
- `bulkReindex` inner function (~lines 845–850)

Binary formats (Excel `.xlsx`, `.docx`, `.ods`, images, etc.) get corrupted when decoded as UTF-8 strings via `.text()`. This causes `parseDocument()` in `ingestion.ts` to skip the `AI.toMarkdown()` path entirely — it is guarded by `typeof content !== "string"` — and fall through to returning raw binary garbage as text. **Large Excel files are silently broken right now.**

**Fix:** For all three locations, replace the branching logic with `arrayBuffer()` for all formats, not just PDFs:

```typescript
// Before (broken for binary formats):
if (source.mime === "application/pdf") {
  const arrayBuffer = await r2Object.arrayBuffer();
  content = Buffer.from(arrayBuffer);
} else {
  content = await r2Object.text();  // ← corrupts binary files
}

// After (correct):
const arrayBuffer = await r2Object.arrayBuffer();
content = Buffer.from(arrayBuffer);
```

This works because `parseDocument()` already handles text-based formats (plain text, markdown, CSV, HTML) by calling `.toString("utf-8")` on the buffer — so passing a Buffer is safe for all formats.

#### Phase 0.2 — Add Server-Side File Size Validation

**Bug:** `uploadStart` in `knowledge.ts` accepts `bytes: z.number()` with no maximum. The 10MB limit is enforced client-side only by react-dropzone — trivially bypassed.

**Fix:** After raising the limit (Phase 1), add server-side validation to `uploadStart`:

```typescript
bytes: z.number().max(MAX_KNOWLEDGE_FILE_SIZE, "File exceeds maximum size"),
```

---

### Phase 1 — Raise File Size Limit to 50MB (implement now)

**Why it's safe:** Files go directly to R2 via presigned PUT URL, bypassing the Worker body. The upload step has no Worker size constraint. The bottleneck is synchronous ingestion inside the Worker (addressed by Phase 5).

**Changes:**

1. **`src/lib/ai/constants.ts`** — Add a shared constant:
   ```typescript
   export const MAX_KNOWLEDGE_FILE_SIZE = 50 * 1024 * 1024; // 50MB
   ```

2. **`src/components/ui/file-upload.tsx`** — Update the default `maxSize` param from `10 * 1024 * 1024` to import and use `MAX_KNOWLEDGE_FILE_SIZE`.

3. **`src/components/knowledge-upload-dialog.tsx`** — Update the `maxSize` prop passed to `<FileUpload>` to use `MAX_KNOWLEDGE_FILE_SIZE`.

4. **`src/integrations/trpc/router/knowledge.ts`** — Use `MAX_KNOWLEDGE_FILE_SIZE` in the `uploadStart` Zod validation (see Phase 0.2).

---

### Phase 5 — Async Ingestion via Cloudflare Queues (implement now)

**Why needed:** Synchronous ingestion inside a Worker hits CPU time limits for large files. Vision API calls and many embedding batches can easily exceed Worker limits for 50MB files.

#### Schema Changes (`src/db/schema.ts`)

Add `"processing"` to the `knowledgeSource.status` enum and add a `progress` integer column (0–100):

```typescript
status: text("status", {
  enum: ["uploaded", "parsed", "processing", "indexed", "failed"],
})
  .default("uploaded")
  .notNull(),
progress: integer("progress").default(0),
```

Generate and apply a migration after this change (`pnpm db:generate && pnpm db:push`).

#### Queue Configuration (`wrangler.jsonc`)

Add producer and consumer bindings for a new queue named `knowledge-index-queue`:

```jsonc
"queues": {
  "producers": [
    {
      "binding": "knowledge-index-queue",
      "queue": "knowledge-index-queue"
    }
  ],
  "consumers": [
    {
      "queue": "knowledge-index-queue",
      "max_batch_size": 1,
      "max_retries": 3,
      "dead_letter_queue": "knowledge-index-dlq"
    }
  ]
}
```

Create the queue via the Cloudflare dashboard or `wrangler queues create knowledge-index-queue`.

#### Queue Message Schema

```typescript
interface KnowledgeIndexMessage {
  sourceId: string;
  agentId: string;
}
```

#### `index` tRPC Procedure Changes (`src/integrations/trpc/router/knowledge.ts`)

Instead of calling `processKnowledgeSource()` synchronously, enqueue the job:

```typescript
// Set status to "processing" so UI can poll for it
await db.update(knowledgeSource)
  .set({ status: "processing", progress: 0, updatedAt: new Date() })
  .where(eq(knowledgeSource.id, input.sourceId));

// Enqueue for async processing
const { env } = await import("cloudflare:workers");
await env.knowledge-index-queue.send({
  sourceId: input.sourceId,
  agentId: source.agentId,
});

return { queued: true, sourceId: input.sourceId };
```

> **Small file optimization:** For files < 1MB that already pass `contentBuffer` inline, we can still process synchronously to keep the fast path for small uploads. Only fall through to the queue for files without inline content.

#### Queue Consumer Handler

Create `src/lib/ai/queue-consumer.ts` (or add to the Worker entry point):

```typescript
export async function handleKnowledgeIndexQueue(
  batch: MessageBatch<KnowledgeIndexMessage>
): Promise<void> {
  for (const message of batch.messages) {
    const { sourceId } = message.body;
    try {
      // Fetch file from R2 (always — no inline content in queue messages)
      const source = await getSourceFromDb(sourceId);
      const r2Object = await env.R2.get(source.r2Key);
      const content = Buffer.from(await r2Object.arrayBuffer());

      await processKnowledgeSource(sourceId, content, {
        // Write progress updates back to D1 via streamResponse callback
        streamResponse: async ({ progress }) => {
          if (progress != null) {
            await db.update(knowledgeSource)
              .set({ progress: Math.round(progress) })
              .where(eq(knowledgeSource.id, sourceId));
          }
        },
      });

      message.ack();
    } catch (error) {
      message.retry();
    }
  }
}
```

Wire this up to the Worker's `queue` export handler.

#### `processKnowledgeSource` Progress Updates (`src/lib/ai/ingestion.ts`)

The `streamResponse` callback already exists and is called with `progress` on each embedding batch. The queue consumer wires it up to write `progress` to D1 — no changes needed to `ingestion.ts` itself.

---

### Phase 6 — UI Updates (implement now)

#### Upload Dialog (`src/components/knowledge-upload-dialog.tsx`)

- Update `maxSize` prop to use the shared constant
- After triggering indexing (which now returns `{ queued: true }`), instead of showing "Complete!", begin polling for status
- Show a "Indexing in background..." state with the progress value from `knowledgeSource.progress`

#### Polling Logic

Use a polling loop in the upload dialog (or a dedicated hook) after the queue is triggered:

```typescript
// Poll until status is "indexed" or "failed"
const pollStatus = async (sourceId: string) => {
  const interval = setInterval(async () => {
    const status = await trpc.knowledge.status.query({ sourceId });
    setUploadProgress({
      fileName: file.name,
      stage: status.status === "processing"
        ? `Indexing... (${status.progress ?? 0}%)`
        : status.status,
      progress: status.progress ?? 0,
    });
    if (status.status === "indexed" || status.status === "failed") {
      clearInterval(interval);
      // Invalidate list query, show toast, etc.
    }
  }, 2000); // poll every 2s
};
```

#### Knowledge Source List

Update the status badge in the knowledge sources list to show `"processing"` as a spinner/progress state rather than an unknown value. The `statusCounts` object in `healthOverview` should also include `processing`.

#### File Size Display

The `file-upload.tsx` component already dynamically shows `(maxSize / (1024 * 1024)).toFixed(0) MB each` — this will update automatically once `maxSize` is changed to 50MB.

---

### Phase 2 — Excel Image Extraction with SheetJS (deferred)

**Why deferred:** Needs empirical testing of whether `AI.toMarkdown()` already handles embedded Excel images before investing in SheetJS. Also, SheetJS (ExcelJS) adds significant bundle size and complexity — only worth it if `AI.toMarkdown()` doesn't handle this.

**Approach (when ready):**

- Parse `.xlsx` files with SheetJS to extract embedded image blobs
- For each image, call `AI.toMarkdown()` with the image blob to get a vision description
- Append vision descriptions as additional text chunks: `"[Product Image: {description}]"`
- Embed these additional chunks alongside the normal cell-content chunks

---

### Phase 3 — Vision Descriptions at Ingestion Time (deferred)

Depends on Phase 2. Vision API calls (GPT-4o-mini or Workers AI vision) per embedded image. These will be the main driver of async queue processing being required.

---

### Phase 4 — Query-Time User Photo to RAG Query (deferred)

End-to-end multimodal retrieval:

1. User uploads a photo in chat
2. Chat API calls vision model to describe the photo: `"This appears to be a can of Coca-Cola Zero"`
3. The description is used as the RAG query instead of (or in addition to) any text the user typed
4. Hybrid search finds matching product chunks
5. Answer is generated from retrieved context

This is a chat API change, not an ingestion change.

---

## Files Affected

### Phase 0 + 1

| File | Change |
|------|--------|
| `src/lib/ai/constants.ts` | Add `MAX_KNOWLEDGE_FILE_SIZE = 50 * 1024 * 1024` |
| `src/integrations/trpc/router/knowledge.ts` | Fix `r2Object.text()` → `arrayBuffer()` in 3 locations; add server-side size validation |
| `src/components/ui/file-upload.tsx` | Update default `maxSize` to use shared constant |
| `src/components/knowledge-upload-dialog.tsx` | Update `maxSize` prop to use shared constant |

### Phase 5

| File | Change |
|------|--------|
| `wrangler.jsonc` | Add queue producer + consumer bindings |
| `src/db/schema.ts` | Add `"processing"` to status enum; add `progress` integer column |
| `drizzle/migrations/XXXX_add_processing_status.sql` | Generated migration |
| `src/integrations/trpc/router/knowledge.ts` | `index` procedure enqueues instead of syncing for large files |
| `src/lib/ai/queue-consumer.ts` | New queue consumer handler |

### Phase 6

| File | Change |
|------|--------|
| `src/components/knowledge-upload-dialog.tsx` | Polling loop for async indexing status |
| `src/integrations/trpc/router/knowledge.ts` | `healthOverview` statusCounts includes `"processing"` |

---

## Key Discoveries

- **`AI.toMarkdown()` image handling:** Cloudflare's `AI.toMarkdown()` uses vision models for standalone image files (jpeg, png, webp, svg). Whether it extracts and describes images *embedded within* Excel files is undocumented — needs empirical testing. This is why Phases 2/3 are deferred.
- **OpenAI Assistants limitation:** OpenAI's file search also cannot parse images within documents — explicitly documented. No platform solves this out of the box.
- **Small file optimization:** Files < 1MB are sent inline via `contentBuffer: Uint8Array` in the tRPC payload (avoids R2 download round-trip). This threshold stays at 1MB and is unrelated to the 50MB upload limit.
- **Upload architecture:** Files go directly to R2 via presigned PUT URL. The Worker never touches the file body during upload. The 50MB limit is safe for the upload step.
