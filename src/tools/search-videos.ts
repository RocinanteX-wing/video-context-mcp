import { z } from 'zod';
import { toToolError } from '../errors.js';
import { formatMs } from '../utils/time.js';
import { type Deps, textResult } from './shared.js';

export const name = 'search_videos';

export const description =
  'Full-text search across all ingested videos: spoken transcript AND on-screen OCR text (code, ' +
  'slides, terminals). Returns ranked hits labeled (speech) or (screen) with video, timestamp, ' +
  'and snippet. Follow up with get_transcript around a speech hit or peek_frame at a screen hit.';

export const inputSchema = {
  query: z.string().min(1).describe('Search terms (FTS5 syntax supported; plain words work fine)'),
  video_id: z.string().optional().describe('Restrict search to one video'),
  limit: z.number().int().positive().max(25).optional().describe('Max hits per source (default 5)'),
};

interface Hit {
  video_id: string;
  title: string | null;
  start_ms: number;
  snip: string;
}

export function handler(deps: Deps) {
  return async (args: { query: string; video_id?: string; limit?: number }) => {
    try {
      const limit = args.limit ?? 5;
      const speechSql = `
        SELECT s.video_id, v.title, s.start_ms,
               snippet(segments_fts, 0, '«', '»', '…', 14) AS snip
        FROM segments_fts
        JOIN segments s ON s.id = segments_fts.rowid
        JOIN videos v ON v.id = s.video_id
        WHERE segments_fts MATCH @q
        ${args.video_id ? 'AND s.video_id = @vid' : ''}
        ORDER BY rank
        LIMIT @limit`;
      const screenSql = `
        SELECT f.video_id, v.title, f.ts_ms AS start_ms,
               snippet(ocr_fts, 0, '«', '»', '…', 14) AS snip
        FROM ocr_fts
        JOIN ocr_blocks b ON b.id = ocr_fts.rowid
        JOIN frames f ON f.id = b.frame_id
        JOIN videos v ON v.id = f.video_id
        WHERE ocr_fts MATCH @q
        ${args.video_id ? 'AND f.video_id = @vid' : ''}
        ORDER BY rank
        LIMIT @limit`;

      const run = (sql: string, match: string): Hit[] => {
        const params: Record<string, unknown> = { q: match, limit };
        if (args.video_id) params.vid = args.video_id;
        return deps.db.prepare(sql).all(params) as Hit[];
      };
      const runBoth = (match: string): { speech: Hit[]; screen: Hit[] } => ({
        speech: run(speechSql, match),
        screen: run(screenSql, match),
      });

      let hits: { speech: Hit[]; screen: Hit[] };
      try {
        hits = runBoth(args.query);
      } catch {
        // User query wasn't valid FTS5 syntax — retry as a quoted phrase.
        hits = runBoth(`"${args.query.replace(/"/g, '""')}"`);
      }

      if (hits.speech.length === 0 && hits.screen.length === 0) {
        return textResult(
          `No matches for "${args.query}"${args.video_id ? ` in ${args.video_id}` : ''}. Only ingested videos are searchable (speech needs captions, screen text needs visual indexing) — check list_videos.`,
        );
      }
      const fmt = (h: Hit, kind: string) =>
        `${h.video_id} [${formatMs(h.start_ms)}] (${kind}) ${h.title ?? ''} — ${h.snip}`;
      const lines = [
        ...hits.speech.map((h) => fmt(h, 'speech')),
        ...hits.screen.map((h) => fmt(h, 'screen')),
      ];
      return textResult(lines.join('\n'));
    } catch (err) {
      return toToolError(err);
    }
  };
}
