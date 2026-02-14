# FTS Index Corruption Fix

## Problem

You may encounter the following error when searching documents:

```
D1_ERROR: fts5: missing row X from content table 'main'.'document_chunks': SQLITE_CORRUPT
```

This indicates that your Full-Text Search (FTS) index (`document_chunks_fts`) is out of sync with the content table (`document_chunks`).

### Root Cause (Fixed in Migration 0017)

Prior to migration `0017_fix_fts_delete_commands.sql`, the FTS triggers used incorrect SQL syntax for external content tables:

```sql
-- INCORRECT (used before migration 0017)
DELETE FROM document_chunks_fts WHERE rowid = old.rowid;
```

For FTS5 external content tables (`content = 'document_chunks'`), this causes FTS5 to look up the row in `document_chunks` to determine what to remove. But in an `AFTER DELETE` trigger, the row is already gone from the content table. FTS5 silently fails and leaves orphaned index entries, which eventually cause `SQLITE_CORRUPT` errors.

The correct syntax for external content FTS5 tables is the **delete command**, which explicitly provides the old values:

```sql
-- CORRECT (fixed in migration 0017)
INSERT INTO document_chunks_fts(document_chunks_fts, rowid, id, source_id, text, agent_id)
VALUES('delete', old.rowid, old.id, old.source_id, old.text, old.agent_id);
```

## Solution

### If You See This Error

Run the migration to fix the triggers and rebuild the index:

```bash
# Apply the fix migration
wrangler d1 migrations apply poprag --remote

# Or use the rebuild script (does the same thing)
pnpm db:rebuild-fts
```

This will:
1. Drop the existing corrupted FTS table and old triggers
2. Recreate the FTS virtual table with correct schema
3. Create triggers using the correct FTS5 delete command syntax
4. Rebuild the index from current `document_chunks` data
5. Optimize the index for performance

### After Migration 0017

Once migration 0017 is applied, FTS corruption **will not happen again**. The triggers now use the correct FTS5 delete command syntax, so all delete operations (cascade FK deletes, reindexing, manual deletes) will properly clean up the FTS index.

## Prevention

The migration permanently fixes the issue. No manual intervention needed. The corrected triggers handle:

1. **Cascade deletes** - When a `knowledgeSource` is deleted, child `document_chunks` cascade delete and trigger FTS cleanup
2. **Reindexing** - Direct `DELETE` operations during reindex properly clean FTS entries
3. **Manual deletes** - Any future deletes will use the correct FTS5 delete command

If restoring from a backup, ensure you run migrations to get the correct trigger definitions.

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
