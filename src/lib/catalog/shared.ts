export type CatalogOrigin = "api" | "csv";

export type CatalogFieldRole =
  | "stable_key"
  | "title"
  | "exact"
  | "searchable"
  | "filterable";

export interface CatalogMapping {
  stableKeyField: string;
  updatedAtField?: string | null;
  deletionField?: string | null;
  deletionInactiveValues?: string[] | null;
  titleField: string;
  searchableFields?: string[] | null;
  exactMatchFields?: string[] | null;
  filterableFields?: string[] | null;
}

export interface CatalogImportConfig extends CatalogMapping {
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
      return query.length > 0 && fact.normalizedValue.includes(query);
    }
    default:
      return false;
  }
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
