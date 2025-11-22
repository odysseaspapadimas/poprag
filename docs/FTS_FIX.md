# FTS Index Corruption Fix

## Problem

You may encounter the following error when searching documents:

```
D1_ERROR: fts5: missing row X from content table 'main'.'document_chunks': SQLITE_CORRUPT
```

This indicates that your Full-Text Search (FTS) index (`document_chunks_fts`) is out of sync with the content table (`document_chunks`). This typically happens when:

1. Rows were deleted from `document_chunks` but not from the FTS index
2. The database was restored from a backup without the FTS index
3. Direct SQL operations were performed that bypassed FTS triggers

## Solution

### Quick Fix

Run the FTS rebuild script:

```bash
pnpm db:rebuild-fts
```

This will:
1. Drop the existing corrupted FTS table
2. Recreate the FTS virtual table
3. Rebuild the index from current `document_chunks` data
4. Optimize the index for performance

### Manual Fix (Alternative)

If you prefer to fix it manually via SQL:

```sql
-- 1. Drop the corrupted FTS table
DROP TABLE IF EXISTS document_chunks_fts;

-- 2. Recreate the FTS virtual table
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  id UNINDEXED,
  text,
  content='document_chunks',
  content_rowid='rowid'
);

-- 3. Rebuild the index
INSERT INTO document_chunks_fts(rowid, id, text)
SELECT rowid, id, text FROM document_chunks;

-- 4. Optimize (optional but recommended)
INSERT INTO document_chunks_fts(document_chunks_fts) VALUES('optimize');
```

## Prevention

To prevent FTS corruption in the future:

1. **Use Drizzle ORM operations** - Don't run direct SQL DELETE operations on `document_chunks`
2. **Maintain FTS triggers** - Ensure the FTS table has proper triggers for INSERT/UPDATE/DELETE
3. **Backup both tables** - When backing up, include both `document_chunks` and `document_chunks_fts`

## Graceful Degradation

The system is designed to handle FTS failures gracefully:

- If FTS search fails, the system automatically falls back to **vector-only search**
- Chat functionality continues to work using semantic similarity search via Vectorize
- You'll see warning logs but the application won't crash

The hybrid search provides better results, but vector search alone is still highly effective for RAG queries.

## Technical Details

The FTS table uses SQLite's FTS5 extension with:
- **Content table**: `document_chunks` - stores actual document text
- **FTS virtual table**: `document_chunks_fts` - stores search index
- **Content rowid mapping**: Links FTS entries to source rows

When the mapping breaks (missing rows), SQLite returns `SQLITE_CORRUPT` errors.
