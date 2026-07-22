import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { VcmError } from './errors.js';

const LOW_WATER_RATIO = 0.9;
const TOUCH_THROTTLE_MS = 60_000;
const GC_LEASE_MS = 5 * 60_000;
const GC_BATCH = 50;
const EVICTION_GRACE_MS = 5 * 60_000;
const TERMINAL_STAGES = new Set(['done', 'error']);

export interface CacheVideoUsage {
  videoId: string;
  title: string | null;
  stage: string;
  lastAccessedAt: string | null;
  retainedBytes: number;
  evictionEligible: boolean;
}

export interface CacheSnapshot {
  budgetBytes: number;
  lowWaterBytes: number;
  videoBytes: number;
  totalPhysicalBytes: number;
  sharedBytes: number;
  indexPhysicalBytes: number;
  cleanupPending: number;
  videos: CacheVideoUsage[];
}

export interface ReleaseResult {
  deleted: string;
  title: string | null;
  cleanupPending: boolean;
  alreadyReleased: boolean;
}

export interface MaintenanceReport {
  reason: 'startup' | 'pre_ingest' | 'post_ingest' | 'manual';
  dryRun: boolean;
  budgetBytes: number;
  lowWaterBytes: number;
  beforeBytes: number;
  afterBytes: number;
  candidates: CacheVideoUsage[];
  released: CacheVideoUsage[];
  cleanupPending: number;
  unresolvedOverageBytes: number;
}

export interface CacheCleanupOps {
  removeVideoDir(path: string): Promise<void>;
  deleteVectors(videoId: string, config: Config): Promise<void>;
  optimizeVectors(config: Config): Promise<void>;
}

interface GcRow {
  video_id: string;
  files_pending: number;
  vectors_pending: number;
}

interface UsageRow {
  id: string;
  title: string | null;
  stage: string;
  last_accessed_at: string | null;
  ingested_at: string | null;
  retained_bytes: number;
}

function boundedDetail(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replaceAll(/\s+/g, ' ').slice(0, 300);
}

export function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      // A concurrent cleanup can remove an entry between readdir and stat.
    }
  }
  return total;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Owns the boundary between queryable video state and disposable cache data.
 * SQLite deletion is the logical commit; filesystem/Lance cleanup is retried
 * from cache_gc until physical reclamation succeeds.
 */
export class CacheManager {
  private readonly owner = `${process.pid}-${randomUUID()}`;
  private readonly touchedAt = new Map<string, number>();
  private maintenanceTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly cleanup: CacheCleanupOps = {
      removeVideoDir: (path) => rm(path, { recursive: true, force: true }),
      deleteVectors: async (videoId, config) => {
        const { deleteVideoVectors } = await import('./pipeline/embed.js');
        await deleteVideoVectors(videoId, config);
      },
      optimizeVectors: async (config) => {
        const { optimizeVectors } = await import('./pipeline/embed.js');
        await optimizeVectors(config);
      },
    },
  ) {}

  get budgetBytes(): number {
    return Math.floor(this.config.maxCacheGb * 1024 ** 3);
  }

  get lowWaterBytes(): number {
    return Math.floor(this.budgetBytes * LOW_WATER_RATIO);
  }

  hasPendingGc(videoId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM cache_gc WHERE video_id = ?').get(videoId));
  }

  touchVideo(videoId: string, force = false): void {
    const nowMs = Date.now();
    if (!force && nowMs - (this.touchedAt.get(videoId) ?? 0) < TOUCH_THROTTLE_MS) return;
    this.touchedAt.set(videoId, nowMs);
    this.db
      .prepare('UPDATE videos SET last_accessed_at = ? WHERE id = ?')
      .run(new Date(nowMs).toISOString(), videoId);
  }

  refreshVideoUsage(videoId: string, vectorBytes?: number): void {
    const assetBytes = dirSizeBytes(join(this.config.cacheDir, videoId));
    if (vectorBytes === undefined) {
      this.db.prepare('UPDATE videos SET asset_bytes = ? WHERE id = ?').run(assetBytes, videoId);
    } else {
      this.db
        .prepare('UPDATE videos SET asset_bytes = ?, vector_bytes = ? WHERE id = ?')
        .run(assetBytes, vectorBytes, videoId);
    }
  }

  private usageRows(): CacheVideoUsage[] {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.title, v.stage, v.last_accessed_at, v.ingested_at,
                COALESCE(v.asset_bytes, 0) + COALESCE(v.vector_bytes, 0)
                + COALESCE((SELECT SUM(length(CAST(s.text AS BLOB)))
                            FROM segments s WHERE s.video_id = v.id), 0)
                + COALESCE((SELECT SUM(length(CAST(c.title AS BLOB)))
                            FROM chapters c WHERE c.video_id = v.id), 0)
                + COALESCE((SELECT SUM(length(CAST(b.text AS BLOB)))
                            FROM ocr_blocks b JOIN frames f ON f.id = b.frame_id
                            WHERE f.video_id = v.id), 0) AS retained_bytes
         FROM videos v
         ORDER BY COALESCE(v.last_accessed_at, v.ingested_at, '1970-01-01T00:00:00.000Z'), v.id`,
      )
      .all() as UsageRow[];
    return rows.map((row) => ({
      videoId: row.id,
      title: row.title,
      stage: row.stage,
      lastAccessedAt: row.last_accessed_at ?? row.ingested_at,
      retainedBytes: Math.max(0, Number(row.retained_bytes)),
      evictionEligible:
        TERMINAL_STAGES.has(row.stage) &&
        Date.parse(row.last_accessed_at ?? row.ingested_at ?? '1970-01-01') <=
          Date.now() - EVICTION_GRACE_MS,
    }));
  }

  private cleanupPendingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM cache_gc').get() as { n: number }).n;
  }

  snapshot(includePhysical = true): CacheSnapshot {
    const videos = this.usageRows();
    const sharedBytes = includePhysical
      ? ['runtime', 'models', 'transformers', 'tesseract'].reduce(
          (sum, name) => sum + dirSizeBytes(join(this.config.cacheDir, name)),
          0,
        )
      : 0;
    const indexPhysicalBytes = includePhysical
      ? dirSizeBytes(join(this.config.cacheDir, 'lancedb')) +
        fileSize(join(this.config.cacheDir, 'index.sqlite')) +
        fileSize(join(this.config.cacheDir, 'index.sqlite-wal')) +
        fileSize(join(this.config.cacheDir, 'index.sqlite-shm'))
      : 0;
    return {
      budgetBytes: this.budgetBytes,
      lowWaterBytes: this.lowWaterBytes,
      videoBytes: videos.reduce((sum, video) => sum + video.retainedBytes, 0),
      totalPhysicalBytes: includePhysical ? dirSizeBytes(this.config.cacheDir) : 0,
      sharedBytes,
      indexPhysicalBytes,
      cleanupPending: this.cleanupPendingCount(),
      videos,
    };
  }

  warning(videoId?: string): string | null {
    const snapshot = this.snapshot(false);
    if (snapshot.videoBytes <= snapshot.budgetBytes) return null;
    const video = videoId
      ? snapshot.videos.find((candidate) => candidate.videoId === videoId)
      : undefined;
    if (video && video.retainedBytes > snapshot.budgetBytes) {
      return `This video alone exceeds VCM_MAX_CACHE_GB=${this.config.maxCacheGb}; it was retained so the completed analysis remains usable. Call delete_video after saving the resulting note.`;
    }
    return `Retained video data exceeds VCM_MAX_CACHE_GB=${this.config.maxCacheGb}; automatic cleanup could not reclaim enough eligible data. Call delete_video after saving notes or inspect prune_cache.`;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.maintenanceTail.then(fn, fn);
    this.maintenanceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async releaseVideo(videoId: string): Promise<ReleaseResult> {
    return this.serialize(async () => {
      const released = this.logicalRelease(videoId, 'explicit');
      await this.retryPendingGc(videoId);
      return {
        deleted: videoId,
        title: released.title,
        cleanupPending: this.hasPendingGc(videoId),
        alreadyReleased: released.alreadyReleased,
      };
    });
  }

  private logicalRelease(
    videoId: string,
    reason: 'explicit' | 'lru',
    expectedLastAccess?: string | null,
  ): { title: string | null; alreadyReleased: boolean } {
    if (!/^[\w-]+$/.test(videoId)) {
      throw new VcmError('NOT_INGESTED', `Invalid video_id "${videoId}".`);
    }
    const release = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT title, stage, last_accessed_at, ingested_at FROM videos WHERE id = ?')
        .get(videoId) as
        | {
            title: string | null;
            stage: string;
            last_accessed_at: string | null;
            ingested_at: string | null;
          }
        | undefined;
      if (!row) {
        const pending = this.db
          .prepare('SELECT title FROM cache_gc WHERE video_id = ?')
          .get(videoId) as { title: string | null } | undefined;
        if (pending) return { title: pending.title, alreadyReleased: true };
        throw new VcmError(
          'NOT_INGESTED',
          `No video with id "${videoId}" in the index. Call list_videos to see retained videos.`,
        );
      }
      if (!TERMINAL_STAGES.has(row.stage)) {
        throw new VcmError(
          'STAGE_NOT_READY',
          `Cannot release ${videoId} while ingestion is at stage=${row.stage}. Wait for done/error, then retry delete_video.`,
        );
      }
      const currentLastAccess = row.last_accessed_at ?? row.ingested_at;
      if (expectedLastAccess !== undefined && currentLastAccess !== expectedLastAccess) {
        throw new VcmError(
          'STAGE_NOT_READY',
          `Skipped automatic eviction of ${videoId} because it was accessed during pruning.`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO cache_gc
             (video_id, title, reason, files_pending, vectors_pending, created_at)
           VALUES (?, ?, ?, 1, 1, ?)`,
        )
        .run(videoId, row.title, reason, new Date().toISOString());
      this.db.prepare('DELETE FROM videos WHERE id = ?').run(videoId);
      this.touchedAt.delete(videoId);
      return { title: row.title, alreadyReleased: false };
    });
    return release.immediate();
  }

  private claimGc(videoId?: string): GcRow | null {
    const now = Date.now();
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT video_id, files_pending, vectors_pending
           FROM cache_gc
           WHERE (lease_until_ms IS NULL OR lease_until_ms < ?)
             AND (? IS NULL OR video_id = ?)
           ORDER BY created_at
           LIMIT 1`,
        )
        .get(now, videoId ?? null, videoId ?? null) as GcRow | undefined;
      if (!row) return null;
      const claimed = this.db
        .prepare(
          `UPDATE cache_gc SET claimed_by = ?, lease_until_ms = ?
           WHERE video_id = ? AND (lease_until_ms IS NULL OR lease_until_ms < ?)`,
        )
        .run(this.owner, now + GC_LEASE_MS, row.video_id, now);
      return claimed.changes === 1 ? row : null;
    });
    return claim.immediate();
  }

  private async cleanupClaim(row: GcRow): Promise<void> {
    let filesPending = Boolean(row.files_pending);
    let vectorsPending = Boolean(row.vectors_pending);
    const errors: string[] = [];

    if (filesPending) {
      try {
        await this.cleanup.removeVideoDir(join(this.config.cacheDir, row.video_id));
        filesPending = false;
      } catch (err) {
        errors.push(`files: ${boundedDetail(err)}`);
      }
    }
    if (vectorsPending) {
      try {
        await this.cleanup.deleteVectors(row.video_id, this.config);
        await this.cleanup.optimizeVectors(this.config);
        vectorsPending = false;
      } catch (err) {
        errors.push(`vectors: ${boundedDetail(err)}`);
      }
    }

    const finish = this.db.transaction(() => {
      if (!filesPending && !vectorsPending) {
        this.db
          .prepare('DELETE FROM cache_gc WHERE video_id = ? AND claimed_by = ?')
          .run(row.video_id, this.owner);
        return;
      }
      this.db
        .prepare(
          `UPDATE cache_gc
           SET files_pending = ?, vectors_pending = ?, attempts = attempts + 1,
               last_error = ?, claimed_by = NULL, lease_until_ms = ?
           WHERE video_id = ? AND claimed_by = ?`,
        )
        .run(
          filesPending ? 1 : 0,
          vectorsPending ? 1 : 0,
          errors.join(' | ').slice(0, 600),
          Date.now() + 60_000,
          row.video_id,
          this.owner,
        );
    });
    finish.immediate();
  }

  private async retryPendingGc(videoId?: string): Promise<void> {
    for (let i = 0; i < GC_BATCH; i++) {
      const row = this.claimGc(videoId);
      if (!row) break;
      await this.cleanupClaim(row);
      if (videoId) break;
    }
  }

  private refreshUnmeasuredVideos(): void {
    const rows = this.db.prepare('SELECT id FROM videos WHERE asset_bytes IS NULL').all() as {
      id: string;
    }[];
    for (const row of rows) this.refreshVideoUsage(row.id);
  }

  async maintain(args: {
    reason: MaintenanceReport['reason'];
    protectIds?: Iterable<string>;
    dryRun?: boolean;
  }): Promise<MaintenanceReport> {
    return this.serialize(async () => {
      const dryRun = args.dryRun ?? false;
      if (!dryRun) {
        await this.retryPendingGc();
        this.refreshUnmeasuredVideos();
      }
      const before = this.snapshot(false);
      const protectedIds = new Set(args.protectIds ?? []);
      const candidates: CacheVideoUsage[] = [];
      let projectedBytes = before.videoBytes;
      if (projectedBytes > before.budgetBytes) {
        for (const video of before.videos) {
          if (projectedBytes <= before.lowWaterBytes) break;
          if (!video.evictionEligible || protectedIds.has(video.videoId)) continue;
          candidates.push(video);
          projectedBytes -= video.retainedBytes;
        }
      }

      const released: CacheVideoUsage[] = [];
      if (!dryRun) {
        for (const candidate of candidates) {
          try {
            this.logicalRelease(candidate.videoId, 'lru', candidate.lastAccessedAt);
            await this.retryPendingGc(candidate.videoId);
            released.push(candidate);
          } catch (err) {
            if (!(err instanceof VcmError && err.code === 'STAGE_NOT_READY')) throw err;
          }
        }
      }
      const afterBytes = dryRun ? projectedBytes : this.snapshot(false).videoBytes;
      return {
        reason: args.reason,
        dryRun,
        budgetBytes: before.budgetBytes,
        lowWaterBytes: before.lowWaterBytes,
        beforeBytes: before.videoBytes,
        afterBytes,
        candidates,
        released,
        cleanupPending: this.cleanupPendingCount(),
        unresolvedOverageBytes: Math.max(0, afterBytes - before.budgetBytes),
      };
    });
  }
}
