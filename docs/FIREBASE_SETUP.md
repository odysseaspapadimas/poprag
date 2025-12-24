# Firebase Integration Guide

This guide explains how to set up and use Firebase in the PopRAG project for user management.

## Overview

The project uses Firebase Firestore REST API to store and manage users. This approach works in Cloudflare Workers (edge runtime) where the Firebase Admin SDK is not compatible.

## Architecture

- **Firebase REST API Client** (`src/lib/firebase/admin.ts`): Server-side Firestore access using REST API
- **Firebase Client SDK** (`src/lib/firebase/config.ts`): Client-side operations (optional, for future use)
- **Users Collection**: Firestore collection named "Users" that stores user data

## Why REST API Instead of Admin SDK?

Firebase Admin SDK requires Node.js APIs that aren't available in Cloudflare Workers (edge runtime). The REST API approach:
- ✅ Works in any runtime environment (Node.js, edge, browser)
- ✅ No dependency issues with Vite or Cloudflare Workers
- ✅ Uses service account credentials for authentication
- ✅ Provides the same functionality as the Admin SDK

## Setup Instructions

### 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or select an existing one
3. Enable Firestore Database:
   - Go to **Build** > **Firestore Database**
   - Click **Create Database**
   - Choose production mode
   - Select a location

### 2. Generate Service Account Credentials

1. Go to **Project Settings** > **Service Accounts**
2. Click **Generate New Private Key**
3. Save the JSON file securely

### 3. Encode Service Account for Environment Variable

```bash
# Convert the service account JSON to base64
base64 -i path/to/serviceAccountKey.json | tr -d '\n'
```

Copy the output and add it to your `.env` file:

```env
SERVICE_ACCOUNT_DATA=paste_base64_encoded_json_here
```

### 4. Get Firebase Client Configuration

1. Go to **Project Settings** > **General**
2. Scroll to **Your apps** section
3. Click the web app icon (`</>`) or select your existing web app
4. Copy the configuration values

Add them to your `.env` file:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=your_measurement_id
```

### 5. Add Test Data (Optional)

You can manually add test users in the Firebase Console:

1. Go to Firestore Database
2. Create a collection named "Users"
3. Add documents with the structure below

## Data Structure

### Firebase User Document

```typescript
{
  id: string;                    // User ID
  name: string;                  // Display name
  email: string;                 // Email address
  emailVerified: boolean;        // Email verification status
  image?: string;                // Profile image URL (optional)
  created_time: {                // Creation timestamp
    _seconds: number;
    _nanoseconds: number;
  };
  updated_time?: {               // Last update timestamp (optional)
    _seconds: number;
    _nanoseconds: number;
  };
  isAdmin: boolean;              // Admin flag
}
```

### D1 User Table (Legacy)

```typescript
{
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  isAdmin: boolean | null;
}
```

## Usage

### Server-side (tRPC)

```typescript
import { getFirebaseAdmin } from "@/lib/firebase/admin";

// Fetch all users
const db = await getFirebaseAdmin();
const usersSnapshot = await db.collection("Users").get();
const users = usersSnapshot.docs.map(doc => ({
  id: doc.id,
  ...doc.data()
}));

// Get a specific user
const userDoc = await db.collection("Users").doc(userId).get();
const user = userDoc.data();

// Create a user
await db.collection("Users").doc(userId).set({
  name: "John Doe",
  email: "john@example.com",
  emailVerified: false,
  created_time: {
    _seconds: Math.floor(Date.now() / 1000),
    _nanoseconds: 0
  },
  isAdmin: false
});

// Update a user
await db.collection("Users").doc(userId).update({
  name: "Jane Doe",
  updated_time: {
    _seconds: Math.floor(Date.now() / 1000),
    _nanoseconds: 0
  }
});

// Delete a user
await db.collection("Users").doc(userId).delete();
```

### Client-side (Future Use)

```typescript
import { db, auth } from "@/lib/firebase/config";
import { collection, getDocs, query, where } from "firebase/firestore";

// Query users (with proper security rules)
const usersRef = collection(db, "Users");
const q = query(usersRef, where("isAdmin", "==", true));
const snapshot = await getDocs(q);
const admins = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
```

## Files Modified

1. **`src/lib/firebase/admin.ts`**: Firebase Admin SDK initialization
2. **`src/lib/firebase/config.ts`**: Firebase Client SDK configuration
3. **`src/integrations/trpc/router/user.ts`**: User router updated to fetch from Firebase
4. **`src/components/tables/columns-users.tsx`**: User table columns updated for Firebase data
5. **`scripts/migrate-users-to-firebase.ts`**: Migration utility
6. **`.env.example`**: Added Firebase environment variables

## Security Considerations

1. **Service Account**: Never commit `SERVICE_ACCOUNT_DATA` or the JSON file to version control
2. **Firestore Rules**: Set up proper security rules in Firebase Console:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Only authenticated admins can read/write Users collection
    match /Users/{userId} {
      allow read, write: if request.auth != null && 
                            get(/databases/$(database)/documents/Users/$(request.auth.uid)).data.isAdmin == true;
    }
  }
}
```

3. **Environment Variables**: Use `.env.local` for local development and never commit it

## Troubleshooting

### Error: "SERVICE_ACCOUNT_DATA is not defined"

Make sure you've added the base64-encoded service account to your `.env` file.

### Error: "Cannot connect to Firestore"

1. Check that your Firebase project has Firestore enabled
2. Verify the service account credentials are correct
3. Ensure the project ID in the service account matches your Firebase project

### Migration Script Fails

1. Ensure D1 database is accessible
2. Check that Firebase credentials are configured
3. Review console logs for specific error messages

## Next Steps

1. Set up Firestore security rules
2. Consider adding Firebase Authentication for user login
3. Implement real-time listeners for live updates
4. Add user CRUD operations in the admin panel
5. Set up Firebase indexes for efficient queries

## Resources

- [Firebase Admin SDK Documentation](https://firebase.google.com/docs/admin/setup)
- [Firestore Documentation](https://firebase.google.com/docs/firestore)
- [Firebase Security Rules](https://firebase.google.com/docs/firestore/security/get-started)
