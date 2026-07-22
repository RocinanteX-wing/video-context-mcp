import { describe, expect, it } from 'vitest';
import {
  isEnglishOnlyModel,
  ownWindowChunks,
  parseWhisperProgress,
} from '../src/pipeline/whisper.js';

describe('parseWhisperProgress', () => {
  it('extracts the percentage from -pp output', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =   5%')).toBe(5);
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 100%')).toBe(100);
  });

  it('returns null for unrelated lines', () => {
    expect(parseWhisperProgress('whisper_init_from_file_with_params_no_state: loading model')).toBe(
      null,
    );
    expect(parseWhisperProgress('[00:00:00.000 --> 00:00:02.000]  Hello')).toBe(null);
  });
});

describe('isEnglishOnlyModel', () => {
  it.each([
    ['/x/ggml-base.en.bin', true],
    ['/x/ggml-small.en-q5_1.bin', true],
    ['/x/ggml-base.bin', false],
    ['/x/ggml-large-v3-turbo.bin', false],
  ])('%s → %s', (path, expected) => {
    expect(isEnglishOnlyModel(path)).toBe(expected);
  });
});

describe('ownWindowChunks', () => {
  it('deduplicates overlapping windows by global timestamp midpoint', () => {
    const first = ownWindowChunks(
      [
        { timestamp: [24, 27], text: 'kept by first' },
        { timestamp: [27, 29], text: 'owned by next' },
      ],
      0,
      false,
    );
    const second = ownWindowChunks(
      [
        { timestamp: [0, 2], text: 'duplicate from first' },
        { timestamp: [2, 4], text: 'owned by next' },
      ],
      25,
      true,
    );
    expect(first.map((chunk) => chunk.text)).toEqual(['kept by first']);
    expect(second.map((chunk) => chunk.text)).toEqual(['owned by next']);
    expect(second[0]?.startS).toBe(27);
  });
});
