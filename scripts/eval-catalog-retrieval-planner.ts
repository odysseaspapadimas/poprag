import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

type PlanKind =
  | "catalog_overview"
  | "catalog_search"
  | "catalog_count"
  | "catalog_capabilities"
  | "catalog_continue"
  | "catalog_detail"
  | "document_retrieval"
  | "mixed"
  | "none";

type EvidenceKind =
  | "overview"
  | "product_page"
  | "product_detail"
  | "product_clarification"
  | "count"
  | "capabilities"
  | "no_match";

interface TurnExpectation {
  planKind?: PlanKind;
  evidenceKind?: EvidenceKind;
  validationResult?: string;
  minMatchedProducts?: number;
  returnedProducts?: number;
  hasMore?: boolean;
  catalogAvailable?: boolean;
  includes?: string[];
  excludes?: string[];
}

interface EvalTurn {
  prompt: string;
  expect: TurnExpectation;
}

interface EvalScenario {
  name: string;
  agentSlug: string;
  turns: EvalTurn[];
}

interface DebugRow {
  planKind: PlanKind | null;
  planReason: string | null;
  evidenceKind: EvidenceKind | null;
  validationResult: string | null;
  catalogAvailable: number | null;
  activeProductCount: number | null;
  matchedProducts: number | null;
  returnedProducts: number | null;
  hasMore: number | null;
}

const baseUrl = process.env.POPRAG_EVAL_BASE_URL ?? "http://localhost:3000";
const dbPath = findLocalD1Database();

const scenarios: EvalScenario[] = [
  {
    name: "Greek broad inventory overview",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι προιοντα εχεις",
        expect: {
          planKind: "catalog_overview",
          evidenceKind: "overview",
          validationResult: "validated",
          catalogAvailable: true,
          includes: ["LUX"],
          excludes: ["1.", "πρώτα 20", "first 20"],
        },
      },
    ],
  },
  {
    name: "Greek deodorant availability",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "εχεις αποσμητικα;",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          minMatchedProducts: 1,
          returnedProducts: 20,
          hasMore: true,
          includes: ["AXE"],
        },
      },
    ],
  },
  {
    name: "Greek shower gel availability without accents",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "για ψαξε για αφρολουτρα",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          minMatchedProducts: 1,
          returnedProducts: 20,
          hasMore: true,
          includes: ["Αφρόλουτρο"],
        },
      },
    ],
  },
  {
    name: "Greek LUX product page",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Δείξε μου προϊόντα LUX",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          minMatchedProducts: 1,
          includes: ["LUX"],
        },
      },
    ],
  },
  {
    name: "Greek LUX follow-up preserves raw Latin brand",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι μαρκες εχεις",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          catalogAvailable: true,
          includes: ["LUX"],
        },
      },
      {
        prompt: "lux τι εχει",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          minMatchedProducts: 20,
          includes: ["LUX"],
        },
      },
    ],
  },
  {
    name: "Continuation after paged list",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Δείξε μου προϊόντα AXE",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          minMatchedProducts: 21,
          returnedProducts: 20,
          hasMore: true,
          includes: ["AXE"],
        },
      },
      {
        prompt: "ναι",
        expect: {
          planKind: "catalog_continue",
          evidenceKind: "product_page",
          validationResult: "validated",
          returnedProducts: 20,
          includes: ["AXE"],
        },
      },
    ],
  },
  {
    name: "Non-catalog agent isolation",
    agentSlug: process.env.POPRAG_EVAL_NON_CATALOG_AGENT ?? "aimodosia",
    turns: [
      {
        prompt: "which brands do you have?",
        expect: {
          catalogAvailable: false,
          excludes: ["Catalog Evidence"],
        },
      },
    ],
  },
];

async function main() {
  console.log(`Running catalog retrieval planner eval against ${baseUrl}`);
  console.log(`Reading debug state from ${dbPath}`);

  let checkedTurns = 0;
  for (const scenario of scenarios) {
    const conversationId = `catalog-planner-eval-${slugify(scenario.name)}-${Date.now()}`;
    const messages: Array<{
      id: string;
      role: "user" | "assistant";
      parts: Array<{ type: "text"; text: string }>;
    }> = [];

    console.log(`\nScenario: ${scenario.name}`);
    for (const [index, turn] of scenario.turns.entries()) {
      messages.push({
        id: `u${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: turn.prompt }],
      });

      const responseText = await sendChatTurn(
        scenario.agentSlug,
        conversationId,
        messages,
      );
      const debug = await waitForDebugRow(conversationId, index);
      assertTurnExpectation(scenario, turn, responseText, debug);
      messages.push({
        id: `a${index + 1}`,
        role: "assistant",
        parts: [{ type: "text", text: responseText }],
      });
      checkedTurns += 1;
      console.log(
        `  ok ${turn.prompt} -> plan=${debug.planKind ?? "none"} evidence=${debug.evidenceKind ?? "none"} matched=${debug.matchedProducts ?? "-"}`,
      );
    }
  }

  console.log(`\nCatalog retrieval planner eval passed (${checkedTurns} turns).`);
}

async function sendChatTurn(
  agentSlug: string,
  conversationId: string,
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    parts: Array<{ type: "text"; text: string }>;
  }>,
) {
  const response = await fetch(`${baseUrl}/api/chat/${agentSlug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, messages }),
  });
  const streamText = await response.text();
  const text = extractTextFromUiMessageStream(streamText);

  assert.equal(response.status, 200, `HTTP ${response.status}: ${text || streamText}`);
  assert.notEqual(text.trim(), "", "Expected non-empty chat response");
  assert.notEqual(
    text.trim(),
    "Something went wrong, please try again later.",
    "Chat endpoint returned generic error fallback",
  );

  return text;
}

function assertTurnExpectation(
  scenario: EvalScenario,
  turn: EvalTurn,
  responseText: string,
  debug: DebugRow,
) {
  const label = `${scenario.name}: ${turn.prompt}`;
  const expected = turn.expect;

  if (expected.planKind !== undefined) {
    assert.equal(
      debug.planKind ?? "none",
      expected.planKind,
      `${label}: unexpected planner decision (${debug.planReason ?? "no reason"})`,
    );
  }
  if (expected.evidenceKind !== undefined) {
    assert.equal(
      debug.evidenceKind ?? "none",
      expected.evidenceKind,
      `${label}: unexpected catalog evidence kind`,
    );
  }
  if (expected.validationResult !== undefined) {
    assert.equal(
      debug.validationResult,
      expected.validationResult,
      `${label}: unexpected catalog validation result`,
    );
  }
  if (expected.catalogAvailable !== undefined) {
    assert.equal(
      debug.catalogAvailable === 1,
      expected.catalogAvailable,
      `${label}: unexpected catalog availability`,
    );
  }
  if (expected.minMatchedProducts !== undefined) {
    assert.ok(
      (debug.matchedProducts ?? 0) >= expected.minMatchedProducts,
      `${label}: expected at least ${expected.minMatchedProducts} matches, got ${debug.matchedProducts}`,
    );
  }
  if (expected.returnedProducts !== undefined) {
    assert.equal(
      debug.returnedProducts,
      expected.returnedProducts,
      `${label}: unexpected returned product count`,
    );
  }
  if (expected.hasMore !== undefined) {
    assert.equal(debug.hasMore === 1, expected.hasMore, `${label}: unexpected hasMore`);
  }
  for (const needle of expected.includes ?? []) {
    assert.ok(
      responseText.includes(needle),
      `${label}: response did not include ${JSON.stringify(needle)}\n${responseText}`,
    );
  }
  for (const needle of expected.excludes ?? []) {
    assert.ok(
      !responseText.includes(needle),
      `${label}: response unexpectedly included ${JSON.stringify(needle)}\n${responseText}`,
    );
  }
}

async function waitForDebugRow(
  conversationId: string,
  turnIndex: number,
): Promise<DebugRow> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const rows = readDebugRows(conversationId);
    if (rows.length > turnIndex) return rows[turnIndex]!;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(
    `Timed out waiting for transcript debug row ${turnIndex + 1} for ${conversationId}`,
  );
}

function readDebugRows(conversationId: string): DebugRow[] {
  const query = `
    select
      json_extract(request, '$.ragDebug.retrievalPlanKind') as planKind,
      json_extract(request, '$.ragDebug.retrievalPlanReason') as planReason,
      json_extract(request, '$.ragDebug.catalogEvidenceKind') as evidenceKind,
      json_extract(request, '$.ragDebug.catalogValidationResult') as validationResult,
      json_extract(request, '$.ragDebug.catalogAvailable') as catalogAvailable,
      json_extract(request, '$.ragDebug.catalogActiveProductCount') as activeProductCount,
      json_extract(request, '$.ragDebug.catalogMatchedProducts') as matchedProducts,
      json_extract(request, '$.ragDebug.catalogProductsReturned') as returnedProducts,
      json_extract(request, '$.ragDebug.catalogPageHasMore') as hasMore
    from transcript
    where conversation_id = ${sqlString(conversationId)}
    order by created_at asc
  `;
  const output = execFileSync("sqlite3", ["-json", dbPath, query], {
    encoding: "utf8",
  }).trim();
  return output ? (JSON.parse(output) as DebugRow[]) : [];
}

function extractTextFromUiMessageStream(streamText: string) {
  let text = "";
  for (const line of streamText.split(/\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as { type?: string; delta?: string };
      if (event.type === "text-delta" && event.delta) text += event.delta;
    } catch {
      // Ignore non-JSON stream fragments.
    }
  }
  return text;
}

function findLocalD1Database() {
  const configured = process.env.POPRAG_EVAL_DB;
  if (configured) {
    assert.ok(existsSync(configured), `POPRAG_EVAL_DB does not exist: ${configured}`);
    return configured;
  }

  const d1Root = path.join(process.cwd(), ".wrangler", "state", "v3", "d1");
  assert.ok(
    existsSync(d1Root),
    `Could not find local D1 state at ${d1Root}. Set POPRAG_EVAL_DB.`,
  );

  const databases = listFilesRecursive(d1Root)
    .filter((file) => file.endsWith(".sqlite"))
    .filter((file) => path.basename(file) !== "metadata.sqlite")
    .filter(isApplicationD1Database)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  assert.ok(
    databases.length > 0,
    `No application D1 databases found under ${d1Root}. Set POPRAG_EVAL_DB.`,
  );
  return databases[0]!;
}

function isApplicationD1Database(file: string) {
  try {
    const output = execFileSync(
      "sqlite3",
      [
        file,
        "select count(*) from sqlite_master where type = 'table' and name in ('agent', 'transcript')",
      ],
      { encoding: "utf8" },
    ).trim();
    return Number(output) >= 2;
  } catch {
    return false;
  }
}

function listFilesRecursive(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function slugify(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
