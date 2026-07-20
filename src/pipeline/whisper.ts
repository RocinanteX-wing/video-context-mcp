/**
 * Local ASR fallback via whisper.cpp (`whisper-cli`). Only invoked when a
 * video has no captions AND the ingest asked for whisper_fallback. Emits VTT
 * so the transcript flows through the same parser as YouTube captions.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = 'ggml-base.en.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;

export type ProgressFn = (pct: number, note?: string) => void;

/** whisper-cli `-pp` lines look like: "... progress =  15%". */
export function parseWhisperProgress(line: string): number | null {
  const m = line.match(/progress\s*=\s*(\d+)%/);
  return m ? Number(m[1]) : null;
}

/** English-only ggml models ("…base.en.bin") must not get `-l auto`. */
export function isEnglishOnlyModel(modelPath: string): boolean {
  return /\.en\b/.test(basename(modelPath));
}

/** Resolve the model path, auto-downloading the default model on first use. */
export async function ensureWhisperModel(config: Config, onProgress?: ProgressFn): Promise<string> {
  if (config.whisperModel) {
    if (!existsSync(config.whisperModel)) {
      throw new VcmError(
        'ASR_FAILED',
        `VCM_WHISPER_MODEL points to a missing file: ${config.whisperModel}. Download a ggml model (e.g. from huggingface.co/ggerganov/whisper.cpp) or unset the variable to auto-download base.en.`,
      );
    }
    return config.whisperModel;
  }
  const dest = join(config.cacheDir, 'models', DEFAULT_MODEL);
  if (existsSync(dest)) return dest;

  onProgress?.(0, `downloading whisper model ${DEFAULT_MODEL} (~148 MB, one-time)`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tmp),
    );
    renameSync(tmp, dest);
    return dest;
  } catch (err) {
    throw new VcmError(
      'NETWORK',
      `Failed to download the whisper model (${err instanceof Error ? err.message : err}). ` +
        `Download it manually to ${dest} (source: ${MODEL_URL}) or set VCM_WHISPER_MODEL.`,
    );
  }
}

/** Extract/convert any media file to the 16 kHz mono WAV whisper.cpp needs. */
export async function toWav16k(mediaPath: string, wavPath: string, config: Config): Promise<void> {
  try {
    await execFileAsync(
      config.ffmpegBin,
      [
        '-hide_banner',
        '-nostats',
        '-y',
        '-i',
        mediaPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
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
      .slice(-2)
      .join(' | ')
      .slice(0, 300);
    throw new VcmError('ASR_FAILED', `ffmpeg audio extraction failed: ${tail}`);
  }
}

function runWhisperCli(
  modelPath: string,
  wavPath: string,
  outBase: string,
  config: Config,
  onProgress?: ProgressFn,
): Promise<void> {
  const args = ['-m', modelPath, '-f', wavPath, '-ovtt', '-of', outBase, '-pp', '-np'];
  if (!isEnglishOnlyModel(modelPath)) args.push('-l', 'auto');

  return new Promise((resolve, reject) => {
    const child = spawn(config.whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      tail = (tail + s).slice(-2000);
      for (const line of s.split('\n')) {
        const pct = parseWhisperProgress(line);
        if (pct !== null) onProgress?.(pct);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new VcmError(
              'BINARY_MISSING',
              'whisper-cli was not found on PATH. Install whisper.cpp or set VCM_WHISPER_BIN.',
            )
          : new VcmError('ASR_FAILED', `whisper-cli failed to start: ${err.message}`),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const last = tail.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
        reject(new VcmError('ASR_FAILED', `whisper-cli exited with code ${code}: ${last}`));
      }
    });
  });
}

/**
 * Full ASR path: model → 16k WAV → whisper-cli → VTT text.
 * onProgress receives 0..100 within the transcription.
 */
export async function transcribeToVtt(
  mediaPath: string,
  workDir: string,
  config: Config,
  onProgress?: ProgressFn,
): Promise<string> {
  const modelPath = await ensureWhisperModel(config, onProgress);
  const wavPath = join(workDir, 'audio16k.wav');
  await toWav16k(mediaPath, wavPath, config);
  const outBase = join(workDir, 'whisper-out');
  await runWhisperCli(modelPath, wavPath, outBase, config, onProgress);
  try {
    return readFileSync(`${outBase}.vtt`, 'utf-8');
  } catch {
    throw new VcmError('ASR_FAILED', 'whisper-cli finished but produced no VTT output.');
  }
}
