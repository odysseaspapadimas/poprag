import { eq } from "drizzle-orm";
import { shouldAutoAdminSignUps } from "@/auth/env";
import { db } from "@/db";
import { user } from "@/db/schema";

type SessionWithUser = {
  user?: {
    id?: string;
    isAdmin?: boolean | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
} | null;

export async function ensureStagingAdminSession<T extends SessionWithUser>(
  session: T,
): Promise<T> {
  if (!shouldAutoAdminSignUps() || !session?.user?.id) return session;
  if (session.user.isAdmin === true) return session;

  await db
    .update(user)
    .set({ isAdmin: true })
    .where(eq(user.id, session.user.id));

  return {
    ...session,
    user: {
      ...session.user,
      isAdmin: true,
    },
  } as T;
}
