import { describe, expect, it } from 'vitest';
import { isEnglishOnlyModel, parseWhisperProgress } from '../src/pipeline/whisper.js';

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
