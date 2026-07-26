import { z } from 'zod';
import { toToolError } from '../errors.js';
import { formatMs } from '../utils/time.js';
import { type Deps, jsonResult } from './shared.js';

export const name = 'list_videos';

export const description =
  'List all videos in the local index with their ingest stage, transcript availability, and ' +
  'retained usage. Reports the video LRU budget separately from reusable runtime/model data.';

export const inputSchema = {};

export const outputSchema = {
  count: z.number().int().nonnegative(),
  cache_dir: z.string(),
  cache_gb: z.number().nonnegative(),
  physical_cache_gb: z.number().nonnegative(),
  video_cache_gb: z.number().nonnegative(),
  shared_cache_gb: z.number().nonnegative(),
  runtime_cache_gb: z.number().nonnegative(),
  index_cache_gb: z.number().nonnegative(),
  budget_gb: z.number().nonnegative(),
  low_water_gb: z.number().nonnegative(),
  cleanup_pending: z.number().int().nonnegative(),
  over_budget: z.boolean(),
  cache_warning: z.string().nullable(),
  videos: z.array(
    z.object({
      video_id: z.string(),
      title: z.string().nullable(),
      kind: z.string(),
      stage: z.string(),
      duration: z.string().nullable(),
      segments: z.number().int().nonnegative(),
      error_code: z.string().nullable(),
      disk_mb: z.number().nonnegative(),
      retained_mb: z.number().nonnegative(),
      last_accessed_at: z.string().nullable(),
      eviction_eligible: z.boolean(),
    }),
  ),
};

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
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

      const cache = deps.cache.snapshot(true);
      const usageById = new Map(cache.videos.map((video) => [video.videoId, video]));
      const videos = rows.map((r) => {
        const usage = usageById.get(r.id);
        return {
          video_id: r.id,
          title: r.title,
          kind: r.kind,
          stage: r.stage,
          duration: r.duration_s ? formatMs(r.duration_s * 1000) : null,
          segments: r.segments,
          error_code: r.error_code,
          disk_mb: Math.round(((usage?.retainedBytes ?? 0) / 1024 ** 2) * 10) / 10,
          retained_mb: Math.round(((usage?.retainedBytes ?? 0) / 1024 ** 2) * 10) / 10,
          last_accessed_at: usage?.lastAccessedAt ?? null,
          eviction_eligible: usage?.evictionEligible ?? false,
        };
      });

      return jsonResult({
        count: videos.length,
        cache_dir: deps.config.cacheDir,
        cache_gb: gb(cache.totalPhysicalBytes),
        physical_cache_gb: gb(cache.totalPhysicalBytes),
        video_cache_gb: gb(cache.videoBytes),
        shared_cache_gb: gb(cache.sharedBytes),
        runtime_cache_gb: gb(cache.sharedBytes),
        index_cache_gb: gb(cache.indexPhysicalBytes),
        budget_gb: gb(cache.budgetBytes),
        low_water_gb: gb(cache.lowWaterBytes),
        cleanup_pending: cache.cleanupPending,
        over_budget: cache.videoBytes > cache.budgetBytes,
        cache_warning: deps.cache.warning(),
        videos,
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}
