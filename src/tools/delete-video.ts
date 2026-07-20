import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { VcmError, toToolError } from '../errors.js';
import { type Deps, getVideoRow, jsonResult } from './shared.js';

export const name = 'delete_video';

export const description =
  'Remove a video from the local index: deletes its transcript segments, chapters, frames, and ' +
  'cached files on disk. The source video on YouTube (or the local file) is not touched.';

export const inputSchema = {
  video_id: z.string().describe('The video_id to remove from the index'),
};

export function handler(deps: Deps) {
  return async (args: { video_id: string }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      // Filesystem first: if this fails, the row survives and the call can be
      // retried — the reverse order would strand an unmanageable orphan dir.
      try {
        rmSync(join(deps.config.cacheDir, row.id), { recursive: true, force: true });
      } catch (err) {
        throw new VcmError(
          'STAGE_NOT_READY',
          `Could not delete cached files for ${row.id} (${err instanceof Error ? err.message.slice(0, 200) : err}). The index entry was kept — fix permissions and retry.`,
        );
      }
      deps.db.prepare('DELETE FROM videos WHERE id = ?').run(row.id);
      return jsonResult({ deleted: row.id, title: row.title });
    } catch (err) {
      return toToolError(err);
    }
  };
}
