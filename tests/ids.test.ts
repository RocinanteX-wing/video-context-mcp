import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VcmError } from '../src/errors.js';
import { resolveRef } from '../src/ids.js';

describe('resolveRef', () => {
  const ID = 'dQw4w9WgXcQ';

  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?list=PL123&v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    ID,
  ])('resolves %s to the youtube id', (input) => {
    const ref = resolveRef(input);
    expect(ref.id).toBe(ID);
    expect(ref.kind).toBe('youtube');
    expect(ref.source).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('content-addresses existing local files deterministically', () => {
    const p = join(tmpdir(), `vcm-test-${process.pid}.mp4`);
    writeFileSync(p, 'fake video bytes');
    const a = resolveRef(p);
    const b = resolveRef(p);
    expect(a.kind).toBe('local');
    expect(a.id).toMatch(/^local-[0-9a-f]{12}$/);
    expect(a.id).toBe(b.id);
    expect(a.source).toBe(p);
  });

  it('rejects directories and other non-regular files', () => {
    try {
      resolveRef(tmpdir());
      expect.unreachable();
    } catch (e) {
      expect((e as VcmError).code).toBe('FILE_NOT_FOUND');
      expect((e as VcmError).message).toContain('regular file');
    }
  });

  it('rejects missing local files with FILE_NOT_FOUND', () => {
    expect(() => resolveRef('/nope/definitely-missing.mp4')).toThrowError(VcmError);
    try {
      resolveRef('/nope/definitely-missing.mp4');
    } catch (e) {
      expect((e as VcmError).code).toBe('FILE_NOT_FOUND');
    }
  });

  it('rejects garbage with UNSUPPORTED_URL and a helpful message', () => {
    try {
      resolveRef('not a video at all');
      expect.unreachable();
    } catch (e) {
      expect((e as VcmError).code).toBe('UNSUPPORTED_URL');
      expect((e as VcmError).message).toContain('youtube.com/watch');
    }
  });
});
