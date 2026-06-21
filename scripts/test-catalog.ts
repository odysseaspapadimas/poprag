import assert from "node:assert/strict";
import { parseCatalogDelimitedRows } from "../src/lib/catalog/delimited";
import {
  catalogFactMatchesFilter,
  catalogTitleMatchesQuery,
  collectCatalogFacts,
  normalizeCatalogFactValue,
  normalizeCatalogRecord,
  normalizeCatalogValue,
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

assert.equal(normalizeCatalogValue("  ΣΚΙΠ   Υγρό "), "σκιπ υγρό");
assert.equal(
  normalizeCatalogFactValue("stable_key", "SKU-001 / A"),
  "sku001a",
);
assert.equal(
  normalizeCatalogFactValue("exact", "520-123 456"),
  "520123456",
);
assert.equal(normalizeCatalogFactValue("title", "  Καφές φίλτρου "), "καφές φίλτρου");
assert.equal(catalogTitleMatchesQuery("Νεσκαφέ Classic 200g", "Νεσκαφέ"), true);
assert.equal(catalogTitleMatchesQuery("Νεσκαφέ Classic 200g", "Classic"), false);

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
      normalizedValue: "υγρό απορρυπαντικό για πλυντήριο",
    },
    { value: "πλυντήριο" },
  ),
  true,
);

console.log("Catalog tests passed");
