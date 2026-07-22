import { z } from 'zod';
import { toToolError } from '../errors.js';
import { type RankedItem, rrfFuse } from '../utils/rrf.js';
import { formatMs } from '../utils/time.js';
import { type Deps, textResult } from './shared.js';

export const name = 'search_videos';

export const description =
  'Hybrid search across all ingested videos: full-text AND semantic (dense embeddings) over both ' +
  'spoken transcript and on-screen OCR text, fused by reciprocal rank. Returns hits labeled ' +
  '(speech) or (screen) with video, timestamp, and snippet. Follow up with get_transcript around ' +
  'a speech hit or peek_frame at a screen hit. Semantic matching finds paraphrases ("how do they ' +
  'avoid memory bugs") even when the exact words differ.';

export const inputSchema = {
  query: z.string().min(1).describe('Search terms or a natural-language question'),
  video_id: z.string().optional().describe('Restrict search to one video'),
  limit: z.number().int().positive().max(25).optional().describe('Max fused hits (default 8)'),
};

interface Hit {
  video_id: string;
  title: string | null;
  ts_ms: number;
  kind: 'speech' | 'screen';
  display: string;
}

export function filterLiveVectorHits<T extends { video_id: string }>(
  hits: T[],
  liveVideoIds: ReadonlySet<string>,
  limit: number,
): T[] {
  return hits.filter((hit) => liveVideoIds.has(hit.video_id)).slice(0, limit);
}

export function handler(deps: Deps) {
  return async (args: { query: string; video_id?: string; limit?: number }) => {
    try {
      const limit = args.limit ?? 8;
      const perList = Math.max(limit, 8);

      const speechSql = `
        SELECT s.id AS ref_id, s.video_id, v.title, s.start_ms AS ts_ms,
               snippet(segments_fts, 0, '«', '»', '…', 14) AS snip
        FROM segments_fts
        JOIN segments s ON s.id = segments_fts.rowid
        JOIN videos v ON v.id = s.video_id
        WHERE segments_fts MATCH @q
        ${args.video_id ? 'AND s.video_id = @vid' : ''}
        ORDER BY rank
        LIMIT @limit`;
      const screenSql = `
        SELECT f.id AS ref_id, f.video_id, v.title, f.ts_ms,
               snippet(ocr_fts, 0, '«', '»', '…', 14) AS snip
        FROM ocr_fts
        JOIN ocr_blocks b ON b.id = ocr_fts.rowid
        JOIN frames f ON f.id = b.frame_id
        JOIN videos v ON v.id = f.video_id
        WHERE ocr_fts MATCH @q
        ${args.video_id ? 'AND f.video_id = @vid' : ''}
        ORDER BY rank
        LIMIT @limit`;

      interface FtsRow {
        ref_id: number;
        video_id: string;
        title: string | null;
        ts_ms: number;
        snip: string;
      }
      const run = (sql: string, match: string): FtsRow[] => {
        const params: Record<string, unknown> = { q: match, limit: perList };
        if (args.video_id) params.vid = args.video_id;
        return deps.db.prepare(sql).all(params) as FtsRow[];
      };
      const runBoth = (match: string): { speech: FtsRow[]; screen: FtsRow[] } => ({
        speech: run(speechSql, match),
        screen: run(screenSql, match),
      });

      let fts: { speech: FtsRow[]; screen: FtsRow[] };
      try {
        fts = runBoth(args.query);
      } catch {
        // User query wasn't valid FTS5 syntax — retry as a quoted phrase.
        fts = runBoth(`"${args.query.replace(/"/g, '""')}"`);
      }

      const toRanked = (rows: FtsRow[], kind: 'speech' | 'screen'): RankedItem<Hit>[] =>
        rows.map((r) => ({
          key: `${kind === 'speech' ? 'seg' : 'frame'}-${r.ref_id}`,
          item: { video_id: r.video_id, title: r.title, ts_ms: r.ts_ms, kind, display: r.snip },
        }));

      const lists: RankedItem<Hit>[][] = [
        toRanked(fts.speech, 'speech'),
        toRanked(fts.screen, 'screen'),
      ];

      // Semantic list — skipped instantly when nothing was ever embedded, and
      // degrades to FTS-only (with a note) if the model/store misbehaves.
      let semanticNote: string | null = null;
      try {
        const embed = await import('../pipeline/embed.js');
        if (await embed.hasVectors(deps.config)) {
          const [queryVec] = await embed.embedTexts([args.query], deps.config);
          const hits = await embed.searchVectors(
            queryVec!,
            perList * 4,
            deps.config,
            args.video_id,
          );
          const liveIds = new Set(
            (
              deps.db.prepare('SELECT id FROM videos').all() as {
                id: string;
              }[]
            ).map((row) => row.id),
          );
          const titleStmt = deps.db.prepare('SELECT title FROM videos WHERE id = ?');
          lists.push(
            filterLiveVectorHits(hits, liveIds, perList).map((h) => ({
              key: h.id,
              item: {
                video_id: h.video_id,
                title:
                  (titleStmt.get(h.video_id) as { title: string | null } | undefined)?.title ??
                  null,
                ts_ms: h.ts_ms,
                kind: h.kind,
                display: h.text.length > 120 ? `${h.text.slice(0, 120)}…` : h.text,
              },
            })),
          );
        }
      } catch (err) {
        semanticNote = `Note: semantic search unavailable (${err instanceof Error ? err.message.slice(0, 150) : err}); showing full-text matches only.`;
      }

      const fused = rrfFuse(lists, limit);
      if (fused.length === 0) {
        return textResult(
          `No matches for "${args.query}"${args.video_id ? ` in ${args.video_id}` : ''}. Only ingested videos are searchable (speech needs captions or whisper, screen text needs visual indexing) — check list_videos.${semanticNote ? `\n${semanticNote}` : ''}`,
        );
      }
      for (const videoId of new Set(fused.map((hit) => hit.item.video_id))) {
        deps.cache.touchVideo(videoId);
      }
      const lines = fused.map(
        (f) =>
          `${f.item.video_id} [${formatMs(f.item.ts_ms)}] (${f.item.kind}) ${f.item.title ?? ''} — ${f.item.display}`,
      );
      if (semanticNote) lines.push(semanticNote);
      return textResult(lines.join('\n'));
    } catch (err) {
      return toToolError(err);
    }
  };
}
