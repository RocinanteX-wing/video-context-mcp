import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { VcmError, toToolError } from '../errors.js';
import { formatMs, parseTimestamp } from '../utils/time.js';
import { type Deps, getVideoRow, ingestStateNote, textResult } from './shared.js';

export const name = 'get_transcript';

export const description =
  'Timestamped transcript of an ingested video, optionally sliced to a time range. Timestamps ' +
  'accept seconds (90), MM:SS (1:30), or H:MM:SS (1:02:30). Inline output is capped; if ' +
  'truncated, the response says where to resume. Local stdio clients can use delivery="file" to ' +
  'materialize the complete selected range in the disposable cache. Prefer slicing to ranges found ' +
  'via search_videos or the timeline.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
  start: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Start of range (default: beginning)'),
  end: z.union([z.string(), z.number()]).optional().describe('End of range (default: end)'),
  delivery: z
    .enum(['inline', 'file'])
    .optional()
    .describe(
      'inline (default) returns capped text; file writes the complete range to a local UTF-8 file',
    ),
};

export const outputSchema = {
  video_id: z.string(),
  delivery: z.enum(['inline', 'file']),
  start_seconds: z.number().nonnegative(),
  end_seconds: z.number().nonnegative().nullable(),
  segment_count: z.number().int().nonnegative(),
  content_bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  resume_at_seconds: z.number().nonnegative().nullable(),
  file_path: z.string().nullable(),
};

const MAX_CHARS = 30_000;

interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

function writeTranscriptFile(
  deps: Deps,
  videoId: string,
  startMs: number,
  endMs: number | null,
  body: string,
): string {
  if (!/^[\w-]+$/.test(videoId)) {
    throw new VcmError(
      'UNSUPPORTED_URL',
      `Cannot export transcript for unsafe video id "${videoId}". Delete and re-ingest the video.`,
    );
  }
  const dir = join(deps.config.cacheDir, videoId, 'exports');
  const path = join(dir, `transcript-${startMs}-${endMs ?? 'end'}.txt`);
  const staging = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(staging, body, { encoding: 'utf8', flag: 'wx' });
    try {
      renameSync(staging, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      rmSync(path, { force: true });
      renameSync(staging, path);
    }
    deps.cache.refreshVideoUsage(videoId);
    return path;
  } catch {
    throw new VcmError(
      'CACHE_WRITE_FAILED',
      'Could not write the transcript export under VCM_CACHE_DIR. Check that the cache path is writable and has free space, then retry.',
    );
  } finally {
    try {
      rmSync(staging, { force: true });
    } catch {
      // Best-effort cleanup; the actionable write error above takes precedence.
    }
  }
}

export function handler(deps: Deps) {
  return async (args: {
    video_id: string;
    start?: string | number;
    end?: string | number;
    delivery?: 'inline' | 'file';
  }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      deps.cache.touchVideo(row.id);
      const note = ingestStateNote(row, deps.ingest);

      const startMs = args.start !== undefined ? parseTimestamp(args.start) : 0;
      const requestedEndMs = args.end !== undefined ? parseTimestamp(args.end) : null;
      const queryEndMs = requestedEndMs ?? Number.MAX_SAFE_INTEGER;
      if (queryEndMs < startMs) {
        throw new VcmError(
          'UNSUPPORTED_URL',
          `Invalid range: end (${formatMs(queryEndMs)}) is before start (${formatMs(startMs)}).`,
        );
      }
      const segments = deps.db
        .prepare(
          `SELECT start_ms, end_ms, text FROM segments
           WHERE video_id = ? AND end_ms >= ? AND start_ms <= ?
           ORDER BY start_ms`,
        )
        .all(row.id, startMs, queryEndMs) as TranscriptSegment[];

      const delivery = args.delivery ?? 'inline';

      if (segments.length === 0) {
        return {
          ...textResult(
            `No transcript segments in range for ${row.id}. The video may have no captions (check get_ingest_status) or the range may be outside its duration.${note ? `\n${note}` : ''}`,
          ),
          structuredContent: {
            video_id: row.id,
            delivery,
            start_seconds: startMs / 1000,
            end_seconds: requestedEndMs === null ? null : requestedEndMs / 1000,
            segment_count: 0,
            content_bytes: 0,
            truncated: false,
            resume_at_seconds: null,
            file_path: null,
          },
        };
      }

      const allLines = segments.map((seg) => `[${formatMs(seg.start_ms)}] ${seg.text}`);
      if (delivery === 'file') {
        const body = `${allLines.join('\n')}\n`;
        const filePath = writeTranscriptFile(deps, row.id, startMs, requestedEndMs, body);
        return {
          ...textResult(
            `Transcript for ${row.id} (${segments.length} segments, ${Buffer.byteLength(body)} bytes) written to ${filePath}. The file is disposable cache data and is removed by delete_video or cache eviction.${note ? `\n${note}` : ''}`,
          ),
          structuredContent: {
            video_id: row.id,
            delivery,
            start_seconds: startMs / 1000,
            end_seconds: requestedEndMs === null ? null : requestedEndMs / 1000,
            segment_count: segments.length,
            content_bytes: Buffer.byteLength(body),
            truncated: false,
            resume_at_seconds: null,
            file_path: filePath,
          },
        };
      }

      const lines: string[] = [];
      let chars = 0;
      let truncatedAt: number | null = null;
      let includedSegments = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        const line = allLines[i]!;
        if (chars + line.length > MAX_CHARS) {
          truncatedAt = seg.start_ms;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
        includedSegments++;
      }
      if (truncatedAt !== null) {
        lines.push(
          '',
          `[TRUNCATED at ${formatMs(truncatedAt)}] Call get_transcript again with start="${formatMs(truncatedAt)}" to continue.`,
        );
      }
      if (note) lines.push('', note);
      const body = lines.join('\n');
      return {
        ...textResult(body),
        structuredContent: {
          video_id: row.id,
          delivery,
          start_seconds: startMs / 1000,
          end_seconds: requestedEndMs === null ? null : requestedEndMs / 1000,
          segment_count: includedSegments,
          content_bytes: Buffer.byteLength(body),
          truncated: truncatedAt !== null,
          resume_at_seconds: truncatedAt === null ? null : truncatedAt / 1000,
          file_path: null,
        },
      };
    } catch (err) {
      return toToolError(err);
    }
  };
}
