import { eq } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeSource } from "@/db/schema";
import {
  applyCatalogRecords,
  type CatalogIndexBuild,
  emptyCatalogImportStats,
  failCatalogIndexVersion,
  prepareCatalogIndexVersion,
  promoteCatalogIndexVersion,
  refreshSourceVectorizeIds,
} from "./apply";
import { loadCatalogImportConfigBySourceId } from "./config";
import { parseCatalogDelimitedRows } from "./delimited";

type DelimitedFormat = "csv" | "tsv";

export async function processCsvCatalogSource(options: {
  sourceId: string;
  env: Env;
  content?: string | ArrayBuffer | Uint8Array;
  abortSignal?: AbortSignal;
}): Promise<{
  success: true;
  sourceId: string;
  productsProcessed: number;
  chunksProcessed: number;
  chunksInserted: number;
  vectorsInserted: number;
  factsInserted: number;
}> {
  const config = await loadCatalogImportConfigBySourceId(options.sourceId);
  if (!config) {
    throw new Error("Catalog config not found for CSV source");
  }
  if (config.origin !== "csv") {
    throw new Error("Only CSV catalog sources can be imported with this path");
  }

  const source = await loadSource(options.sourceId);
  await updateSourceProgress(source.id, 5, "Reading CSV catalog", "processing");

  const content =
    options.content !== undefined
      ? decodeToText(options.content)
      : await readSourceTextFromR2(source, options.env);
  if (options.abortSignal?.aborted) {
    throw new Error("CSV catalog import cancelled");
  }

  const format: DelimitedFormat =
    source.fileName?.toLowerCase().endsWith(".tsv") ||
    source.mime === "text/tab-separated-values"
      ? "tsv"
      : "csv";
  const { records } = parseCatalogDelimitedRows(content, format);
  const stats = emptyCatalogImportStats();
  stats.fetched = records.length;
  stats.pagesFetched = 1;
  let indexBuild: CatalogIndexBuild | undefined;

  await updateSourceProgress(
    source.id,
    12,
    `Parsed ${records.length} CSV catalog products`,
    "processing",
  );

  let lastProgressReportAt = 0;
  try {
    indexBuild = await prepareCatalogIndexVersion({ config });

    await applyCatalogRecords({
      config,
      records,
      env: options.env,
      mode: "snapshot",
      indexVersion: indexBuild.version,
      stats,
      onProgress: async ({ processed, total }) => {
        const now = Date.now();
        if (
          processed < total &&
          processed % 10 !== 0 &&
          now - lastProgressReportAt < 5000
        ) {
          return;
        }
        lastProgressReportAt = now;
        await updateSourceProgress(
          source.id,
          getCsvCatalogIndexProgress(processed, total),
          `Indexing catalog products ${processed}/${total}: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.deactivated} hidden, ${stats.chunksInserted} chunks`,
          "processing",
        );
      },
    });

    await updateSourceProgress(
      source.id,
      96,
      "Refreshing catalog vector metadata",
    );
    await refreshSourceVectorizeIds(source.id, {
      indexVersion: indexBuild.version,
    });

    await promoteCatalogIndexVersion({
      config,
      build: indexBuild,
      env: options.env,
      stats,
    });
  } catch (error) {
    await failCatalogIndexVersion({ build: indexBuild, error, stats });
    throw error;
  }

  await db
    .update(knowledgeSource)
    .set({
      status: "indexed",
      progress: 100,
      progressMessage: `CSV catalog import complete: ${stats.created} created, ${stats.updated} updated, ${stats.deactivated} hidden`,
      parserErrors: [],
      updatedAt: new Date(),
    })
    .where(eq(knowledgeSource.id, source.id));

  return {
    success: true,
    sourceId: source.id,
    productsProcessed: records.length,
    chunksProcessed: stats.chunksInserted,
    chunksInserted: stats.chunksInserted,
    vectorsInserted: stats.vectorsUpserted,
    factsInserted: stats.factsInserted,
  };
}

async function loadSource(sourceId: string) {
  const [source] = await db
    .select()
    .from(knowledgeSource)
    .where(eq(knowledgeSource.id, sourceId))
    .limit(1);

  if (!source) throw new Error("Knowledge source not found");
  return source;
}

async function readSourceTextFromR2(
  source: Awaited<ReturnType<typeof loadSource>>,
  env: Env,
): Promise<string> {
  if (!source.r2Key) throw new Error("No R2 file found for this source");
  const object = await env.R2.get(source.r2Key);
  if (!object) throw new Error("CSV catalog file not found in R2");
  return await object.text();
}

async function updateSourceProgress(
  sourceId: string,
  progress: number,
  message: string,
  status: "processing" | "indexed" | "failed" = "processing",
): Promise<void> {
  await db
    .update(knowledgeSource)
    .set({
      status,
      progress,
      progressMessage: message,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeSource.id, sourceId));
}

function decodeToText(content: string | ArrayBuffer | Uint8Array): string {
  if (typeof content === "string") return content;
  const decoder = new TextDecoder();
  if (content instanceof ArrayBuffer) return decoder.decode(content);
  return decoder.decode(content);
}

function getCsvCatalogIndexProgress(processed: number, total: number): number {
  if (total <= 0) return 88;
  const ratio = Math.min(1, Math.max(0, processed / total));
  return Math.round(15 + ratio * 73);
}
