import { z } from 'zod';
import { toToolError } from '../errors.js';
import { type Deps, jsonResult } from './shared.js';

export const name = 'delete_video';

export const description =
  'Release a video after saving the resulting note elsewhere. Immediately removes it from ' +
  'transcript/search tools, then reclaims its frames and vectors. Safe to retry if physical ' +
  'cleanup is still pending. The YouTube source or local source file is never touched.';

export const inputSchema = {
  video_id: z.string().describe('The video_id to remove from the index'),
};

export function handler(deps: Deps) {
  return async (args: { video_id: string }) => {
    try {
      const result = await deps.cache.releaseVideo(args.video_id);
      return jsonResult({
        deleted: result.deleted,
        title: result.title,
        cleanup_pending: result.cleanupPending,
        already_released: result.alreadyReleased,
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}
