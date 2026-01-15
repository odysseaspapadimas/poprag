import type { TRPCRouterRecord } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "@/integrations/trpc/init";
import { getAllUsers, getUserById } from "@/lib/firebase/queries";

/**
 * User router - fetches from Firebase Firestore using REST API
 */

export const userRouter = {
  /**
   * Get all users
   */
  getAll: protectedProcedure
    .input(
      z
        .object({
          includeExperiences: z.boolean().optional(),
          includeChats: z.boolean().optional(),
          includeMessages: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      try {
        return await getAllUsers(input || {});
      } catch (error) {
        console.error("Error fetching users from Firebase:", error);
        return [];
      }
    }),

  /**
   * Get a single user by UID
   */
  getById: protectedProcedure
    .input(
      z.object({
        uid: z.string(),
        includeExperiences: z.boolean().optional(),
        includeChats: z.boolean().optional(),
        includeMessages: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        const { uid, ...options } = input;
        return await getUserById(uid, options);
      } catch (error) {
        console.error("Error fetching user from Firebase:", error);
        return null;
      }
    }),

  /**
   * Get user with specific experience
   */
  getWithExperience: protectedProcedure
    .input(
      z.object({
        uid: z.string(),
        experienceId: z.string(),
        includeChats: z.boolean().optional(),
        includeMessages: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        const { uid, experienceId, ...options } = input;
        const user = await getUserById(uid, {
          includeExperiences: true,
          experienceId,
          ...options,
        });
        return user;
      } catch (error) {
        console.error("Error fetching user with experience:", error);
        return null;
      }
    }),

  /**
   * Get user with specific experience and chat
   */
  getWithChat: protectedProcedure
    .input(
      z.object({
        uid: z.string(),
        experienceId: z.string(),
        chatId: z.string(),
        includeMessages: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        const { uid, experienceId, chatId, includeMessages } = input;
        const user = await getUserById(uid, {
          includeExperiences: true,
          includeChats: true,
          experienceId,
          chatId,
          includeMessages,
        });
        return user;
      } catch (error) {
        console.error("Error fetching user with chat:", error);
        return null;
      }
    }),
} satisfies TRPCRouterRecord;
