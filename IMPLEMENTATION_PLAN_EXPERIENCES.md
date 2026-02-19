# Multi-Experience Agent Implementation Plan

## Overview
Implement **Knowledge Groups** to support 20+ experiences (school books) under a single parent agent. Each experience maps to specific knowledge sources while sharing prompts, model policies, and configuration.

---

## 1. Database Schema Changes

### New Table: `agent_experience`

```typescript
// src/db/schema.ts
export const agentExperience = sqliteTable(
  "agent_experience",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(), // e.g., "math-101", "biology-grade10"
    name: text("name").notNull(),
    description: text("description"),
    order: integer("order").default(0),
    isActive: integer("is_active", { mode: "boolean" })
      .default(true)
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("agent_experience_agent_idx").on(table.agentId),
    index("agent_experience_slug_idx").on(table.agentId, table.slug),
  ],
);
```

### Junction Table: `agent_experience_knowledge`

```typescript
// src/db/schema.ts
export const agentExperienceKnowledge = sqliteTable(
  "agent_experience_knowledge",
  {
    experienceId: text("experience_id")
      .notNull()
      .references(() => agentExperience.id, { onDelete: "cascade" }),
    knowledgeSourceId: text("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.experienceId, table.knowledgeSourceId] }),
    index("agent_exp_knowledge_exp_idx").on(table.experienceId),
    index("agent_exp_knowledge_source_idx").on(table.knowledgeSourceId),
  ],
);
```

---

## 2. API Layer Changes

### Chat Endpoint

```
POST /api/chat/school-books?experience=math-101
```

Extract experience from query params in existing handler:

```typescript
// src/routes/api/chat.$agentSlug.ts
const url = new URL(request.url);
const experienceSlug = url.searchParams.get('experience');

const result = await handleChatRequest(
  {
    agentSlug: params.agentSlug,
    experienceSlug,
    ...validated,
    firebaseUid: firebaseUserData?.uid,
  },
  env,
);
```

```typescript
// src/lib/ai/chat.ts
export interface ChatRequest {
  agentSlug: string;
  experienceSlug?: string | null;
  messages: UIMessage[];
  // ... rest of fields
}
```

When `experienceSlug` is provided:
1. Resolve parent agent by slug
2. Look up experience by agentId + experienceSlug
3. Retrieve associated knowledge source IDs from junction table
4. Pass to RAG pipeline as filter

### RAG Pipeline Updates

```typescript
// src/lib/ai/rag-pipeline.ts
interface RAGConfig {
  // ... existing fields
  experienceKnowledgeIds?: string[];
}

// Filter both vector and FTS queries when experience is specified
if (config.experienceKnowledgeIds) {
  vectorQuery.filter = { knowledgeSourceId: { $in: config.experienceKnowledgeIds } };
  ftsQuery.where(inArray(documentChunks.documentId, config.experienceKnowledgeIds));
}
```

### tRPC Procedures

```typescript
// src/integrations/trpc/router/experience.ts

experience.list       // List experiences for an agent
experience.create     // Create with knowledgeSourceIds
experience.update     // Update name, description, knowledge assignments, isActive
experience.delete     // Delete experience (knowledge sources remain)
experience.bulkCreate // Create multiple at once
```

---

## 3. UI Components

- **ExperienceList**: Table of experiences with knowledge count
- **ExperienceForm**: Create/edit with knowledge source multi-select
- **BulkImportDialog**: Create multiple experiences at once
- **Experience selector** in chat playground (dropdown when agent has experiences)

---

## 4. Backward Compatibility

- `/api/chat/agent-slug` continues to work (searches ALL knowledge)
- `?experience=slug` filters to specific knowledge sources
- Deleting an experience does NOT delete its knowledge sources

---

## 5. Implementation Phases

### Phase 1: Schema & API (Day 1)
- [ ] Add `agent_experience` and `agent_experience_knowledge` tables
- [ ] Create database migration
- [ ] Update chat API to extract experience from query params
- [ ] Modify RAG pipeline to filter by experience knowledge IDs

### Phase 2: tRPC Procedures (Day 2)
- [ ] Implement CRUD procedures for experiences
- [ ] Add bulk creation endpoint

### Phase 3: UI (Day 3-4)
- [ ] Experience list page
- [ ] Experience create/edit form with knowledge selection
- [ ] Update chat playground with experience selector

### Phase 4: Testing & Migration (Day 5)
- [ ] Manual testing checklist
- [ ] Deploy migration
- [ ] Create 20 school book experiences

---

## Design Decisions

### Query Params over Sub-routes
- No new route files, no TanStack Router changes
- Easy to extend to multi-experience queries (`?experience=a,b`)
- Existing URLs work unchanged

---

## Files to Create/Modify

### New Files
- `src/integrations/trpc/router/experience.ts`
- `src/routes/_app/agents/$agentId/experiences.tsx`
- `src/components/experiences/ExperienceList.tsx`
- `src/components/experiences/ExperienceForm.tsx`

### Modified Files
- `src/db/schema.ts` - Add new tables
- `src/lib/ai/chat.ts` - Handle experience parameter
- `src/lib/ai/rag-pipeline.ts` - Filter by experience knowledge
- `src/routes/api/chat.$agentSlug.ts` - Extract query param

---

*Estimated: ~5 days*
