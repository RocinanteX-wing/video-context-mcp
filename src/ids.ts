import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { VcmError } from './errors.js';

export interface VideoRef {
  /** Stable content-addressed ID: the YouTube video ID, or `local-<hash12>`. */
  id: string;
  kind: 'youtube' | 'local';
  /** Canonical source: full YouTube watch URL, or absolute file path. */
  source: string;
}

const YT_URL_RE =
  /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/;
const YT_ID_RE = /^[\w-]{11}$/;

/**
 * Content-address a local file: sha256 over (size + first 8 MiB). Full-file
 * hashing would be exact but too slow for multi-GB videos; size+head is
 * collision-safe enough for a personal cache.
 */
function hashLocalFile(absPath: string): string {
  const st = statSync(absPath);
  const hash = createHash('sha256');
  hash.update(String(st.size));
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(8 * 1024 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return `local-${hash.digest('hex').slice(0, 12)}`;
}

/** Resolve user input (YouTube URL, bare video ID, or local file path) to a VideoRef. */
export function resolveRef(input: string): VideoRef {
  const trimmed = input.trim();
  if (!trimmed) throw new VcmError('UNSUPPORTED_URL', 'Empty url_or_path.');

  const urlMatch = trimmed.match(YT_URL_RE);
  if (urlMatch?.[1]) {
    const id = urlMatch[1];
    return { id, kind: 'youtube', source: `https://www.youtube.com/watch?v=${id}` };
  }

  // Local file path (absolute, relative, or ~)
  const looksLikePath =
    trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('~/');
  if (looksLikePath) {
    const abs = resolvePath(trimmed.replace(/^~\//, `${process.env.HOME}/`));
    if (!existsSync(abs)) {
      throw new VcmError('FILE_NOT_FOUND', `Local file not found: ${abs}`);
    }
    return { id: hashLocalFile(abs), kind: 'local', source: abs };
  }

  if (YT_ID_RE.test(trimmed)) {
    return {
      id: trimmed,
      kind: 'youtube',
      source: `https://www.youtube.com/watch?v=${trimmed}`,
    };
  }

  throw new VcmError(
    'UNSUPPORTED_URL',
    `Could not interpret "${trimmed}" as a YouTube URL, YouTube video ID, or existing local file path. Supported: youtube.com/watch?v=…, youtu.be/…, shorts/…, an 11-char video ID, or a path to a video file.`,
  );
}
