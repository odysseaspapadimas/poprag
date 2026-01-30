# PopRAG - Multi-Agent RAG Platform

A production-ready platform for managing multiple AI agents with Retrieval-Augmented Generation (RAG), built on Cloudflare's infrastructure stack.

## Architecture

### Tech Stack

- **Frontend**: TanStack Start, React, TailwindCSS
- **Backend**: tRPC, Drizzle ORM
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (object storage)
- **Vector DB**: Cloudflare Vectorize
- **AI**: AI SDK with OpenAI, OpenRouter, Workers AI support
- **Gateway**: Cloudflare AI Gateway for routing, caching, and analytics

### Core Features

✅ **Multi-Agent Management**
- Create and configure multiple AI agents
- Agent-specific prompts with versioning (dev/staging/prod)
- Model selection via allow-listed aliases
- Per-agent generation knobs (temperature, topP, maxTokens)

✅ **RAG (Retrieval-Augmented Generation)**
- Knowledge source management (upload to R2)
- Document parsing and chunking
- Vector embeddings with AI SDK
- Semantic search via Vectorize
- Citation support in responses

✅ **Prompt Versioning**
- Immutable prompt versions
- Label-based promotion (dev → staging → prod)
- Rollback capability
- Variable substitution support

✅ **Provider Portability**
- OpenAI, OpenRouter, Hugging Face support
- Cloudflare AI Gateway integration
- Fallback and caching via Gateway routing
- Workers AI for edge inference (optional)

✅ **Observability**
- Per-agent metrics (tokens, cost, latency)
- Transcript logging
- Audit trail for all changes
- Run-level error tracking

## Project Structure

```
src/
├── db/
│   ├── schema.ts              # D1 schema with agent tables
│   ├── seed.ts                # User seed script
│   └── seed-models.ts         # Model aliases seed
├── lib/
│   ├── ai/
│   │   ├── chat.ts            # Runtime chat handler
│   │   ├── embedding.ts       # Embedding utilities
│   │   ├── ingestion.ts       # Knowledge processing pipeline
│   │   ├── models.ts          # Model provider configuration
│   │   └── prompt.ts          # Prompt rendering utilities
│   └── types/
│       └── cloudflare.ts      # Cloudflare bindings types
├── integrations/
│   └── trpc/
│       └── router/
│           ├── agent.ts       # Agent CRUD operations
│           ├── prompt.ts      # Prompt versioning
│           └── knowledge.ts   # Knowledge source management
├── routes/
│   ├── _app/
│   │   └── agents.tsx         # Agent management UI
│   └── api/
│       └── chat.ts            # Chat API endpoint
└── components/
    └── ui/                    # shadcn/ui components
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm
- Cloudflare account (for D1, R2, Vectorize)
- OpenAI API key

### Installation

```bash
# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env

# Configure environment variables
# Add your OPENAI_API_KEY, D1 credentials, etc.
```

### Database Setup

```bash
# Generate migration
pnpm db:generate

# Push schema to D1
pnpm db:push

# Seed model aliases
pnpm db:seed-models

# (Optional) Seed test users
pnpm db:seed
```

### Development

```bash
# Start development server
pnpm dev

# In another terminal, open Drizzle Studio
pnpm db:studio
```

### Environment Variables

Required variables in `.env`:

```env
# Database
DATABASE_URL=your_d1_connection_string
D1_ACCOUNT_ID=your_cloudflare_account_id
D1_DATABASE_ID=your_d1_database_id
D1_TOKEN=your_d1_api_token

# AI Providers
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...  # Optional

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_GATEWAY_ID=your_gateway_id  # Optional

# Auth
SESSION_SECRET=your_random_secret
```

## Key Concepts

### Agents

Agents are AI assistants with:
- Unique slug identifier
- System prompt (versioned)
- Model configuration policy
- Optional knowledge base
- Status (draft/active/archived)

### Prompt Versioning

Prompts follow an immutable versioning model:
1. Create new version (increments version number)
2. Assign label (dev/staging/prod) to version
3. Runtime uses 'prod' label
4. Rollback by reassigning label to previous version

### Knowledge Ingestion Pipeline

1. **Upload**: Store file in R2 (`agents/{slug}/{sourceId}/{filename}`)
2. **Parse**: Extract text (PDF, XLSX, CSV, TXT)
3. **Chunk**: Split into semantic chunks
4. **Embed**: Generate vector embeddings (AI SDK)
5. **Index**: Upsert to Vectorize with metadata
6. **Pin**: Activate index version for agent

### RAG Runtime Flow

1. Resolve agent by slug
2. Load production prompt version
3. Load model policy
4. Query user input → embed → Vectorize search
5. Build context with top-k chunks
6. Inject context into system prompt
7. Stream response via AI SDK
8. Log transcript + metrics

## API

### tRPC Routes

**Agent Management**
- `agent.list()` - List agents with filters
- `agent.get({ id/slug })` - Get agent details
- `agent.create({ name, slug, ... })` - Create agent
- `agent.update({ id, ... })` - Update agent
- `agent.archive({ id })` - Archive agent

**Prompt Management**
- `prompt.list({ agentId })` - List prompts
- `prompt.getVersions({ promptId })` - Get versions
- `prompt.createVersion({ ... })` - Create version
- `prompt.assignLabel({ promptId, version, label })` - Promote
- `prompt.rollbackLabel({ promptId, label, toVersion })` - Rollback

**Knowledge Management**
- `knowledge.uploadStart({ agentId, fileName, ... })` - Init upload
- `knowledge.confirm({ sourceId, checksum })` - Confirm upload
- `knowledge.index({ sourceId })` - Process & index
- `knowledge.status({ sourceId })` - Get status
- `knowledge.delete({ sourceId })` - Delete source

### Chat API

```typescript
POST /api/chat

Request:
{
  "agentSlug": "support-bot",
  "messages": [
    { "role": "user", "content": "What are the available coffee capsules?" }
  ],
  "variables": { "brand": "Nescafé" },
  "rag": {
    "topK": 6
  }
}

Response: Text stream (Server-Sent Events)
```

## Deployment

### Cloudflare Workers

1. Configure `wrangler.jsonc` with bindings:

```jsonc
{
  "name": "poprag",
  "compatibility_date": "2024-01-01",
  "d1_databases": [
    { "binding": "DB", "database_id": "..." }
  ],
  "r2_buckets": [
    { "binding": "R2", "bucket_name": "agents-admin-prod" }
  ],
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": "agents-vectors" }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

2. Deploy:

```bash
pnpm build
wrangler deploy
```

## Roadmap

- [x] R2 presigned URL generation for direct uploads
- [x] Vectorize integration (replace placeholder)
- [ ] Workers AI model support
- [ ] PDF/XLSX parsing (WASM libraries)
- [x] Advanced chunking strategies
- [ ] Multi-step tool calling
- [ ] Guardrails (moderation, denylist)
- [ ] Cost estimation & budget caps
- [ ] Admin analytics dashboard
- [ ] Evaluation dataset support

## Contributing

See implementation plan in `IMPLEMENTATION_PLAN.md` for architecture details.

## License

MIT
