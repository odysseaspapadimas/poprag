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

type ExpectedValue<T> = T | T[];

interface TurnExpectation {
  planKind?: ExpectedValue<PlanKind>;
  evidenceKind?: ExpectedValue<EvidenceKind | "none">;
  validationResult?: string;
  matchedProducts?: number;
  minMatchedProducts?: number;
  matchedEqualsActive?: boolean;
  returnedProducts?: number;
  pageOffset?: number;
  hasMore?: boolean;
  activeCatalogProductCount?: number;
  catalogAvailable?: boolean;
  noCatalogLane?: boolean;
  noDocumentChunks?: boolean;
  includes?: string[];
  excludes?: string[];
}

interface EvalTurn {
  prompt: string;
  expect?: TurnExpectation;
}

interface EvalScenario {
  name: string;
  agentSlug: string;
  turns: EvalTurn[];
}

interface DebugRow {
  planKind: PlanKind | null;
  planReason: string | null;
  plannerFallbackReason: string | null;
  evidenceKind: EvidenceKind | null;
  validationResult: string | null;
  validationError: string | null;
  catalogAvailable: number | null;
  documentAvailable: number | null;
  activeProductCount: number | null;
  matchedProducts: number | null;
  returnedProducts: number | null;
  pageOffset: number | null;
  pageLimit: number | null;
  nextOffset: number | null;
  hasMore: number | null;
  chunkCount: number | null;
}

const baseUrl = process.env.POPRAG_EVAL_BASE_URL ?? "http://localhost:3000";
const scenarioFilter = process.env.POPRAG_EVAL_SCENARIO?.toLocaleLowerCase();
const dbPath = findLocalD1Database();

const scenarios: EvalScenario[] = [
  {
    name: "English LUX filter",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Show me LUX products",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 20,
          returnedProducts: 20,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["LUX"],
        },
      },
    ],
  },
  {
    name: "Greek LUX filter",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Δείξε μου προϊόντα LUX",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 20,
          returnedProducts: 20,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["LUX"],
        },
      },
    ],
  },
  {
    name: "Greek CIF availability",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Έχετε προϊόντα CIF;",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 4,
          returnedProducts: 4,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["Cif"],
        },
      },
    ],
  },
  {
    name: "Greek KNORR page",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Ποια προϊόντα έχει η KNORR;",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 80,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["KNORR"],
        },
      },
    ],
  },
  {
    name: "Greek broad inventory",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι προιοντα εχεις",
        expect: {
          planKind: "catalog_overview",
          evidenceKind: "overview",
          validationResult: "validated",
          minMatchedProducts: 600,
          matchedEqualsActive: true,
          returnedProducts: 0,
          noDocumentChunks: true,
          includes: ["AIM", "AXE", "DOVE"],
          excludes: [
            "φίλτρο \"προϊόντα\"",
            "φίλτρο \"προιοντα\"",
            "πρώτα 20",
            "τρέχουσα σελίδα",
            "σειράς AIM",
          ],
        },
      },
    ],
  },
  {
    name: "Greek broad inventory with punctuation",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι προιοντα εχεις;",
        expect: {
          planKind: "catalog_overview",
          evidenceKind: "overview",
          validationResult: "validated",
          minMatchedProducts: 600,
          matchedEqualsActive: true,
          returnedProducts: 0,
          noDocumentChunks: true,
          includes: ["AIM", "AXE", "DOVE"],
          excludes: [
            "φίλτρο \"προϊόντα\"",
            "φίλτρο \"προιοντα\"",
            "φίλτρο που ζήτησες",
            "πρώτα 20",
            "τρέχουσα σελίδα",
            "σειράς AIM",
          ],
        },
      },
    ],
  },
  {
    name: "Greek explicit broad product list",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "δείξε μου λίστα προϊόντων",
        expect: {
          planKind: "catalog_overview",
          evidenceKind: "overview",
          validationResult: "validated",
          minMatchedProducts: 600,
          matchedEqualsActive: true,
          returnedProducts: 0,
          noDocumentChunks: true,
          includes: ["AIM"],
          excludes: ["φίλτρο \"προϊόντων\"", "τρέχουσα σελίδα"],
        },
      },
    ],
  },
  {
    name: "English AXE page",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Show me AXE products",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 55,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["AXE"],
        },
      },
    ],
  },
  {
    name: "Greek filtered count",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "πόσα προϊόντα Dove υπάρχουν;",
        expect: {
          planKind: "catalog_count",
          evidenceKind: "count",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 0,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["111"],
          excludes: ["μερική λίστα", "partial list"],
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
          matchedProducts: 17,
          returnedProducts: 17,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["AXE"],
          excludes: ["apo Smyktika", "apo smyktika"],
        },
      },
    ],
  },
  {
    name: "Greek cleaning products inventory search",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι καθαριστικα εχεις;",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 11,
          returnedProducts: 11,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["Cif Καθαριστική", "KLINEX"],
          excludes: ["Dove Αφρόλουτρο", "91 καθαριστικά"],
        },
      },
    ],
  },
  {
    name: "Greek explicit more results pagination",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "δείξε μου προϊόντα DOVE",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 20,
          pageOffset: 0,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["DOVE"],
        },
      },
      {
        prompt: "δειξε μου κι άλλα",
        expect: {
          planKind: ["catalog_search", "catalog_continue"],
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 20,
          pageOffset: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["DOVE"],
        },
      },
    ],
  },
  {
    name: "Dove ambiguous comparison clarification",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "συγκρινε μου dove fresh care με fruity nourish",
        expect: {
          planKind: "catalog_detail",
          evidenceKind: "product_clarification",
          validationResult: "needs_clarification",
          minMatchedProducts: 4,
          noDocumentChunks: true,
          includes: ["Dove Fresh Care", "Dove Fruity Nourish", "450ML", "720ML"],
          excludes: ["Dove Αφρόλουτρο Hydrate 250ML"],
        },
      },
    ],
  },
  {
    name: "AXE count-to-list follow-up regression",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι προιοντα εχεις",
        expect: {
          planKind: "catalog_overview",
          evidenceKind: "overview",
          validationResult: "validated",
          minMatchedProducts: 600,
          matchedEqualsActive: true,
          returnedProducts: 0,
          noDocumentChunks: true,
          includes: ["AXE"],
        },
      },
      {
        prompt: "ποσα axe προιοντα εχεις",
        expect: {
          planKind: "catalog_count",
          evidenceKind: "count",
          validationResult: "validated",
          matchedProducts: 55,
          returnedProducts: 0,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["55", "AXE"],
        },
      },
      {
        prompt: "ποια εχεις;",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 55,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["AXE"],
          excludes: ["Detail Text", "partial list"],
        },
      },
      {
        prompt: "δωσε μου λιστα των προιοντων",
        expect: {
          planKind: ["catalog_search", "catalog_continue"],
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 55,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["AXE"],
          excludes: ["Detail Text", "partial list"],
        },
      },
    ],
  },
  {
    name: "Greek category wording uses brands groups",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι κατηγοριες εχεις;",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          returnedProducts: 0,
          noDocumentChunks: true,
          includes: ["DOVE", "AXE", "LUX"],
          excludes: ["Οι διαθέσιμες κατηγορίες (ομάδες προϊόντων)", "Οι διαθέσιμες κατηγορίες είναι"],
        },
      },
    ],
  },
  {
    name: "Vaseline compare follow-up regression",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "vaseline",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 10,
          returnedProducts: 10,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["Vaseline Petroleum Jelly 100ml", "Vaseline Petroleum Jelly Cocoa 100ml"],
          excludes: ["συγκρίνω", "compare it"],
        },
      },
      {
        prompt: "πες μου για το κλασσικο το 100μλ",
        expect: {
          planKind: ["catalog_search", "catalog_detail"],
          evidenceKind: ["product_page", "product_detail"],
          validationResult: "validated",
          minMatchedProducts: 1,
          noDocumentChunks: true,
          includes: ["Vaseline Petroleum Jelly 100ml"],
          excludes: ["συγκρ", "compare"],
        },
      },
      {
        prompt: "συγκρινε το ναι",
        expect: {
          planKind: "catalog_detail",
          evidenceKind: "product_detail",
          validationResult: "validated",
          matchedProducts: 2,
          returnedProducts: 2,
          noDocumentChunks: true,
          includes: ["Vaseline Petroleum Jelly 100ml", "Vaseline Petroleum Jelly Cocoa 100ml"],
          excludes: ["μόνο ένα προϊόν Vaseline", "Δεν έχω καταχωρημένο το Cocoa"],
        },
      },
    ],
  },
  {
    name: "Vaseline direct comparison regression",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "vaseline",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 10,
          returnedProducts: 10,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["Vaseline Petroleum Jelly 100ml", "Vaseline Petroleum Jelly Cocoa 100ml"],
          excludes: ["συγκρίνω", "compare it"],
        },
      },
      {
        prompt: "σύγκρινε το Vaseline Petroleum Jelly 100ml με το Vaseline Petroleum Jelly Cocoa 100ml",
        expect: {
          planKind: "catalog_detail",
          evidenceKind: "product_detail",
          validationResult: "validated",
          matchedProducts: 2,
          returnedProducts: 2,
          noDocumentChunks: true,
          includes: ["Vaseline Petroleum Jelly 100ml", "Vaseline Petroleum Jelly Cocoa 100ml"],
          excludes: ["μόνο ένα προϊόν Vaseline", "Δεν έχω καταχωρημένο το Cocoa"],
        },
      },
    ],
  },
  {
    name: "English capability after filtered page",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Show me OMO products",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 22,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["OMO"],
        },
      },
      {
        prompt: "Which brands do you have?",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          returnedProducts: 0,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["DOVE", "KNORR", "AXE", "LUX", "CIF"],
        },
      },
    ],
  },
  {
    name: "Greek capability after filtered page",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Δείξε μου προϊόντα Dove",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["DOVE"],
        },
      },
      {
        prompt: "τι μάρκες έχετε;",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          returnedProducts: 0,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["DOVE", "KNORR", "AXE", "LUX", "CIF"],
        },
      },
    ],
  },
  {
    name: "Greek continuation then global capability",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Δείξε μου προϊόντα AXE",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 55,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["AXE"],
        },
      },
      {
        prompt: "ναι",
        expect: {
          planKind: "catalog_continue",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 55,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["AXE"],
        },
      },
      {
        prompt: "ποιες μάρκες υπάρχουν;",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          returnedProducts: 0,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["DOVE", "KNORR", "AXE", "LUX", "CIF"],
        },
      },
    ],
  },
  {
    name: "English affirmative continuations",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Show me DOVE products",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["DOVE"],
        },
      },
      {
        prompt: "yes",
        expect: {
          planKind: "catalog_continue",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["DOVE"],
        },
      },
      {
        prompt: "more",
        expect: {
          planKind: "catalog_continue",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 111,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["DOVE"],
        },
      },
    ],
  },
  {
    name: "Greek continuation keywords",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Δείξε μου προϊόντα SKIP",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 78,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["SKIP"],
        },
      },
      {
        prompt: "συνέχισε",
        expect: {
          planKind: "catalog_continue",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 78,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["SKIP"],
        },
      },
      {
        prompt: "επόμενα",
        expect: {
          planKind: "catalog_continue",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 78,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["SKIP"],
        },
      },
    ],
  },
  {
    name: "Mixed Greek-English brand capability",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "Show me OMO products",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          matchedProducts: 22,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["OMO"],
        },
      },
      {
        prompt: "τι brands υπάρχουν;",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          returnedProducts: 0,
          hasMore: false,
          noDocumentChunks: true,
          includes: ["DOVE", "KNORR", "AXE", "LUX", "CIF"],
        },
      },
    ],
  },
  {
    name: "Filter capability prompts",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "what filters can I use?",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          noDocumentChunks: true,
          includes: ["DOVE", "KNORR", "CIF"],
        },
      },
      {
        prompt: "τι φίλτρα μπορώ να χρησιμοποιήσω;",
        expect: {
          planKind: "catalog_capabilities",
          evidenceKind: "capabilities",
          validationResult: "validated",
          noDocumentChunks: true,
          includes: ["DOVE", "KNORR", "CIF"],
        },
      },
    ],
  },
  {
    name: "Greek searchable category",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "ποια προϊόντα είναι στην κατηγορία απορρυπαντικά;",
        expect: {
          planKind: "catalog_search",
          evidenceKind: "product_page",
          validationResult: "validated",
          minMatchedProducts: 50,
          returnedProducts: 20,
          hasMore: true,
          noDocumentChunks: true,
          includes: ["OMO"],
        },
      },
    ],
  },
  {
    name: "Product detail stays out of inventory lane",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "τι συστατικά έχει το AXE Black Αφρόλουτρο 400ml;",
        expect: {
          planKind: "document_retrieval",
          evidenceKind: "none",
          validationResult: "skipped",
          includes: ["Aqua", "Sodium"],
        },
      },
    ],
  },
  {
    name: "Comparison stays out of inventory lane",
    agentSlug: "keyvoto",
    turns: [
      {
        prompt: "σύγκρινε δύο προϊόντα LUX",
        expect: {
          planKind: ["document_retrieval", "mixed"],
          includes: ["LUX"],
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
          activeCatalogProductCount: 0,
          noCatalogLane: true,
          includes: ["brands"],
        },
      },
    ],
  },
];

async function main() {
  console.log(`Running Keyvoto catalog eval against ${baseUrl}`);
  console.log(`Reading debug state from ${dbPath}`);

  const selectedScenarios = scenarioFilter
    ? scenarios.filter((scenario) =>
        scenario.name.toLocaleLowerCase().includes(scenarioFilter),
      )
    : scenarios;
  assert.ok(
    selectedScenarios.length > 0,
    `No scenarios matched POPRAG_EVAL_SCENARIO=${scenarioFilter}`,
  );

  let checkedTurns = 0;
  for (const scenario of selectedScenarios) {
    const conversationId = `keyvoto-eval-${slugify(scenario.name)}-${Date.now()}`;
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
        `  ✓ ${turn.prompt} -> plan=${debug.planKind ?? "none"} evidence=${debug.evidenceKind ?? "none"} matched=${debug.matchedProducts ?? "-"} returned=${debug.returnedProducts ?? "-"}`,
      );
    }
  }

  console.log(`\nKeyvoto catalog eval passed (${checkedTurns} turns).`);
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

  assert.equal(
    response.status,
    200,
    `HTTP ${response.status}: ${text || streamText}`,
  );
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
  if (!expected) return;

  if (expected.noCatalogLane) {
    assert.equal(
      debug.evidenceKind,
      null,
      `${label}: expected no catalog evidence lane`,
    );
  }
  if (expected.planKind !== undefined) {
    assertExpectedValue(
      debug.planKind ?? "none",
      expected.planKind,
      `${label}: unexpected retrieval plan (${debug.planReason ?? "no reason"}; fallback=${debug.plannerFallbackReason ?? "none"})`,
    );
  }
  if (expected.evidenceKind !== undefined) {
    assertExpectedValue(
      debug.evidenceKind ?? "none",
      expected.evidenceKind,
      `${label}: unexpected catalog evidence kind (${debug.validationError ?? "no validation error"})`,
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
  if (expected.activeCatalogProductCount !== undefined) {
    assert.equal(
      debug.activeProductCount,
      expected.activeCatalogProductCount,
      `${label}: unexpected active catalog product count`,
    );
  }
  if (expected.matchedProducts !== undefined) {
    assert.equal(
      debug.matchedProducts,
      expected.matchedProducts,
      `${label}: unexpected matched product count`,
    );
  }
  if (expected.minMatchedProducts !== undefined) {
    assert.ok(
      (debug.matchedProducts ?? 0) >= expected.minMatchedProducts,
      `${label}: expected at least ${expected.minMatchedProducts} matched products, got ${debug.matchedProducts}`,
    );
  }
  if (expected.matchedEqualsActive) {
    assert.equal(
      debug.matchedProducts,
      debug.activeProductCount,
      `${label}: expected matched product count to equal active catalog count`,
    );
  }
  if (expected.returnedProducts !== undefined) {
    assert.equal(
      debug.returnedProducts,
      expected.returnedProducts,
      `${label}: unexpected returned product count`,
    );
  }
  if (expected.pageOffset !== undefined) {
    assert.equal(
      debug.pageOffset,
      expected.pageOffset,
      `${label}: unexpected catalog page offset`,
    );
  }
  if (expected.hasMore !== undefined) {
    assert.equal(
      toBoolean(debug.hasMore),
      expected.hasMore,
      `${label}: unexpected hasMore`,
    );
  }
  if (expected.noDocumentChunks) {
    assert.equal(
      debug.chunkCount ?? 0,
      0,
      `${label}: expected catalog evidence without document chunks`,
    );
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

function assertExpectedValue<T>(actual: T, expected: ExpectedValue<T>, message: string) {
  if (Array.isArray(expected)) {
    assert.ok(
      expected.includes(actual),
      `${message}; expected one of ${expected.join(", ")}, got ${String(actual)}`,
    );
    return;
  }

  assert.equal(actual, expected, message);
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
      json_extract(request, '$.ragDebug.retrievalPlannerFallbackReason') as plannerFallbackReason,
      json_extract(request, '$.ragDebug.catalogEvidenceKind') as evidenceKind,
      json_extract(request, '$.ragDebug.catalogValidationResult') as validationResult,
      json_extract(request, '$.ragDebug.catalogValidationError') as validationError,
      json_extract(request, '$.ragDebug.catalogAvailable') as catalogAvailable,
      json_extract(request, '$.ragDebug.documentAvailable') as documentAvailable,
      json_extract(request, '$.ragDebug.catalogActiveProductCount') as activeProductCount,
      json_extract(request, '$.ragDebug.catalogMatchedProducts') as matchedProducts,
      json_extract(request, '$.ragDebug.catalogProductsReturned') as returnedProducts,
      json_extract(request, '$.ragDebug.catalogPageOffset') as pageOffset,
      json_extract(request, '$.ragDebug.catalogPageLimit') as pageLimit,
      json_extract(request, '$.ragDebug.catalogPageNextOffset') as nextOffset,
      json_extract(request, '$.ragDebug.catalogPageHasMore') as hasMore,
      coalesce(json_array_length(json_extract(request, '$.ragDebug.chunks')), 0) as chunkCount
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
    assert.ok(
      existsSync(configured),
      `POPRAG_EVAL_DB does not exist: ${configured}`,
    );
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

function toBoolean(value: number | null) {
  return value === 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
