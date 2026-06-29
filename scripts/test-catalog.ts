import assert from "node:assert/strict";
import { parseCatalogDelimitedRows } from "../src/lib/catalog/delimited";
import {
  detectCatalogCapabilitiesQuestion,
  detectCatalogContinuationReply,
  detectCatalogCountQuestion,
  detectCatalogInventoryQuestion,
  detectCatalogNonInventoryQuestion,
  detectCatalogOverviewQuestion,
  inferCatalogFiltersFromInventoryQuestion,
  repairCatalogFilterTermsFromQuery,
  resolveCatalogStructuredLookup,
  sanitizeCatalogStructuredFilters,
  shouldUseCatalogStructuredLane,
} from "../src/lib/catalog/structured-lookup";
import {
  catalogFactMatchesFilter,
  catalogTitleMatchesQuery,
  collectCatalogFacts,
  formatCatalogFilterValueSummaryLines,
  isCatalogTitlePrefixCandidate,
  normalizeCatalogFactValue,
  normalizeCatalogRecord,
  normalizeCatalogValue,
  selectCatalogFilteredProductIds,
} from "../src/lib/catalog/shared";

const baseConfig = {
  id: "cfg_1",
  agentId: "agent_1",
  knowledgeSourceId: "source_1",
  name: "Catalog",
  origin: "csv" as const,
  enabled: true,
  stableKeyField: "sku",
  titleField: "name",
  updatedAtField: "updated_at",
  deletionField: "status",
  deletionInactiveValues: ["inactive", "deleted"],
  searchableFields: ["description"],
  exactMatchFields: ["sku", "barcode", "name"],
  filterableFields: ["brand", "category"],
};

const { headers, records } = parseCatalogDelimitedRows(
  [
    "sku,name,brand,category,barcode,status,description,updated_at",
    "S-1,Skip Liquid,Skip,Detergents,520123,active,Laundry detergent,2026-01-01T00:00:00Z",
    "S-2,Old Item,Skip,Detergents,520999,inactive,Old product,2026-01-02T00:00:00Z",
  ].join("\n"),
  "csv",
);

assert.deepEqual(headers.slice(0, 3), ["sku", "name", "brand"]);
assert.equal(records.length, 2);

const active = await normalizeCatalogRecord(baseConfig, records[0]);
assert.ok(active);
assert.equal(active.recordKey, "S-1");
assert.equal(active.title, "Skip Liquid");
assert.equal(active.active, true);

const inactive = await normalizeCatalogRecord(baseConfig, records[1]);
assert.ok(inactive);
assert.equal(inactive.active, false);

const includedProduct = await normalizeCatalogRecord(
  {
    ...baseConfig,
    includeFilters: [{ fieldPath: "contentType", values: ["Product"] }],
  },
  { sku: "S-3", name: "Product row", status: "active", contentType: "Product" },
);
assert.ok(includedProduct);
assert.equal(includedProduct.recordKey, "S-3");

const skippedBrand = await normalizeCatalogRecord(
  {
    ...baseConfig,
    includeFilters: [{ fieldPath: "contentType", values: ["Product"] }],
  },
  { sku: "B-1", name: "Brand row", status: "active", contentType: "Brand" },
);
assert.equal(skippedBrand, null);

const facts = collectCatalogFacts(baseConfig, active);
assert.ok(
  facts.some(
    (fact) =>
      fact.role === "filterable" &&
      fact.fieldPath === "brand" &&
      fact.value === "Skip",
  ),
);
assert.ok(
  facts.some(
    (fact) =>
      fact.role === "exact" &&
      fact.fieldPath === "barcode" &&
      fact.value === "520123",
  ),
);

assert.equal(normalizeCatalogValue("  ΣΚΙΠ   Υγρό "), "σκιπ υγρο");
assert.equal(
  normalizeCatalogFactValue("stable_key", "SKU-001 / A"),
  "sku001a",
);
assert.equal(
  normalizeCatalogFactValue("exact", "520-123 456"),
  "520123456",
);
assert.equal(
  normalizeCatalogFactValue("title", "  Καφές φίλτρου "),
  "καφεσ φιλτρου",
);
assert.equal(catalogTitleMatchesQuery("Νεσκαφέ Classic 200g", "Νεσκαφέ"), true);
assert.equal(catalogTitleMatchesQuery("Νεσκαφέ Classic 200g", "Classic"), false);
assert.equal(
  isCatalogTitlePrefixCandidate("τι συστατικά έχει το AXE Black Αφρόλουτρο 400ml;"),
  false,
);

assert.equal(
  catalogFactMatchesFilter(
    {
      role: "exact",
      fieldPath: "barcode",
      normalizedValue: "520123456",
    },
    { fieldPath: "barcode", value: "520-123 456" },
  ),
  true,
);
assert.equal(
  catalogFactMatchesFilter(
    {
      role: "filterable",
      fieldPath: "brand",
      normalizedValue: "σκιπ",
    },
    { fieldPath: "brand", value: "ΣΚΙΠ" },
  ),
  true,
);
assert.equal(
  catalogFactMatchesFilter(
    {
      role: "filterable",
      fieldPath: "category",
      normalizedValue: "detergents",
    },
    { fieldPath: "brand", value: "detergents" },
  ),
  false,
);
assert.equal(
  catalogFactMatchesFilter(
    {
      role: "title",
      fieldPath: "name",
      normalizedValue: "skip liquid detergent",
    },
    { value: "skip liquid" },
  ),
  true,
);
assert.equal(
  catalogFactMatchesFilter(
    {
      role: "searchable",
      fieldPath: "description",
      normalizedValue: normalizeCatalogFactValue(
        "searchable",
        "υγρό απορρυπαντικό για πλυντήριο",
      ),
    },
    { value: "πλυντήριο" },
  ),
  true,
);
assert.equal(
  catalogFactMatchesFilter(
    {
      role: "searchable",
      fieldPath: "description",
      normalizedValue: normalizeCatalogFactValue(
        "searchable",
        "υγρό απορρυπαντικό για πλυντήριο",
      ),
    },
    { value: "απορρυπαντικά" },
  ),
  true,
);

assert.deepEqual(
  selectCatalogFilteredProductIds(
    [{ value: "AXE" }],
    [
      {
        productId: "brand-row",
        role: "title",
        fieldPath: "name",
        normalizedValue: normalizeCatalogFactValue("title", "AXE"),
      },
      {
        productId: "axe-1",
        role: "filterable",
        fieldPath: "brand",
        normalizedValue: normalizeCatalogFactValue("filterable", "AXE"),
      },
      {
        productId: "axe-2",
        role: "filterable",
        fieldPath: "brand",
        normalizedValue: normalizeCatalogFactValue("filterable", "AXE"),
      },
    ],
  ),
  ["axe-1", "axe-2"],
);
assert.deepEqual(
  selectCatalogFilteredProductIds(
    [{ value: "Δείξε" }, { value: "AXE" }],
    [
      {
        productId: "description-hit",
        role: "searchable",
        fieldPath: "description",
        normalizedValue: normalizeCatalogFactValue(
          "searchable",
          "θα σου δείξει πως λειτουργεί",
        ),
      },
      {
        productId: "axe-1",
        role: "filterable",
        fieldPath: "brand",
        normalizedValue: normalizeCatalogFactValue("filterable", "AXE"),
      },
      {
        productId: "axe-2",
        role: "filterable",
        fieldPath: "brand",
        normalizedValue: normalizeCatalogFactValue("filterable", "AXE"),
      },
    ],
  ),
  ["axe-1", "axe-2"],
);
assert.deepEqual(
  selectCatalogFilteredProductIds(
    [{ value: "520-123 456", fieldPath: "barcode" }],
    [
      {
        productId: "sku-hit",
        role: "exact",
        fieldPath: "barcode",
        normalizedValue: normalizeCatalogFactValue("exact", "520123456"),
      },
      {
        productId: "wrong-field",
        role: "exact",
        fieldPath: "sku",
        normalizedValue: normalizeCatalogFactValue("exact", "520123456"),
      },
    ],
  ),
  ["sku-hit"],
);
assert.deepEqual(
  selectCatalogFilteredProductIds(
    [{ value: "πλυντήριο" }],
    [
      {
        productId: "greek-searchable",
        role: "searchable",
        fieldPath: "description",
        normalizedValue: normalizeCatalogFactValue(
          "searchable",
          "υγρό απορρυπαντικό για πλυντήριο",
        ),
      },
    ],
  ),
  ["greek-searchable"],
);
assert.deepEqual(
  selectCatalogFilteredProductIds(
    [{ value: "απορρυπαντικά" }],
    [
      {
        productId: "detergent",
        role: "searchable",
        fieldPath: "description",
        normalizedValue: normalizeCatalogFactValue(
          "searchable",
          "υγρό απορρυπαντικό για πλυντήριο",
        ),
      },
    ],
  ),
  ["detergent"],
);
assert.deepEqual(
  selectCatalogFilteredProductIds(
    [{ value: "AXE" }, { value: "deodorant", fieldPath: "category" }],
    [
      {
        productId: "axe-deodorant",
        role: "filterable",
        fieldPath: "brand",
        normalizedValue: normalizeCatalogFactValue("filterable", "AXE"),
      },
      {
        productId: "axe-deodorant",
        role: "filterable",
        fieldPath: "category",
        normalizedValue: normalizeCatalogFactValue("filterable", "deodorant"),
      },
      {
        productId: "axe-hair",
        role: "filterable",
        fieldPath: "brand",
        normalizedValue: normalizeCatalogFactValue("filterable", "AXE"),
      },
      {
        productId: "axe-hair",
        role: "filterable",
        fieldPath: "category",
        normalizedValue: normalizeCatalogFactValue("filterable", "hair"),
      },
    ],
  ),
  ["axe-deodorant"],
);

const filterValueLines = formatCatalogFilterValueSummaryLines([
  {
    fieldPath: "brand",
    value: "DOVE",
    normalizedValue: "dove",
    productCount: 111,
  },
  {
    fieldPath: "brand",
    value: "LUX",
    normalizedValue: "lux",
    productCount: 20,
  },
  {
    fieldPath: "category",
    value: "Απορρυπαντικά",
    normalizedValue: normalizeCatalogFactValue("filterable", "Απορρυπαντικά"),
    productCount: 42,
  },
]);
assert.equal(filterValueLines[0], "Available configured filter values:");
assert.ok(filterValueLines.some((line) => line.includes("DOVE (111)")));
assert.ok(filterValueLines.some((line) => line.includes("LUX (20)")));
assert.ok(
  filterValueLines.some((line) => line.includes("Απορρυπαντικά (42)")),
);

const previousCatalogPage = {
  intent: "filter" as const,
  filters: [{ value: "LUX" }],
  offset: 0,
  limit: 20,
  nextOffset: 20,
  hasMore: true,
};
assert.deepEqual(
  resolveCatalogStructuredLookup(
    "continue_list",
    [],
    previousCatalogPage,
    30,
  ),
  {
    intent: "filter",
    filters: [{ value: "LUX" }],
    offset: 20,
    limit: 20,
  },
);
assert.equal(resolveCatalogStructuredLookup("continue_list", [], undefined, 30), null);
assert.deepEqual(
  resolveCatalogStructuredLookup("capabilities", [], previousCatalogPage, 30),
  {
    intent: "capabilities",
    filters: [],
    offset: 0,
    limit: 30,
  },
);
assert.deepEqual(
  resolveCatalogStructuredLookup("overview", [], previousCatalogPage, 30),
  {
    intent: "overview",
    filters: [],
    offset: 0,
    limit: 30,
  },
);
assert.deepEqual(
  resolveCatalogStructuredLookup(
    "count",
    [{ value: "DOVE" }],
    previousCatalogPage,
    30,
  ),
  {
    intent: "count",
    filters: [{ value: "DOVE" }],
    offset: 0,
    limit: 30,
  },
);
assert.equal(resolveCatalogStructuredLookup("filter", [], undefined, 30), null);

assert.equal(detectCatalogCapabilitiesQuestion("Which brands do you have?"), true);
assert.equal(detectCatalogCapabilitiesQuestion("τι μάρκες έχετε;"), true);
assert.equal(detectCatalogCapabilitiesQuestion("ποιες μάρκες υπάρχουν;"), true);
assert.equal(
  detectCatalogCapabilitiesQuestion("τι φίλτρα μπορώ να χρησιμοποιήσω;"),
  true,
);
assert.equal(detectCatalogCapabilitiesQuestion("Έχετε προϊόντα AXE;"), false);
assert.equal(detectCatalogCapabilitiesQuestion("what brand is SKU 123?"), false);
assert.equal(detectCatalogContinuationReply("yes"), true);
assert.equal(detectCatalogContinuationReply("more"), true);
assert.equal(detectCatalogContinuationReply("ναι"), true);
assert.equal(detectCatalogContinuationReply("συνέχισε"), true);
assert.equal(detectCatalogContinuationReply("επόμενα"), true);
assert.equal(detectCatalogContinuationReply("which brands do you have?"), false);
assert.equal(detectCatalogCountQuestion("πόσα προϊόντα Dove υπάρχουν;"), true);
assert.equal(detectCatalogCountQuestion("how many DOVE products are there?"), true);
assert.equal(detectCatalogCountQuestion("πόσο κοστίζει το DOVE;"), false);
assert.equal(detectCatalogCountQuestion("which brands do you have?"), false);
assert.equal(
  detectCatalogNonInventoryQuestion(
    "τι συστατικά έχει το AXE Black Αφρόλουτρο 400ml;",
  ),
  true,
);
assert.equal(detectCatalogNonInventoryQuestion("σύγκρινε δύο προϊόντα LUX"), true);
assert.equal(detectCatalogNonInventoryQuestion("Show me LUX products"), false);
assert.equal(detectCatalogInventoryQuestion("τι προιοντα εχεις"), true);
assert.equal(detectCatalogOverviewQuestion("τι προιοντα εχεις"), true);
assert.equal(detectCatalogOverviewQuestion("δείξε μου λίστα προϊόντων"), false);
assert.equal(detectCatalogOverviewQuestion("Ποια προϊόντα έχει η KNORR;"), false);
assert.equal(detectCatalogOverviewQuestion("εχεις αποσμητικα;"), false);
assert.deepEqual(sanitizeCatalogStructuredFilters([{ value: "προϊόντα" }]), []);
assert.deepEqual(
  sanitizeCatalogStructuredFilters([{ value: "τι προιοντα" }]),
  [],
);
assert.deepEqual(
  sanitizeCatalogStructuredFilters([{ value: "τι προιοντα εχεις" }]),
  [],
);
assert.deepEqual(
  sanitizeCatalogStructuredFilters([{ value: "Dove" }, { value: "προϊόντα" }]),
  [{ value: "Dove" }],
);
assert.deepEqual(
  repairCatalogFilterTermsFromQuery(
    [{ value: "Δοβ" }],
    "Δείξε μου προϊόντα Dove",
  ),
  [{ value: "Dove" }],
);
assert.deepEqual(
  repairCatalogFilterTermsFromQuery(
    [{ value: "apo Smyktika" }],
    "εχεις αποσμητικα;",
  ),
  [{ value: "αποσμητικα" }],
);
assert.deepEqual(inferCatalogFiltersFromInventoryQuestion("Δείξε μου προϊόντα SKIP"), [
  { value: "SKIP" },
]);
assert.deepEqual(inferCatalogFiltersFromInventoryQuestion("Show me LUX products"), [
  { value: "LUX" },
]);
assert.deepEqual(
  inferCatalogFiltersFromInventoryQuestion("δείξε μου λίστα προϊόντων"),
  [],
);
assert.deepEqual(inferCatalogFiltersFromInventoryQuestion("εχεις αποσμητικα;"), [
  { value: "αποσμητικα" },
]);
assert.deepEqual(inferCatalogFiltersFromInventoryQuestion("τι brands υπάρχουν;"), []);
assert.equal(shouldUseCatalogStructuredLane(0, true), false);
assert.equal(shouldUseCatalogStructuredLane(10, false), false);
assert.equal(shouldUseCatalogStructuredLane(10, true), true);

console.log("Catalog tests passed");
