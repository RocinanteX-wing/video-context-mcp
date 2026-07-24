import { describe, expect, it } from 'vitest';
import { normalizeUploadDate } from '../src/pipeline/ytdlp.js';

describe('yt-dlp metadata normalization', () => {
  it('normalizes valid upload dates and rejects malformed or impossible values', () => {
    expect(normalizeUploadDate('20260724')).toBe('2026-07-24');
    expect(normalizeUploadDate('20240229')).toBe('2024-02-29');
    expect(normalizeUploadDate('20230229')).toBeNull();
    expect(normalizeUploadDate('20261301')).toBeNull();
    expect(normalizeUploadDate('202607')).toBeNull();
    expect(normalizeUploadDate(20260724)).toBeNull();
  });
});
