# PopRAG Dart/Flutter Integration Guide

Complete guide for integrating PopRAG's chat API into your Flutter application.

## Table of Contents
- [Authentication & Security](#authentication--security)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Core Implementation](#core-implementation)
- [Flutter Widgets](#flutter-widgets)
- [Advanced Features](#advanced-features)
- [State Management](#state-management)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

## Authentication & Security

**⚠️ IMPORTANT: The PopRAG chat API currently does NOT require authentication.**

The endpoint is publicly accessible to anyone who knows:
- Your PopRAG base URL
- The agent slug

### What This Means

✅ **Pros:**
- Easy integration - no auth setup needed
- Perfect for public chatbots/assistants
- Simple HTTP requests, no token management

⚠️ **Cons:**
- No built-in access control
- Anyone can use your agent if they know the slug
- Agent visibility settings are not enforced

### Security Recommendations

**1. For Public Agents**
If your agent is meant to be public, the current setup is fine. Just use it directly:

```dart
final client = PopRAGClient(
  baseUrl: 'https://your-instance.workers.dev',
  agentSlug: 'my-public-agent',
);
```

**2. For Private/Internal Agents**

Implement additional security measures:

**Option A: Use Hard-to-Guess Agent Slugs**
```dart
// Bad: Easy to guess
agentSlug: 'support-bot'

// Better: Hard to guess
agentSlug: 'agent-7f8d9c2a-4e1b-9f3a'
```

**Option B: Add API Key (Custom Implementation)**
```dart
class PopRAGClient {
  final String? apiKey;
  
  PopRAGClient({
    required this.baseUrl,
    required this.agentSlug,
    this.apiKey, // Optional API key
  });
  
  // Add to headers if provided
  final headers = <String, String>{
    'Content-Type': 'application/json',
    if (apiKey != null) 'X-API-Key': apiKey!,
  };
}
```

**Option C: Restrict by IP/Domain**
Configure your PopRAG instance to only accept requests from specific IPs or domains.

**Option D: Rate Limiting**
Implement client-side rate limiting to prevent abuse:
```dart
class RateLimiter {
  final int maxRequests;
  final Duration window;
  final List<DateTime> _timestamps = [];
  
  RateLimiter({
    this.maxRequests = 10,
    this.window = const Duration(minutes: 1),
  });
  
  bool canMakeRequest() {
    final now = DateTime.now();
    _timestamps.removeWhere((t) => now.difference(t) > window);
    
    if (_timestamps.length >= maxRequests) {
      return false;
    }
    
    _timestamps.add(now);
    return true;
  }
}
```

**3. Environment Variables**

Never hardcode URLs or agent slugs in your app:

```dart
// .env (DO NOT commit to version control)
POPRAG_BASE_URL=https://your-instance.workers.dev
POPRAG_AGENT_SLUG=agent-7f8d9c2a

// Load securely
await dotenv.load();
final baseUrl = dotenv.env['POPRAG_BASE_URL']!;
final agentSlug = dotenv.env['POPRAG_AGENT_SLUG']!;
```

## Quick Start

### Add Dependencies

```yaml
# pubspec.yaml
dependencies:
  http: ^1.1.0
  uuid: ^4.2.1
  flutter_dotenv: ^5.1.0  # For environment variables
```

### Minimal Example

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

Future<void> main() async {
  final client = PopRAGClient(
    baseUrl: 'https://your-instance.workers.dev',
    agentSlug: 'my-agent',
  );
  
  await for (var chunk in client.sendMessage('Hello!')) {
    print(chunk);
  }
}
```

## Installation

### 1. Add Dependencies

```bash
flutter pub add http uuid
flutter pub add flutter_dotenv  # Optional: for env vars
```

### 2. Configure Environment

Create `.env` file in your project root:
```env
POPRAG_BASE_URL=https://your-instance.workers.dev
POPRAG_AGENT_SLUG=my-agent
```

Load in `main.dart`:
```dart
import 'package:flutter_dotenv/flutter_dotenv.dart';

Future<void> main() async {
  await dotenv.load();
  runApp(MyApp());
}
```

## Core Implementation

### Data Models

```dart
// lib/models/chat_models.dart

import 'package:uuid/uuid.dart';

const _uuid = Uuid();

/// Message role
enum MessageRole {
  user,
  assistant;
  
  String toJson() => name;
  
  static MessageRole fromJson(String json) {
    return MessageRole.values.firstWhere((e) => e.name == json);
  }
}

/// Message part types
sealed class MessagePart {
  const MessagePart();
  
  Map<String, dynamic> toJson();
}

class TextPart extends MessagePart {
  final String text;
  
  const TextPart(this.text);
  
  @override
  Map<String, dynamic> toJson() => {
    'type': 'text',
    'text': text,
  };
  
  factory TextPart.fromJson(Map<String, dynamic> json) {
    return TextPart(json['text'] as String);
  }
}

class ImagePart extends MessagePart {
  final String image; // Data URL or HTTP URL
  
  const ImagePart(this.image);
  
  @override
  Map<String, dynamic> toJson() => {
    'type': 'image',
    'image': image,
  };
  
  factory ImagePart.fromJson(Map<String, dynamic> json) {
    return ImagePart(json['image'] as String);
  }
}

/// Chat message
class ChatMessage {
  final String id;
  final MessageRole role;
  final List<MessagePart> parts;
  
  ChatMessage({
    String? id,
    required this.role,
    required this.parts,
  }) : id = id ?? _uuid.v4();
  
  /// Create a text-only message
  factory ChatMessage.text({
    required MessageRole role,
    required String text,
    String? id,
  }) {
    return ChatMessage(
      id: id,
      role: role,
      parts: [TextPart(text)],
    );
  }
  
  /// Create a message with text and image
  factory ChatMessage.withImage({
    required MessageRole role,
    required String text,
    required String imageUrl,
    String? id,
  }) {
    return ChatMessage(
      id: id,
      role: role,
      parts: [
        TextPart(text),
        ImagePart(imageUrl),
      ],
    );
  }
  
  Map<String, dynamic> toJson() => {
    'id': id,
    'role': role.toJson(),
    'parts': parts.map((p) => p.toJson()).toList(),
  };
  
  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final parts = (json['parts'] as List)
        .map((p) => p['type'] == 'text' 
            ? TextPart.fromJson(p)
            : ImagePart.fromJson(p))
        .toList();
    
    return ChatMessage(
      id: json['id'],
      role: MessageRole.fromJson(json['role']),
      parts: parts,
    );
  }
  
  /// Get text content (concatenates all text parts)
  String get text {
    return parts
        .whereType<TextPart>()
        .map((p) => p.text)
        .join(' ');
  }
}

/// RAG configuration
class RAGConfig {
  final int? topK;
  final String? query;
  final Map<String, dynamic>? filters;
  
  const RAGConfig({
    this.topK,
    this.query,
    this.filters,
  });
  
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{};
    if (topK != null) json['topK'] = topK;
    if (query != null) json['query'] = query;
    if (filters != null) json['filters'] = filters;
    return json;
  }
}

/// Chat request
class ChatRequest {
  final List<ChatMessage> messages;
  final String? conversationId;
  final String? modelAlias;
  final Map<String, dynamic>? variables;
  final RAGConfig? rag;
  
  const ChatRequest({
    required this.messages,
    this.conversationId,
    this.modelAlias,
    this.variables,
    this.rag,
  });
  
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{
      'messages': messages.map((m) => m.toJson()).toList(),
    };
    
    if (conversationId != null) json['conversationId'] = conversationId;
    if (modelAlias != null) json['modelAlias'] = modelAlias;
    if (variables != null) json['variables'] = variables;
    if (rag != null) json['rag'] = rag.toJson();
    
    return json;
  }
}

/// Stream finish event
class StreamFinishEvent {
  final String finishReason;
  final int promptTokens;
  final int completionTokens;
  final int totalTokens;
  
  const StreamFinishEvent({
    required this.finishReason,
    required this.promptTokens,
    required this.completionTokens,
    required this.totalTokens,
  });
  
  factory StreamFinishEvent.fromJson(Map<String, dynamic> json) {
    final usage = json['usage'] as Map<String, dynamic>;
    return StreamFinishEvent(
      finishReason: json['finishReason'],
      promptTokens: usage['promptTokens'],
      completionTokens: usage['completionTokens'],
      totalTokens: usage['totalTokens'],
    );
  }
}
```

### PopRAG Client

```dart
// lib/services/poprag_client.dart

import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';
import '../models/chat_models.dart';

const _uuid = Uuid();

class PopRAGException implements Exception {
  final String message;
  final int? statusCode;
  final dynamic details;
  
  PopRAGException(this.message, {this.statusCode, this.details});
  
  @override
  String toString() => 'PopRAGException: $message (status: $statusCode)';
}

class PopRAGClient {
  final String baseUrl;
  final String agentSlug;
  final http.Client _httpClient;
  
  final List<ChatMessage> _messages = [];
  final String conversationId;
  
  PopRAGClient({
    required this.baseUrl,
    required this.agentSlug,
    http.Client? httpClient,
    String? conversationId,
  }) : _httpClient = httpClient ?? http.Client(),
       conversationId = conversationId ?? _uuid.v4();
  
  /// Get all messages in the conversation
  List<ChatMessage> get messages => List.unmodifiable(_messages);
  
  /// Send a text message and stream the response
  Stream<String> sendMessage(
    String text, {
    String? imageUrl,
    RAGConfig? rag,
    Map<String, dynamic>? variables,
    String? modelAlias,
  }) async* {
    // Create user message
    final userMessage = imageUrl != null
        ? ChatMessage.withImage(
            role: MessageRole.user,
            text: text,
            imageUrl: imageUrl,
          )
        : ChatMessage.text(
            role: MessageRole.user,
            text: text,
          );
    
    _messages.add(userMessage);
    
    try {
      // Build request
      final request = ChatRequest(
        messages: _messages,
        conversationId: conversationId,
        rag: rag,
        variables: variables,
        modelAlias: modelAlias,
      );
      
      // Send request
      final response = await _httpClient.post(
        Uri.parse('$baseUrl/api/chat/$agentSlug'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(request.toJson()),
      );
      
      // Handle errors
      if (response.statusCode != 200) {
        final error = _parseError(response);
        throw PopRAGException(
          error['error'] ?? 'Request failed',
          statusCode: response.statusCode,
          details: error['details'],
        );
      }
      
      // Stream response
      String assistantText = '';
      StreamFinishEvent? finishEvent;
      
      await for (final chunk in _parseStream(response.bodyBytes)) {
        if (chunk is String) {
          assistantText += chunk;
          yield chunk;
        } else if (chunk is StreamFinishEvent) {
          finishEvent = chunk;
        }
      }
      
      // Add assistant message to history
      final assistantMessage = ChatMessage.text(
        role: MessageRole.assistant,
        text: assistantText,
      );
      _messages.add(assistantMessage);
      
    } catch (e) {
      // Remove user message on error
      _messages.removeLast();
      rethrow;
    }
  }
  
  /// Send a custom message (for advanced use cases)
  Stream<String> sendCustomMessage(
    ChatMessage message, {
    RAGConfig? rag,
    Map<String, dynamic>? variables,
    String? modelAlias,
  }) async* {
    _messages.add(message);
    
    try {
      final request = ChatRequest(
        messages: _messages,
        conversationId: conversationId,
        rag: rag,
        variables: variables,
        modelAlias: modelAlias,
      );
      
      final response = await _httpClient.post(
        Uri.parse('$baseUrl/api/chat/$agentSlug'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(request.toJson()),
      );
      
      if (response.statusCode != 200) {
        final error = _parseError(response);
        throw PopRAGException(
          error['error'] ?? 'Request failed',
          statusCode: response.statusCode,
          details: error['details'],
        );
      }
      
      String assistantText = '';
      
      await for (final chunk in _parseStream(response.bodyBytes)) {
        if (chunk is String) {
          assistantText += chunk;
          yield chunk;
        }
      }
      
      final assistantMessage = ChatMessage.text(
        role: MessageRole.assistant,
        text: assistantText,
      );
      _messages.add(assistantMessage);
      
    } catch (e) {
      _messages.removeLast();
      rethrow;
    }
  }
  
  /// Clear conversation history
  void clearHistory() {
    _messages.clear();
  }
  
  /// Parse streaming response
  Stream<dynamic> _parseStream(List<int> bytes) async* {
    final stream = Stream.fromIterable([bytes]);
    String buffer = '';
    
    await for (final chunk in stream.transform(utf8.decoder)) {
      buffer += chunk;
      final lines = buffer.split('\n');
      buffer = lines.removeLast(); // Keep incomplete line
      
      for (final line in lines) {
        final trimmed = line.trim();
        if (trimmed.isEmpty) continue;
        
        if (trimmed.startsWith('0:')) {
          // Text delta
          final text = jsonDecode(trimmed.substring(2)) as String;
          yield text;
        } else if (trimmed.startsWith('e:')) {
          // Finish event
          final event = jsonDecode(trimmed.substring(2));
          yield StreamFinishEvent.fromJson(event);
        }
      }
    }
    
    // Process any remaining buffer
    if (buffer.isNotEmpty) {
      if (buffer.startsWith('0:')) {
        final text = jsonDecode(buffer.substring(2)) as String;
        yield text;
      } else if (buffer.startsWith('e:')) {
        final event = jsonDecode(buffer.substring(2));
        yield StreamFinishEvent.fromJson(event);
      }
    }
  }
  
  /// Parse error response
  Map<String, dynamic> _parseError(http.Response response) {
    try {
      return jsonDecode(response.body) as Map<String, dynamic>;
    } catch (e) {
      return {'error': 'Failed to parse error response'};
    }
  }
  
  /// Dispose client
  void dispose() {
    _httpClient.close();
  }
}
```

## Flutter Widgets

### Basic Chat Widget

```dart
// lib/widgets/chat_screen.dart

import 'package:flutter/material.dart';
import '../models/chat_models.dart';
import '../services/poprag_client.dart';

class ChatScreen extends StatefulWidget {
  final String baseUrl;
  final String agentSlug;
  
  const ChatScreen({
    Key? key,
    required this.baseUrl,
    required this.agentSlug,
  }) : super(key: key);
  
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late final PopRAGClient _client;
  final _controller = TextEditingController();
  final _scrollController = ScrollController();
  bool _isLoading = false;
  String? _error;
  
  @override
  void initState() {
    super.initState();
    _client = PopRAGClient(
      baseUrl: widget.baseUrl,
      agentSlug: widget.agentSlug,
    );
  }
  
  @override
  void dispose() {
    _client.dispose();
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }
  
  Future<void> _sendMessage() async {
    if (_controller.text.trim().isEmpty) return;
    
    final text = _controller.text;
    _controller.clear();
    
    setState(() {
      _isLoading = true;
      _error = null;
    });
    
    try {
      await for (final _ in _client.sendMessage(text)) {
        // Update UI on each chunk
        setState(() {});
        _scrollToBottom();
      }
    } on PopRAGException catch (e) {
      setState(() {
        _error = e.message;
      });
    } catch (e) {
      setState(() {
        _error = 'An unexpected error occurred';
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }
  
  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }
  
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Chat'),
      ),
      body: Column(
        children: [
          // Error banner
          if (_error != null)
            MaterialBanner(
              content: Text(_error!),
              backgroundColor: Colors.red.shade100,
              actions: [
                TextButton(
                  onPressed: () => setState(() => _error = null),
                  child: const Text('Dismiss'),
                ),
              ],
            ),
          
          // Messages
          Expanded(
            child: _client.messages.isEmpty
                ? const Center(
                    child: Text('Start a conversation'),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(16),
                    itemCount: _client.messages.length,
                    itemBuilder: (context, index) {
                      final message = _client.messages[index];
                      return MessageBubble(message: message);
                    },
                  ),
          ),
          
          // Loading indicator
          if (_isLoading)
            const LinearProgressIndicator(),
          
          // Input
          Container(
            decoration: BoxDecoration(
              color: Theme.of(context).cardColor,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.05),
                  blurRadius: 10,
                  offset: const Offset(0, -2),
                ),
              ],
            ),
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    decoration: const InputDecoration(
                      hintText: 'Type a message...',
                      border: OutlineInputBorder(),
                    ),
                    maxLines: null,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _sendMessage(),
                    enabled: !_isLoading,
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: const Icon(Icons.send),
                  onPressed: _isLoading ? null : _sendMessage,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  
  const MessageBubble({
    Key? key,
    required this.message,
  }) : super(key: key);
  
  @override
  Widget build(BuildContext context) {
    final isUser = message.role == MessageRole.user;
    
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(12),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        decoration: BoxDecoration(
          color: isUser
              ? Theme.of(context).primaryColor
              : Colors.grey.shade200,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final part in message.parts)
              if (part is TextPart)
                Text(
                  part.text,
                  style: TextStyle(
                    color: isUser ? Colors.white : Colors.black,
                  ),
                )
              else if (part is ImagePart)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Image.network(
                    part.image,
                    errorBuilder: (context, error, stackTrace) {
                      return const Icon(Icons.broken_image);
                    },
                  ),
                ),
          ],
        ),
      ),
    );
  }
}
```

### Advanced Chat Widget with Markdown

```dart
// pubspec.yaml
dependencies:
  flutter_markdown: ^0.6.18

// lib/widgets/advanced_chat_screen.dart

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../models/chat_models.dart';
import '../services/poprag_client.dart';

class AdvancedChatScreen extends StatefulWidget {
  final String baseUrl;
  final String agentSlug;
  
  const AdvancedChatScreen({
    Key? key,
    required this.baseUrl,
    required this.agentSlug,
  }) : super(key: key);
  
  @override
  State<AdvancedChatScreen> createState() => _AdvancedChatScreenState();
}

class _AdvancedChatScreenState extends State<AdvancedChatScreen> {
  late final PopRAGClient _client;
  final _controller = TextEditingController();
  final _scrollController = ScrollController();
  bool _isLoading = false;
  String? _error;
  
  // Track streaming message
  String _streamingText = '';
  
  @override
  void initState() {
    super.initState();
    _client = PopRAGClient(
      baseUrl: widget.baseUrl,
      agentSlug: widget.agentSlug,
    );
  }
  
  @override
  void dispose() {
    _client.dispose();
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }
  
  Future<void> _sendMessage() async {
    if (_controller.text.trim().isEmpty) return;
    
    final text = _controller.text;
    _controller.clear();
    
    setState(() {
      _isLoading = true;
      _error = null;
      _streamingText = '';
    });
    
    try {
      await for (final chunk in _client.sendMessage(text)) {
        setState(() {
          _streamingText += chunk;
        });
        _scrollToBottom();
      }
    } on PopRAGException catch (e) {
      setState(() {
        _error = e.message;
      });
    } catch (e) {
      setState(() {
        _error = 'An unexpected error occurred';
      });
    } finally {
      setState(() {
        _isLoading = false;
        _streamingText = '';
      });
    }
  }
  
  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }
  
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Chat'),
        actions: [
          IconButton(
            icon: const Icon(Icons.delete),
            onPressed: () {
              setState(() {
                _client.clearHistory();
                _error = null;
              });
            },
            tooltip: 'Clear conversation',
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null)
            MaterialBanner(
              content: Text(_error!),
              backgroundColor: Colors.red.shade100,
              actions: [
                TextButton(
                  onPressed: () => setState(() => _error = null),
                  child: const Text('Dismiss'),
                ),
              ],
            ),
          
          Expanded(
            child: _buildMessageList(),
          ),
          
          if (_isLoading)
            const LinearProgressIndicator(),
          
          _buildInputField(),
        ],
      ),
    );
  }
  
  Widget _buildMessageList() {
    if (_client.messages.isEmpty && _streamingText.isEmpty) {
      return const Center(
        child: Text('Start a conversation'),
      );
    }
    
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.all(16),
      itemCount: _client.messages.length + (_streamingText.isNotEmpty ? 1 : 0),
      itemBuilder: (context, index) {
        // Show streaming message last
        if (index == _client.messages.length) {
          return MarkdownMessageBubble(
            message: ChatMessage.text(
              role: MessageRole.assistant,
              text: _streamingText,
            ),
            isStreaming: true,
          );
        }
        
        return MarkdownMessageBubble(
          message: _client.messages[index],
        );
      },
    );
  }
  
  Widget _buildInputField() {
    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.05),
            blurRadius: 10,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              decoration: const InputDecoration(
                hintText: 'Type a message...',
                border: OutlineInputBorder(),
              ),
              maxLines: null,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _sendMessage(),
              enabled: !_isLoading,
            ),
          ),
          const SizedBox(width: 8),
          IconButton(
            icon: const Icon(Icons.send),
            onPressed: _isLoading ? null : _sendMessage,
          ),
        ],
      ),
    );
  }
}

class MarkdownMessageBubble extends StatelessWidget {
  final ChatMessage message;
  final bool isStreaming;
  
  const MarkdownMessageBubble({
    Key? key,
    required this.message,
    this.isStreaming = false,
  }) : super(key: key);
  
  @override
  Widget build(BuildContext context) {
    final isUser = message.role == MessageRole.user;
    
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(12),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        decoration: BoxDecoration(
          color: isUser
              ? Theme.of(context).primaryColor
              : Colors.grey.shade200,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (isUser)
              Text(
                message.text,
                style: const TextStyle(color: Colors.white),
              )
            else
              MarkdownBody(
                data: message.text,
                styleSheet: MarkdownStyleSheet(
                  p: const TextStyle(color: Colors.black),
                  code: TextStyle(
                    backgroundColor: Colors.grey.shade300,
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            
            if (isStreaming)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
```

## Advanced Features

### Image Upload

```dart
// lib/services/image_helper.dart

import 'dart:convert';
import 'dart:io';
import 'package:image_picker/image_picker.dart';

class ImageHelper {
  static final _picker = ImagePicker();
  
  /// Pick image from gallery
  static Future<String?> pickImageAsDataUrl() async {
    final XFile? image = await _picker.pickImage(source: ImageSource.gallery);
    if (image == null) return null;
    
    final bytes = await image.readAsBytes();
    final base64 = base64Encode(bytes);
    final mimeType = _getMimeType(image.path);
    
    return 'data:$mimeType;base64,$base64';
  }
  
  /// Pick image from camera
  static Future<String?> captureImageAsDataUrl() async {
    final XFile? image = await _picker.pickImage(source: ImageSource.camera);
    if (image == null) return null;
    
    final bytes = await image.readAsBytes();
    final base64 = base64Encode(bytes);
    final mimeType = _getMimeType(image.path);
    
    return 'data:$mimeType;base64,$base64';
  }
  
  static String _getMimeType(String path) {
    final ext = path.split('.').last.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/jpeg';
    }
  }
}

// Usage in chat screen
Future<void> _sendMessageWithImage() async {
  final imageUrl = await ImageHelper.pickImageAsDataUrl();
  if (imageUrl == null) return;
  
  final text = _controller.text.trim().isEmpty 
      ? 'What do you see in this image?'
      : _controller.text;
  
  _controller.clear();
  
  setState(() {
    _isLoading = true;
    _streamingText = '';
  });
  
  try {
    await for (final chunk in _client.sendMessage(text, imageUrl: imageUrl)) {
      setState(() {
        _streamingText += chunk;
      });
    }
  } catch (e) {
    // Handle error
  } finally {
    setState(() {
      _isLoading = false;
      _streamingText = '';
    });
  }
}
```

### Custom RAG Configuration

```dart
// Send with custom RAG settings
await for (final chunk in _client.sendMessage(
  'Tell me about coffee',
  rag: const RAGConfig(
    topK: 10,
    query: 'coffee brewing techniques',
    filters: {'category': 'tutorial'},
  ),
)) {
  print(chunk);
}
```

### Template Variables

```dart
// Send with template variables
await for (final chunk in _client.sendMessage(
  'Hello',
  variables: {
    'userName': 'Alice',
    'brand': 'Acme Corp',
  },
)) {
  print(chunk);
}
```

### Retry Logic

```dart
// lib/services/retry_helper.dart

class RetryHelper {
  static Future<T> withExponentialBackoff<T>({
    required Future<T> Function() operation,
    int maxRetries = 3,
    Duration initialDelay = const Duration(seconds: 1),
  }) async {
    int attempt = 0;
    
    while (true) {
      try {
        return await operation();
      } on PopRAGException catch (e) {
        final isLastAttempt = attempt >= maxRetries - 1;
        final isRetryable = e.statusCode == null || e.statusCode! >= 500;
        
        if (!isRetryable || isLastAttempt) {
          rethrow;
        }
        
        final delay = initialDelay * (1 << attempt); // 1s, 2s, 4s
        print('Retrying in ${delay.inSeconds}s...');
        await Future.delayed(delay);
        attempt++;
      }
    }
  }
}

// Usage
await RetryHelper.withExponentialBackoff(
  operation: () => _client.sendMessage('Hello').drain(),
  maxRetries: 3,
);
```

## State Management

### Provider Pattern

```dart
// pubspec.yaml
dependencies:
  provider: ^6.1.1

// lib/providers/chat_provider.dart

import 'package:flutter/foundation.dart';
import '../models/chat_models.dart';
import '../services/poprag_client.dart';

class ChatProvider extends ChangeNotifier {
  final PopRAGClient _client;
  
  bool _isLoading = false;
  String? _error;
  String _streamingText = '';
  
  ChatProvider({
    required String baseUrl,
    required String agentSlug,
  }) : _client = PopRAGClient(
         baseUrl: baseUrl,
         agentSlug: agentSlug,
       );
  
  bool get isLoading => _isLoading;
  String? get error => _error;
  List<ChatMessage> get messages => _client.messages;
  String get streamingText => _streamingText;
  
  Future<void> sendMessage(String text, {String? imageUrl}) async {
    _isLoading = true;
    _error = null;
    _streamingText = '';
    notifyListeners();
    
    try {
      await for (final chunk in _client.sendMessage(text, imageUrl: imageUrl)) {
        _streamingText += chunk;
        notifyListeners();
      }
    } on PopRAGException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = 'An unexpected error occurred';
    } finally {
      _isLoading = false;
      _streamingText = '';
      notifyListeners();
    }
  }
  
  void clearHistory() {
    _client.clearHistory();
    _error = null;
    notifyListeners();
  }
  
  void clearError() {
    _error = null;
    notifyListeners();
  }
  
  @override
  void dispose() {
    _client.dispose();
    super.dispose();
  }
}

// main.dart
void main() {
  runApp(
    ChangeNotifierProvider(
      create: (_) => ChatProvider(
        baseUrl: 'https://your-instance.workers.dev',
        agentSlug: 'my-agent',
      ),
      child: MyApp(),
    ),
  );
}

// In widget
class ChatScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final chat = context.watch<ChatProvider>();
    
    return Scaffold(
      body: ListView.builder(
        itemCount: chat.messages.length,
        itemBuilder: (context, index) {
          return MessageBubble(message: chat.messages[index]);
        },
      ),
    );
  }
}
```

### Riverpod Pattern

```dart
// pubspec.yaml
dependencies:
  flutter_riverpod: ^2.4.9

// lib/providers/chat_provider.dart

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/chat_models.dart';
import '../services/poprag_client.dart';

final chatClientProvider = Provider<PopRAGClient>((ref) {
  return PopRAGClient(
    baseUrl: 'https://your-instance.workers.dev',
    agentSlug: 'my-agent',
  );
});

class ChatState {
  final List<ChatMessage> messages;
  final bool isLoading;
  final String? error;
  final String streamingText;
  
  const ChatState({
    this.messages = const [],
    this.isLoading = false,
    this.error,
    this.streamingText = '',
  });
  
  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? isLoading,
    String? error,
    String? streamingText,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      isLoading: isLoading ?? this.isLoading,
      error: error ?? this.error,
      streamingText: streamingText ?? this.streamingText,
    );
  }
}

class ChatNotifier extends StateNotifier<ChatState> {
  final PopRAGClient _client;
  
  ChatNotifier(this._client) : super(const ChatState());
  
  Future<void> sendMessage(String text) async {
    state = state.copyWith(isLoading: true, error: null, streamingText: '');
    
    try {
      String fullText = '';
      await for (final chunk in _client.sendMessage(text)) {
        fullText += chunk;
        state = state.copyWith(streamingText: fullText);
      }
      
      state = state.copyWith(
        messages: _client.messages,
        streamingText: '',
      );
    } on PopRAGException catch (e) {
      state = state.copyWith(error: e.message);
    } finally {
      state = state.copyWith(isLoading: false);
    }
  }
  
  void clearHistory() {
    _client.clearHistory();
    state = const ChatState();
  }
}

final chatProvider = StateNotifierProvider<ChatNotifier, ChatState>((ref) {
  final client = ref.watch(chatClientProvider);
  return ChatNotifier(client);
});

// Usage
class ChatScreen extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chat = ref.watch(chatProvider);
    
    return Scaffold(
      body: ListView.builder(
        itemCount: chat.messages.length,
        itemBuilder: (context, index) {
          return MessageBubble(message: chat.messages[index]);
        },
      ),
    );
  }
}
```

## Error Handling

### Custom Error Widget

```dart
class ErrorBanner extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  final VoidCallback? onDismiss;
  
  const ErrorBanner({
    Key? key,
    required this.message,
    this.onRetry,
    this.onDismiss,
  }) : super(key: key);
  
  @override
  Widget build(BuildContext context) {
    return MaterialBanner(
      content: Text(message),
      backgroundColor: Colors.red.shade100,
      leading: const Icon(Icons.error, color: Colors.red),
      actions: [
        if (onRetry != null)
          TextButton(
            onPressed: onRetry,
            child: const Text('Retry'),
          ),
        if (onDismiss != null)
          TextButton(
            onPressed: onDismiss,
            child: const Text('Dismiss'),
          ),
      ],
    );
  }
}
```

### Network Status Monitoring

```dart
// pubspec.yaml
dependencies:
  connectivity_plus: ^5.0.2

// lib/services/network_monitor.dart

import 'package:connectivity_plus/connectivity_plus.dart';

class NetworkMonitor {
  final _connectivity = Connectivity();
  
  Stream<bool> get onConnectivityChanged {
    return _connectivity.onConnectivityChanged.map((result) {
      return result != ConnectivityResult.none;
    });
  }
  
  Future<bool> get isConnected async {
    final result = await _connectivity.checkConnectivity();
    return result != ConnectivityResult.none;
  }
}

// Usage in chat screen
@override
void initState() {
  super.initState();
  
  final monitor = NetworkMonitor();
  monitor.onConnectivityChanged.listen((isConnected) {
    if (!isConnected) {
      setState(() {
        _error = 'No internet connection';
      });
    }
  });
}
```

## Best Practices

### 1. Dispose Resources

Always dispose clients and controllers:
```dart
@override
void dispose() {
  _client.dispose();
  _controller.dispose();
  _scrollController.dispose();
  super.dispose();
}
```

### 2. Handle Stream Errors

```dart
try {
  await for (final chunk in _client.sendMessage(text)) {
    // Handle chunk
  }
} on PopRAGException catch (e) {
  // Handle API errors
} on SocketException catch (e) {
  // Handle network errors
} catch (e) {
  // Handle unexpected errors
}
```

### 3. Debounce Input

```dart
// pubspec.yaml
dependencies:
  rxdart: ^0.27.7

import 'package:rxdart/rxdart.dart';

final _inputSubject = BehaviorSubject<String>();

@override
void initState() {
  super.initState();
  
  _inputSubject
      .debounceTime(const Duration(milliseconds: 300))
      .listen((text) {
    // Handle input
  });
}

// In TextField
onChanged: (text) => _inputSubject.add(text),
```

### 4. Show Loading Feedback

```dart
if (_isLoading)
  const Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        CircularProgressIndicator(),
        SizedBox(height: 16),
        Text('Thinking...'),
      ],
    ),
  )
```

### 5. Persist Conversations

```dart
// pubspec.yaml
dependencies:
  shared_preferences: ^2.2.2

import 'package:shared_preferences/shared_preferences.dart';

Future<void> saveConversation() async {
  final prefs = await SharedPreferences.getInstance();
  final json = _client.messages.map((m) => m.toJson()).toList();
  await prefs.setString('conversation', jsonEncode(json));
}

Future<void> loadConversation() async {
  final prefs = await SharedPreferences.getInstance();
  final data = prefs.getString('conversation');
  if (data != null) {
    final json = jsonDecode(data) as List;
    final messages = json.map((m) => ChatMessage.fromJson(m)).toList();
    // Restore messages
  }
}
```

### 6. Implement Auto-Scroll

```dart
void _scrollToBottom() {
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  });
}

// Call after each update
setState(() {
  _streamingText += chunk;
});
_scrollToBottom();
```

### 7. Test with Mock Client

```dart
// test/mocks/mock_poprag_client.dart

import 'package:mockito/mockito.dart';
import '../models/chat_models.dart';
import '../services/poprag_client.dart';

class MockPopRAGClient extends Mock implements PopRAGClient {
  @override
  Stream<String> sendMessage(
    String text, {
    String? imageUrl,
    RAGConfig? rag,
    Map<String, dynamic>? variables,
    String? modelAlias,
  }) async* {
    yield 'Hello';
    yield ' ';
    yield 'World';
  }
}
```

### 8. Handle App Lifecycle

```dart
class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }
  
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
  
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) {
      // Save conversation
      saveConversation();
    } else if (state == AppLifecycleState.resumed) {
      // Restore conversation
      loadConversation();
    }
  }
}
```

### 9. Secure Environment Variables

```dart
// .env (add to .gitignore)
POPRAG_BASE_URL=https://your-instance.workers.dev
POPRAG_AGENT_SLUG=my-agent

// lib/config/env.dart
import 'package:flutter_dotenv/flutter_dotenv.dart';

class Env {
  static String get popragBaseUrl => dotenv.env['POPRAG_BASE_URL']!;
  static String get popragAgentSlug => dotenv.env['POPRAG_AGENT_SLUG']!;
}

// main.dart
Future<void> main() async {
  await dotenv.load();
  runApp(MyApp());
}
```

### 10. Log Errors (Production)

```dart
// pubspec.yaml
dependencies:
  sentry_flutter: ^7.14.0

import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  await SentryFlutter.init(
    (options) {
      options.dsn = 'your-sentry-dsn';
    },
    appRunner: () => runApp(MyApp()),
  );
}

// In error handler
} catch (e, stackTrace) {
  Sentry.captureException(e, stackTrace: stackTrace);
  setState(() {
    _error = 'An error occurred';
  });
}
```

## Complete Example App

```dart
// lib/main.dart

import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'widgets/chat_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await dotenv.load();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({Key? key}) : super(key: key);
  
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PopRAG Chat',
      theme: ThemeData(
        primarySwatch: Colors.blue,
        useMaterial3: true,
      ),
      home: ChatScreen(
        baseUrl: dotenv.env['POPRAG_BASE_URL']!,
        agentSlug: dotenv.env['POPRAG_AGENT_SLUG']!,
      ),
    );
  }
}
```

## Troubleshooting

### Stream Not Working
```dart
// Bad: Don't await the stream
await _client.sendMessage(text); // ❌

// Good: Iterate through the stream
await for (final chunk in _client.sendMessage(text)) { // ✅
  print(chunk);
}
```

### UI Not Updating
```dart
// Always call setState when updating UI
setState(() {
  _streamingText += chunk;
});
```

### CORS Errors
Ensure your PopRAG instance has CORS configured for your app's origin.

### Memory Leaks
Always dispose controllers and clients:
```dart
@override
void dispose() {
  _client.dispose();
  super.dispose();
}
```

## Further Reading

- [Dart HTTP Package](https://pub.dev/packages/http)
- [Flutter State Management](https://docs.flutter.dev/development/data-and-backend/state-mgmt)
- [PopRAG Frontend Integration](./FRONTEND_INTEGRATION.md)
- [PopRAG API Reference](./IMPLEMENTATION_PLAN.md)

## Support

For issues or questions:
1. Review this guide
2. Check the [Frontend Integration Guide](./FRONTEND_INTEGRATION.md)
3. Open an issue in the repository
4. Contact your PopRAG instance administrator
