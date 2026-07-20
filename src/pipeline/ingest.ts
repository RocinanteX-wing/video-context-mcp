import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';
import type { VideoRef } from '../ids.js';
import { resolveRef } from '../ids.js';
import { mergeCues, parseVtt } from './vtt.js';
import {
  downloadCaptions,
  fetchYoutubeMetadata,
  pickCaptionTrack,
  probeLocalFile,
} from './ytdlp.js';

export interface IngestOptions {
  whisperFallback?: boolean;
  force?: boolean;
}

export interface StartResult {
  videoId: string;
  stage: string;
  cached: boolean;
  alreadyRunning: boolean;
}

const MAX_CONCURRENT = 2;

export class IngestManager {
  private running = new Map<string, Promise<void>>();
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private db: Database.Database,
    private config: Config,
  ) {}

  /** Resolve the ref, register the job, and kick the pipeline (not awaited). */
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
    this.db.transaction(() => {
      // force / retry: wipe derived rows so re-ingest starts clean.
      this.db.prepare('DELETE FROM segments WHERE video_id = ?').run(ref.id);
      this.db.prepare('DELETE FROM chapters WHERE video_id = ?').run(ref.id);
      this.db
        .prepare(
          `INSERT INTO videos (id, kind, source_url, stage, opts_json)
           VALUES (?, ?, ?, 'pending', ?)
           ON CONFLICT(id) DO UPDATE SET
             stage = 'pending', error_code = NULL, error_detail = NULL, opts_json = excluded.opts_json`,
        )
        .run(ref.id, ref.kind, ref.source, JSON.stringify(opts));
      this.db
        .prepare(
          `INSERT INTO jobs (video_id, stage, progress_pct, updated_at) VALUES (?, 'pending', 0, ?)
           ON CONFLICT(video_id) DO UPDATE SET stage = 'pending', progress_pct = 0, updated_at = excluded.updated_at`,
        )
        .run(ref.id, now);
    })();

    const job = this.withSlot(() => this.run(ref)).finally(() => this.running.delete(ref.id));
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

  private setStage(videoId: string, stage: string, pct: number): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE videos SET stage = ? WHERE id = ?').run(stage, videoId);
    this.db
      .prepare('UPDATE jobs SET stage = ?, progress_pct = ?, updated_at = ? WHERE video_id = ?')
      .run(stage, pct, now, videoId);
  }

  private async run(ref: VideoRef): Promise<void> {
    const workDir = join(this.config.cacheDir, ref.id, 'tmp');
    try {
      this.setStage(ref.id, 'metadata', 5);
      let captionsVtt: string | null = null;
      let captionTrack: { lang: string; auto: boolean } | null = null;

      if (ref.kind === 'youtube') {
        const meta = await fetchYoutubeMetadata(ref, this.config);
        this.db
          .prepare('UPDATE videos SET title = ?, channel = ?, duration_s = ? WHERE id = ?')
          .run(meta.title, meta.channel, meta.durationS, ref.id);
        const insertChapter = this.db.prepare(
          'INSERT INTO chapters (video_id, start_ms, title) VALUES (?, ?, ?)',
        );
        this.db.transaction(() => {
          for (const ch of meta.chapters) insertChapter.run(ref.id, ch.startMs, ch.title);
        })();

        this.setStage(ref.id, 'transcript', 40);
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
        this.setStage(ref.id, 'transcript', 40);
        // Local files have no caption track; whisper fallback lands in Phase 3.
      }

      if (captionsVtt) {
        const segments = mergeCues(parseVtt(captionsVtt));
        const insert = this.db.prepare(
          'INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, ?, ?, ?, ?)',
        );
        this.db.transaction(() => {
          for (const s of segments) insert.run(ref.id, s.startMs, s.endMs, s.text, 'captions');
        })();
        this.db
          .prepare('UPDATE videos SET captions_lang = ?, captions_auto = ? WHERE id = ?')
          .run(captionTrack!.lang, captionTrack!.auto ? 1 : 0, ref.id);
      }

      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE videos SET stage = 'done', ingested_at = ? WHERE id = ?")
        .run(now, ref.id);
      this.db
        .prepare(
          "UPDATE jobs SET stage = 'done', progress_pct = 100, updated_at = ? WHERE video_id = ?",
        )
        .run(now, ref.id);
    } catch (err) {
      const code = err instanceof VcmError ? err.code : 'YTDLP_FAILED';
      const detail = err instanceof Error ? err.message : String(err);
      this.db
        .prepare("UPDATE videos SET stage = 'error', error_code = ?, error_detail = ? WHERE id = ?")
        .run(code, detail, ref.id);
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE jobs SET stage = 'error', updated_at = ? WHERE video_id = ?")
        .run(now, ref.id);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
