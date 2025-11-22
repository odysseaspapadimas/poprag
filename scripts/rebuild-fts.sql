-- Rebuild FTS index for document_chunks
-- Run this if you get SQLITE_CORRUPT errors related to document_chunks_fts

-- Step 1: Drop the existing FTS table
DROP TABLE IF EXISTS document_chunks_fts;

-- Step 2: Recreate the FTS table
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  id UNINDEXED,
  text,
  content='document_chunks',
  content_rowid='rowid'
);

-- Step 3: Rebuild the index from current data
INSERT INTO document_chunks_fts(rowid, id, text)
SELECT rowid, id, text FROM document_chunks;

-- Step 4: Optimize the index
INSERT INTO document_chunks_fts(document_chunks_fts) VALUES('optimize');