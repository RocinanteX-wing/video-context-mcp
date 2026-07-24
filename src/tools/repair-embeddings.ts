import { z } from 'zod';
import { toToolError } from '../errors.js';
import { type Deps, jsonResult } from './shared.js';

export const name = 'repair_embeddings';

export const description =
  'Rebuild semantic vectors for one completed video from its stored transcript and OCR text. ' +
  'Returns immediately and never re-downloads metadata, captions, audio, video, or frames. Use ' +
  'after an EMBED_FAILED warning or force=true after changing the embedding model; poll ' +
  'get_ingest_status until stage=done. Full-text search remains available if repair fails.';

export const inputSchema = {
  video_id: z.string().describe('The completed video_id to repair'),
  force: z
    .boolean()
    .optional()
    .describe('Rebuild even when the video already records healthy embeddings'),
};

export function handler(deps: Deps) {
  return async (args: { video_id: string; force?: boolean }) => {
    try {
      const result = deps.ingest.repairEmbeddings(args.video_id, args.force ?? false);
      return jsonResult({
        video_id: result.videoId,
        stage: result.stage,
        cached: result.cached,
        already_running: result.alreadyRunning,
        next: result.cached
          ? 'Embeddings are already healthy. Use force=true only when the configured embedding model changed.'
          : result.alreadyRunning
            ? 'A job for this video is already running. Poll get_ingest_status until stage=done.'
            : 'Embedding repair started from stored text. Poll get_ingest_status until stage=done.',
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}
