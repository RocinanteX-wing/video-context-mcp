export type ManagedTool = 'ytdlp' | 'ffmpeg' | 'ffprobe';

export interface ArtifactExecutable {
  tool: ManagedTool;
  /** Exact archive path or a slash-normalized suffix for archives with a versioned root. */
  archivePath: string;
  filename: string;
  versionArgs: string[];
  versionPattern: string;
}

export interface RuntimeArtifact {
  id: string;
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  url: string;
  sourceUrl: string;
  sha256: string;
  format: 'file' | 'zip';
  maxDownloadBytes: number;
  license: string;
  executables: ArtifactExecutable[];
}

const YTDLP_VERSION = '2026.06.09';
const YTDLP_BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`;
const YTDLP_SOURCE = `https://github.com/yt-dlp/yt-dlp/releases/tag/${YTDLP_VERSION}`;

const ytdlp = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  asset: string,
  sha256: string,
  filename: string,
): RuntimeArtifact => ({
  id: `yt-dlp-${YTDLP_VERSION}-${platform}-${arch}`,
  version: YTDLP_VERSION,
  platform,
  arch,
  url: `${YTDLP_BASE}/${asset}`,
  sourceUrl: YTDLP_SOURCE,
  sha256,
  format: 'file',
  maxDownloadBytes: 80 * 1024 * 1024,
  license: 'GPL-3.0-or-later (standalone executable distribution)',
  executables: [
    {
      tool: 'ytdlp',
      archivePath: asset,
      filename,
      versionArgs: ['--version'],
      versionPattern: YTDLP_VERSION.replaceAll('.', '\\.'),
    },
  ],
});

const FF_VERSION = '8.1.2';
const MARTIN_SOURCE = 'https://ffmpeg.martin-riedl.de/';

const martin = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  build: string,
  tool: 'ffmpeg' | 'ffprobe',
  sha256: string,
): RuntimeArtifact => ({
  id: `${tool}-${FF_VERSION}-${platform}-${arch}`,
  version: FF_VERSION,
  platform,
  arch,
  url: `https://ffmpeg.martin-riedl.de/download/${
    platform === 'darwin' ? 'macos' : 'linux'
  }/${arch === 'x64' ? 'amd64' : arch}/${build}_${FF_VERSION}/${tool}.zip`,
  sourceUrl: MARTIN_SOURCE,
  sha256,
  format: 'zip',
  maxDownloadBytes: 150 * 1024 * 1024,
  license: 'GPL-3.0-or-later',
  executables: [
    {
      tool,
      archivePath: tool,
      filename: tool,
      versionArgs: ['-version'],
      versionPattern: `version ${FF_VERSION.replaceAll('.', '\\.')}`,
    },
  ],
});

const windowsFfmpeg: RuntimeArtifact = {
  id: `ffmpeg-${FF_VERSION}-win32-x64`,
  version: FF_VERSION,
  platform: 'win32',
  arch: 'x64',
  url: `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FF_VERSION}-essentials_build.zip`,
  sourceUrl: 'https://www.gyan.dev/ffmpeg/builds/',
  sha256: 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
  format: 'zip',
  maxDownloadBytes: 160 * 1024 * 1024,
  license: 'GPL-3.0-or-later',
  executables: [
    {
      tool: 'ffmpeg',
      archivePath: '/bin/ffmpeg.exe',
      filename: 'ffmpeg.exe',
      versionArgs: ['-version'],
      versionPattern: `version ${FF_VERSION.replaceAll('.', '\\.')}`,
    },
    {
      tool: 'ffprobe',
      archivePath: '/bin/ffprobe.exe',
      filename: 'ffprobe.exe',
      versionArgs: ['-version'],
      versionPattern: `version ${FF_VERSION.replaceAll('.', '\\.')}`,
    },
  ],
};

/**
 * Release-pinned runtime artifacts. Updating any entry is a release change:
 * verify the upstream checksum, run the binary audit, update notices, and run
 * the four-platform package smoke suite before publishing.
 */
export const RUNTIME_ARTIFACTS: RuntimeArtifact[] = [
  ytdlp(
    'darwin',
    'arm64',
    'yt-dlp_macos',
    'b82c3626952e6c14eaf654cc565866775ffd0b9ffb7021628ac59b42c2f4f244',
    'yt-dlp',
  ),
  ytdlp(
    'darwin',
    'x64',
    'yt-dlp_macos',
    'b82c3626952e6c14eaf654cc565866775ffd0b9ffb7021628ac59b42c2f4f244',
    'yt-dlp',
  ),
  ytdlp(
    'linux',
    'x64',
    'yt-dlp_linux',
    'bf8aac79b72287a6d2043074415132558b43743a8f9461a22b0141e90f16ce66',
    'yt-dlp',
  ),
  ytdlp(
    'win32',
    'x64',
    'yt-dlp.exe',
    '3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27',
    'yt-dlp.exe',
  ),
  martin(
    'darwin',
    'arm64',
    '1783011502',
    'ffmpeg',
    'ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c',
  ),
  martin(
    'darwin',
    'arm64',
    '1783011502',
    'ffprobe',
    'c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf',
  ),
  martin(
    'darwin',
    'x64',
    '1783018342',
    'ffmpeg',
    'a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9',
  ),
  martin(
    'darwin',
    'x64',
    '1783018342',
    'ffprobe',
    '5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695',
  ),
  martin(
    'linux',
    'x64',
    '1783011670',
    'ffmpeg',
    '56452c0bfc4ee0325cd615d62f46ba8264f62eed34f727c2224c6c84fa7b8719',
  ),
  martin(
    'linux',
    'x64',
    '1783011670',
    'ffprobe',
    'c6f2d36e98f9a4445fad0b0be539f4c4faf13fd502116bf131becd53f56cd390',
  ),
  windowsFfmpeg,
];

export function artifactsFor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): RuntimeArtifact[] {
  return RUNTIME_ARTIFACTS.filter(
    (artifact) => artifact.platform === platform && artifact.arch === arch,
  );
}

export function artifactForTool(
  tool: ManagedTool,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): RuntimeArtifact | undefined {
  return artifactsFor(platform, arch).find((artifact) =>
    artifact.executables.some((executable) => executable.tool === tool),
  );
}
