import { z } from 'zod';
import { toToolError } from '../errors.js';
import { type Deps, jsonResult } from './shared.js';

export const name = 'ingest_video';

export const description =
  'Start (or reuse) ingestion of a video into the local index. Accepts a YouTube URL, a bare ' +
  '11-character YouTube video ID, or an absolute path to a local video file. Returns immediately ' +
  'with a video_id and job stage — ingestion runs in the background (typically seconds for ' +
  'metadata+captions). Poll get_ingest_status until stage=done, then use get_video_timeline, ' +
  'get_transcript, and search_videos. Re-ingest a failed or stale video with force=true.';

export const inputSchema = {
  url_or_path: z.string().describe('YouTube URL, YouTube video ID, or local video file path'),
  whisper_fallback: z
    .boolean()
    .optional()
    .describe(
      'Reserved: transcribe with local whisper when the video has no captions (not yet implemented)',
    ),
  force: z.boolean().optional().describe('Re-ingest even if the video is already indexed'),
};

export function handler(deps: Deps) {
  return async (args: { url_or_path: string; whisper_fallback?: boolean; force?: boolean }) => {
    try {
      const res = deps.ingest.start(args.url_or_path, {
        whisperFallback: args.whisper_fallback,
        force: args.force,
      });
      return jsonResult({
        video_id: res.videoId,
        stage: res.stage,
        cached: res.cached,
        already_running: res.alreadyRunning,
        next: res.cached
          ? 'Video is already indexed. Use get_video_timeline / get_transcript / search_videos.'
          : 'Ingestion started in the background. Poll get_ingest_status until stage=done.',
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}
