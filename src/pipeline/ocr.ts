/**
 * OCR via tesseract TSV output, grouped into line-level blocks with pixel
 * bounding boxes, plus a cheap text-density frame classifier (Phase 2 rule:
 * heuristics first — no bespoke vision model; a VLM label pass is a later,
 * optional enrichment).
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Worker } from 'tesseract.js';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

const MIN_WORD_CONF = 30;
const MIN_LINE_CONF = 40;
const nativeAvailability = new Map<string, Promise<boolean>>();
let wasmWorker: Promise<Worker> | null = null;
let wasmCacheDir = '';
let wasmQueue: Promise<void> = Promise.resolve();

export interface OcrBlock {
  text: string;
  /** Pixel bbox in the stored frame: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  conf: number;
}

export type FrameClass = 'code' | 'slide' | 'talking_head' | 'other';

/** Parse tesseract TSV (level 5 = word rows) into line-level blocks. */
export function parseTsv(tsv: string): OcrBlock[] {
  interface Word {
    left: number;
    top: number;
    width: number;
    height: number;
    conf: number;
    text: string;
  }
  const lines = new Map<string, Word[]>();
  for (const row of tsv.split('\n').slice(1)) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const conf = Number(cols[10]);
    const text = (cols[11] ?? '').trim();
    if (!text || !Number.isFinite(conf) || conf < MIN_WORD_CONF) continue;
    const key = `${cols[2]}:${cols[3]}:${cols[4]}`; // block:par:line
    const list = lines.get(key) ?? [];
    list.push({
      left: Number(cols[6]),
      top: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      conf,
      text,
    });
    lines.set(key, list);
  }

  const blocks: OcrBlock[] = [];
  for (const words of lines.values()) {
    const text = words.map((w) => w.text).join(' ');
    const conf = words.reduce((s, w) => s + w.conf, 0) / words.length;
    if (text.length < 2 || conf < MIN_LINE_CONF) continue;
    blocks.push({
      text,
      bbox: [
        Math.min(...words.map((w) => w.left)),
        Math.min(...words.map((w) => w.top)),
        Math.max(...words.map((w) => w.left + w.width)),
        Math.max(...words.map((w) => w.top + w.height)),
      ],
      conf: Math.round(conf),
    });
  }
  return blocks;
}

const CODE_SIGNALS =
  /[{};]|=>|::|<\/|\(\)|==|\bdef\b|\bconst\b|\blet\b|\bfn\b|\bimport\b|\breturn\b|\bfunction\b|\$\s|#include|\bclass\b/g;

/** Classify a frame from its OCR yield alone (cheap, deliberately rough). */
export function classifyFrame(blocks: OcrBlock[]): FrameClass {
  const text = blocks.map((b) => b.text).join('\n');
  if (text.length < 20) return 'talking_head';
  if (text.length < 80) return 'other';
  const codeHits = text.match(CODE_SIGNALS)?.length ?? 0;
  return codeHits >= 3 ? 'code' : 'slide';
}

async function nativeAvailable(binary: string): Promise<boolean> {
  let probe = nativeAvailability.get(binary);
  if (!probe) {
    probe = execFileAsync(binary, ['--version'], { timeout: 10_000, windowsHide: true })
      .then(() => true)
      .catch(() => false);
    nativeAvailability.set(binary, probe);
  }
  return probe;
}

async function ocrNative(imagePath: string, config: Config): Promise<OcrBlock[]> {
  try {
    const { stdout } = await execFileAsync(
      config.tesseractBin,
      [imagePath, 'stdout', '--psm', '3', 'tsv'],
      { maxBuffer: MAX_BUFFER, timeout: 120_000, killSignal: 'SIGKILL' },
    );
    return parseTsv(stdout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'tesseract was not found on PATH. Install tesseract or set VCM_TESSERACT_BIN.',
      );
    }
    // A single unreadable frame should not sink the whole visual stage.
    return [];
  }
}

async function getWasmWorker(config: Config): Promise<Worker> {
  const cacheDir = join(config.cacheDir, 'tesseract');
  if (wasmWorker && wasmCacheDir === cacheDir) return wasmWorker;
  if (wasmWorker) {
    const previous = await wasmWorker.catch(() => null);
    await previous?.terminate().catch(() => undefined);
  }
  mkdirSync(cacheDir, { recursive: true });
  wasmCacheDir = cacheDir;
  wasmWorker = import('tesseract.js')
    .then(({ createWorker, OEM }) =>
      createWorker('eng', OEM.LSTM_ONLY, {
        cachePath: cacheDir,
        logger: (message) => {
          if (message.status === 'recognizing text') return;
          console.error(
            `[video-context-mcp] tesseract.js: ${message.status} ${Math.round(message.progress * 100)}%`,
          );
        },
      }),
    )
    .catch((err) => {
      wasmWorker = null;
      throw new VcmError(
        'VISUAL_FAILED',
        `Could not initialize the self-contained OCR model (${err instanceof Error ? err.message.slice(0, 200) : err}). Check network access or run video-context-mcp setup --all.`,
      );
    });
  return wasmWorker;
}

async function ocrWasm(imagePath: string, config: Config): Promise<OcrBlock[]> {
  let resolveTurn: (() => void) | undefined;
  const previous = wasmQueue;
  wasmQueue = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  await previous;
  try {
    const worker = await getWasmWorker(config);
    const { data } = await worker.recognize(imagePath, {}, { blocks: true, text: false });
    const lines =
      data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ??
      [];
    return lines
      .filter((line) => line.text.trim().length >= 2 && line.confidence >= MIN_LINE_CONF)
      .map((line) => ({
        text: line.text.trim(),
        bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1],
        conf: Math.round(line.confidence),
      }));
  } catch (err) {
    if (err instanceof VcmError) throw err;
    throw new VcmError(
      'VISUAL_FAILED',
      `Self-contained OCR failed (${err instanceof Error ? err.message.slice(0, 200) : err}). Run video-context-mcp doctor or set VCM_TESSERACT_BIN.`,
    );
  } finally {
    resolveTurn?.();
  }
}

export async function warmOcr(config: Config, dispose = false): Promise<void> {
  const worker = await getWasmWorker(config);
  if (dispose) {
    await worker.terminate();
    wasmWorker = null;
    wasmCacheDir = '';
  }
}

/** Run the selected native or WASM OCR provider on one frame. */
export async function ocrFrame(imagePath: string, config: Config): Promise<OcrBlock[]> {
  if (config.ocrBackend === 'wasm') return ocrWasm(imagePath, config);
  if (config.ocrBackend === 'native') return ocrNative(imagePath, config);
  if (config.binaryOverrides.tesseract) return ocrNative(imagePath, config);
  return (await nativeAvailable(config.tesseractBin))
    ? ocrNative(imagePath, config)
    : ocrWasm(imagePath, config);
}
