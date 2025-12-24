# Firebase User Queries - Usage Examples

This document shows how to use the flexible user query system.

## Type Definitions

### User Structure
```typescript
interface FirebaseUser {
  uid: string;
  display_name: string;
  email: string;
  photo_url?: string;
  created_time: FirebaseTimestamp;
  Logged_id: boolean;
  ApiCalls: number;
  ApiCallsLimit: number;
  responsePreference: "long" | "short";
  isFirstTimeImageRecognition: boolean;
  ExpirationDateAnnouncementApplied: boolean;
  experiences?: FirebaseExperience[];
}
```

### Experience Structure
```typescript
interface FirebaseExperience {
  id: string;  // Same as document ID (experience name)
  lastUsed: FirebaseTimestamp;
  chats?: FirebaseChat[];
}
```

### Chat Structure
```typescript
interface FirebaseChat {
  id: string;
  title: string;
  createdAt: FirebaseTimestamp;
  messages?: FirebaseMessage[];
}
```

### Message Structure
```typescript
interface FirebaseMessage {
  id: string;
  content: string;
  imageUrl?: string;
  role: "user" | "assistant";
  timestamp: FirebaseTimestamp;
}
```

## tRPC API Endpoints

### 1. Get All Users (Basic)

```typescript
// Just users, no subcollections
const users = await trpc.user.getAll.query();
```

### 2. Get All Users with Experiences

```typescript
// Users with their experiences
const users = await trpc.user.getAll.query({
  includeExperiences: true,
});
```

### 3. Get All Users with Full Nested Data

```typescript
// Users → Experiences → Chats → Messages
const users = await trpc.user.getAll.query({
  includeExperiences: true,
  includeChats: true,
  includeMessages: true,
});
```

### 4. Get Single User

```typescript
// Just user data
const user = await trpc.user.getById.query({
  uid: "DRNm3EIOabZmbHx8DYCHioBSi8s1",
});
```

### 5. Get User with Experiences

```typescript
// User with all their experiences
const user = await trpc.user.getById.query({
  uid: "DRNm3EIOabZmbHx8DYCHioBSi8s1",
  includeExperiences: true,
});
```

### 6. Get User with Specific Experience

```typescript
// User with one specific experience
const user = await trpc.user.getWithExperience.query({
  uid: "DRNm3EIOabZmbHx8DYCHioBSi8s1",
  experienceId: "shopping-assistant",
});
```

### 7. Get User with Experience and Chats

```typescript
// User → Specific Experience → All Chats
const user = await trpc.user.getWithExperience.query({
  uid: "DRNm3EIOabZmbHx8DYCHioBSi8s1",
  experienceId: "shopping-assistant",
  includeChats: true,
});
```

### 8. Get User with Specific Chat and Messages

```typescript
// User → Experience → Specific Chat → All Messages
const user = await trpc.user.getWithChat.query({
  uid: "DRNm3EIOabZmbHx8DYCHioBSi8s1",
  experienceId: "shopping-assistant",
  chatId: "chat-123",
  includeMessages: true,
});
```

## Direct Query Functions

You can also use the query functions directly (outside tRPC):

### Get All Users
```typescript
import { getAllUsers } from "@/lib/firebase/queries";

// Basic
const users = await getAllUsers();

// With experiences
const users = await getAllUsers({ includeExperiences: true });

// With full nested data
const users = await getAllUsers({
  includeExperiences: true,
  includeChats: true,
  includeMessages: true,
});
```

### Get Single User
```typescript
import { getUserById } from "@/lib/firebase/queries";

const user = await getUserById("user-uid", {
  includeExperiences: true,
  includeChats: true,
});
```

### Get Specific Experience
```typescript
import { getUserExperience } from "@/lib/firebase/queries";

const experience = await getUserExperience(
  "user-uid",
  "shopping-assistant",
  { includeChats: true }
);
```

### Get Specific Chat
```typescript
import { getExperienceChat } from "@/lib/firebase/queries";

const chat = await getExperienceChat(
  "user-uid",
  "shopping-assistant",
  "chat-123",
  { includeMessages: true }
);
```

## Query Options

All query functions accept an options object:

```typescript
interface UserQueryOptions {
  includeExperiences?: boolean;  // Include experiences subcollection
  includeChats?: boolean;        // Include chats for experiences
  includeMessages?: boolean;     // Include messages for chats
  experienceId?: string;         // Filter to specific experience
  chatId?: string;              // Filter to specific chat
}
```

## Firestore Collection Structure

```
Users/
  {uid}/
    - display_name
    - email
    - photo_url
    - created_time
    - ApiCalls
    - ApiCallsLimit
    - etc.
    
    experiences/
      {experienceName}/
        - lastUsed
        
        chats/
          {chatId}/
            - title
            - createdAt
            
            messages/
              {messageId}/
                - content
                - imageUrl
                - role
                - timestamp
```

## Example Response

```json
{
  "uid": "DRNm3EIOabZmbHx8DYCHioBSi8s1",
  "display_name": "Anastasia Garnavou",
  "email": "anastasiagarnavou@gmail.com",
  "photo_url": "https://lh3.googleusercontent.com/...",
  "created_time": {
    "_seconds": 1761498022,
    "_nanoseconds": 794000000
  },
  "ApiCalls": 0,
  "ApiCallsLimit": 50,
  "responsePreference": "long",
  "experiences": [
    {
      "id": "shopping-assistant",
      "lastUsed": {
        "_seconds": 1761500000,
        "_nanoseconds": 0
      },
      "chats": [
        {
          "id": "chat-123",
          "title": "Product Search",
          "createdAt": {
            "_seconds": 1761499000,
            "_nanoseconds": 0
          },
          "messages": [
            {
              "id": "msg-1",
              "content": "Hello!",
              "role": "user",
              "timestamp": {
                "_seconds": 1761499100,
                "_nanoseconds": 0
              }
            }
          ]
        }
      ]
    }
  ]
}
```

## Performance Considerations

- **Minimize nesting**: Only include subcollections you need
- **Specific queries**: Use `experienceId` and `chatId` filters to fetch specific items
- **Pagination**: For large datasets, consider implementing pagination (not yet supported)
- **Caching**: Results are not cached by default - implement caching if needed

## Future Enhancements

- Pagination support for large collections
- Filtering and sorting options
- Real-time listeners for live updates
- Batch operations for multiple documents
- Field-level filtering
