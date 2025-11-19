# File Type Handling

The ingestion pipeline now properly handles different file types with appropriate parsing and text splitting strategies.

## Supported File Types

### 1. **PDF Files** (`.pdf`)
- **Parser**: `pdf-parse` library (PDFParse)
- **Splitter**: RecursiveCharacterTextSplitter
- **Features**:
  - Extracts text from all pages
  - Preserves document metadata (title, author, creation date)
  - Includes page count information
  - Properly handles multi-page documents

### 2. **Markdown Files** (`.md`, `.markdown`)
- **Parser**: UTF-8 text parsing
- **Splitter**: MarkdownTextSplitter
- **Features**:
  - Preserves markdown structure (headers, lists, code blocks)
  - Respects semantic boundaries (doesn't split mid-section)
  - Better context preservation for RAG
  - Ideal for documentation and technical content

### 3. **Plain Text Files** (`.txt`, `.text`)
- **Parser**: UTF-8 text parsing
- **Splitter**: RecursiveCharacterTextSplitter
- **Features**:
  - Standard text extraction
  - Character-based chunking with smart boundaries

### 4. **CSV/Spreadsheet Files** (planned)
- **Parser**: UTF-8 text parsing (basic support)
- **Splitter**: RecursiveCharacterTextSplitter
- **Note**: Currently treats as plain text. Future enhancement: use `xlsx` or `csv-parse` for structured parsing

## Text Splitting Strategies

### RecursiveCharacterTextSplitter (Default)
- Used for: PDF, plain text, spreadsheets
- Splits text by trying separators in order: `\n\n`, `\n`, ` `, `""`
- Chunk size: 1024 characters
- Chunk overlap: 200 characters
- Best for general content

### MarkdownTextSplitter
- Used for: Markdown files
- Splits by markdown structure:
  - Headers (`#`, `##`, `###`, etc.)
  - Horizontal rules
  - Code blocks
  - Paragraphs
- Chunk size: 1024 characters
- Chunk overlap: 200 characters
- Best for preserving document hierarchy

## Implementation Details

### File Type Detection
1. **MIME type**: Primary detection method
2. **File extension**: Fallback for markdown detection
3. **Content inspection**: Future enhancement for better detection

### Parsing Flow
```typescript
parseDocument(content, mimeType, filename)
  ↓
[PDF Parser | Text Parser]
  ↓
{ content, metadata }
```

### Chunking Flow
```typescript
processKnowledgeSource(sourceId, content)
  ↓
parseDocument() → get text and metadata
  ↓
Select splitter based on file type
  ↓
[MarkdownTextSplitter | RecursiveCharacterTextSplitter]
  ↓
Generate chunks
  ↓
Batch embed chunks (10 at a time)
  ↓
Store in D1 + Vectorize
```

## Configuration

### Adjusting Chunk Size
```typescript
await processKnowledgeSource(sourceId, content, {
  chunkSize: 512,  // Smaller chunks for more precise retrieval
  // or
  chunkSize: 2048  // Larger chunks for more context
});
```

### Custom Chunk Overlap
The overlap ensures context continuity between chunks. Current default: 200 characters (~50 tokens).

## Future Enhancements

1. **Better spreadsheet parsing**: Use `xlsx` library for proper cell extraction
2. **DOCX support**: Add Word document parsing with `mammoth` or `docx`
3. **HTML support**: Add web page parsing with `cheerio`
4. **Code file handling**: Language-specific splitters for source code
5. **Image OCR**: Extract text from images in PDFs
6. **Table extraction**: Preserve table structure in chunks

## Dependencies

```json
{
  "@langchain/textsplitters": "^1.0.0",  // Markdown + Recursive splitters
  "@langchain/community": "^1.0.3",      // LangChain utilities
  "pdf-parse": "^2.4.5"                   // PDF text extraction
}
```

## Error Handling

- **Unsupported file types**: Throws clear error with MIME type
- **PDF parsing failures**: Catches and reports PDF-specific errors
- **Invalid content**: Validates Buffer vs String for PDFs
- **Encoding issues**: Uses UTF-8 for text-based formats

## Testing

To test different file types:

```bash
# Upload markdown file
curl -X POST /api/knowledge/upload \
  -F "file=@README.md" \
  -F "agentId=agent-123"

# Upload PDF file
curl -X POST /api/knowledge/upload \
  -F "file=@document.pdf" \
  -F "agentId=agent-123"
```

Check logs for splitter selection:
- `Using MarkdownTextSplitter for README.md`
- `Using RecursiveCharacterTextSplitter for document.pdf`
