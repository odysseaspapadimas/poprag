# AGENTS.md

> Instructions for AI coding agents working on PopRAG

## Project Overview

PopRAG is a multi-agent RAG (Retrieval-Augmented Generation) platform built on Cloudflare infrastructure. It enables creating AI agents with custom knowledge bases, versioned prompts, and configurable model policies.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | TanStack Start (React) with file-based routing |
| Styling | TailwindCSS v4, shadcn/ui components |
| API | tRPC procedures with TanStack Query |
| Database | Drizzle ORM with Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 (files), Vectorize (embeddings) |
| AI | Vercel AI SDK v6, multi-provider (OpenAI, OpenRouter, Workers AI) |
| Auth | Better-auth with session management |
| Runtime | Cloudflare Workers |

## Project Structure

```
src/
├── routes/           # TanStack Router file-based routes
│   ├── __root.tsx    # Root layout with auth context
│   ├── _app/         # Authenticated app routes
│   └── api/          # API routes (chat endpoint)
├── components/       # React components
│   ├── ui/           # shadcn/ui primitives
│   └── *.tsx         # Feature components
├── integrations/
│   └── trpc/router/  # tRPC procedure definitions
│       ├── agent.ts  # Agent CRUD
│       ├── prompt.ts # Prompt versioning
│       ├── knowledge.ts # Knowledge source management
│       ├── chat.ts   # Chat utilities & debug info
│       └── model.ts  # Model alias management
├── lib/ai/           # AI/RAG core logic
│   ├── chat.ts       # Chat request handler with RAG
│   ├── embedding.ts  # Vector search & reranking
│   ├── ingestion.ts  # Document parsing & chunking
│   ├── models.ts     # AI provider configuration
│   └── prompt.ts     # Prompt rendering & RAG context injection
├── db/
│   ├── schema.ts     # Drizzle schema definitions
│   └── index.ts      # Database client
└── styles/
    └── app.css       # Global styles
```

## Commands

```bash
# Development
pnpm dev              # Start dev server
pnpm build            # Build for production
pnpm check            # Lint & format with Biome

# Database
pnpm db:push          # Push schema to D1
pnpm db:generate      # Generate migrations
pnpm db:studio        # Open Drizzle Studio
pnpm db:seed          # Seed test data

# Deployment
wrangler deploy       # Deploy to Cloudflare Workers
```

## Key Patterns

### Routing (TanStack Router)
- File-based routing in `src/routes/`
- Layouts use `_` prefix: `_app/` for authenticated routes
- Route tree auto-generated in `routeTree.gen.ts`
- API routes in `src/routes/api/` use server handlers

### Data Fetching (tRPC + TanStack Query)
```typescript
// In components - use query options
const { data } = useSuspenseQuery(trpc.agent.list.queryOptions());

// Mutations
const mutation = useMutation(trpc.agent.create.mutationOptions());
```

### Chat API Flow
1. POST `/api/chat/$agentSlug` with messages
2. Intent classification skips RAG for trivial messages (greetings, etc.)
3. Conversational query reformulation (condense-question pattern with context)
4. Query rewriting expands user query into variations
5. Hybrid search: Vector (Vectorize) + FTS (D1) with no skip threshold
6. Reciprocal rank fusion merges results
7. Optional reranking with cross-encoder
8. RAG context injected into system prompt with source metadata
9. Streamed response via AI SDK

### RAG Configuration (per agent)
- `ragEnabled` - Enable/disable knowledge retrieval
- `rewriteQuery` - Expand queries for better recall
- `rewriteModel` - Model for query rewriting
- `rerank` - Enable cross-encoder reranking
- `rerankModel` - Model for reranking

### Prompt Versioning
- Prompts stored in `prompt` table, versions in `promptVersion`
- Labels: `dev`, `staging`, `prod`, `none`
- Only `prod` label is used in chat API
- Variables interpolated with `{{variable}}` syntax

### Model Configuration
- Aliases in `modelAlias` table map friendly names to provider/model
- Policies in `agentModelPolicy` set temperature, topP, etc.
- Providers: `openai`, `openrouter`, `workers-ai`, `huggingface`

## Database Schema (Key Tables)

```
agent              # AI agents with RAG config
├── prompt         # Prompt definitions (system, user, etc.)
│   └── promptVersion  # Versioned prompt content
├── knowledgeSource    # Uploaded files/URLs
│   └── documentChunks # Parsed & chunked content
├── agentModelPolicy   # Model settings per agent
└── transcript     # Chat history with RAG debug info

modelAlias         # Provider/model mappings
runMetric          # Performance metrics
chatImage          # Uploaded images for multimodal
```

## Environment

Required bindings in `wrangler.jsonc`:
- `DB` - D1 database
- `R2` - R2 bucket for files
- `VECTORIZE` - Vectorize index
- `AI` - Workers AI binding

API keys in `.env`:
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

## Code Style

- Biome for linting/formatting (`biome.json`)
- TypeScript strict mode
- Zod for runtime validation
- React Hook Form for forms
- Prefer `useSuspenseQuery` over `useQuery`

### Type Safety Guidelines

**IMPORTANT**: Always check for TypeScript errors after making changes that could affect types:
- Adding/modifying interfaces or types
- Changing function signatures or return types
- Updating data structures passed between modules
- Modifying database schema or API responses

Use `get_errors` tool to verify no type errors exist before completing your work. Fix all type errors immediately - do not leave broken types in the codebase.

## Testing Changes

1. Run `pnpm dev` for local development
2. Check browser console for `[Chat]` logs showing RAG flow
3. RAG debug panel in chat UI shows retrieval details
4. Transcripts table stores full request/response with debug info

## Common Tasks

### Add a new tRPC procedure
1. Add to appropriate router in `src/integrations/trpc/router/`
2. Export from `src/integrations/trpc/router/index.ts`
3. Use in components via `trpc.routerName.procedureName`

### Add a new route
1. Create file in `src/routes/` following naming conventions
2. Route tree auto-regenerates on save
3. Use `createFileRoute` for type-safe routes

### Modify RAG behavior
1. Agent-level config in `agent` table columns
2. Chat logic in `src/lib/ai/chat.ts`
3. Embedding/search in `src/lib/ai/embedding.ts`
4. Prompt injection in `src/lib/ai/prompt.ts`
