import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Locale-safe formatting helpers ──────────────────────────────────
// Change this single constant to switch every formatted date/number in the app.
const LOCALE = "el-GR";

/** Format a date+time string (e.g. "17/2/2026, 4:52:49 μ.μ.") */
export const formatDateTime = (value: number | Date) =>
  new Date(value).toLocaleString(LOCALE);

/** Format a date-only string (e.g. "17/2/2026") */
export const formatDate = (value: number | Date) =>
  new Date(value).toLocaleDateString(LOCALE);

/** Format a number with locale grouping (e.g. "1.234") */
export const formatNumber = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toLocaleString(LOCALE);
};

/**
 * Reciprocal Rank Fusion (RRF) for merging search results from multiple sources
 * Combines rankings from different search methods into a unified ranking
 * Based on: https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking
 *
 * @param k - Constant for fusion (default: 60) - controls smoothing
 */
export function reciprocalRankFusion<T extends { id: string; score: number }>(
  resultSets: T[][],
  k = 60,
): T[] {
  const scores: Map<string, { item: T; fusedScore: number }> = new Map();

  // Process each result set
  for (const resultSet of resultSets) {
    resultSet.forEach((item, rank) => {
      const rrfScore = 1 / (k + rank + 1); // +1 for 0-based indexing

      const existing = scores.get(item.id);
      if (existing) {
        existing.fusedScore += rrfScore;
      } else {
        scores.set(item.id, {
          item,
          fusedScore: rrfScore,
        });
      }
    });
  }

  // Sort by fused score descending
  return Array.from(scores.values())
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .map(({ item }) => item);
}

/**
 * Get unique items from an array by a specific key
 */
export function getUniqueListBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): T[] {
  const seen = new Set();
  return arr.filter((item) => {
    const value = item[key];
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}
