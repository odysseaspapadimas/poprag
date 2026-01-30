# Dart App: Add Firebase Authentication to PopRAG API Calls

## Overview

Update the Flutter/Dart app to send Firebase ID tokens when making requests to the PopRAG chat API. This enables user tracking and metrics in the PopRAG dashboard.

## File to Update

`docs/codeee.dart` - The `AssistantAChatWidgetWithHistory` widget

## Changes Required

### 1. Update `_sendPopragRequest` method (around line 1029)

**Current code:**
```dart
final client = http.Client();
try {
  final request = http.Request(
    'POST',
    Uri.parse('$_popragBaseUrl/api/chat/$_popragAgentSlug'),
  )
    ..headers['Content-Type'] = 'application/json'
    ..body = jsonEncode(requestBody);
```

**Updated code:**
```dart
// Get Firebase ID token for authentication
String? idToken;
try {
  idToken = await _auth.currentUser?.getIdToken();
} catch (e) {
  print('[PopRAG Auth] Failed to get Firebase ID token: $e');
}

final client = http.Client();
try {
  final request = http.Request(
    'POST',
    Uri.parse('$_popragBaseUrl/api/chat/$_popragAgentSlug'),
  );
  
  // Set headers
  request.headers['Content-Type'] = 'application/json';
  
  // Add Authorization header if user is authenticated
  if (idToken != null && idToken.isNotEmpty) {
    request.headers['Authorization'] = 'Bearer $idToken';
    print('[PopRAG Auth] Sending request with Firebase auth token');
  } else {
    print('[PopRAG Auth] Sending request without auth (user not logged in)');
  }
  
  request.body = jsonEncode(requestBody);
```

## How It Works

1. `_auth.currentUser?.getIdToken()` gets the current Firebase user's ID token
2. Firebase SDK automatically refreshes expired tokens
3. Token is sent in the `Authorization: Bearer <token>` header
4. PopRAG backend verifies the token and tracks the user

## Notes

- The `_auth` variable already exists in the class (`final FirebaseAuth _auth = FirebaseAuth.instance;`)
- Token retrieval is wrapped in try/catch to handle edge cases gracefully
- Requests still work without a token (unauthenticated users allowed)
- No new dependencies required - uses existing `firebase_auth` package

## Testing

After making changes:
1. Ensure user is logged into Firebase in the app
2. Send a chat message
3. Check PopRAG dashboard for the user in Firebase Users section
4. Verify transcript shows the Firebase UID
