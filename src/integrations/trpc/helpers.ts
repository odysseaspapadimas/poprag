/**
 * Shared helpers for tRPC procedures
 * Reduces duplication across routers for common patterns
 */

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { type Agent, agent, auditLog } from "@/db/schema";

// ─────────────────────────────────────────────────────
// Audit Logging
// ─────────────────────────────────────────────────────

/**
 * Audit event types for consistent naming
 */
export type AuditEventType =
  // Agent events
  | "agent.created"
  | "agent.updated"
  | "agent.archived"
  | "agent.deleted"
  | "agent.index_pinned"
  | "agent.policy_updated"
  // Knowledge events
  | "knowledge.uploaded"
  | "knowledge.indexed"
  | "knowledge.reindexed"
  | "knowledge.deleted"
  | "knowledge.failed"
  // Prompt events
  | "prompt.version_created"
  | "prompt.version_updated"
  | "prompt.version_deleted"
  | "prompt.label_assigned"
  | "prompt.label_rollback"
  // Chat events
  | "chat.image_uploaded"
  | "chat.image_deleted"
  // Model events
  | "model.alias_created"
  | "model.alias_updated"
  | "model.alias_deleted";

/**
 * Target types for audit logs
 */
export type AuditTargetType =
  | "agent"
  | "knowledge_source"
  | "prompt"
  | "chat_image"
  | "model_alias";

/**
 * Create an audit log entry
 *
 * @param actorId - User ID performing the action
 * @param eventType - Type of event being logged
 * @param target - Target entity being affected
 * @param diff - Changes being made (optional)
 */
export async function createAuditLog(
  actorId: string,
  eventType: AuditEventType,
  target: { type: AuditTargetType; id: string },
  diff?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    id: nanoid(),
    actorId,
    eventType,
    targetType: target.type,
    targetId: target.id,
    diff: diff || {},
    createdAt: new Date(),
  });
}

/**
 * Shorthand for creating audit log from context
 * Use in tRPC procedures
 */
export function audit(
  ctx: { session: { user: { id: string } } },
  eventType: AuditEventType,
  target: { type: AuditTargetType; id: string },
  diff?: Record<string, unknown>,
): Promise<void> {
  return createAuditLog(ctx.session.user.id, eventType, target, diff);
}

// ─────────────────────────────────────────────────────
// Agent Verification
// ─────────────────────────────────────────────────────

/**
 * Get an agent by ID, throwing if not found
 *
 * @param agentId - The agent ID to look up
 * @returns The agent record
 * @throws TRPCError with NOT_FOUND if agent doesn't exist
 */
export async function requireAgent(agentId: string): Promise<Agent> {
  const [agentData] = await db
    .select()
    .from(agent)
    .where(eq(agent.id, agentId))
    .limit(1);

  if (!agentData) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Agent not found",
    });
  }

  return agentData;
}

/**
 * Get an agent by slug, throwing if not found
 *
 * @param slug - The agent slug to look up
 * @returns The agent record
 * @throws TRPCError with NOT_FOUND if agent doesn't exist
 */
export async function requireAgentBySlug(slug: string): Promise<Agent> {
  const [agentData] = await db
    .select()
    .from(agent)
    .where(eq(agent.slug, slug))
    .limit(1);

  if (!agentData) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Agent '${slug}' not found`,
    });
  }

  return agentData;
}

/**
 * Get an agent by ID or slug, returning null if not found
 *
 * @param identifier - Object with either id or slug
 * @returns The agent record or null
 */
export async function getAgent(identifier: {
  id?: string;
  slug?: string;
}): Promise<Agent | null> {
  if (!identifier.id && !identifier.slug) {
    return null;
  }

  const [agentData] = await db
    .select()
    .from(agent)
    .where(
      identifier.id
        ? eq(agent.id, identifier.id)
        : eq(agent.slug, identifier.slug!),
    )
    .limit(1);

  return agentData || null;
}

/**
 * Require an agent to be in active status
 *
 * @param agentData - The agent record to check
 * @throws TRPCError with PRECONDITION_FAILED if not active
 */
export function requireActiveAgent(agentData: Agent): void {
  if (agentData.status !== "active") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Agent '${agentData.slug}' is not active`,
    });
  }
}

/**
 * Get agent and verify it's active in one call
 *
 * @param agentId - The agent ID to look up
 * @returns The active agent record
 * @throws TRPCError if not found or not active
 */
export async function requireActiveAgentById(agentId: string): Promise<Agent> {
  const agentData = await requireAgent(agentId);
  requireActiveAgent(agentData);
  return agentData;
}
