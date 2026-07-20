import { describe, expect, it } from 'vitest';
import { formatMs, parseTimestamp } from '../src/utils/time.js';

describe('parseTimestamp', () => {
  it.each([
    ['90', 90_000],
    ['90.5', 90_500],
    ['90s', 90_000],
    ['1:30', 90_000],
    ['1:02:30', 3_750_000],
    ['0:00', 0],
    [42, 42_000],
  ])('parses %s → %d ms', (input, expected) => {
    expect(parseTimestamp(input as string | number)).toBe(expected);
  });

  it('rejects nonsense', () => {
    expect(() => parseTimestamp('abc')).toThrow(/Invalid timestamp/);
    expect(() => parseTimestamp(-5)).toThrow();
  });
});

describe('formatMs', () => {
  it.each([
    [0, '0:00'],
    [90_000, '1:30'],
    [3_750_000, '1:02:30'],
    [59_999, '0:59'],
  ])('formats %d ms → %s', (ms, expected) => {
    expect(formatMs(ms)).toBe(expected);
  });
});
