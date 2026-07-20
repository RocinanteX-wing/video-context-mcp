import { describe, expect, it } from 'vitest';
import { rrfFuse } from '../src/utils/rrf.js';

const item = (key: string) => ({ key, item: key });

describe('rrfFuse', () => {
  it('items appearing in multiple lists outrank single-list items', () => {
    const fused = rrfFuse(
      [
        [item('a'), item('b')],
        [item('c'), item('a')],
      ],
      10,
    );
    expect(fused[0]!.key).toBe('a');
    expect(fused[0]!.sources).toBe(2);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 6);
  });

  it('respects rank order within a single list', () => {
    const fused = rrfFuse([[item('first'), item('second'), item('third')]], 10);
    expect(fused.map((f) => f.key)).toEqual(['first', 'second', 'third']);
  });

  it('applies the limit after fusion', () => {
    const fused = rrfFuse([[item('a'), item('b'), item('c')], [item('c')]], 2);
    expect(fused).toHaveLength(2);
    expect(fused[0]!.key).toBe('c'); // in both lists
  });

  it('handles empty input', () => {
    expect(rrfFuse([], 5)).toEqual([]);
    expect(rrfFuse([[], []], 5)).toEqual([]);
  });
});
