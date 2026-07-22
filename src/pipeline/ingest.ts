import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';
import type { VideoRef } from '../ids.js';
import { resolveRef } from '../ids.js';
import { RuntimeManager } from '../runtime/manager.js';
import { extractFrames } from './frames.js';
import { classifyFrame, ocrFrame } from './ocr.js';
import { mergeCues, parseVtt } from './vtt.js';
import { transcribeToVtt } from './whisper.js';
import {
  downloadAudio,
  downloadCaptions,
  downloadVideo,
  fetchYoutubeMetadata,
  pickCaptionTrack,
  probeLocalFile,
} from './ytdlp.js';

export interface IngestOptions {
  whisperFallback?: boolean;
  force?: boolean;
  /** Download the video and index keyframes+OCR (default true). */
  visual?: boolean;
  /** Embed transcript+screen text for semantic search (default true). */
  embed?: boolean;
}

export interface StartResult {
  videoId: string;
  stage: string;
  cached: boolean;
  alreadyRunning: boolean;
}

const MAX_CONCURRENT = 2;

/** Best-effort removal that never throws (cache cleanup must not crash jobs). */
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.error(`[video-context-mcp] cleanup of ${path} failed:`, err);
  }
}

export class IngestManager {
  private running = new Map<string, Promise<void>>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private runtime: RuntimeManager;

  constructor(
    private db: Database.Database,
    private config: Config,
  ) {
    this.runtime = new RuntimeManager(config);
  }

  /**
   * Resolve the ref, register the job, and kick the pipeline (not awaited).
   * Re-ingest is GENERATIONAL: existing derived rows (segments, chapters,
   * frames) are never deleted here — each pipeline stage atomically swaps in
   * its replacement only once the new data is ready, so a failed re-ingest
   * cannot destroy the last good index.
   */
  start(input: string, opts: IngestOptions = {}): StartResult {
    const ref = resolveRef(input);
    const row = this.db.prepare('SELECT stage FROM videos WHERE id = ?').get(ref.id) as
      | { stage: string }
      | undefined;

    if (this.running.has(ref.id)) {
      return {
        videoId: ref.id,
        stage: row?.stage ?? 'pending',
        cached: false,
        alreadyRunning: true,
      };
    }
    if (row?.stage === 'done' && !opts.force) {
      return { videoId: ref.id, stage: 'done', cached: true, alreadyRunning: false };
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO videos (id, kind, source_url, stage, opts_json)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(id) DO UPDATE SET
           stage = 'pending', error_code = NULL, error_detail = NULL,
           kind = excluded.kind, source_url = excluded.source_url,
           opts_json = excluded.opts_json`,
      )
      .run(ref.id, ref.kind, ref.source, JSON.stringify(opts));
    this.db
      .prepare(
        `INSERT INTO jobs (video_id, stage, progress_pct, progress_detail, updated_at)
         VALUES (?, 'pending', 0, NULL, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           stage = 'pending', progress_pct = 0, progress_detail = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(ref.id, now);

    const job = this.withSlot(() => this.run(ref, opts))
      .catch((err) => {
        // run() handles its own errors; this guards cleanup/reporting crashes
        // so a long-lived MCP process never sees an unhandled rejection.
        console.error(`[video-context-mcp] ingest job ${ref.id} crashed:`, err);
      })
      .finally(() => this.running.delete(ref.id));
    this.running.set(ref.id, job);
    return { videoId: ref.id, stage: 'pending', cached: false, alreadyRunning: false };
  }

  isRunning(videoId: string): boolean {
    return this.running.has(videoId);
  }

  /** Await all in-flight jobs (used by tests). */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /**
   * Atomically replace the transcript and reconcile caption metadata.
   * A whisper transcript clears stale caption fields from a previous ingest.
   * Public for tests.
   */
  applyTranscript(
    videoId: string,
    vtt: string,
    source: 'captions' | 'whisper',
    captionTrack: { lang: string; auto: boolean } | null,
  ): number {
    const segments = mergeCues(parseVtt(vtt));
    const insert = this.db.prepare(
      'INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM segments WHERE video_id = ?').run(videoId);
      for (const s of segments) insert.run(videoId, s.startMs, s.endMs, s.text, source);
      this.db
        .prepare('UPDATE videos SET captions_lang = ?, captions_auto = ? WHERE id = ?')
        .run(
          captionTrack?.lang ?? null,
          captionTrack ? (captionTrack.auto ? 1 : 0) : null,
          videoId,
        );
    })();
    return segments.length;
  }

  private applyChapters(videoId: string, chapters: { startMs: number; title: string }[]): void {
    const insert = this.db.prepare(
      'INSERT INTO chapters (video_id, start_ms, title) VALUES (?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chapters WHERE video_id = ?').run(videoId);
      for (const ch of chapters) insert.run(videoId, ch.startMs, ch.title);
    })();
  }

  private async withSlot(fn: () => Promise<void>): Promise<void> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private setStage(
    videoId: string,
    stage: string,
    pct: number,
    detail: string | null = null,
  ): void {
    this.db.prepare('UPDATE videos SET stage = ? WHERE id = ?').run(stage, videoId);
    this.setProgress(videoId, stage, pct, detail);
  }

  private setProgress(
    videoId: string,
    stage: string,
    pct: number,
    detail: string | null = null,
  ): void {
    this.db
      .prepare(
        'UPDATE jobs SET stage = ?, progress_pct = ?, progress_detail = ?, updated_at = ? WHERE video_id = ?',
      )
      .run(stage, pct, detail, new Date().toISOString(), videoId);
  }

  private async run(ref: VideoRef, opts: IngestOptions): Promise<void> {
    const videoDir = join(this.config.cacheDir, ref.id);
    const workDir = join(videoDir, 'tmp');
    try {
      this.setStage(ref.id, 'setup', 1, 'Resolving the managed runtime');
      const needed = new Set<'ytdlp' | 'ffmpeg' | 'ffprobe'>();
      if (ref.kind === 'youtube') needed.add('ytdlp');
      else needed.add('ffprobe');
      if (opts.visual !== false || opts.whisperFallback) needed.add('ffmpeg');
      const paths = await this.runtime.ensureTools([...needed], (pct, detail) =>
        this.setProgress(ref.id, 'setup', 1 + Math.round(pct * 0.04), detail),
      );
      this.runtime.applyResolved(paths);

      this.setStage(ref.id, 'metadata', 5);
      let captionsVtt: string | null = null;
      let captionTrack: { lang: string; auto: boolean } | null = null;

      if (ref.kind === 'youtube') {
        const meta = await fetchYoutubeMetadata(ref, this.config);
        this.db
          .prepare('UPDATE videos SET title = ?, channel = ?, duration_s = ? WHERE id = ?')
          .run(meta.title, meta.channel, meta.durationS, ref.id);
        this.applyChapters(ref.id, meta.chapters);

        this.setStage(ref.id, 'transcript', 25);
        captionTrack = pickCaptionTrack(meta);
        if (captionTrack) {
          mkdirSync(workDir, { recursive: true });
          captionsVtt = await downloadCaptions(ref, captionTrack, workDir, this.config);
        }
      } else {
        const probe = await probeLocalFile(ref.source, this.config);
        this.db
          .prepare('UPDATE videos SET title = ?, duration_s = ? WHERE id = ?')
          .run(basename(ref.source), probe.durationS, ref.id);
        this.setStage(ref.id, 'transcript', 25);
      }

      if (captionsVtt) {
        this.applyTranscript(ref.id, captionsVtt, 'captions', captionTrack);
      }

      // Sub-stage failures downgrade to warnings: whatever succeeded stays usable.
      const warnings: VcmError[] = [];
      const warn = (err: unknown, fallback: 'ASR_FAILED' | 'VISUAL_FAILED' | 'EMBED_FAILED') => {
        warnings.push(
          err instanceof VcmError
            ? err
            : new VcmError(fallback, err instanceof Error ? err.message : String(err)),
        );
      };

      if (!captionsVtt && opts.whisperFallback) {
        this.setStage(ref.id, 'whisper', 30);
        try {
          mkdirSync(workDir, { recursive: true });
          let mediaPath: string;
          if (ref.kind === 'youtube') {
            mediaPath = await downloadAudio(ref, workDir, this.config);
          } else {
            mediaPath = ref.source; // never deleted — the user's own file
          }
          const durationS = (
            this.db.prepare('SELECT duration_s AS d FROM videos WHERE id = ?').get(ref.id) as {
              d: number | null;
            }
          ).d;
          const vtt = await transcribeToVtt(
            mediaPath,
            workDir,
            this.config,
            (pct, note) =>
              this.setProgress(ref.id, 'whisper', 30 + Math.round(pct * 0.15), note ?? null),
            durationS,
          );
          this.applyTranscript(ref.id, vtt, 'whisper', null);
        } catch (err) {
          warn(err, 'ASR_FAILED');
        }
      }
      // If no new transcript was derived, any previous transcript is
      // intentionally left in place (the content did not change).

      if (opts.visual !== false) {
        try {
          await this.runVisual(ref, videoDir, workDir);
        } catch (err) {
          warn(err, 'VISUAL_FAILED');
        }
      }

      if (opts.embed !== false) {
        this.setStage(ref.id, 'embed', 96);
        try {
          // Dynamic import: the ONNX runtime stays unloaded unless needed.
          const { embedVideo } = await import('./embed.js');
          const count = await embedVideo(this.db, ref.id, this.config);
          this.db.prepare('UPDATE videos SET embedded_count = ? WHERE id = ?').run(count, ref.id);
        } catch (err) {
          warn(
            err instanceof VcmError
              ? err
              : new VcmError('EMBED_FAILED', err instanceof Error ? err.message : String(err)),
            'EMBED_FAILED',
          );
        }
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE videos SET stage = 'done', ingested_at = ?, error_code = ?, error_detail = ? WHERE id = ?",
        )
        .run(
          now,
          warnings[0]?.code ?? null,
          warnings.length > 0 ? warnings.map((w) => `[${w.code}] ${w.message}`).join(' | ') : null,
          ref.id,
        );
      this.setProgress(ref.id, 'done', 100);
    } catch (err) {
      // Hard failure: mark the error but leave all previously derived data
      // (from this run's completed swaps or an earlier ingest) untouched.
      const code = err instanceof VcmError ? err.code : 'YTDLP_FAILED';
      const detail = err instanceof Error ? err.message : String(err);
      this.db
        .prepare("UPDATE videos SET stage = 'error', error_code = ?, error_detail = ? WHERE id = ?")
        .run(code, detail, ref.id);
      this.setProgress(ref.id, 'error', 0);
    } finally {
      safeRm(workDir);
    }
  }

  /**
   * frames stage (download + scene-detect keyframes) then ocr stage.
   * Frame rows are committed as soon as extraction succeeds — OCR failure
   * (e.g. tesseract missing) degrades to unclassified frames, not zero frames.
   */
  private async runVisual(ref: VideoRef, videoDir: string, workDir: string): Promise<void> {
    this.setStage(ref.id, 'frames', 45);
    let videoPath: string;
    if (ref.kind === 'youtube') {
      mkdirSync(workDir, { recursive: true });
      videoPath = await downloadVideo(ref, workDir, this.config);
    } else {
      videoPath = ref.source; // never deleted — the user's own file
    }

    const duration = (
      this.db.prepare('SELECT duration_s AS d FROM videos WHERE id = ?').get(ref.id) as {
        d: number | null;
      }
    ).d;
    const frames = await extractFrames(videoPath, videoDir, this.config, duration);
    if (ref.kind === 'youtube') safeRm(videoPath); // source media gone ASAP

    // Swap in the new frame generation (files are already in place on disk).
    const insertFrame = this.db.prepare(
      'INSERT INTO frames (video_id, ts_ms, path, width, height, class) VALUES (?, ?, ?, ?, ?, NULL)',
    );
    const frameIds: number[] = [];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM frames WHERE video_id = ?').run(ref.id);
      for (const f of frames) {
        const res = insertFrame.run(ref.id, f.tsMs, f.path, f.width, f.height);
        frameIds.push(Number(res.lastInsertRowid));
      }
    })();

    this.setStage(ref.id, 'ocr', 65);
    const updateClass = this.db.prepare('UPDATE frames SET class = ? WHERE id = ?');
    const insertBlock = this.db.prepare(
      'INSERT INTO ocr_blocks (frame_id, text, bbox_json, conf) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const blocks = await ocrFrame(frame.path, this.config); // throws only on missing binary
      const cls = classifyFrame(blocks);
      this.db.transaction(() => {
        updateClass.run(cls, frameIds[i]!);
        for (const b of blocks) {
          insertBlock.run(frameIds[i]!, b.text, JSON.stringify(b.bbox), b.conf);
        }
      })();
      if (i % 5 === 4) {
        this.setProgress(ref.id, 'ocr', 65 + Math.round((30 * (i + 1)) / frames.length));
      }
    }
  }
}
