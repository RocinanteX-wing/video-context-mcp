import { z } from 'zod';
import { toToolError } from '../errors.js';
import { type Deps, jsonResult } from './shared.js';

export const name = 'prune_cache';

export const description =
  'Preview or apply quota-based LRU cleanup of retained videos. Whole videos are released oldest ' +
  'first; running ingests and the newest active working set are protected. Defaults to dry-run. ' +
  'Shared runtimes/models are reported separately and never removed.';

export const inputSchema = {
  dry_run: z
    .boolean()
    .optional()
    .describe('Preview candidates without deleting anything (default true)'),
};

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 1000) / 1000;
}

export function handler(deps: Deps) {
  return async (args: { dry_run?: boolean }) => {
    try {
      const report = await deps.cache.maintain({
        reason: 'manual',
        protectIds: deps.ingest.runningIds(),
        dryRun: args.dry_run ?? true,
      });
      const summarize = (video: (typeof report.candidates)[number]) => ({
        video_id: video.videoId,
        title: video.title,
        last_accessed_at: video.lastAccessedAt,
        retained_mb: Math.round((video.retainedBytes / 1024 ** 2) * 10) / 10,
      });
      return jsonResult({
        dry_run: report.dryRun,
        budget_gb: gb(report.budgetBytes),
        low_water_gb: gb(report.lowWaterBytes),
        before_gb: gb(report.beforeBytes),
        after_gb: gb(report.afterBytes),
        candidate_count: report.candidates.length,
        candidates: report.candidates.slice(0, 50).map(summarize),
        released_count: report.released.length,
        released: report.released.slice(0, 50).map(summarize),
        cleanup_pending: report.cleanupPending,
        unresolved_overage_gb: gb(report.unresolvedOverageBytes),
        next:
          report.dryRun && report.candidates.length > 0
            ? 'Call prune_cache with dry_run=false to release these videos.'
            : null,
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}
