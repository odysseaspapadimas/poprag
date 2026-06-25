import assert from "node:assert/strict";
import {
  makeCatalogFocus,
  makeCatalogPageCursor,
  makeCatalogProductFocus,
} from "../src/lib/retrieval/catalog-page-state";
import { buildRetrievalSystemPrompt } from "../src/lib/retrieval/answer-composer";
import { normalizeCatalogValue } from "../src/lib/catalog/shared";
import { planRetrieval } from "../src/lib/retrieval/retrieval-planner";
import type {
  CatalogEvidence,
  SourceCapabilities,
} from "../src/lib/retrieval/types";

assert.equal(normalizeCatalogValue("Αποσμητικά"), "αποσμητικα");
assert.equal(normalizeCatalogValue("αποσμητικα"), "αποσμητικα");
assert.equal(normalizeCatalogValue("Μάρκες"), "μαρκεσ");

const plannerCapabilities: SourceCapabilities = {
  agentId: "agent1",
  catalog: {
    available: true,
    activeProductCount: 623,
    fieldCapabilities: [
      { fieldPath: "parent.documentSummary.name.el-GR", role: "filterable" },
      { fieldPath: "document.general-information.name.el-GR", role: "title" },
    ],
    filterValueSummaries: [],
    scopes: [
      {
        sourceId: "catalog-source-1",
        name: "Acme Foods",
        aliases: ["Acme Foods", "ACME", "της Acme"],
      },
    ],
  },
  documents: { available: true, indexedChunkCount: 10 },
};

const scopedCatalogPlan = await planRetrieval(null, {
  modelId: "test-planner",
  userMessage: "δειξε μου προιοντα της ACME",
  effectiveQuery: "δειξε μου προιοντα της ACME",
  capabilities: plannerCapabilities,
  generatePlannerText: async () =>
    JSON.stringify({
      kind: "catalog_search",
      reason: "user asks to show products of a named brand",
      terms: [
        { value: "ACME", fieldPath: "parent.documentSummary.name.el-GR" },
      ],
      pageAction: "first",
      products: [],
      requestedField: "",
      plans: [],
    }),
});
assert.deepEqual(scopedCatalogPlan.plan, {
  kind: "catalog_search",
  reason:
    "A configured catalog scope alias means the whole catalog, so list products from the matching catalog scope",
  terms: [],
  limit: undefined,
  pageAction: "first",
  allProducts: true,
  scopeSourceIds: ["catalog-source-1"],
});

const scopedCatalogEmptyTermPlan = await planRetrieval(null, {
  modelId: "test-planner",
  userMessage: "δειξε μου προιοντα της ACME",
  effectiveQuery: "δειξε μου προιοντα της ACME",
  capabilities: plannerCapabilities,
  generatePlannerText: async () =>
    JSON.stringify({
      kind: "catalog_search",
      reason: "User asks to show products from ACME, which means the whole catalog",
      terms: [],
      pageAction: "first",
      products: [],
      requestedField: "",
      plans: [],
    }),
});
assert.deepEqual(scopedCatalogEmptyTermPlan.plan, {
  kind: "catalog_search",
  reason:
    "A configured catalog scope alias means the whole catalog, so list products from the matching catalog scope",
  terms: [],
  limit: undefined,
  pageAction: "first",
  allProducts: true,
  scopeSourceIds: ["catalog-source-1"],
});

const scopedFollowUpPlan = await planRetrieval(null, {
  modelId: "test-planner",
  userMessage: "ποια είναι;",
  effectiveQuery: "ποια είναι;",
  capabilities: plannerCapabilities,
  previousCatalogFocus: {
    kind: "catalog_focus",
    planKind: "catalog_count",
    terms: [],
    scopeSourceIds: ["catalog-source-1"],
    matchedProducts: 623,
  },
  generatePlannerText: async () =>
    JSON.stringify({
      kind: "catalog_search",
      reason: "elliptical follow-up asking to list previous count results",
      terms: [],
      pageAction: "first",
      products: [],
      requestedField: "",
      plans: [],
    }),
});
assert.deepEqual(scopedFollowUpPlan.plan, {
  kind: "catalog_search",
  reason: "Short follow-up asks to list the previous catalog focus",
  terms: [],
  pageAction: "first",
  allProducts: true,
  scopeSourceIds: ["catalog-source-1"],
});

const overviewEvidence: CatalogEvidence = {
  kind: "overview",
  totalActiveProducts: 623,
  fieldCapabilities: [
    { fieldPath: "brand", role: "filterable" },
    { fieldPath: "name", role: "title" },
    { fieldPath: "description", role: "searchable" },
  ],
  filterValueSummaries: [
    {
      fieldPath: "brand",
      value: "LUX",
      normalizedValue: "lux",
      productCount: 20,
    },
  ],
};

const overviewPrompt = buildRetrievalSystemPrompt("Base prompt", {
  catalogEvidence: overviewEvidence,
  documentEvidence: null,
});
assert.match(overviewPrompt, /Product Data/);
assert.match(overviewPrompt, /Information type: product overview/);
assert.match(overviewPrompt, /Total products available: 623/);
assert.match(overviewPrompt, /LUX \(20\)/);
assert.match(overviewPrompt, /Available brands\/product groups/);
assert.match(overviewPrompt, /not necessarily retail categories/);
assert.match(overviewPrompt, /Do not proactively offer comparisons/);
assert.doesNotMatch(overviewPrompt, /Products to show:\n1\./);
assert.doesNotMatch(overviewPrompt, /Catalog Evidence/);
assert.doesNotMatch(overviewPrompt, /Evidence kind/);
assert.doesNotMatch(overviewPrompt, /Document Evidence/);
assert.doesNotMatch(overviewPrompt, /product page/);

const pageEvidence: CatalogEvidence = {
  kind: "product_page",
  terms: [{ value: "LUX" }],
  totalActiveProducts: 623,
  matchedProducts: 20,
  offset: 0,
  limit: 20,
  nextOffset: 20,
  hasMore: false,
  complete: true,
  products: [
    {
      productId: "p1",
      sourceId: "source1",
      recordKey: "sku1",
      title: "LUX Soft 250ml",
      facts: [
        { fieldPath: "recordKey", value: "sku1" },
        { fieldPath: "brand", value: "LUX" },
      ],
    },
  ],
};

const mixedPrompt = buildRetrievalSystemPrompt("Base prompt", {
  catalogEvidence: pageEvidence,
  documentEvidence: {
    chunks: [
      {
        content: "A document-only description.",
        sourceId: "doc1",
        score: 0.9,
        metadata: { fileName: "manual.pdf" },
      },
    ],
  },
});
assert.match(mixedPrompt, /Product Data/);
assert.match(mixedPrompt, /Detail Text/);
assert.match(
  mixedPrompt,
  /Only product data may be used for product availability, count, or list claims/,
);
assert.ok(
  mixedPrompt.indexOf("Product Data") < mixedPrompt.indexOf("Detail Text"),
);
assert.match(mixedPrompt, /Matching products: 20/);
assert.match(mixedPrompt, /Products shown now: 1/);
assert.match(mixedPrompt, /More matching products are available: no/);
assert.match(mixedPrompt, /1\. LUX Soft 250ml/);
assert.match(mixedPrompt, /List every product under Products to show/);
assert.match(mixedPrompt, /Do not proactively offer comparisons/);
assert.doesNotMatch(mixedPrompt, /manual\.pdf/);
assert.doesNotMatch(mixedPrompt, /Source:/);
assert.doesNotMatch(mixedPrompt, /Excerpt/);
assert.doesNotMatch(mixedPrompt, /Products returned in this page/);

assert.deepEqual(makeCatalogPageCursor(pageEvidence), {
  kind: "catalog_page",
  planKind: "catalog_search",
  terms: [{ value: "LUX" }],
  scopeSourceIds: undefined,
  offset: 0,
  limit: 20,
  nextOffset: 20,
  hasMore: false,
});
assert.equal(makeCatalogPageCursor(overviewEvidence), undefined);
assert.deepEqual(makeCatalogFocus(pageEvidence), {
  kind: "catalog_focus",
  planKind: "catalog_search",
  terms: [{ value: "LUX" }],
  scopeSourceIds: undefined,
  matchedProducts: 20,
});
assert.deepEqual(
  makeCatalogFocus({
    kind: "count",
    terms: [{ value: "AXE" }],
    totalActiveProducts: 623,
    matchedProducts: 55,
  }),
  {
    kind: "catalog_focus",
    planKind: "catalog_count",
    terms: [{ value: "AXE" }],
    scopeSourceIds: undefined,
    matchedProducts: 55,
  },
);
assert.equal(makeCatalogFocus(overviewEvidence), undefined);
assert.deepEqual(makeCatalogProductFocus(pageEvidence), {
  kind: "catalog_product_focus",
  terms: [{ value: "LUX" }],
  matchedProducts: 20,
  products: [
    {
      productId: "p1",
      title: "LUX Soft 250ml",
      recordKey: "sku1",
    },
  ],
});
assert.equal(makeCatalogProductFocus(overviewEvidence), undefined);

const detailPrompt = buildRetrievalSystemPrompt("Base prompt", {
  catalogEvidence: {
    kind: "product_detail",
    totalActiveProducts: 623,
    matchedProducts: 2,
    products: [
      {
        productId: "classic",
        sourceId: "source1",
        recordKey: "T106053",
        title: "Vaseline Petroleum Jelly 100ml",
        facts: [
          { fieldPath: "recordKey", value: "T106053" },
          { fieldPath: "document.gs1-and-barcode.gtin", value: "42182634" },
        ],
      },
      {
        productId: "cocoa",
        sourceId: "source1",
        recordKey: "U106049",
        title: "Vaseline Petroleum Jelly Cocoa 100ml",
        facts: [
          { fieldPath: "recordKey", value: "U106049" },
          { fieldPath: "document.gs1-and-barcode.gtin", value: "8710447485323" },
        ],
      },
    ],
  },
});
assert.match(detailPrompt, /Information type: product facts/);
assert.match(detailPrompt, /Vaseline Petroleum Jelly 100ml/);
assert.match(detailPrompt, /Vaseline Petroleum Jelly Cocoa 100ml/);
assert.match(detailPrompt, /If the user explicitly asked to compare/);
assert.match(detailPrompt, /do not offer comparisons/i);

const clarificationPrompt = buildRetrievalSystemPrompt("Base prompt", {
  catalogEvidence: {
    kind: "product_clarification",
    totalActiveProducts: 623,
    message: "Multiple catalog products matched at least one requested product.",
    references: [
      {
        requested: { terms: [{ value: "Dove Fresh Care" }] },
        candidates: [
          {
            productId: "fresh-450",
            sourceId: "source1",
            recordKey: "U147209",
            title: "Dove Αφρόλουτρο Fresh Care 450ML",
            facts: [{ fieldPath: "recordKey", value: "U147209" }],
          },
          {
            productId: "fresh-720",
            sourceId: "source1",
            recordKey: "T147176",
            title: "Dove Αφρόλουτρο Fresh Care 720ML",
            facts: [{ fieldPath: "recordKey", value: "T147176" }],
          },
        ],
      },
    ],
  },
});
assert.match(clarificationPrompt, /product clarification needed/);
assert.match(clarificationPrompt, /Dove Fresh Care/);
assert.match(clarificationPrompt, /Fresh Care 450ML/);
assert.match(clarificationPrompt, /Fresh Care 720ML/);
assert.match(clarificationPrompt, /Ask the user which exact product they mean/);

const noMatchPrompt = buildRetrievalSystemPrompt("Base prompt", {
  catalogEvidence: {
    kind: "no_match",
    terms: [{ value: "missing" }],
    totalActiveProducts: 623,
    code: "no_match",
    message: "No active catalog products matched the validated terms.",
  },
});
assert.match(noMatchPrompt, /Information type: no matching products/);
assert.match(noMatchPrompt, /Do not say matching products are available/);
assert.doesNotMatch(noMatchPrompt, /active catalog/);
assert.doesNotMatch(noMatchPrompt, /validated terms/i);

console.log("Catalog retrieval planner contract tests passed");
