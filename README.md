# video-context-mcp

Model-agnostic MCP server that turns videos into an **interactive, queryable knowledge structure** — transcript, chapters, keyframes, OCR, and search — that any MCP client model (Claude, GPT, Gemini, local models) can **scrub lazily** instead of receiving a context-flooding dump of keyframes.

Most video tools for agents either lock you to one model provider or eagerly dump dozens of frames into context. `video-context-mcp` treats a video like a filesystem: ingest once, then let the agent pull exactly the slice it needs — a timeline overview, a transcript range, a search hit, or a single frame at a timestamp.

## Requirements

- Node ≥ 22
- Network access on first use

No Python, package manager, or preinstalled media tools are required on macOS
(Apple Silicon or Intel), Windows x64, or Linux glibc x64. The server securely
downloads pinned yt-dlp and FFmpeg builds only when a feature needs them, then
caches them under `VCM_CACHE_DIR`. OCR and caption-less speech use local
Tesseract.js and Transformers.js fallbacks when native tools are unavailable.

## Install & register

Not yet published to npm — install from source:

```bash
git clone https://github.com/smallthinkingmachines/video-context-mcp.git
cd video-context-mcp
npm install && npm run build
```

**Claude Code / Gemini-style JSON config:**

```json
{
  "mcpServers": {
    "video-context": {
      "command": "node",
      "args": ["/path/to/video-context-mcp/dist/index.js"]
    }
  }
}
```

**Codex (`~/.codex/config.toml`):**

```toml
[mcp_servers.video-context]
command = "node"
args = ["/path/to/video-context-mcp/dist/index.js"]
```

Once published to npm, `npm install -g @smallthinkingmachines/video-context-mcp` will provide a `video-context-mcp` binary you can use as the `command` directly.

Optional bootstrap and diagnostics:

```bash
video-context-mcp setup          # prefetch yt-dlp + FFmpeg
video-context-mcp setup --all    # also prefetch OCR, ASR, and embedding models
video-context-mcp setup --update # explicitly activate this release's pinned tools
video-context-mcp doctor         # read-only health and remediation report
```

## Tools

| Tool | Purpose |
|---|---|
| `ingest_video` | Index a YouTube URL/ID or local file (async job, returns immediately) |
| `get_ingest_status` | Stage, progress, what's queryable, actionable errors |
| `get_video_timeline` | Compact overview: chapters + sampled transcript outline |
| `get_transcript` | Timestamped transcript, sliceable by range |
| `search_videos` | Hybrid search (full-text + semantic, RRF-fused) over speech AND on-screen text |
| `peek_frame` | The keyframe image nearest a timestamp + its OCR text — *you* look at it |
| `crop_region` | Zoom into a bbox of a frame (IDE panel, diagram) for dense text |
| `list_videos` / `delete_video` | Cache inventory and explicit release after saving a note |
| `prune_cache` | Preview or apply quota-based whole-video LRU cleanup |

Typical agent flow: `ingest_video` → poll `get_ingest_status` → inspect timeline/search/transcript/frame slices → save the resulting note elsewhere → `delete_video` to release the working assets.

## Configuration

All settings are optional; see `.env.example`. Managed tools are the default.
Set `VCM_TOOLCHAIN_MODE=system` to restore PATH-only resolution. An explicit
`VCM_YTDLP_BIN`, `VCM_FFMPEG_BIN`, or `VCM_FFPROBE_BIN` always wins. OCR and
ASR providers can be selected with `VCM_OCR_BACKEND` and `VCM_ASR_BACKEND`.
Cookies for restricted YouTube videos remain user-supplied through
`YTDLP_COOKIES_FILE` and are never bundled.

## Cache lifecycle

Downloaded source video/audio, captions, staging files, WAVs, and temporary
crops are removed automatically after every ingest. Retained transcript, OCR,
keyframes, and vectors form a queryable working set until the agent calls
`delete_video` after saving its note.

`VCM_MAX_CACHE_GB` defaults to 20 GB and applies only to retained per-video
data. If agents forget to release videos, startup and ingestion maintenance
evicts complete videos by least-recently-used order until usage is below 90%
of the budget. Running and just-completed ingests are protected; an oversized
new result is retained with a warning. Shared managed binaries and OCR/ASR/
embedding models are reusable and never automatically evicted. Use
`list_videos` for accounting or `prune_cache` for a dry-run preview.
Interrupted runtime and native ASR downloads are reclaimed on the next server
startup or `setup` run after they have remained inactive for at least one hour.

## Roadmap

- **Phase 1 (shipped):** metadata + captions transcript + timeline + FTS search
- **Phase 2 (shipped):** keyframes, lazy frame inspection, and native/WASM OCR into search. Known limitation: YouTube's SABR streaming experiment can cap downloads at 360p, degrading code OCR — surfaced as a note in `get_ingest_status`.
- **Phase 3 (shipped):** local ASR fallback — `ingest_video(…, whisper_fallback=true)` uses native whisper.cpp when explicitly configured or quantized Transformers.js Base.en otherwise; failures downgrade to warnings without sinking the ingest
- **Phase 4 (shipped):** hybrid dense+lexical search — ONNX embeddings (`Xenova/all-MiniLM-L6-v2` by default) in LanceDB, fused with FTS5 by reciprocal rank
- **Phase 5 (shipped):** self-contained, checksummed runtime provisioning with setup/doctor commands and four-platform package validation
- **Phase 6 (this release):** explicit working-set release plus whole-video quota LRU with retryable cross-store cleanup
- **Phase 7 (experimental):** on-screen code diff reconstruction, diagram→Mermaid, deictic alignment

## Notes

Intended for personal research and note-taking on content you can legitimately access. Caption/metadata fetching uses `yt-dlp`; respect YouTube's Terms of Service and copyright. Cookies are user-supplied and never bundled.

Managed executables retain their upstream licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The npm package stays small:
runtime binaries and models are downloaded into the disposable cache, not
embedded in the tarball.

**Trust boundary:** the server trusts its MCP client. In particular, `ingest_video` will read any local file path the client asks for (by design — it's your agent indexing your files), and the cache is plain files on disk. Run it as a local stdio server for clients you control; do not expose it to untrusted clients or over the network without adding your own authorization layer.

## Development

```bash
just setup   # npm install
just ci      # lint + typecheck + test + build
just e2e     # network-gated end-to-end test against a real video
```

MIT © Small Thinking Machines
