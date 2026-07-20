import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { toToolError } from '../errors.js';
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
      deps.db.prepare('DELETE FROM videos WHERE id = ?').run(row.id);
      rmSync(join(deps.config.cacheDir, row.id), { recursive: true, force: true });
      return jsonResult({ deleted: row.id, title: row.title });
    } catch (err) {
      return toToolError(err);
    }
  };
}
