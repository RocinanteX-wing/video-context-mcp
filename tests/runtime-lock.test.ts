import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRuntimeLock } from '../src/runtime/lock.js';

afterEach(() => vi.useRealTimers());

describe('runtime installation locks', () => {
  it('reclaims an abandoned lock after its heartbeat expires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-runtime-lock-'));
    const lockPath = join(dir, '.locks', 'fixture.lock');
    const ownerPath = join(lockPath, 'owner');
    try {
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(ownerPath, 'abandoned-owner');
      const old = new Date(Date.now() - 10_000);
      utimesSync(ownerPath, old, old);

      const lock = await acquireRuntimeLock(dir, 'fixture', {
        staleMs: 5_000,
        heartbeatMs: 1_000,
        pollMs: 1,
      });
      expect(readFileSync(ownerPath, 'utf8')).not.toBe('abandoned-owner');
      expect(() => lock.assertOwned()).not.toThrow();
      lock.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heartbeats a live lock and only releases the matching owner token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-runtime-lock-'));
    const lockPath = join(dir, '.locks', 'fixture.lock');
    const ownerPath = join(lockPath, 'owner');
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const lock = await acquireRuntimeLock(dir, 'fixture', { heartbeatMs: 1_000 });
      const initialMtime = statSync(ownerPath).mtimeMs;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(statSync(ownerPath).mtimeMs).toBeGreaterThan(initialMtime);

      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      writeFileSync(ownerPath, 'replacement-owner');
      lock.release();
      expect(readFileSync(ownerPath, 'utf8')).toBe('replacement-owner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
