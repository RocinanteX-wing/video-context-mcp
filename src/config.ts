import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface Config {
  cacheDir: string;
  cookiesFile?: string;
  maxCacheGb: number;
  ytdlpBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  tesseractBin: string;
  /** Max height of the video stream downloaded for frame extraction. */
  maxVideoHeight: number;
  /** ffmpeg scene-change score threshold (0..1) for keyframe selection. */
  sceneThreshold: number;
  /** Minimum seconds between kept keyframes (rate cap for busy videos). */
  minFrameGapS: number;
  /** Hard cap on keyframes stored per video. */
  maxFrames: number;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? Number.NaN);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawCache = env.VCM_CACHE_DIR
    ? expandHome(env.VCM_CACHE_DIR)
    : join(homedir(), '.cache', 'video-context-mcp');
  if (!isAbsolute(rawCache)) {
    throw new Error(`VCM_CACHE_DIR must be an absolute path, got: ${rawCache}`);
  }
  return {
    cacheDir: rawCache,
    cookiesFile: env.YTDLP_COOKIES_FILE ? expandHome(env.YTDLP_COOKIES_FILE) : undefined,
    maxCacheGb: num(env.VCM_MAX_CACHE_GB, 20),
    ytdlpBin: env.VCM_YTDLP_BIN ?? 'yt-dlp',
    ffmpegBin: env.VCM_FFMPEG_BIN ?? 'ffmpeg',
    ffprobeBin: env.VCM_FFPROBE_BIN ?? 'ffprobe',
    tesseractBin: env.VCM_TESSERACT_BIN ?? 'tesseract',
    maxVideoHeight: num(env.VCM_MAX_VIDEO_HEIGHT, 720),
    sceneThreshold: num(env.VCM_SCENE_THRESHOLD, 0.3),
    minFrameGapS: num(env.VCM_MIN_FRAME_GAP_S, 10),
    maxFrames: num(env.VCM_MAX_FRAMES, 500),
  };
}
