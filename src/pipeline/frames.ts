/**
 * Keyframe extraction: ffmpeg scene-change detection with showinfo timestamp
 * parsing, a minimum-gap rate cap, and ≤1280px JPEG storage named by
 * millisecond timestamp (frames/000012345.jpg).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const STORE_WIDTH = 1280;

export interface ExtractedFrame {
  tsMs: number;
  path: string;
  width: number;
  height: number;
}

export interface ShowinfoFrame {
  index: number;
  tsMs: number;
  width: number;
  height: number;
}

const SHOWINFO_RE = /Parsed_showinfo.*?\sn:\s*(\d+)\s.*?pts_time:([\d.]+).*?\ss:(\d+)x(\d+)/;

/** Parse ffmpeg showinfo stderr lines into per-frame index/timestamp/dims. */
export function parseShowinfo(stderr: string): ShowinfoFrame[] {
  const frames: ShowinfoFrame[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(SHOWINFO_RE);
    if (m) {
      frames.push({
        index: Number(m[1]),
        tsMs: Math.round(Number(m[2]) * 1000),
        width: Number(m[3]),
        height: Number(m[4]),
      });
    }
  }
  return frames;
}

/**
 * Enforce the minimum gap between kept frames and the total cap.
 * Returns the kept subset (input order preserved).
 */
export function filterByGap<T extends { tsMs: number }>(
  frames: T[],
  minGapMs: number,
  maxFrames: number,
): T[] {
  const kept: T[] = [];
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const f of frames) {
    if (f.tsMs - lastMs >= minGapMs) {
      kept.push(f);
      lastMs = f.tsMs;
      if (kept.length >= maxFrames) break;
    }
  }
  return kept;
}

async function runFfmpeg(args: string[], config: Config): Promise<string> {
  try {
    const { stderr } = await execFileAsync(config.ffmpegBin, args, { maxBuffer: MAX_BUFFER });
    return stderr;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'ffmpeg was not found on PATH. Install ffmpeg or set VCM_FFMPEG_BIN.',
      );
    }
    const tail = (e.stderr ?? e.message ?? '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | ')
      .slice(0, 400);
    throw new VcmError('VISUAL_FAILED', `ffmpeg frame extraction failed: ${tail}`);
  }
}

async function extractPass(
  videoPath: string,
  outDir: string,
  vf: string,
  config: Config,
): Promise<ShowinfoFrame[]> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    videoPath,
    '-vf',
    vf,
    '-fps_mode',
    'vfr',
    '-q:v',
    '4',
    join(outDir, 'raw-%06d.jpg'),
  ];
  try {
    return parseShowinfo(await runFfmpeg(args, config));
  } catch (err) {
    // ffmpeg exits non-zero when a select filter matches no frames at all
    // ("Output file is empty, nothing was encoded"). That is a valid outcome
    // (static video) — signal it as zero frames so the caller can fall back.
    if (err instanceof VcmError && /nothing was encoded|Output file is empty/i.test(err.message)) {
      return [];
    }
    throw err;
  }
}

/**
 * Extract keyframes from a video file into `<videoDir>/frames/`.
 * Scene-change detection first; if the video is too static to trigger any
 * scene cuts, falls back to one frame per 60s.
 */
export async function extractFrames(
  videoPath: string,
  videoDir: string,
  config: Config,
): Promise<ExtractedFrame[]> {
  const framesDir = join(videoDir, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const scale = `scale='min(${STORE_WIDTH},iw)':-2`;
  let info = await extractPass(
    videoPath,
    framesDir,
    `select='gt(scene,${config.sceneThreshold})',${scale},showinfo`,
    config,
  );

  if (info.length === 0) {
    // Static video (single slide, fixed camera): sample once a minute instead.
    for (const f of readdirSync(framesDir)) rmSync(join(framesDir, f), { force: true });
    info = await extractPass(videoPath, framesDir, `fps=1/60,${scale},showinfo`, config);
  }

  const kept = filterByGap(info, config.minFrameGapS * 1000, config.maxFrames);
  const keptIndices = new Set(kept.map((f) => f.index));

  // Output files raw-000001.jpg… are 1-indexed in showinfo order (n: 0-based).
  const results: ExtractedFrame[] = [];
  for (const f of info) {
    const rawPath = join(framesDir, `raw-${String(f.index + 1).padStart(6, '0')}.jpg`);
    if (keptIndices.has(f.index)) {
      const finalPath = join(framesDir, `${String(f.tsMs).padStart(9, '0')}.jpg`);
      renameSync(rawPath, finalPath);
      results.push({ tsMs: f.tsMs, path: finalPath, width: f.width, height: f.height });
    } else {
      rmSync(rawPath, { force: true });
    }
  }
  return results;
}

/** Re-encode a stored frame to ≤maxWidth for compact MCP image payloads. */
export async function reencodeFrame(
  srcPath: string,
  destPath: string,
  maxWidth: number,
  config: Config,
): Promise<void> {
  await runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      srcPath,
      '-vf',
      `scale='min(${maxWidth},iw)':-2`,
      '-q:v',
      '5',
      destPath,
    ],
    config,
  );
}

/** Crop a normalized bbox out of a stored frame, upscaling small crops ≤2×. */
export async function cropFrame(
  srcPath: string,
  destPath: string,
  frameW: number,
  frameH: number,
  bbox: [number, number, number, number],
  config: Config,
): Promise<void> {
  const [x0, y0, x1, y1] = bbox;
  const x = Math.round(x0 * frameW);
  const y = Math.round(y0 * frameH);
  const w = Math.max(8, Math.round((x1 - x0) * frameW));
  const h = Math.max(8, Math.round((y1 - y0) * frameH));
  await runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      srcPath,
      '-vf',
      `crop=${w}:${h}:${x}:${y},scale='min(1024,iw*2)':-2`,
      '-q:v',
      '4',
      destPath,
    ],
    config,
  );
}
