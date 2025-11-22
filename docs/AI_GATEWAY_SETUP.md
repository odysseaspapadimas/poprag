# AI Gateway Setup

This project now includes Cloudflare AI Gateway integration for embeddings and AI requests.

## Benefits

- **Request Logging**: Track all AI requests and responses
- **Analytics**: Monitor usage, costs, and performance
- **Caching**: Reduce costs by caching identical requests
- **Rate Limiting**: Protect against abuse
- **Retries**: Automatic retry logic for failed requests
- **Model Fallbacks**: Configure fallback models

## Setup

### 1. Create an AI Gateway in Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **AI** > **AI Gateway**
3. Click **Create Gateway**
4. Name it (e.g., `poprag-gateway`)
5. Copy the **Gateway ID**

### 2. Add Environment Variables

Add to your `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "CLOUDFLARE_ACCOUNT_ID": "your-account-id",
    "AI_GATEWAY_ID": "poprag-gateway",
    "CLOUDFLARE_API_TOKEN": "your-api-token" // Optional, only needed for external API calls
  }
}
```

Or for local development, create `.dev.vars`:

```env
CLOUDFLARE_ACCOUNT_ID=your-account-id
AI_GATEWAY_ID=poprag-gateway
CLOUDFLARE_API_TOKEN=your-api-token
```

### 3. Get Your Account ID

Find your account ID in:
- Cloudflare Dashboard URL: `https://dash.cloudflare.com/{ACCOUNT_ID}/`
- Or in **Workers & Pages** > **Overview** sidebar

## How It Works

The `runWorkersAI()` function in `src/lib/ai/gateway.ts` automatically routes requests through AI Gateway if configured, or falls back to direct Workers AI access.

```typescript
// Automatically uses AI Gateway if configured
const embedding = await runWorkersAI<{ data: number[][] }>(
  "@cf/baai/bge-large-en-v1.5",
  { text: ["Hello world"] }
);
```

## Monitoring

Once configured, view analytics at:
- Cloudflare Dashboard > **AI** > **AI Gateway** > **Your Gateway**

You'll see:
- Request volume over time
- Cost estimates
- Cache hit rates
- Error rates
- Model usage breakdown

## For Vercel AI SDK (Future)

The gateway URLs are also available for Vercel AI SDK:

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { getOpenAIGatewayURL } from "@/lib/ai/gateway";

const openai = createOpenAI({
  baseURL: getOpenAIGatewayURL(),
  apiKey: process.env.OPENAI_API_KEY,
});
```

## Documentation

- [AI Gateway Docs](https://developers.cloudflare.com/ai-gateway/)
- [Vercel AI SDK Integration](https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/)
