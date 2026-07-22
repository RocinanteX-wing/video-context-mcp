import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('managed runtime config', () => {
  it('defaults to managed core tools and self-contained fallbacks', () => {
    const config = loadConfig({ VCM_CACHE_DIR: '/tmp/vcm-config-test' });
    expect(config.toolchainMode).toBe('managed');
    expect(config.ocrBackend).toBe('auto');
    expect(config.asrBackend).toBe('auto');
    expect(config.asrModel).toBe('Xenova/whisper-base.en');
    expect(config.asrRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(config.embedRevision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('records explicit binary overrides separately from defaults', () => {
    const config = loadConfig({
      VCM_CACHE_DIR: '/tmp/vcm-config-test',
      VCM_YTDLP_BIN: '/opt/tools/yt-dlp',
      VCM_FFMPEG_BIN: '/opt/tools/ffmpeg',
    });
    expect(config.binaryOverrides).toMatchObject({
      ytdlp: '/opt/tools/yt-dlp',
      ffmpeg: '/opt/tools/ffmpeg',
    });
  });

  it('rejects invalid provider modes early', () => {
    expect(() =>
      loadConfig({ VCM_CACHE_DIR: '/tmp/vcm-config-test', VCM_TOOLCHAIN_MODE: 'sometimes' }),
    ).toThrow('VCM_TOOLCHAIN_MODE must be one of managed, system');
  });
});
