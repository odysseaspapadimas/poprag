/**
 * Firebase type definitions for PopRAG
 *
 * These types ensure consistency between Firebase data and TypeScript code
 */

/**
 * Firebase Timestamp format
 * Firestore stores dates as objects with seconds and nanoseconds
 */
export interface FirebaseTimestamp {
  _seconds: number;
  _nanoseconds: number;
}

/**
 * Message role type
 */
export type MessageRole = "user" | "assistant";

/**
 * Message document structure
 * Maps to Users/{uid}/experiences/{experienceId}/chats/{chatId}/messages collection
 */
export interface FirebaseMessage {
  /** Message ID */
  id: string;

  /** Message content */
  content: string;

  /** Image URL (optional) */
  imageUrl?: string;

  /** Message role */
  role: MessageRole;

  /** Message timestamp */
  timestamp: FirebaseTimestamp;
}

/**
 * Chat document structure
 * Maps to Users/{uid}/experiences/{experienceId}/chats collection
 */
export interface FirebaseChat {
  /** Chat ID */
  id: string;

  /** Chat title */
  title: string;

  /** Chat creation timestamp */
  createdAt: FirebaseTimestamp;

  /** Optional messages subcollection */
  messages?: FirebaseMessage[];
}

/**
 * Experience document structure
 * Maps to Users/{uid}/experiences collection
 * Document ID is the experience name
 */
export interface FirebaseExperience {
  /** Experience ID (same as name) */
  id: string;

  /** Last time this experience was used */
  lastUsed: FirebaseTimestamp;

  /** Optional chats subcollection */
  chats?: FirebaseChat[];
}

/**
 * Firebase User document structure
 * Maps to the Users collection in Firestore
 */
export interface FirebaseUser {
  /** Unique user identifier (uid) */
  uid: string;

  /** Display name */
  display_name: string;

  /** Email address */
  email: string;

  /** Profile photo URL */
  photo_url?: string;

  /** Account creation timestamp */
  created_time: FirebaseTimestamp;

  /** Whether user has logged in */
  Logged_id: boolean;

  /** API calls made */
  ApiCalls: number;

  /** API calls limit */
  ApiCallsLimit: number;

  /** Response preference */
  responsePreference: "long" | "short";

  /** First time image recognition flag */
  isFirstTimeImageRecognition: boolean;

  /** Expiration date announcement applied flag */
  ExpirationDateAnnouncementApplied: boolean;

  /** Optional experiences subcollection */
  experiences?: FirebaseExperience[];
}

/**
 * Query options for fetching users with subcollections
 */
export interface UserQueryOptions {
  /** Include experiences subcollection */
  includeExperiences?: boolean;

  /** Include chats for experiences */
  includeChats?: boolean;

  /** Include messages for chats */
  includeMessages?: boolean;

  /** Specific experience ID to fetch */
  experienceId?: string;

  /** Specific chat ID to fetch */
  chatId?: string;
}

/**
 * Utility type for creating new Firebase users
 */
export type CreateFirebaseUser = Omit<FirebaseUser, "uid" | "experiences"> & {
  uid?: string;
};

/**
 * Utility type for updating Firebase users
 */
export type UpdateFirebaseUser = Partial<
  Omit<FirebaseUser, "uid" | "experiences">
> & {
  uid: string;
};

/**
 * Convert JavaScript Date to Firebase Timestamp
 */
export function dateToFirebaseTimestamp(date: Date): FirebaseTimestamp {
  const milliseconds = date.getTime();
  return {
    _seconds: Math.floor(milliseconds / 1000),
    _nanoseconds: (milliseconds % 1000) * 1000000,
  };
}

/**
 * Convert Firebase Timestamp to JavaScript Date
 */
export function firebaseTimestampToDate(timestamp: FirebaseTimestamp): Date {
  return new Date(timestamp._seconds * 1000 + timestamp._nanoseconds / 1000000);
}

/**
 * Format Firebase Timestamp for display
 */
export function formatFirebaseTimestamp(
  timestamp: FirebaseTimestamp,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = firebaseTimestampToDate(timestamp);
  return date.toLocaleDateString(
    "en-US",
    options || {
      year: "numeric",
      month: "short",
      day: "numeric",
    },
  );
}
