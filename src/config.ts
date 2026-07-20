import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface Config {
  cacheDir: string;
  cookiesFile?: string;
  maxCacheGb: number;
  ytdlpBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawCache = env.VCM_CACHE_DIR
    ? expandHome(env.VCM_CACHE_DIR)
    : join(homedir(), '.cache', 'video-context-mcp');
  if (!isAbsolute(rawCache)) {
    throw new Error(`VCM_CACHE_DIR must be an absolute path, got: ${rawCache}`);
  }
  const maxCacheGb = Number(env.VCM_MAX_CACHE_GB ?? 20);
  return {
    cacheDir: rawCache,
    cookiesFile: env.YTDLP_COOKIES_FILE ? expandHome(env.YTDLP_COOKIES_FILE) : undefined,
    maxCacheGb: Number.isFinite(maxCacheGb) && maxCacheGb > 0 ? maxCacheGb : 20,
    ytdlpBin: env.VCM_YTDLP_BIN ?? 'yt-dlp',
    ffmpegBin: env.VCM_FFMPEG_BIN ?? 'ffmpeg',
    ffprobeBin: env.VCM_FFPROBE_BIN ?? 'ffprobe',
  };
}
