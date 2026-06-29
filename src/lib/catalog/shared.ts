export type CatalogOrigin = "api" | "csv";

export type CatalogFieldRole =
  | "stable_key"
  | "title"
  | "exact"
  | "searchable"
  | "filterable";

export interface CatalogScopeConfig {
  scopeName?: string | null;
  scopeAliases?: string[] | null;
}

export interface CatalogIncludeFilter {
  fieldPath: string;
  values: string[];
}

export interface CatalogMapping {
  stableKeyField: string;
  updatedAtField?: string | null;
  deletionField?: string | null;
  deletionInactiveValues?: string[] | null;
  titleField: string;
  searchableFields?: string[] | null;
  exactMatchFields?: string[] | null;
  filterableFields?: string[] | null;
  includeFilters?: CatalogIncludeFilter[] | null;
}

export interface CatalogImportConfig
  extends CatalogMapping,
    CatalogScopeConfig {
  id: string;
  agentId: string;
  knowledgeSourceId: string;
  name: string;
  origin: CatalogOrigin;
  enabled: boolean;
  sourceFileName?: string | null;
  sourceR2Key?: string | null;
}

export interface NormalizedCatalogProduct {
  id: string;
  recordKey: string;
  recordHash: string;
  title: string;
  searchText: string;
  data: Record<string, unknown>;
  active: boolean;
  updatedAt?: Date;
}

export interface CatalogFieldFactInput {
  fieldPath: string;
  role: CatalogFieldRole;
  value: string;
  normalizedValue: string;
}

export interface CatalogFilterCandidateFact {
  productId: string;
  fieldPath: string;
  role: CatalogFieldRole;
  normalizedValue: string;
}

export interface CatalogFilterValueSummary {
  fieldPath: string;
  value: string;
  normalizedValue: string;
  productCount: number;
}

export function normalizeCatalogScopeAliases(config: CatalogScopeConfig) {
  const seen = new Set<string>();
  const aliases: string[] = [];

  for (const value of [config.scopeName, ...(config.scopeAliases ?? [])]) {
    const alias = String(value ?? "").trim();
    if (!alias) continue;
    const normalized = normalizeCatalogValue(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(alias);
  }

  return aliases;
}

export const DEFAULT_INACTIVE_VALUES = [
  "false",
  "inactive",
  "deleted",
  "0",
  "no",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPathValue(value: unknown, path: string): unknown {
  if (!path) return value;
  if (isRecord(value) && Object.hasOwn(value, path)) {
    return value[path];
  }

  return path.split(".").reduce<unknown>((current, segment) => {
    if (current == null || !segment) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (!isRecord(current)) return undefined;
    if (Object.hasOwn(current, segment)) return current[segment];
    return undefined;
  }, value);
}

export function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join(", ");
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, entry]) => {
        const text = stringifyValue(entry);
        return text ? `${key}: ${text}` : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

export function normalizeCatalogValue(value: unknown): string {
  return stringifyValue(value)
    .normalize("NFKC")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ς/g, "σ")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeExactValue(value: unknown): string {
  return normalizeCatalogValue(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeCatalogFactValue(
  role: CatalogFieldRole,
  value: unknown,
): string {
  return role === "stable_key" || role === "exact"
    ? normalizeExactValue(value)
    : normalizeCatalogValue(value);
}

export function normalizeCatalogQueryForRole(
  role: CatalogFieldRole,
  value: unknown,
): string {
  return normalizeCatalogFactValue(role, value);
}

export function isCatalogTitlePrefixCandidate(value: unknown): boolean {
  const normalized = normalizeCatalogValue(value);
  if (normalized.length < 3 || normalized.length > 120) return false;
  if (/[\n\r]/u.test(normalized)) return false;
  if (/[?!;:]/u.test(normalized)) return false;
  if (normalized.split(/\s+/u).length > 8) return false;
  return /\p{L}|\p{N}/u.test(normalized);
}

export function catalogTitleMatchesQuery(
  titleValue: unknown,
  queryValue: unknown,
): boolean {
  const title = normalizeCatalogValue(titleValue);
  const query = normalizeCatalogValue(queryValue);
  if (!title || !query) return false;
  return (
    title === query ||
    (isCatalogTitlePrefixCandidate(query) && title.startsWith(query))
  );
}

export function catalogFactMatchesFilter(
  fact: {
    fieldPath: string;
    role: CatalogFieldRole;
    normalizedValue: string;
  },
  filter: { value: string; fieldPath?: string },
): boolean {
  if (filter.fieldPath && filter.fieldPath !== fact.fieldPath) return false;

  switch (fact.role) {
    case "stable_key":
    case "exact":
      return (
        fact.normalizedValue ===
        normalizeCatalogFactValue(fact.role, filter.value)
      );
    case "title": {
      const titleQuery = normalizeCatalogFactValue("title", filter.value);
      return (
        fact.normalizedValue === titleQuery ||
        (isCatalogTitlePrefixCandidate(filter.value) &&
          fact.normalizedValue.startsWith(titleQuery))
      );
    }
    case "filterable":
      return (
        fact.normalizedValue ===
        normalizeCatalogFactValue("filterable", filter.value)
      );
    case "searchable": {
      const query = normalizeCatalogFactValue("searchable", filter.value);
      const tokens = tokenizeCatalogSearchableQuery(query);
      return (
        tokens.length > 0 &&
        tokens.every((token) =>
          getCatalogSearchableQueryCandidates(token).some((candidate) =>
            fact.normalizedValue.includes(candidate),
          ),
        )
      );
    }
    default:
      return false;
  }
}

export function getCatalogSearchableQueryCandidates(value: unknown): string[] {
  const normalized = normalizeCatalogFactValue("searchable", value);
  const candidates = [normalized];
  for (const token of tokenizeCatalogSearchableQuery(normalized)) {
    candidates.push(token);
    const stem = stemCatalogSearchableToken(token);
    if (stem !== token) candidates.push(stem);
  }
  return Array.from(
    new Set(candidates.filter((candidate) => candidate.length > 0)),
  );
}

export function selectCatalogFilteredProductIds(
  filters: Array<{ value: string; fieldPath?: string }>,
  candidateFacts: CatalogFilterCandidateFact[],
): string[] {
  const normalizedFilters = normalizeCatalogFilterTerms(filters);
  if (normalizedFilters.length === 0) return [];

  const matchesByFilter = normalizedFilters.map((filter) => {
    const matchingFacts = candidateFacts.filter((fact) =>
      catalogFactMatchesFilter(fact, filter),
    );
    const filterableFacts = matchingFacts.filter(
      (fact) => fact.role === "filterable",
    );
    const exactFacts = matchingFacts.filter(
      (fact) => fact.role === "stable_key" || fact.role === "exact",
    );
    const titleFacts = matchingFacts.filter((fact) => fact.role === "title");
    const selectedFacts =
      filterableFacts.length > 0
        ? filterableFacts
        : exactFacts.length > 0
          ? exactFacts
          : titleFacts.length > 0
            ? titleFacts
            : matchingFacts;

    return {
      hasAuthoritativeFacts:
        filterableFacts.length > 0 ||
        exactFacts.length > 0 ||
        titleFacts.length > 0,
      selectedFacts,
    };
  });
  const hasAuthoritativeMatch = matchesByFilter.some(
    (match) => match.hasAuthoritativeFacts,
  );
  const productIdsByFilter = matchesByFilter
    .map((match) => {
      const effectiveFacts = match.hasAuthoritativeFacts
        ? match.selectedFacts
        : hasAuthoritativeMatch
          ? []
          : match.selectedFacts;

      return new Set(effectiveFacts.map((fact) => fact.productId));
    })
    .filter((productIds) => productIds.size > 0 || !hasAuthoritativeMatch);

  if (productIdsByFilter.some((productIds) => productIds.size === 0)) {
    return [];
  }

  const [firstProductIds, ...remainingProductIds] = productIdsByFilter;
  const seen = new Set<string>();
  const orderedProductIds: string[] = [];

  for (const fact of candidateFacts) {
    if (!firstProductIds.has(fact.productId) || seen.has(fact.productId)) {
      continue;
    }
    if (
      remainingProductIds.every((productIds) => productIds.has(fact.productId))
    ) {
      seen.add(fact.productId);
      orderedProductIds.push(fact.productId);
    }
  }

  return orderedProductIds;
}

export function formatCatalogFilterValueSummaryLines(
  summaries: CatalogFilterValueSummary[],
  maxValuesPerField = 80,
): string[] {
  if (summaries.length === 0) {
    return ["Available configured filter values: none"];
  }

  const valuesByField = new Map<string, CatalogFilterValueSummary[]>();
  for (const summary of summaries) {
    const fieldPath = summary.fieldPath.trim();
    const value = summary.value.trim();
    if (!fieldPath || !value) continue;
    valuesByField.set(fieldPath, [
      ...(valuesByField.get(fieldPath) ?? []),
      { ...summary, fieldPath, value },
    ]);
  }

  if (valuesByField.size === 0) {
    return ["Available configured filter values: none"];
  }

  const lines = ["Available configured filter values:"];
  for (const [fieldPath, values] of valuesByField) {
    const displayedValues = values
      .slice(0, maxValuesPerField)
      .map((summary) => `${summary.value} (${summary.productCount})`);
    const remainingCount = values.length - displayedValues.length;
    lines.push(
      `- ${fieldPath}: ${displayedValues.join(", ")}${
        remainingCount > 0 ? `, and ${remainingCount} more` : ""
      }`,
    );
  }

  return lines;
}

function normalizeCatalogFilterTerms(
  filters: Array<{ value: string; fieldPath?: string }>,
) {
  const seen = new Set<string>();
  return filters
    .map((filter) => ({
      value: filter.value.trim(),
      fieldPath: filter.fieldPath?.trim() || undefined,
    }))
    .filter((filter) => {
      const key = normalizeCatalogValue(
        `${filter.fieldPath ?? "*"}:${filter.value}`,
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function tokenizeCatalogSearchableQuery(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function stemCatalogSearchableToken(token: string): string {
  return token.length >= 6 ? token.slice(0, -1) : token;
}

export function parseCatalogDate(value: unknown): Date | undefined {
  const scalar = stringifyScalar(value);
  if (!scalar) return undefined;
  const date = new Date(scalar);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function isInactiveCatalogValue(
  value: unknown,
  inactiveValues: string[] = DEFAULT_INACTIVE_VALUES,
): boolean {
  if (value === undefined || value === null || value === "") return false;
  const normalized = normalizeCatalogValue(value);
  return inactiveValues
    .map((candidate) => normalizeCatalogValue(candidate))
    .includes(normalized);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

export async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function makeCatalogProductId(
  sourceId: string,
  recordKey: string,
  indexVersion = 0,
): Promise<string> {
  return `cat_${(await sha256(`${sourceId}:${indexVersion}:${recordKey}`)).slice(0, 26)}`;
}

export async function makeCatalogFactId(options: {
  productId: string;
  fieldPath: string;
  role: CatalogFieldRole;
  normalizedValue: string;
  indexVersion?: number;
}): Promise<string> {
  return `catfact_${(
    await sha256(
      [
        options.productId,
        options.indexVersion ?? 0,
        options.role,
        options.fieldPath,
        options.normalizedValue,
      ].join(":"),
    )
  ).slice(0, 24)}`;
}

export function uniqueFieldList(fields: Array<string | null | undefined>) {
  return Array.from(
    new Set(fields.map((field) => field?.trim()).filter(Boolean) as string[]),
  );
}

export function normalizeCatalogIncludeFilters(
  filters: CatalogIncludeFilter[] | null | undefined,
): CatalogIncludeFilter[] {
  if (!Array.isArray(filters)) return [];

  return filters
    .map((filter) => {
      const fieldPath = filter?.fieldPath?.trim();
      const values = Array.isArray(filter?.values)
        ? Array.from(
            new Set(
              filter.values
                .map((value) => stringifyScalar(value))
                .filter(Boolean),
            ),
          )
        : [];
      return fieldPath && values.length > 0 ? { fieldPath, values } : null;
    })
    .filter((filter): filter is CatalogIncludeFilter => filter !== null);
}

export function catalogRecordMatchesIncludeFilters(
  mapping: Pick<CatalogMapping, "includeFilters">,
  record: Record<string, unknown>,
): boolean {
  const filters = normalizeCatalogIncludeFilters(mapping.includeFilters);
  if (filters.length === 0) return true;

  return filters.every((filter) => {
    const recordValues = extractCatalogFieldValues(
      getPathValue(record, filter.fieldPath),
    ).map(normalizeCatalogValue);
    if (recordValues.length === 0) return false;

    const allowedValues = filter.values.map(normalizeCatalogValue);
    return recordValues.some((recordValue) =>
      allowedValues.includes(recordValue),
    );
  });
}

export function buildCatalogSearchText(
  mapping: CatalogMapping,
  data: Record<string, unknown>,
  recordKey: string,
  title: string,
): string {
  const fields = uniqueFieldList([
    mapping.stableKeyField,
    mapping.titleField,
    ...(mapping.exactMatchFields ?? []),
    ...(mapping.searchableFields ?? []),
    ...(mapping.filterableFields ?? []),
    ...normalizeCatalogIncludeFilters(mapping.includeFilters).map(
      (filter) => filter.fieldPath,
    ),
  ]);
  const lines = [`Product: ${title}`, `Record key: ${recordKey}`];

  for (const field of fields) {
    const value = stringifyValue(getPathValue(data, field));
    if (value) lines.push(`${field}: ${value}`);
  }

  return lines.join("\n");
}

export async function normalizeCatalogRecord(
  config: CatalogImportConfig,
  record: unknown,
): Promise<NormalizedCatalogProduct | null> {
  if (!isRecord(record)) return null;

  if (!catalogRecordMatchesIncludeFilters(config, record)) return null;

  const recordKey = stringifyScalar(
    getPathValue(record, config.stableKeyField),
  );
  if (!recordKey) return null;

  const deletionValue = config.deletionField
    ? getPathValue(record, config.deletionField)
    : undefined;
  const active = !isInactiveCatalogValue(
    deletionValue,
    config.deletionInactiveValues ?? DEFAULT_INACTIVE_VALUES,
  );
  const title =
    stringifyScalar(getPathValue(record, config.titleField)) || recordKey;
  const data = record;
  const recordHash = await sha256(stableStringify(data));
  const searchText = buildCatalogSearchText(config, data, recordKey, title);
  const updatedAtValue = config.updatedAtField
    ? getPathValue(record, config.updatedAtField)
    : undefined;
  const updatedAt = parseCatalogDate(updatedAtValue);
  const id = await makeCatalogProductId(config.knowledgeSourceId, recordKey);

  return {
    id,
    recordKey,
    recordHash,
    title,
    searchText,
    data,
    active,
    updatedAt,
  };
}

export function extractCatalogFieldValues(
  value: unknown,
  maxValues = 20,
): string[] {
  const values: string[] = [];
  const visit = (entry: unknown) => {
    if (values.length >= maxValues) return;
    const scalar = stringifyScalar(entry);
    if (scalar) {
      values.push(scalar);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (isRecord(entry)) {
      const text = stringifyValue(entry);
      if (text) values.push(text);
    }
  };

  visit(value);
  return Array.from(
    new Set(values.map((entry) => entry.trim()).filter(Boolean)),
  );
}

export function collectCatalogFacts(
  mapping: CatalogMapping,
  product: Pick<NormalizedCatalogProduct, "recordKey" | "title" | "data">,
): Array<Omit<CatalogFieldFactInput, "normalizedValue">> {
  const facts: Array<Omit<CatalogFieldFactInput, "normalizedValue">> = [];
  const addField = (fieldPath: string, role: CatalogFieldRole) => {
    const value = getPathValue(product.data, fieldPath);
    for (const scalar of extractCatalogFieldValues(value)) {
      facts.push({ fieldPath, role, value: scalar });
    }
  };

  facts.push({
    fieldPath: mapping.stableKeyField,
    role: "stable_key",
    value: product.recordKey,
  });
  facts.push({
    fieldPath: mapping.titleField,
    role: "title",
    value: product.title,
  });

  for (const field of mapping.exactMatchFields ?? []) {
    addField(field, "exact");
  }
  for (const field of mapping.searchableFields ?? []) {
    addField(field, "searchable");
  }
  for (const field of mapping.filterableFields ?? []) {
    addField(field, "filterable");
  }

  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.role}:${fact.fieldPath}:${normalizeCatalogValue(fact.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
