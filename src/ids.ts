import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
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

const HASH_CHUNK = 8 * 1024 * 1024;

/**
 * Content-address a local file: sha256 over (size + first 8 MiB + last 8 MiB).
 * Full-file hashing would be exact but too slow for multi-GB videos; head+tail
 * +size catches files that share a container header but differ in content.
 */
function hashLocalFile(absPath: string, size: number): string {
  const hash = createHash('sha256');
  hash.update(String(size));
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(HASH_CHUNK);
    const head = readSync(fd, buf, 0, buf.length, 0);
    hash.update(buf.subarray(0, head));
    if (size > HASH_CHUNK) {
      const tailPos = Math.max(HASH_CHUNK, size - HASH_CHUNK);
      const tail = readSync(fd, buf, 0, buf.length, tailPos);
      hash.update(buf.subarray(0, tail));
    }
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
    isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\');
  if (looksLikePath) {
    const expanded = trimmed.replace(/^~[\\/]/, `${homedir()}/`);
    const abs = resolvePath(expanded);
    if (!existsSync(abs)) {
      throw new VcmError('FILE_NOT_FOUND', `Local file not found: ${abs}`);
    }
    try {
      const st = statSync(abs);
      // Regular files only: directories error uselessly and FIFOs would block
      // the event loop during hashing.
      if (!st.isFile()) {
        throw new VcmError('FILE_NOT_FOUND', `Not a regular file: ${abs}`);
      }
      return { id: hashLocalFile(abs, st.size), kind: 'local', source: abs };
    } catch (err) {
      if (err instanceof VcmError) throw err;
      throw new VcmError(
        'FILE_NOT_FOUND',
        `Cannot read local file ${abs}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
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
