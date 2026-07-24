import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type ToolchainMode = 'managed' | 'system';
export type OcrBackend = 'auto' | 'native' | 'wasm';
export type AsrBackend = 'auto' | 'native' | 'transformers';

export type BinaryName = 'ytdlp' | 'ffmpeg' | 'ffprobe' | 'tesseract' | 'whisper';

export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_EMBED_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';

export interface Config {
  cacheDir: string;
  cookiesFile?: string;
  maxCacheGb: number;
  toolchainMode: ToolchainMode;
  ytdlpBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  tesseractBin: string;
  whisperBin: string;
  /** Explicit VCM_*_BIN values. Managed resolution never replaces these. */
  binaryOverrides: Partial<Record<BinaryName, string>>;
  ocrBackend: OcrBackend;
  asrBackend: AsrBackend;
  /** Path to a ggml whisper model; unset = auto-download base.en to the cache. */
  whisperModel?: string;
  /** Transformers.js model used by the self-contained ASR backend. */
  asrModel: string;
  asrRevision: string;
  /** HF model id for dense embeddings (Transformers.js/ONNX). */
  embedModel: string;
  embedRevision: string;
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

function choice<T extends string>(
  name: string,
  raw: string | undefined,
  values: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) return fallback;
  if ((values as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of ${values.join(', ')}, got: ${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawCache = env.VCM_CACHE_DIR
    ? expandHome(env.VCM_CACHE_DIR)
    : join(homedir(), '.cache', 'video-context-mcp');
  if (!isAbsolute(rawCache)) {
    throw new Error(`VCM_CACHE_DIR must be an absolute path, got: ${rawCache}`);
  }
  const binaryOverrides: Partial<Record<BinaryName, string>> = {};
  if (env.VCM_YTDLP_BIN) binaryOverrides.ytdlp = expandHome(env.VCM_YTDLP_BIN);
  if (env.VCM_FFMPEG_BIN) binaryOverrides.ffmpeg = expandHome(env.VCM_FFMPEG_BIN);
  if (env.VCM_FFPROBE_BIN) binaryOverrides.ffprobe = expandHome(env.VCM_FFPROBE_BIN);
  if (env.VCM_TESSERACT_BIN) binaryOverrides.tesseract = expandHome(env.VCM_TESSERACT_BIN);
  if (env.VCM_WHISPER_BIN) binaryOverrides.whisper = expandHome(env.VCM_WHISPER_BIN);

  const asrModel = env.VCM_ASR_MODEL ?? 'Xenova/whisper-base.en';
  const embedModel = env.VCM_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  return {
    cacheDir: rawCache,
    cookiesFile: env.YTDLP_COOKIES_FILE ? expandHome(env.YTDLP_COOKIES_FILE) : undefined,
    maxCacheGb: num(env.VCM_MAX_CACHE_GB, 20),
    toolchainMode: choice(
      'VCM_TOOLCHAIN_MODE',
      env.VCM_TOOLCHAIN_MODE,
      ['managed', 'system'],
      'managed',
    ),
    ytdlpBin: binaryOverrides.ytdlp ?? 'yt-dlp',
    ffmpegBin: binaryOverrides.ffmpeg ?? 'ffmpeg',
    ffprobeBin: binaryOverrides.ffprobe ?? 'ffprobe',
    tesseractBin: binaryOverrides.tesseract ?? 'tesseract',
    whisperBin: binaryOverrides.whisper ?? 'whisper-cli',
    binaryOverrides,
    ocrBackend: choice('VCM_OCR_BACKEND', env.VCM_OCR_BACKEND, ['auto', 'native', 'wasm'], 'auto'),
    asrBackend: choice(
      'VCM_ASR_BACKEND',
      env.VCM_ASR_BACKEND,
      ['auto', 'native', 'transformers'],
      'auto',
    ),
    whisperModel: env.VCM_WHISPER_MODEL ? expandHome(env.VCM_WHISPER_MODEL) : undefined,
    asrModel,
    asrRevision:
      env.VCM_ASR_REVISION ??
      (asrModel === 'Xenova/whisper-base.en' ? '95bf40a508535962c6483ead40270b2e32267508' : 'main'),
    embedModel,
    embedRevision:
      env.VCM_EMBED_REVISION ??
      (embedModel === DEFAULT_EMBED_MODEL ? DEFAULT_EMBED_REVISION : 'main'),
    maxVideoHeight: num(env.VCM_MAX_VIDEO_HEIGHT, 720),
    sceneThreshold: num(env.VCM_SCENE_THRESHOLD, 0.3),
    minFrameGapS: num(env.VCM_MIN_FRAME_GAP_S, 10),
    maxFrames: num(env.VCM_MAX_FRAMES, 500),
  };
}
