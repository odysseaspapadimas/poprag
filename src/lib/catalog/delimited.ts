type DelimitedFormat = "csv" | "tsv";

export function parseCatalogDelimitedRows(
  input: string,
  format: DelimitedFormat,
): { headers: string[]; records: Record<string, unknown>[] } {
  const delimiter = format === "tsv" ? "\t" : ",";
  const rows = parseDelimitedRows(input.replace(/^\uFEFF/, ""), delimiter);
  if (rows.length <= 1) {
    return { headers: rows[0] ?? [], records: [] };
  }

  const headers = rows[0].map((header, index) => {
    const cleaned = cleanDelimitedCell(header);
    return cleaned || `Column ${index + 1}`;
  });

  const records = rows.slice(1).flatMap((row) => {
    if (!row.some((cell) => cleanDelimitedCell(cell))) return [];
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const value = cleanDelimitedCell(row[index] ?? "");
      if (value) record[header] = value;
    });
    return Object.keys(record).length > 0 ? [record] : [];
  });

  return { headers, records };
}

function parseDelimitedRows(input: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const nextChar = input[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function cleanDelimitedCell(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
