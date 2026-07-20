import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toToolError } from '../errors.js';
import { formatMs } from '../utils/time.js';
import { type Deps, jsonResult } from './shared.js';

export const name = 'list_videos';

export const description =
  'List all videos in the local index with their ingest stage, transcript availability, and ' +
  'disk usage. Warns when the cache exceeds the configured size cap (VCM_MAX_CACHE_GB).';

export const inputSchema = {};

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

export function handler(deps: Deps) {
  return async () => {
    try {
      const rows = deps.db
        .prepare(
          `SELECT v.id, v.title, v.kind, v.stage, v.duration_s, v.error_code,
                  (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id) AS segments
           FROM videos v ORDER BY v.ingested_at DESC NULLS LAST, v.id`,
        )
        .all() as {
        id: string;
        title: string | null;
        kind: string;
        stage: string;
        duration_s: number | null;
        error_code: string | null;
        segments: number;
      }[];

      const videos = rows.map((r) => {
        const bytes = dirSizeBytes(join(deps.config.cacheDir, r.id));
        return {
          video_id: r.id,
          title: r.title,
          kind: r.kind,
          stage: r.stage,
          duration: r.duration_s ? formatMs(r.duration_s * 1000) : null,
          segments: r.segments,
          error_code: r.error_code,
          disk_mb: Math.round((bytes / 1024 / 1024) * 10) / 10,
        };
      });

      // Whole-cache size: includes video dirs, whisper models, the SQLite
      // index, and any orphans — not just directories with live rows.
      const totalGb = dirSizeBytes(deps.config.cacheDir) / 1024 ** 3;
      return jsonResult({
        count: videos.length,
        cache_dir: deps.config.cacheDir,
        cache_gb: Math.round(totalGb * 100) / 100,
        cache_warning:
          totalGb > deps.config.maxCacheGb
            ? `Cache exceeds VCM_MAX_CACHE_GB=${deps.config.maxCacheGb}. Consider delete_video on old entries.`
            : null,
        videos,
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}
