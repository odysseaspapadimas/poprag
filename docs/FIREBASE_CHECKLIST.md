# Firebase Integration Checklist

This checklist will help you complete the Firebase setup for PopRAG.

## ✅ Completed (by AI)

- [x] Installed Firebase packages (`firebase` and `firebase-admin`)
- [x] Created Firebase Admin SDK configuration
- [x] Created Firebase Client SDK configuration
- [x] Added environment variables to `.env.example`
- [x] Created migration script for existing users
- [x] Updated user router to fetch from Firebase
- [x] Updated user table columns for Firebase data
- [x] Created shared type definitions
- [x] Created comprehensive documentation

## 🔲 Your Next Steps

### 1. Set Up Firebase Project

- [ ] Go to [Firebase Console](https://console.firebase.google.com/)
- [ ] Create a new project or select existing one
- [ ] Enable Firestore Database (Production mode)
- [ ] Note down your Project ID

### 2. Generate Service Account

- [ ] Go to Project Settings → Service Accounts
- [ ] Click "Generate New Private Key"
- [ ] Download the JSON file
- [ ] Store it securely (DO NOT commit to Git)

### 3. Configure Environment Variables

- [ ] Create `.env` file (copy from `.env.example`)
- [ ] Encode service account:
  ```bash
  base64 -i path/to/serviceAccountKey.json | tr -d '\n'
  ```
- [ ] Add to `.env`:
  ```env
  SERVICE_ACCOUNT_DATA=your_base64_encoded_service_account
  ```

### 4. Add Firebase Client Configuration

- [ ] Go to Project Settings → General
- [ ] Scroll to "Your apps" → Web app
- [ ] Copy configuration values
- [ ] Add to `.env`:
  ```env
  NEXT_PUBLIC_FIREBASE_API_KEY=...
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
  NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
  NEXT_PUBLIC_FIREBASE_APP_ID=...
  NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=...
  ```

### 5. Migrate Existing Users

- [ ] Ensure `.env` is configured with Firebase credentials
- [ ] Run migration script:
  ```bash
  pnpm migrate-users-to-firebase
  ```
- [ ] Verify users in Firebase Console

### 6. Set Up Firestore Security Rules

- [ ] Go to Firestore Database → Rules
- [ ] Update with these rules:
  ```javascript
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /Users/{userId} {
        allow read, write: if request.auth != null && 
          get(/databases/$(database)/documents/Users/$(request.auth.uid)).data.isAdmin == true;
      }
    }
  }
  ```
- [ ] Click "Publish"

### 7. Test the Integration

- [ ] Start dev server: `pnpm dev`
- [ ] Navigate to `/users` page
- [ ] Verify users are displayed
- [ ] Check for any console errors

### 8. Security Checklist

- [ ] `.env` is in `.gitignore`
- [ ] Service account JSON is NOT committed to Git
- [ ] Firestore security rules are configured
- [ ] Only admin users can access `/users` page
- [ ] Environment variables are set in production

### 9. Optional Enhancements

- [ ] Set up Firebase Authentication for user login
- [ ] Add user CRUD operations (Create, Update, Delete)
- [ ] Implement real-time listeners for live updates
- [ ] Create Firestore indexes for common queries
- [ ] Set up Firebase App Check for additional security

## 📚 Documentation Files

- **Setup Guide**: [docs/FIREBASE_SETUP.md](./FIREBASE_SETUP.md)
- **Implementation Summary**: [docs/FIREBASE_IMPLEMENTATION.md](./FIREBASE_IMPLEMENTATION.md)
- **This Checklist**: [docs/FIREBASE_CHECKLIST.md](./FIREBASE_CHECKLIST.md)

## 🆘 Troubleshooting

### "SERVICE_ACCOUNT_DATA is not defined"
1. Make sure `.env` exists (not just `.env.example`)
2. Verify the environment variable is spelled correctly
3. Restart the dev server after adding the variable

### "Permission denied" errors
1. Check Firestore security rules
2. Verify user has admin privileges (`isAdmin: true`)
3. Ensure user is authenticated

### Migration script fails
1. Check D1 database is accessible
2. Verify Firebase credentials are correct
3. Look at console output for specific errors
4. Try running with fewer users first (edit script to limit batch size)

### Users not displaying
1. Open browser DevTools console
2. Check Network tab for failed requests
3. Verify Firebase credentials in `.env`
4. Check Firestore Console to ensure Users collection exists

## 🎯 Success Criteria

You'll know the integration is successful when:

1. ✅ Dev server starts without errors
2. ✅ `/users` page loads
3. ✅ Users are displayed in the table
4. ✅ User data includes name, email, admin status, created date
5. ✅ No console errors in browser or terminal
6. ✅ Firebase Console shows Users collection with data

## 📝 Notes

- Keep your service account credentials secure
- Never commit `.env` or service account JSON to Git
- Set up proper security rules before going to production
- Consider setting up Firebase Authentication for enhanced security
- Monitor Firebase usage in the Firebase Console

## 🚀 Ready to Deploy?

Before deploying to production:

- [ ] All environment variables set in production environment
- [ ] Firestore security rules configured and tested
- [ ] Users migrated successfully
- [ ] Application tested thoroughly
- [ ] Firebase billing set up (if needed for scale)
- [ ] Monitoring and alerts configured

---

Need help? Check the documentation files or consult the [Firebase Documentation](https://firebase.google.com/docs).
