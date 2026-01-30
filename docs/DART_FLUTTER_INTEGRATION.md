# PopRAG Dart/Flutter Integration (Minimal)

Use this guide to call the chat API from Dart/Flutter without any SDK.

## Quick Start

Endpoint:
```
POST /api/chat/{agentSlug}
```

Minimal Dart example (streaming):
```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<void> main() async {
  final baseUrl = 'http://localhost:3000';
  final agentSlug = 'nescafe-assistant';

  final body = {
    'messages': [
      {
        'id': 'msg-1',
        'role': 'user',
        'parts': [
          {'type': 'text', 'text': 'How can you help me?'}
        ]
      }
    ],
    'conversationId': 'conv-1',
  };

  final response = await http.post(
    Uri.parse('$baseUrl/api/chat/$agentSlug'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode(body),
  );

  if (response.statusCode != 200) {
    throw Exception('Request failed: ${response.body}');
  }

  await for (final line in response.stream
      .transform(utf8.decoder)
      .transform(const LineSplitter())) {
    final trimmed = line.trim();
    if (trimmed.startsWith('0:')) {
      final text = jsonDecode(trimmed.substring(2)) as String;
      print(text);
    }
  }
}
```

## Request Rules

- The last message must be a **user** message.
- Do not include an empty assistant placeholder in the payload.
- The last user message must include text or image.

Accepted fields:
```
messages, conversationId, modelAlias, variables, rag
```

Unknown fields (like `id`, `trigger`, or `requestTags`) are ignored.

## RAG Options (Use Only for Specific Scenarios)

The agent config controls RAG. In almost all cases, **do not pass `rag`**.

You may pass these only for very specific debugging/experiments:
- `rag.topK`
- `rag.filters`

If you do not have a strong reason, omit `rag` entirely.

## Authentication

The chat API currently does **not** require authentication. If you need private
access, add your own auth layer (API key, proxy, or worker middleware).

## Troubleshooting (Generic Responses)

If responses are generic:
- Ensure the last message is a user message with text or image.
- Confirm the agent exists locally and has a `prod` prompt version.
- Verify `ragEnabled` is true and knowledge is indexed for the agent.
- Localhost uses local D1/Vectorize data (not production).

## Related Docs

- `docs/FRONTEND_INTEGRATION.md`
- `docs/IMPLEMENTATION_PLAN.md`
