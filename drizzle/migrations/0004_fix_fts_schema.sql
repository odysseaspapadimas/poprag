-- Fix FTS schema to match the document_chunks table schema
-- The FTS table was missing source_id and agent_id columns

-- Step 1: Drop the old triggers
DROP TRIGGER IF EXISTS document_chunks_ai;
DROP TRIGGER IF EXISTS document_chunks_au;
DROP TRIGGER IF EXISTS document_chunks_ad;

-- Step 2: Drop the existing FTS table
DROP TABLE IF EXISTS document_chunks_fts;

-- Step 3: Recreate the FTS table with correct schema
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
    id UNINDEXED,
    source_id UNINDEXED,
    text,
    agent_id UNINDEXED,
    content = 'document_chunks',
    content_rowid = 'rowid'
);

-- Step 4: Recreate the triggers with correct schema
CREATE TRIGGER document_chunks_ai
AFTER INSERT ON document_chunks
BEGIN
INSERT INTO document_chunks_fts(rowid, id, source_id, text, agent_id)
VALUES (new.rowid, new.id, new.source_id, new.text, new.agent_id);
END;

CREATE TRIGGER document_chunks_au
AFTER UPDATE ON document_chunks
BEGIN
DELETE FROM document_chunks_fts WHERE rowid = old.rowid;
INSERT INTO document_chunks_fts(rowid, id, source_id, text, agent_id)
VALUES (new.rowid, new.id, new.source_id, new.text, new.agent_id);
END;

CREATE TRIGGER document_chunks_ad
AFTER DELETE ON document_chunks
BEGIN
DELETE FROM document_chunks_fts WHERE rowid = old.rowid;
END;

-- Step 5: Rebuild the index from current data (if any exists)
INSERT INTO document_chunks_fts(rowid, id, source_id, text, agent_id)
SELECT rowid, id, source_id, text, agent_id FROM document_chunks;
