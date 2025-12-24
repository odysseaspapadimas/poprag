import { getFirebaseAdmin } from "./admin";
import type {
  FirebaseChat,
  FirebaseExperience,
  FirebaseMessage,
  FirebaseUser,
  UserQueryOptions,
} from "./types";

/**
 * Fetch all users from Firestore
 */
export async function getAllUsers(
  options: UserQueryOptions = {},
): Promise<FirebaseUser[]> {
  const db = await getFirebaseAdmin();
  const usersSnapshot = await db.collection("Users").get();

  const users: FirebaseUser[] = [];

  for (const doc of usersSnapshot.docs) {
    const userData = doc.data();
    const user: FirebaseUser = {
      uid: doc.id,
      display_name: userData.display_name || "",
      email: userData.email || "",
      photo_url: userData.photo_url,
      created_time: userData.created_time,
      Logged_id: userData.Logged_id ?? false,
      ApiCalls: userData.ApiCalls ?? 0,
      ApiCallsLimit: userData.ApiCallsLimit ?? 50,
      responsePreference: userData.responsePreference || "long",
      isFirstTimeImageRecognition:
        userData.isFirstTimeImageRecognition ?? false,
      ExpirationDateAnnouncementApplied:
        userData.ExpirationDateAnnouncementApplied ?? false,
    };

    if (options.includeExperiences) {
      user.experiences = await getUserExperiences(doc.id, options);
    }

    users.push(user);
  }

  return users;
}

/**
 * Fetch a single user by UID
 */
export async function getUserById(
  uid: string,
  options: UserQueryOptions = {},
): Promise<FirebaseUser | null> {
  const db = await getFirebaseAdmin();
  const userDoc = await db.collection("Users").doc(uid).get();

  if (!userDoc.exists) {
    return null;
  }

  const userData = userDoc.data();
  const user: FirebaseUser = {
    uid: userDoc.id,
    display_name: userData.display_name || "",
    email: userData.email || "",
    photo_url: userData.photo_url,
    created_time: userData.created_time,
    Logged_id: userData.Logged_id ?? false,
    ApiCalls: userData.ApiCalls ?? 0,
    ApiCallsLimit: userData.ApiCallsLimit ?? 50,
    responsePreference: userData.responsePreference || "long",
    isFirstTimeImageRecognition: userData.isFirstTimeImageRecognition ?? false,
    ExpirationDateAnnouncementApplied:
      userData.ExpirationDateAnnouncementApplied ?? false,
  };

  if (options.includeExperiences) {
    user.experiences = await getUserExperiences(uid, options);
  }

  return user;
}

/**
 * Fetch all experiences for a user
 */
export async function getUserExperiences(
  uid: string,
  options: UserQueryOptions = {},
): Promise<FirebaseExperience[]> {
  const db = await getFirebaseAdmin();

  // If specific experience is requested
  if (options.experienceId) {
    const experience = await getUserExperience(
      uid,
      options.experienceId,
      options,
    );
    return experience ? [experience] : [];
  }

  const experiencesSnapshot = await db
    .collection(`Users/${uid}/experiences`)
    .get();

  const experiences: FirebaseExperience[] = [];

  for (const doc of experiencesSnapshot.docs) {
    const expData = doc.data();
    const experience: FirebaseExperience = {
      id: doc.id,
      lastUsed: expData.lastUsed,
    };

    if (options.includeChats) {
      experience.chats = await getExperienceChats(uid, doc.id, options);
    }

    experiences.push(experience);
  }

  return experiences;
}

/**
 * Fetch a specific experience for a user
 */
export async function getUserExperience(
  uid: string,
  experienceId: string,
  options: UserQueryOptions = {},
): Promise<FirebaseExperience | null> {
  const db = await getFirebaseAdmin();
  const expDoc = await db
    .collection(`Users/${uid}/experiences`)
    .doc(experienceId)
    .get();

  if (!expDoc.exists) {
    return null;
  }

  const expData = expDoc.data();
  const experience: FirebaseExperience = {
    id: expDoc.id,
    lastUsed: expData.lastUsed,
  };

  if (options.includeChats) {
    experience.chats = await getExperienceChats(uid, experienceId, options);
  }

  return experience;
}

/**
 * Fetch all chats for an experience
 */
export async function getExperienceChats(
  uid: string,
  experienceId: string,
  options: UserQueryOptions = {},
): Promise<FirebaseChat[]> {
  const db = await getFirebaseAdmin();

  // If specific chat is requested
  if (options.chatId) {
    const chat = await getExperienceChat(
      uid,
      experienceId,
      options.chatId,
      options,
    );
    return chat ? [chat] : [];
  }

  const chatsSnapshot = await db
    .collection(`Users/${uid}/experiences/${experienceId}/chats`)
    .get();

  const chats: FirebaseChat[] = [];

  for (const doc of chatsSnapshot.docs) {
    const chatData = doc.data();
    const chat: FirebaseChat = {
      id: doc.id,
      title: chatData.title || "",
      createdAt: chatData.createdAt,
    };

    if (options.includeMessages) {
      chat.messages = await getChatMessages(uid, experienceId, doc.id);
    }

    chats.push(chat);
  }

  return chats;
}

/**
 * Fetch a specific chat for an experience
 */
export async function getExperienceChat(
  uid: string,
  experienceId: string,
  chatId: string,
  options: UserQueryOptions = {},
): Promise<FirebaseChat | null> {
  const db = await getFirebaseAdmin();
  const chatDoc = await db
    .collection(`Users/${uid}/experiences/${experienceId}/chats`)
    .doc(chatId)
    .get();

  if (!chatDoc.exists) {
    return null;
  }

  const chatData = chatDoc.data();
  const chat: FirebaseChat = {
    id: chatDoc.id,
    title: chatData.title || "",
    createdAt: chatData.createdAt,
  };

  if (options.includeMessages) {
    chat.messages = await getChatMessages(uid, experienceId, chatId);
  }

  return chat;
}

/**
 * Fetch all messages for a chat
 */
export async function getChatMessages(
  uid: string,
  experienceId: string,
  chatId: string,
): Promise<FirebaseMessage[]> {
  const db = await getFirebaseAdmin();
  const messagesSnapshot = await db
    .collection(
      `Users/${uid}/experiences/${experienceId}/chats/${chatId}/messages`,
    )
    .get();

  const messages: FirebaseMessage[] = [];

  for (const doc of messagesSnapshot.docs) {
    const msgData = doc.data();
    messages.push({
      id: doc.id,
      content: msgData.content || "",
      imageUrl: msgData.imageUrl,
      role: msgData.role || "user",
      timestamp: msgData.timestamp,
    });
  }

  return messages;
}
