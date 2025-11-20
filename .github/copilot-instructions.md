# PopRAG AI Agent Instructions

## Architecture Overview
PopRAG is a multi-agent RAG platform built on Cloudflare infrastructure. It features:
- **Frontend**: TanStack Start with file-based routing (`src/routes/`), React components, TailwindCSS v4
- **Backend**: tRPC procedures (`src/integrations/trpc/router/`) for agent/prompt/knowledge management
- **Database**: Drizzle ORM with D1 (SQLite), schema in `src/db/schema.ts`
- **Storage**: R2 for knowledge files, Vectorize for embeddings
- **AI**: AI SDK with provider aliases (OpenAI, OpenRouter, etc.) stored in `modelAlias` table
- **Data Flow**: Knowledge upload → parse/chunk/embed (`src/lib/ai/ingestion.ts`) → Vectorize index → RAG query injects context into versioned prompts (`src/lib/ai/prompt.ts`)

## Key Workflows
- **Development**: `pnpm dev` starts TanStack Start server; edit routes in `src/routes/`, auto-generates `routeTree.gen.ts`
- **Database**: `pnpm db:push` deploys schema to D1; `pnpm db:generate` creates migrations; `pnpm db:studio` opens Drizzle Studio
- **Seeding**: `pnpm db:seed-models` populates model aliases; `pnpm db:seed` adds test users
- **Build/Deploy**: `pnpm build` compiles with Vite; `wrangler deploy` to Cloudflare Workers
- **Code Quality**: `pnpm check` runs Biome lint/format; use `biome.json` config for consistent styling

## Conventions
- **Routing**: File-based with TanStack Router; layouts use `_` prefix (e.g., `src/routes/_app/agents.tsx`); auth routes use `_authenticated.tsx`
- **Authentication**: Better-auth integrated in root route (`src/routes/__root.tsx`); session available via `context.session`
- **Agents**: Created via `agent.create()` tRPC; prompts versioned with labels (`dev`/`staging`/`prod`) in `promptVersion` table
- **Knowledge**: Upload to R2 via `knowledge.uploadStart()`, process with `ingestion.ts`, index chunks in Vectorize
- **Models**: Use aliases from `modelAlias` table; policies in `agentModelPolicy` with temperature/topP settings
- **Chat API**: POST `/api/chat` with `agentSlug`, `messages`, `rag` (query/topK); streams responses via AI SDK
- **Forms**: React Hook Form with Zod validation; shadcn/ui components in `src/components/ui/`
- **Environment**: Bindings for DB/R2/VECTORIZE/AI; API keys for providers in `.env`

## Integration Patterns
- **tRPC**: Procedures return data for TanStack Query; context includes `queryClient` and `trpc` proxy
- **AI SDK**: Use `chat()` for completions, `embed()` for vectors; providers configured via aliases
- **Vectorize**: Query with embeddings returns top-K chunks; metadata includes `sourceId` for citations
- **R2**: Store files under `agents/{slug}/{sourceId}/`; generate presigned URLs for uploads
- **Error Handling**: Use TanStack Router's `errorComponent` for route errors; log to `runMetric` table