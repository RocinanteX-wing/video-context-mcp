import { z } from 'zod';
import { toToolError } from '../errors.js';
import { formatMs } from '../utils/time.js';
import { type Deps, textResult } from './shared.js';

export const name = 'search_videos';

export const description =
  'Full-text search across the transcripts of all ingested videos (or one video via video_id). ' +
  'Returns ranked hits with video, timestamp, and a snippet. Use the hit timestamps with ' +
  'get_transcript to read the surrounding context.';

export const inputSchema = {
  query: z.string().min(1).describe('Search terms (FTS5 syntax supported; plain words work fine)'),
  video_id: z.string().optional().describe('Restrict search to one video'),
  limit: z.number().int().positive().max(25).optional().describe('Max hits (default 5)'),
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
      const sql = `
        SELECT s.video_id, v.title, s.start_ms,
               snippet(segments_fts, 0, '«', '»', '…', 14) AS snip
        FROM segments_fts
        JOIN segments s ON s.id = segments_fts.rowid
        JOIN videos v ON v.id = s.video_id
        WHERE segments_fts MATCH @q
        ${args.video_id ? 'AND s.video_id = @vid' : ''}
        ORDER BY rank
        LIMIT @limit`;

      const run = (match: string): Hit[] => {
        const params: Record<string, unknown> = { q: match, limit };
        if (args.video_id) params.vid = args.video_id;
        return deps.db.prepare(sql).all(params) as Hit[];
      };

      let hits: Hit[];
      try {
        hits = run(args.query);
      } catch {
        // User query wasn't valid FTS5 syntax — retry as a quoted phrase.
        hits = run(`"${args.query.replace(/"/g, '""')}"`);
      }

      if (hits.length === 0) {
        return textResult(
          `No transcript matches for "${args.query}"${args.video_id ? ` in ${args.video_id}` : ''}. Only ingested videos with captions are searchable — check list_videos.`,
        );
      }
      const lines = hits.map(
        (h) => `${h.video_id} [${formatMs(h.start_ms)}] ${h.title ?? ''} — ${h.snip}`,
      );
      return textResult(lines.join('\n'));
    } catch (err) {
      return toToolError(err);
    }
  };
}
