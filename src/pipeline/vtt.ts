/**
 * WebVTT parsing tuned for YouTube captions. Handles inline timing tags,
 * styling tags, and the rolling-window duplication of auto-generated captions
 * (each cue repeats the previous cue's line before adding the new one).
 */

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMING_RE =
  /^(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/;

function timingToMs(h: string | undefined, m: string, s: string, ms: string): number {
  const hours = h ? Number(h.replace(':', '')) : 0;
  return ((hours * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, '') // inline timestamps <00:00:01.500>, <c>, <b>, …
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseVtt(vtt: string): Cue[] {
  const lines = vtt.split(/\r?\n/);
  const cues: Cue[] = [];
  let i = 0;
  let prevLines: string[] = [];

  while (i < lines.length) {
    const timing = lines[i]?.match(TIMING_RE);
    if (!timing) {
      i++;
      continue;
    }
    const startMs = timingToMs(timing[1], timing[2]!, timing[3]!, timing[4]!);
    const endMs = timingToMs(timing[5], timing[6]!, timing[7]!, timing[8]!);
    i++;

    const rawLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !TIMING_RE.test(lines[i]!)) {
      rawLines.push(lines[i]!);
      i++;
    }

    const cleaned = rawLines.map(cleanLine).filter((l) => l.length > 0);
    // Rolling-caption dedup: drop lines already shown in the previous cue.
    const fresh = cleaned.filter((l) => !prevLines.includes(l));
    if (cleaned.length > 0) prevLines = cleaned;

    const text = fresh.join(' ').trim();
    if (text) cues.push({ startMs, endMs, text });
  }
  return cues;
}

export interface MergeOptions {
  maxChars?: number;
  maxGapMs?: number;
}

/**
 * Merge tiny cues into readable segments (~sentence-sized), splitting when a
 * segment grows past maxChars or the gap between cues exceeds maxGapMs.
 */
export function mergeCues(cues: Cue[], opts: MergeOptions = {}): Segment[] {
  const maxChars = opts.maxChars ?? 300;
  const maxGapMs = opts.maxGapMs ?? 3000;
  const segments: Segment[] = [];
  let current: Segment | null = null;

  for (const cue of cues) {
    if (
      current &&
      current.text.length + cue.text.length + 1 <= maxChars &&
      cue.startMs - current.endMs <= maxGapMs
    ) {
      current.text = `${current.text} ${cue.text}`;
      current.endMs = Math.max(current.endMs, cue.endMs);
    } else {
      if (current) segments.push(current);
      current = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
    }
  }
  if (current) segments.push(current);
  return segments;
}
