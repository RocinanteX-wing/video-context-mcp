import { describe, expect, it } from 'vitest';
import { mergeCues, parseVtt } from '../src/pipeline/vtt.js';

const MANUAL_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
Hello and welcome to the show.

00:00:04.500 --> 00:00:08.000
Today we discuss <b>Redis</b> caching.

00:01:02.000 --> 00:01:05.000
A new topic after a gap.
`;

const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000
so today we're going to

00:00:02.000 --> 00:00:04.000
so today we're going to
talk about caching

00:00:04.000 --> 00:00:06.000
talk about caching
with<00:00:04.500><c> redis</c> streams
`;

describe('parseVtt', () => {
  it('parses cues with timing and strips tags', () => {
    const cues = parseVtt(MANUAL_VTT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ startMs: 1000, endMs: 4000, text: 'Hello and welcome to the show.' });
    expect(cues[1]!.text).toBe('Today we discuss Redis caching.');
  });

  it('deduplicates rolling auto-caption lines', () => {
    const cues = parseVtt(AUTO_VTT);
    const all = cues.map((c) => c.text).join(' ');
    expect(all).toBe("so today we're going to talk about caching with redis streams");
  });

  it('handles hour-long timestamps', () => {
    const vtt = 'WEBVTT\n\n01:02:03.500 --> 01:02:05.000\nlate cue\n';
    const cues = parseVtt(vtt);
    expect(cues[0]!.startMs).toBe(3723500);
  });

  it('returns empty for caption-less vtt', () => {
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
  });

  it('preserves genuinely repeated speech separated by a gap', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Repeat after me.

00:10:01.000 --> 00:10:02.000
Repeat after me.
`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[1]!.text).toBe('Repeat after me.');
  });

  it('still dedups identical lines in temporally contiguous rolling cues', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
rolling line

00:00:03.000 --> 00:00:05.000
rolling line
new line
`;
    const cues = parseVtt(vtt);
    expect(cues.map((c) => c.text)).toEqual(['rolling line', 'new line']);
  });
});

describe('mergeCues', () => {
  it('merges small adjacent cues and splits on gaps', () => {
    const cues = parseVtt(MANUAL_VTT);
    const segments = mergeCues(cues, { maxChars: 300, maxGapMs: 3000 });
    expect(segments).toHaveLength(2); // first two merge; 54s gap splits the third
    expect(segments[0]!.text).toBe(
      'Hello and welcome to the show. Today we discuss Redis caching.',
    );
    expect(segments[0]!.startMs).toBe(1000);
    expect(segments[0]!.endMs).toBe(8000);
  });

  it('splits when exceeding maxChars', () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      text: 'x'.repeat(80),
    }));
    const segments = mergeCues(cues, { maxChars: 200, maxGapMs: 3000 });
    expect(segments.length).toBeGreaterThan(3);
  });
});
