-- Fix FTS triggers to use proper FTS5 "delete command" syntax for external content tables
--
-- The previous triggers used `DELETE FROM document_chunks_fts WHERE rowid = old.rowid`
-- which is WRONG for external content FTS5 tables (content = 'document_chunks').
--
-- With external content tables, FTS5 doesn't store text — it reads it from the content
-- table on demand. A regular DELETE causes FTS5 to look up the content table row to
-- determine which index entries to remove. But in an AFTER DELETE trigger, the row is
-- already gone, so FTS5 silently fails to clean up its index, leaving orphaned entries.
-- These orphaned entries eventually cause SQLITE_CORRUPT errors.
--
-- The correct approach is the FTS5 "delete command": INSERT with the special column name
-- set to 'delete' and all old values provided explicitly.

-- Step 1: Drop the broken triggers
DROP TRIGGER IF EXISTS document_chunks_ai;
DROP TRIGGER IF EXISTS document_chunks_au;
DROP TRIGGER IF EXISTS document_chunks_ad;

-- Step 2: Drop the corrupted FTS table
DROP TABLE IF EXISTS document_chunks_fts;

-- Step 3: Recreate the FTS table
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
    id UNINDEXED,
    source_id UNINDEXED,
    text,
    agent_id UNINDEXED,
    content = 'document_chunks',
    content_rowid = 'rowid'
);

-- Step 4: Recreate triggers with correct FTS5 delete command syntax
CREATE TRIGGER document_chunks_ai AFTER INSERT ON document_chunks
BEGIN
  INSERT INTO document_chunks_fts(rowid, id, source_id, text, agent_id)
  VALUES (new.rowid, new.id, new.source_id, new.text, new.agent_id);
END;

CREATE TRIGGER document_chunks_au AFTER UPDATE ON document_chunks
BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, id, source_id, text, agent_id)
  VALUES('delete', old.rowid, old.id, old.source_id, old.text, old.agent_id);
  INSERT INTO document_chunks_fts(rowid, id, source_id, text, agent_id)
  VALUES (new.rowid, new.id, new.source_id, new.text, new.agent_id);
END;

CREATE TRIGGER document_chunks_ad AFTER DELETE ON document_chunks
BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, id, source_id, text, agent_id)
  VALUES('delete', old.rowid, old.id, old.source_id, old.text, old.agent_id);
END;

-- Step 5: Rebuild the index from current data
INSERT INTO document_chunks_fts(rowid, id, source_id, text, agent_id)
SELECT rowid, id, source_id, text, agent_id FROM document_chunks;

-- Step 6: Optimize the index
INSERT INTO document_chunks_fts(document_chunks_fts) VALUES('optimize');
