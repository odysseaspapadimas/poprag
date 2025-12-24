# Refactoring Targets

> Analysis of code areas that would benefit from refactoring, cleanup, or simplification.
> 
> **Status**: Last updated after refactoring session. Items marked with ✅ have been addressed.

---

## 🔴 High Priority

### 1. ✅ `handleChatRequest` Function - God Function Anti-pattern

**File**: [src/lib/ai/chat.ts](../src/lib/ai/chat.ts)

**Status**: REFACTORED

**Changes Made**:
- Extracted RAG pipeline to [src/lib/ai/rag-pipeline.ts](../src/lib/ai/rag-pipeline.ts)
- Extracted image processing to [src/lib/ai/image-service.ts](../src/lib/ai/image-service.ts)
- Extracted model resolution to [src/lib/ai/helpers.ts](../src/lib/ai/helpers.ts)
- Created helper functions: `resolveAgent()`, `loadPromptConfig()`, `loadModelPolicy()`, etc.
- Main function now delegates to extracted modules

---

### 2. ✅ Duplicated Model Resolution Logic

**Status**: REFACTORED

**Changes Made**:
- Created [src/lib/ai/helpers.ts](../src/lib/ai/helpers.ts) with:
  - `resolveAndCreateModel()` - Single function for model resolution
  - `resolveModelConfig()` - Get provider/modelId from alias
  - `getDefaultModel()` - Fallback for missing aliases
- All model lookups now use the centralized helper

---

### 3. Schema Naming Inconsistencies

**File**: [src/db/schema.ts](../src/db/schema.ts#L248-L261)

**Problem**: The `documentChunks` table has confusing column-to-property mappings:
```typescript
documentId: text("source_id")  // Property is documentId, column is source_id
sessionId: text("agent_id")    // Property is sessionId, column is agent_id
```

**Status**: NOT ADDRESSED - Requires migration

**Note**: Fixing this requires a database migration and updating all references. Deferred due to risk of data issues.

---

## 🟡 Medium Priority

### 4. ✅ Hardcoded Model IDs and Magic Strings

**Status**: REFACTORED

**Changes Made**:
- Created [src/lib/ai/constants.ts](../src/lib/ai/constants.ts) with:
  - `DEFAULT_MODELS` - Centralized model ID definitions
  - `EMBEDDING_CONFIG` - Embedding settings
  - `CHUNKING_CONFIG` - Document chunking defaults
  - `RAG_CONFIG` - RAG pipeline configuration
- All files now import from constants

---

### 5. Inconsistent Error Handling in RAG Pipeline

**File**: [src/lib/ai/rag-pipeline.ts](../src/lib/ai/rag-pipeline.ts)

**Status**: PARTIALLY ADDRESSED

**Changes Made**:
- FTS operations wrapped in try-catch with graceful fallback
- Consistent logging for errors
- Functions return safe defaults on failure

**Remaining**: Could benefit from a formal `RAGResult<T>` type for more explicit error handling.

---

### 6. ✅ Deeply Nested Conditional Logic

**Status**: REFACTORED

**Changes Made**:
- Extracted RAG flow to `performRAGRetrieval()` in [rag-pipeline.ts](../src/lib/ai/rag-pipeline.ts)
- Used early returns in `classifyQueryIntent()` and `rewriteQuery()`
- Main chat handler now has flat structure with clear phases

---

### 7. ✅ Repeated Agent Verification Pattern

**Status**: REFACTORED

**Changes Made**:
- Created [src/integrations/trpc/helpers.ts](../src/integrations/trpc/helpers.ts) with:
  - `requireAgent()` - Get agent by ID, throw if not found
  - `requireAgentBySlug()` - Get agent by slug
  - `getAgent()` - Optional agent lookup
  - `requireActiveAgent()` - Verify agent is active
- Updated all tRPC routers to use these helpers

---

### 8. ✅ Image Processing in Chat Handler

**Status**: REFACTORED

**Changes Made**:
- Created [src/lib/ai/image-service.ts](../src/lib/ai/image-service.ts) with:
  - `fetchImageAsBase64()` - R2 fetch and conversion
  - `processImagePart()` - Convert chat image reference to payload
  - `processMessageParts()` - Batch process message parts
- Chat handler now calls the image service for all image processing

---

## 🟢 Low Priority (Technical Debt)

### 9. ✅ Unused Code & Dead Patterns

**Status**: CLEANED UP

**Changes Made**:
- Uncommented OpenRouter provider in [models.ts](../src/lib/ai/models.ts) (was valid code)
- Removed `EMBEDDING_DIMENSIONS` constant from [embedding.ts](../src/lib/ai/embedding.ts)
- Removed unused parameters from `findRelevantContent()`:
  - `indexVersion`
  - `keywords`
  - `useHybridSearch`

---

### 10. Console Logging Instead of Proper Logger

**Files**: Multiple files throughout `src/lib/ai/`

**Status**: NOT ADDRESSED

**Note**: Would require adding a logging library and updating all log calls. Lower priority as current logging is functional for debugging.

---

### 11. ✅ Type Safety Issues

**Status**: FIXED

**Changes Made**:
- Fixed `any[]` to `SQL[]` in [agent.ts](../src/integrations/trpc/router/agent.ts#L295)
- Added proper type imports where needed

---

### 12. ✅ Audit Log Duplication

**Status**: REFACTORED

**Changes Made**:
- Created audit helpers in [src/integrations/trpc/helpers.ts](../src/integrations/trpc/helpers.ts):
  - `createAuditLog()` - Core audit function
  - `audit()` - Shorthand for tRPC context
  - `AuditEventType` - Type-safe event names
  - `AuditTargetType` - Type-safe target types
- Updated all tRPC routers to use `audit()` helper:
  - [agent.ts](../src/integrations/trpc/router/agent.ts)
  - [knowledge.ts](../src/integrations/trpc/router/knowledge.ts)
  - [prompt.ts](../src/integrations/trpc/router/prompt.ts)
  - [chat.ts](../src/integrations/trpc/router/chat.ts)

---

### 13. Missing Batch Operations

**File**: [src/lib/ai/embedding.ts](../src/lib/ai/embedding.ts)

**Status**: NOT ADDRESSED

**Note**: FTS queries use UNION now via `OR` in the MATCH clause, but could still benefit from further optimization.

---

### 14. Large Component with Mixed Concerns

**File**: [src/components/chat.tsx](../src/components/chat.tsx)

**Status**: NOT ADDRESSED

**Note**: Component refactoring is lower priority. The chat component works but could be split for better maintainability.

---

## Summary

| Priority | Total | Completed | Status |
|----------|-------|-----------|--------|
| 🔴 High | 3 | 2 | Schema naming deferred |
| 🟡 Medium | 5 | 4 | Error handling partial |
| 🟢 Low | 6 | 4 | Logger, FTS batch, component deferred |

### Completed ✅
- Model resolution helper
- Constants file for default models
- Dead code and unused parameters removed
- RAG pipeline extraction
- Audit logging helper
- Agent verification helpers
- Type safety fixes
- Image service extraction

### Remaining
- Schema naming inconsistencies (requires migration)
- Formal error result types for RAG
- Structured logging system
- FTS batch optimization
- Chat component split
