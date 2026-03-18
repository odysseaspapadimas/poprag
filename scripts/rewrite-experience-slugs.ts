import "dotenv/config";

import { generateUnicodeSlug } from "../src/lib/slug";

type ExperienceRow = {
  id: string;
  agent_id: string;
  name: string;
  slug: string;
};

type D1QueryResponse<T> = {
  success: boolean;
  result: Array<{
    success: boolean;
    results?: T[];
    error?: string;
  }>;
  errors?: Array<{ message?: string }>;
};

function requiredEnv(name: keyof NodeJS.ProcessEnv): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function runD1Query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const accountId = requiredEnv("D1_ACCOUNT_ID");
  const databaseId = requiredEnv("D1_DATABASE_ID");
  const token = requiredEnv("D1_TOKEN");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );

  const json = (await response.json()) as D1QueryResponse<T>;

  if (!response.ok || !json.success) {
    const message =
      json.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
      `D1 query failed with status ${response.status}`;
    throw new Error(message);
  }

  const firstResult = json.result[0];
  if (!firstResult?.success) {
    throw new Error(firstResult?.error || "D1 query execution failed");
  }

  return firstResult.results || [];
}

async function main() {
  const experiences = await runD1Query<ExperienceRow>(
    `SELECT id, agent_id, name, slug
     FROM agent_experience
     ORDER BY agent_id ASC, created_at ASC, id ASC`,
  );

  const usedSlugsByAgent = new Map<string, Set<string>>();
  const updates: Array<{
    id: string;
    previousSlug: string;
    nextSlug: string;
    name: string;
  }> = [];

  for (const experience of experiences) {
    const baseSlug = generateUnicodeSlug(experience.name);
    const usedSlugs =
      usedSlugsByAgent.get(experience.agent_id) ?? new Set<string>();

    let nextSlug = baseSlug;
    let suffix = 1;
    while (usedSlugs.has(nextSlug)) {
      nextSlug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    usedSlugs.add(nextSlug);
    usedSlugsByAgent.set(experience.agent_id, usedSlugs);

    if (experience.slug !== nextSlug) {
      updates.push({
        id: experience.id,
        previousSlug: experience.slug,
        nextSlug,
        name: experience.name,
      });
    }
  }

  if (updates.length === 0) {
    console.log("No experience slugs need updating.");
    return;
  }

  console.log(`Updating ${updates.length} experience slug(s)...`);

  for (const update of updates) {
    await runD1Query(
      `UPDATE agent_experience
       SET slug = ?, updated_at = cast(unixepoch('subsecond') * 1000 as integer)
       WHERE id = ?`,
      [update.nextSlug, update.id],
    );

    console.log(
      `- ${update.name}: ${update.previousSlug} -> ${update.nextSlug}`,
    );
  }

  console.log("Done.");
}

main().catch((error) => {
  console.error("Failed to rewrite experience slugs:", error);
  process.exitCode = 1;
});
