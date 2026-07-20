/**
 * Reciprocal-rank fusion: merge multiple ranked lists into one, rewarding
 * items that appear in several lists. Standard k=60 damping.
 */

export interface RankedItem<T> {
  /** Stable identity across lists (same key ⇒ same underlying item). */
  key: string;
  item: T;
}

export interface FusedItem<T> {
  key: string;
  item: T;
  score: number;
  /** How many input lists contained this item. */
  sources: number;
}

const RRF_K = 60;

export function rrfFuse<T>(lists: RankedItem<T>[][], limit: number): FusedItem<T>[] {
  const fused = new Map<string, FusedItem<T>>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const { key, item } = list[rank]!;
      const inc = 1 / (RRF_K + rank + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += inc;
        existing.sources += 1;
      } else {
        fused.set(key, { key, item, score: inc, sources: 1 });
      }
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
