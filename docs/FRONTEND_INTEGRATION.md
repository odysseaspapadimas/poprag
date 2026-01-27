# PopRAG Frontend Integration Guide

This guide shows how to integrate PopRAG's chat API into your frontend application.

## Table of Contents
- [Quick Start](#quick-start)
- [API Endpoint](#api-endpoint)
- [Request Format](#request-format)
- [Response Format](#response-format)
- [Framework Examples](#framework-examples)
- [Advanced Features](#advanced-features)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

## Quick Start

### Endpoint
```
POST /api/chat/{agentSlug}
```

### Minimal Example (Fetch API)
```javascript
const response = await fetch('/api/chat/my-agent', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello!' }]
      }
    ]
  })
});

// Handle streaming response
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  console.log(chunk);
}
```

## API Endpoint

### URL Structure
```
POST /api/chat/{agentSlug}
```

**Parameters:**
- `agentSlug` (path) - The unique identifier for your agent

### Authentication

**⚠️ IMPORTANT: Currently, the chat API does NOT require authentication.**

The endpoint is publicly accessible to anyone who knows the agent slug. This means:
- ✅ Easy integration for public chatbots
- ⚠️ No built-in access control for private agents
- ⚠️ Agent visibility settings (`private`, `workspace`, `public`) are NOT enforced

**Security Recommendations:**

1. **For Public Agents**: No authentication needed - the current setup works perfectly
   ```javascript
   fetch('/api/chat/my-agent', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ messages: [...] }),
   });
   ```

2. **For Private Agents**: You should implement one of these approaches:
   - **API Key Authentication**: Add custom authentication layer
   - **Session-based**: Use session cookies for same-domain requests
     ```javascript
     fetch('/api/chat/my-agent', {
       credentials: 'include', // Include session cookies
       // ... rest of config
     });
     ```
   - **Rate Limiting**: Implement rate limiting by IP or API key
   - **Obfuscate Agent Slugs**: Use hard-to-guess slugs (not `my-agent`, use `agent-a7f8d9c2`)

3. **CORS Configuration**: 
   - Current setting: `Access-Control-Allow-Origin: *` (allows all origins)
   - For production, consider restricting to specific domains

**Future Enhancement Needed:**
Authentication/authorization middleware should be added to the chat API to enforce agent visibility settings.

## Request Format

### Request Body Schema
```typescript
{
  messages: UIMessage[];           // Required: Array of messages
  conversationId?: string;         // Optional: Group messages in a conversation
  modelAlias?: string;             // Optional: Override default model
  variables?: Record<string, any>; // Optional: Template variables
  rag?: {                          // Optional: RAG configuration overrides
    topK?: number;                 // Number of context chunks (default: agent setting)
    query?: string;                // Custom retrieval query
    filters?: Record<string, any>; // Metadata filters
  };
}
```

### Message Format (UIMessage)
```typescript
interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
}

type MessagePart = 
  | { type: 'text'; text: string }
  | { type: 'image'; image: string | URL }; // Data URL or HTTP URL
```

### Examples

#### Basic Text Message
```javascript
{
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "parts": [{ "type": "text", "text": "What are the best coffee beans?" }]
    }
  ]
}
```

#### With Conversation Tracking
```javascript
{
  "conversationId": "conv-abc123",
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "parts": [{ "type": "text", "text": "Tell me about your services" }]
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "parts": [{ "type": "text", "text": "We offer..." }]
    },
    {
      "id": "msg-3",
      "role": "user",
      "parts": [{ "type": "text", "text": "What about pricing?" }]
    }
  ]
}
```

#### With Image (Multimodal)
```javascript
{
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "parts": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image", "image": "data:image/jpeg;base64,/9j/4AAQ..." }
      ]
    }
  ]
}
```

#### Custom RAG Settings
```javascript
{
  "messages": [...],
  "rag": {
    "topK": 10,                    // Retrieve more context
    "query": "coffee brewing tips", // Custom search query
    "filters": { "category": "tutorial" }
  }
}
```

#### With Template Variables
```javascript
{
  "messages": [...],
  "variables": {
    "userName": "Alice",
    "brand": "Acme Corp"
  }
}
```

## Response Format

The API returns a streaming response using Server-Sent Events (SSE) format compatible with the Vercel AI SDK.

### Stream Format
Each chunk follows this format:
```
0:"text chunk"
0:"another chunk"
e:{"finishReason":"stop","usage":{"promptTokens":123,"completionTokens":456}}
```

### Response Fields
- Text deltas: `0:"content"`
- Finish event: `e:{finishReason, usage}`
- Error: Standard HTTP error responses (400, 500)

## Framework Examples

### React with Vercel AI SDK

The recommended approach for React applications:

```bash
npm install ai @ai-sdk/react nanoid
```

```typescript
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { nanoid } from 'nanoid';

function ChatComponent() {
  const [conversationId] = useState(() => nanoid());
  
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat/my-agent',
      body: {
        conversationId,
        rag: {
          topK: 6,
        },
      },
    }),
    onFinish: ({ message }) => {
      console.log('Message complete:', message);
    },
    onError: (error) => {
      console.error('Chat error:', error);
    },
  });

  const handleSend = (text: string) => {
    sendMessage({
      id: nanoid(),
      role: 'user',
      parts: [{ type: 'text', text }],
    });
  };

  return (
    <div>
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={msg.role}>
            {msg.parts.map((part, i) => (
              part.type === 'text' && <p key={i}>{part.text}</p>
            ))}
          </div>
        ))}
      </div>
      
      {status === 'submitted' && <div>Loading...</div>}
      
      <input
        type="text"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.currentTarget.value) {
            handleSend(e.currentTarget.value);
            e.currentTarget.value = '';
          }
        }}
      />
    </div>
  );
}
```

### Vue 3 with Composition API

```vue
<script setup>
import { ref, reactive } from 'vue';
import { nanoid } from 'nanoid';

const messages = ref([]);
const input = ref('');
const isLoading = ref(false);
const conversationId = nanoid();

async function sendMessage() {
  if (!input.value.trim()) return;
  
  const userMessage = {
    id: nanoid(),
    role: 'user',
    parts: [{ type: 'text', text: input.value }]
  };
  
  messages.value.push(userMessage);
  input.value = '';
  isLoading.value = true;
  
  try {
    const response = await fetch('/api/chat/my-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        conversationId,
        messages: messages.value,
      })
    });
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = '';
    
    const assistantMessage = {
      id: nanoid(),
      role: 'assistant',
      parts: [{ type: 'text', text: '' }]
    };
    messages.value.push(assistantMessage);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        if (line.startsWith('0:')) {
          const text = JSON.parse(line.slice(2));
          assistantText += text;
          assistantMessage.parts[0].text = assistantText;
        }
      }
    }
  } catch (error) {
    console.error('Chat error:', error);
  } finally {
    isLoading.value = false;
  }
}
</script>

<template>
  <div class="chat">
    <div class="messages">
      <div v-for="msg in messages" :key="msg.id" :class="msg.role">
        <p v-for="(part, i) in msg.parts" :key="i">
          {{ part.type === 'text' ? part.text : '' }}
        </p>
      </div>
    </div>
    <input 
      v-model="input" 
      @keydown.enter="sendMessage"
      :disabled="isLoading"
    />
  </div>
</template>
```

### Vanilla JavaScript (ES6+)

```javascript
class ChatClient {
  constructor(agentSlug) {
    this.agentSlug = agentSlug;
    this.conversationId = this.generateId();
    this.messages = [];
  }
  
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  
  async sendMessage(text, onChunk, onComplete) {
    const userMessage = {
      id: this.generateId(),
      role: 'user',
      parts: [{ type: 'text', text }]
    };
    
    this.messages.push(userMessage);
    
    const response = await fetch(`/api/chat/${this.agentSlug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        conversationId: this.conversationId,
        messages: this.messages,
      })
    });
    
    if (!response.ok) {
      throw new Error(`Chat API error: ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        if (line.startsWith('0:')) {
          const text = JSON.parse(line.slice(2));
          assistantText += text;
          onChunk?.(text, assistantText);
        } else if (line.startsWith('e:')) {
          const event = JSON.parse(line.slice(2));
          onComplete?.(event);
        }
      }
    }
    
    const assistantMessage = {
      id: this.generateId(),
      role: 'assistant',
      parts: [{ type: 'text', text: assistantText }]
    };
    
    this.messages.push(assistantMessage);
    
    return assistantMessage;
  }
}

// Usage
const chat = new ChatClient('my-agent');

chat.sendMessage(
  'Hello!',
  (chunk, fullText) => {
    console.log('Streaming:', chunk);
    document.getElementById('output').textContent = fullText;
  },
  (event) => {
    console.log('Complete:', event);
  }
);
```

### Next.js (App Router)

```typescript
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { nanoid } from 'nanoid';

export default function ChatPage() {
  const [conversationId] = useState(() => nanoid());
  
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: process.env.NEXT_PUBLIC_POPRAG_URL + '/api/chat/my-agent',
      body: {
        conversationId,
      },
    }),
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong>
          {m.parts.map((part, i) => (
            part.type === 'text' && <span key={i}>{part.text}</span>
          ))}
        </div>
      ))}
      
      <form onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('message') as HTMLInputElement;
        sendMessage({
          id: nanoid(),
          role: 'user',
          parts: [{ type: 'text', text: input.value }]
        });
        input.value = '';
      }}>
        <input name="message" disabled={status === 'submitted'} />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

### Flutter (Dart)

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class PopRAGClient {
  final String baseUrl;
  final String agentSlug;
  final String conversationId;
  final List<Map<String, dynamic>> messages = [];
  
  PopRAGClient({
    required this.baseUrl,
    required this.agentSlug,
  }) : conversationId = DateTime.now().millisecondsSinceEpoch.toString();
  
  Stream<String> sendMessage(String text) async* {
    final userMessage = {
      'id': DateTime.now().millisecondsSinceEpoch.toString(),
      'role': 'user',
      'parts': [
        {'type': 'text', 'text': text}
      ]
    };
    
    messages.add(userMessage);
    
    final response = await http.post(
      Uri.parse('$baseUrl/api/chat/$agentSlug'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'conversationId': conversationId,
        'messages': messages,
      }),
    );
    
    final stream = response.stream;
    String buffer = '';
    
    await for (var chunk in stream.transform(utf8.decoder)) {
      buffer += chunk;
      final lines = buffer.split('\n');
      buffer = lines.removeLast(); // Keep incomplete line in buffer
      
      for (var line in lines) {
        if (line.startsWith('0:')) {
          final text = jsonDecode(line.substring(2));
          yield text;
        }
      }
    }
  }
}

// Usage
final client = PopRAGClient(
  baseUrl: 'https://your-poprag-instance.com',
  agentSlug: 'my-agent',
);

await for (var chunk in client.sendMessage('Hello!')) {
  print(chunk);
}
```

## Advanced Features

### Conversation Tracking

Track multi-turn conversations by maintaining a `conversationId`:

```javascript
import { nanoid } from 'nanoid';

// Generate once per conversation
const conversationId = nanoid();

// Include in all requests for this conversation
const response = await fetch('/api/chat/my-agent', {
  method: 'POST',
  body: JSON.stringify({
    conversationId,  // Same ID for entire conversation
    messages: [...],
  }),
});
```

Benefits:
- Groups messages in transcript history
- Enables conversation analytics
- Maintains context across sessions

### Multi-Modal (Images)

Send images alongside text:

```javascript
// Convert file to data URL
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Send image with text
const imageDataURL = await fileToDataURL(file);

sendMessage({
  id: nanoid(),
  role: 'user',
  parts: [
    { type: 'text', text: 'What do you see in this image?' },
    { type: 'image', image: imageDataURL }
  ]
});
```

**Note:** Image support depends on the model. GPT-4 Vision, Claude 3, and Gemini Pro Vision support images.

### Template Variables

Pass dynamic variables to your prompt templates:

```javascript
{
  "messages": [...],
  "variables": {
    "userName": "Alice",
    "companyName": "Acme Corp",
    "date": "2024-01-15"
  }
}
```

If your system prompt contains `{{userName}}`, it will be replaced with `"Alice"`.

### Custom Model Selection

Override the default model per request:

```javascript
{
  "messages": [...],
  "modelAlias": "gpt-4o"  // Use specific model
}
```

Available models are configured in your PopRAG instance's model aliases.

### RAG Configuration Overrides

Customize retrieval behavior per request:

```javascript
{
  "messages": [...],
  "rag": {
    "topK": 10,              // Retrieve more context chunks
    "query": "custom query", // Override automatic query extraction
    "filters": {             // Metadata filters
      "category": "documentation",
      "version": "2.0"
    }
  }
}
```

**Note:** Most RAG settings (rewriting, reranking) are controlled at the agent level and cannot be overridden per request.

## Error Handling

### HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Process stream |
| 400 | Bad Request | Check request format |
| 401 | Unauthorized | Authenticate user |
| 404 | Agent Not Found | Verify agent slug |
| 500 | Server Error | Retry with exponential backoff |

### Error Response Format

```javascript
{
  "error": "Error message",
  "details": [...] // Zod validation errors (if 400)
}
```

### Example Error Handling

```javascript
async function sendChatMessage(agentSlug, messages) {
  try {
    const response = await fetch(`/api/chat/${agentSlug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ messages }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      
      if (response.status === 400) {
        console.error('Validation error:', error.details);
        throw new Error('Invalid message format');
      }
      
      if (response.status === 401) {
        console.error('Not authenticated');
        // Redirect to login
        window.location.href = '/login';
        return;
      }
      
      if (response.status === 404) {
        throw new Error(`Agent '${agentSlug}' not found`);
      }
      
      if (response.status >= 500) {
        console.error('Server error:', error);
        throw new Error('Service temporarily unavailable');
      }
    }
    
    return response;
    
  } catch (error) {
    if (error instanceof TypeError) {
      // Network error
      console.error('Network error:', error);
      throw new Error('Unable to connect to chat service');
    }
    throw error;
  }
}
```

### Retry Logic

Implement exponential backoff for temporary failures:

```javascript
async function sendWithRetry(agentSlug, messages, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await sendChatMessage(agentSlug, messages);
    } catch (error) {
      const isLastAttempt = i === maxRetries - 1;
      const isRetryable = error.message.includes('temporarily unavailable') ||
                          error.message.includes('Network error');
      
      if (!isRetryable || isLastAttempt) {
        throw error;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, i) * 1000;
      console.log(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

## Best Practices

### 1. Generate Unique Message IDs

Always use a proper ID generator:
```javascript
import { nanoid } from 'nanoid';

const messageId = nanoid(); // ✅ Good
const messageId = Date.now().toString(); // ⚠️ May collide
```

### 2. Maintain Conversation State

Keep all previous messages for context:
```javascript
const [messages, setMessages] = useState([]);

function addMessage(newMessage) {
  setMessages(prev => [...prev, newMessage]); // ✅ Preserve history
}
```

### 3. Handle Loading States

Show feedback during streaming:
```javascript
{status === 'submitted' && <LoadingSpinner />}
{status === 'error' && <ErrorMessage />}
```

### 4. Debounce User Input

Prevent rapid-fire requests:
```javascript
import { useDebouncedCallback } from 'use-debounce';

const debouncedSend = useDebouncedCallback(
  (text) => sendMessage(text),
  300 // 300ms delay
);
```

### 5. Sanitize Markdown Output

If rendering assistant responses as Markdown:
```javascript
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

<ReactMarkdown rehypePlugins={[rehypeSanitize]}>
  {message.text}
</ReactMarkdown>
```

### 6. Implement CORS Properly

For cross-origin requests, configure CORS on your PopRAG instance:
```javascript
// Frontend (different domain)
fetch('https://poprag.example.com/api/chat/my-agent', {
  credentials: 'include', // Send cookies cross-origin
  // ...
});
```

### 7. Monitor Performance

Track response times and errors:
```javascript
const startTime = Date.now();

await sendMessage(text);

const latency = Date.now() - startTime;
analytics.track('chat_message', { latency, agentSlug });
```

### 8. Graceful Degradation

Handle missing features gracefully:
```javascript
const supportsStreaming = 'ReadableStream' in window;

if (!supportsStreaming) {
  // Fallback to non-streaming approach
  const response = await fetch(...);
  const fullResponse = await response.json();
}
```

### 9. Secure Sensitive Data

Never log full messages containing PII:
```javascript
console.log('Sending message', { 
  messageId: msg.id,
  length: msg.parts[0].text.length,
  // ❌ DON'T: text: msg.parts[0].text
});
```

### 10. Clear Conversations Appropriately

Provide a way to start fresh:
```javascript
function clearConversation() {
  setMessages([]);
  setConversationId(nanoid()); // New ID for new conversation
}
```

## TypeScript Definitions

```typescript
// Message types
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
}

export type MessagePart = TextPart | ImagePart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  image: string | URL; // Data URL or HTTP URL
}

// Request types
export interface ChatRequest {
  messages: UIMessage[];
  conversationId?: string;
  modelAlias?: string;
  variables?: Record<string, unknown>;
  rag?: {
    topK?: number;
    query?: string;
    filters?: Record<string, unknown>;
  };
}

// Response types
export interface StreamFinishEvent {
  finishReason: 'stop' | 'length' | 'content-filter' | 'error';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatError {
  error: string;
  details?: Array<{
    code: string;
    path: string[];
    message: string;
  }>;
}
```

## Environment Variables

For external integrations, configure your PopRAG URL:

```bash
# .env.local
NEXT_PUBLIC_POPRAG_URL=https://your-instance.workers.dev
NEXT_PUBLIC_AGENT_SLUG=my-agent
```

```javascript
const POPRAG_URL = process.env.NEXT_PUBLIC_POPRAG_URL;
const AGENT_SLUG = process.env.NEXT_PUBLIC_AGENT_SLUG;

fetch(`${POPRAG_URL}/api/chat/${AGENT_SLUG}`, { ... });
```

## Troubleshooting

### Messages not appearing
- Ensure `messages` array includes all previous messages
- Check that message IDs are unique
- Verify the `role` is either `'user'` or `'assistant'`

### CORS errors
- Add `credentials: 'include'` to fetch options
- Verify your PopRAG instance allows your origin

### No streaming response
- Check that you're reading `response.body` as a stream
- Ensure Content-Type is correct
- Verify browser supports ReadableStream

### 400 Bad Request
- Validate message structure matches schema
- Check for missing required fields
- Ensure `parts` array is not empty

### Agent not found (404)
- Verify agent slug is correct
- Check agent status is `'active'`
- Ensure you have access to the agent

## Further Reading

- [Vercel AI SDK Documentation](https://sdk.vercel.ai/docs)
- [Server-Sent Events (SSE) Specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [PopRAG Implementation Plan](./IMPLEMENTATION_PLAN.md)
- [RAG Configuration Guide](./RAG_MANAGEMENT.md)

## Support

For issues or questions:
1. Check this documentation
2. Review the [Quick Start Guide](./QUICK_START.md)
3. Open an issue in the repository
4. Contact your PopRAG instance administrator
