import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { VcmError } from './errors.js';
import { RuntimeManager } from './runtime/manager.js';
import { SERVER_NAME, VERSION } from './version.js';

function help(): string {
  return `${SERVER_NAME} ${VERSION} — MCP server for local, queryable video context.

Usage:
  video-context-mcp                         start the MCP server on stdio
  video-context-mcp setup [--all] [--update] [--json]
  video-context-mcp doctor [--json]
  video-context-mcp --version

Managed mode downloads pinned yt-dlp and FFmpeg builds on first use. Explicit
VCM_YTDLP_BIN, VCM_FFMPEG_BIN, and VCM_FFPROBE_BIN values always take precedence.

Environment:
  VCM_CACHE_DIR, VCM_MAX_CACHE_GB, VCM_TOOLCHAIN_MODE=managed|system
  YTDLP_COOKIES_FILE, VCM_YTDLP_BIN, VCM_FFMPEG_BIN, VCM_FFPROBE_BIN
  VCM_OCR_BACKEND=auto|native|wasm, VCM_TESSERACT_BIN
  VCM_ASR_BACKEND=auto|native|transformers, VCM_WHISPER_BIN, VCM_WHISPER_MODEL
  VCM_ASR_MODEL, VCM_ASR_REVISION, VCM_EMBED_MODEL, VCM_EMBED_REVISION`;
}

function cliError(err: unknown): string {
  if (err instanceof VcmError) return `[${err.code}] ${err.message}`;
  return `[INTERNAL] ${err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400)}`;
}

export async function runCli(argv: string[]): Promise<number | null> {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.error(`${SERVER_NAME} ${VERSION}`);
    return 0;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(help());
    return 0;
  }
  const command = argv[0];
  if (!command) return null;
  if (command !== 'setup' && command !== 'doctor') {
    console.error(`Unknown command: ${command}\n\n${help()}`);
    return 2;
  }

  const allowed = new Set(['--all', '--update', '--json']);
  const unknown = argv.slice(1).filter((arg) => !allowed.has(arg));
  if (
    unknown.length > 0 ||
    (command === 'doctor' && (argv.includes('--all') || argv.includes('--update')))
  ) {
    console.error(`Invalid option for ${command}: ${unknown[0] ?? '--all/--update'}\n\n${help()}`);
    return 2;
  }

  const json = argv.includes('--json');
  try {
    const config = loadConfig();
    const runtime = new RuntimeManager(config);
    if (command === 'setup') {
      let lastBucket = -1;
      const paths = await runtime.ensureTools(
        ['ytdlp', 'ffmpeg', 'ffprobe'],
        (pct, detail) => {
          const bucket = Math.floor(pct / 10);
          if (!json && bucket !== lastBucket) {
            lastBucket = bucket;
            console.error(`[${SERVER_NAME}] ${pct}% ${detail}`);
          }
        },
        argv.includes('--update'),
      );
      runtime.applyResolved(paths);
      const models: string[] = [];
      if (argv.includes('--all')) {
        if (!json) console.error(`[${SERVER_NAME}] preparing English OCR data`);
        const { warmOcr } = await import('./pipeline/ocr.js');
        await warmOcr(config, true);
        models.push('tesseract.js/eng');

        if (!json) console.error(`[${SERVER_NAME}] preparing Base.en ASR model`);
        const { warmAsr } = await import('./pipeline/whisper.js');
        await warmAsr(config, (pct, note) => {
          if (!json && note) console.error(`[${SERVER_NAME}] ASR ${pct}% ${note}`);
        });
        models.push(`${config.asrModel}@${config.asrRevision}`);

        if (!json) console.error(`[${SERVER_NAME}] preparing embedding model`);
        const { warmEmbeddings } = await import('./pipeline/embed.js');
        await warmEmbeddings(config);
        models.push(`${config.embedModel}@${config.embedRevision}`);
      }
      const result = {
        ready: true,
        cache_dir: config.cacheDir,
        toolchain_mode: config.toolchainMode,
        tools: paths,
        models,
      };
      if (json) console.log(JSON.stringify(result));
      else console.error(`[${SERVER_NAME}] setup complete (${config.cacheDir})`);
      return 0;
    }

    const components = await Promise.all(
      (['ytdlp', 'ffmpeg', 'ffprobe'] as const).map((tool) => runtime.doctorTool(tool)),
    );
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const nodeReady = nodeMajor >= 22;
    const result = {
      ready:
        nodeReady &&
        components.every((component) => ['ready', 'update_available'].includes(component.state)),
      platform: `${process.platform}/${process.arch}`,
      node: {
        state: nodeReady ? 'ready' : 'invalid',
        version: process.versions.node,
        detail: nodeReady ? 'Ready.' : 'Node.js 22 or newer is required.',
      },
      cache_dir: config.cacheDir,
      cache_exists: existsSync(config.cacheDir),
      toolchain_mode: config.toolchainMode,
      components,
      fallbacks: {
        ocr: {
          backend: config.ocrBackend,
          cache_ready: existsSync(join(config.cacheDir, 'tesseract')),
        },
        asr: {
          backend: config.asrBackend,
          model: config.asrModel,
          revision: config.asrRevision,
          cache_ready: existsSync(join(config.cacheDir, 'transformers')),
        },
      },
    };
    if (json) console.log(JSON.stringify(result));
    else {
      console.error(`${SERVER_NAME} doctor — ${result.ready ? 'ready' : 'action required'}`);
      console.error(`Node ${result.node.version}: ${result.node.detail}`);
      for (const component of components) {
        console.error(
          `${component.name}: ${component.state} (${component.provider})${component.path ? ` — ${component.path}` : ''}`,
        );
        if (component.remediation) console.error(`  ${component.remediation}`);
      }
    }
    return result.ready ? 0 : 1;
  } catch (err) {
    const message = cliError(err);
    if (json) console.log(JSON.stringify({ ready: false, error: message }));
    else console.error(message);
    return 1;
  }
}
