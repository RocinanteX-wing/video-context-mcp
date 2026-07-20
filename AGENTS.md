# Agent Guide — video-context-mcp

## Commands

- `just setup` — npm install
- `just ci` — lint (Biome) + typecheck + test (Vitest) + build; must pass before commit
- `just e2e` — network-gated E2E (`VCM_E2E=1`), hits YouTube via yt-dlp
- `npm run format` — apply Biome fixes

## Layout

- `src/index.ts` — entry; stdio transport; **stdout is reserved for MCP, log to stderr only**
- `src/tools/` — one file per MCP tool (`name`, `description`, `inputSchema` Zod shape, `handler(deps)`)
- `src/pipeline/` — ingestion: `ytdlp.ts` (shell-outs), `vtt.ts` (caption parsing), `ingest.ts` (async job state machine)
- `src/db.ts` — better-sqlite3 schema + migrations (bump `user_version`; never edit applied DDL)
- `tests/` — Vitest; `server.test.ts` is the required MCP-initialize startup test

## Rules

- Every user-facing failure goes through `src/errors.ts` (`VcmError` + `toToolError`) with an **actionable** message — never raw stderr or stack traces.
- Tool outputs must stay compact (scaffold rule): summarize, cite `video_id` + timestamps, provide handles for follow-up calls. Hard caps like `MAX_CHARS` in `get-transcript.ts` are intentional.
- External binaries (`yt-dlp`, `ffmpeg`, `ffprobe`, later `tesseract`/`whisper-cli`) are shell-outs via `execFile` — no native bindings, no shell-string interpolation.
- Schema changes: add a new migration block in `db.ts` gated on `user_version`; existing installs must upgrade in place.
- The cache under `VCM_CACHE_DIR` is disposable; never store the only copy of anything there.
