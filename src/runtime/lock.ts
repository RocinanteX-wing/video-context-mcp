import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VcmError } from '../errors.js';

export const RUNTIME_LOCK_TIMEOUT_MS = 15 * 60_000;
export const RUNTIME_LOCK_STALE_MS = 5 * 60_000;
export const RUNTIME_LOCK_HEARTBEAT_MS = 30_000;

const RUNTIME_LOCK_POLL_MS = 250;

export interface RuntimeLock {
  assertOwned(): void;
  release(): void;
}

export interface RuntimeLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerPath(lockPath: string): string {
  return join(lockPath, 'owner');
}

function readOwner(lockPath: string): string | null {
  try {
    return readFileSync(ownerPath(lockPath), 'utf8');
  } catch {
    return null;
  }
}

function isStale(path: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Serialize stale-lock removal so two waiters cannot both inspect an old lock
 * and then accidentally remove a newly acquired replacement.
 */
function breakStaleLock(lockPath: string, staleMs: number): void {
  const reaperPath = `${lockPath}.reap`;
  try {
    mkdirSync(reaperPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    // A hard-killed reaper must not permanently disable stale-lock recovery.
    if (isStale(reaperPath, staleMs)) rmSync(reaperPath, { recursive: true, force: true });
    return;
  }

  try {
    const heartbeatPath = ownerPath(lockPath);
    const candidate = readOwner(lockPath) === null ? lockPath : heartbeatPath;
    if (isStale(candidate, staleMs)) rmSync(lockPath, { recursive: true, force: true });
  } finally {
    rmSync(reaperPath, { recursive: true, force: true });
  }
}

/** Acquire a cross-process runtime-install lease backed by an owned directory. */
export async function acquireRuntimeLock(
  runtimeDir: string,
  id: string,
  options: RuntimeLockOptions = {},
): Promise<RuntimeLock> {
  if (!/^[\w.-]+$/.test(id)) {
    throw new VcmError(
      'TOOLCHAIN_INTEGRITY_FAILED',
      `Unsafe managed runtime id: ${id.slice(0, 160)}.`,
    );
  }
  const timeoutMs = options.timeoutMs ?? RUNTIME_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? RUNTIME_LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? RUNTIME_LOCK_HEARTBEAT_MS;
  const pollMs = options.pollMs ?? RUNTIME_LOCK_POLL_MS;
  const lockPath = join(runtimeDir, '.locks', `${id}.lock`);
  const token = `${process.pid}-${randomUUID()}`;
  mkdirSync(join(runtimeDir, '.locks'), { recursive: true });
  const started = Date.now();

  for (;;) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(ownerPath(lockPath), token, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        rmSync(lockPath, { recursive: true, force: true });
        throw err;
      }

      let released = false;
      const heartbeat = setInterval(() => {
        if (released || readOwner(lockPath) !== token) {
          clearInterval(heartbeat);
          return;
        }
        try {
          const now = new Date();
          utimesSync(ownerPath(lockPath), now, now);
        } catch {
          // assertOwned() guards every publish step if the lease is later lost.
        }
      }, heartbeatMs);
      heartbeat.unref();

      const assertOwned = (): void => {
        if (released || readOwner(lockPath) !== token) {
          throw new VcmError(
            'TOOLCHAIN_DOWNLOAD_FAILED',
            `Lost the managed runtime installation lock for ${id}. Another process may be recovering it; retry setup.`,
          );
        }
      };

      return {
        assertOwned,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          if (readOwner(lockPath) === token) {
            rmSync(lockPath, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      breakStaleLock(lockPath, staleMs);
      if (Date.now() - started > timeoutMs) {
        throw new VcmError(
          'TOOLCHAIN_DOWNLOAD_FAILED',
          `Timed out waiting for another process to install ${id}. Run video-context-mcp doctor and retry.`,
        );
      }
      await delay(pollMs);
    }
  }
}
