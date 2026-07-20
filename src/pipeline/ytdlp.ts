import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { VcmError, classifyYtdlpFailure } from '../errors.js';
import type { VideoRef } from '../ids.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface ChapterInfo {
  startMs: number;
  title: string;
}

export interface CaptionTrack {
  lang: string;
  auto: boolean;
}

export interface VideoMetadata {
  title: string;
  channel: string | null;
  durationS: number | null;
  chapters: ChapterInfo[];
  manualCaptionLangs: string[];
  autoCaptionLangs: string[];
}

async function runYtdlp(args: string[], config: Config): Promise<string> {
  const fullArgs = [...args];
  if (config.cookiesFile) fullArgs.unshift('--cookies', config.cookiesFile);
  try {
    const { stdout } = await execFileAsync(config.ytdlpBin, fullArgs, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw classifyYtdlpFailure(e.stderr ?? e.message ?? '', Boolean(config.cookiesFile), e);
  }
}

export async function fetchYoutubeMetadata(ref: VideoRef, config: Config): Promise<VideoMetadata> {
  const stdout = await runYtdlp(['-J', '--no-warnings', '--skip-download', ref.source], config);
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new VcmError('YTDLP_FAILED', 'yt-dlp returned unparseable metadata JSON.');
  }
  const chaptersRaw = Array.isArray(info.chapters)
    ? (info.chapters as { start_time?: number; title?: string }[])
    : [];
  return {
    title: typeof info.title === 'string' ? info.title : ref.id,
    channel: typeof info.channel === 'string' ? info.channel : null,
    durationS: typeof info.duration === 'number' ? info.duration : null,
    chapters: chaptersRaw
      .filter((c) => typeof c.start_time === 'number' && typeof c.title === 'string')
      .map((c) => ({
        startMs: Math.round((c.start_time as number) * 1000),
        title: c.title as string,
      })),
    manualCaptionLangs: Object.keys((info.subtitles as object) ?? {}),
    autoCaptionLangs: Object.keys((info.automatic_captions as object) ?? {}),
  };
}

/** Prefer manual English > any manual > auto English > any auto. */
export function pickCaptionTrack(meta: VideoMetadata): CaptionTrack | null {
  const pickLang = (langs: string[]): string | undefined =>
    langs.find((l) => l === 'en') ?? langs.find((l) => l.startsWith('en')) ?? langs[0];

  // yt-dlp lists non-downloadable "live_chat" as a subtitle track; exclude it.
  const manual = meta.manualCaptionLangs.filter((l) => l !== 'live_chat');
  const manualLang = pickLang(manual);
  if (manualLang) return { lang: manualLang, auto: false };
  const autoLang = pickLang(meta.autoCaptionLangs);
  if (autoLang) return { lang: autoLang, auto: true };
  return null;
}

/** Download one caption track as VTT text. */
export async function downloadCaptions(
  ref: VideoRef,
  track: CaptionTrack,
  workDir: string,
  config: Config,
): Promise<string> {
  await runYtdlp(
    [
      '--skip-download',
      '--no-warnings',
      track.auto ? '--write-auto-subs' : '--write-subs',
      '--sub-langs',
      track.lang,
      '--sub-format',
      'vtt/best',
      '--convert-subs',
      'vtt',
      '-P',
      workDir,
      '-o',
      '%(id)s.%(ext)s',
      ref.source,
    ],
    config,
  );
  const expected = join(workDir, `${ref.id}.${track.lang}.vtt`);
  try {
    return readFileSync(expected, 'utf-8');
  } catch {
    // Fall back to any .vtt yt-dlp produced (lang tag variants like en-orig).
    const vtt = readdirSync(workDir).find((f) => f.endsWith('.vtt'));
    if (vtt) return readFileSync(join(workDir, vtt), 'utf-8');
    throw new VcmError(
      'NO_CAPTIONS',
      `Caption track "${track.lang}" was advertised but could not be downloaded.`,
    );
  }
}

/** Duration (and little else) for local files, via ffprobe. */
export async function probeLocalFile(
  absPath: string,
  config: Config,
): Promise<{ durationS: number | null }> {
  try {
    const { stdout } = await execFileAsync(
      config.ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_format', absPath],
      { maxBuffer: MAX_BUFFER },
    );
    const info = JSON.parse(stdout) as { format?: { duration?: string } };
    const d = info.format?.duration ? Number(info.format.duration) : null;
    return { durationS: d && Number.isFinite(d) ? d : null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'ffprobe was not found on PATH. Install ffmpeg or set VCM_FFPROBE_BIN.',
      );
    }
    throw new VcmError('YTDLP_FAILED', `ffprobe failed on ${absPath}: ${e.message}`);
  }
}
