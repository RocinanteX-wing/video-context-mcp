# Contributing

Thanks for helping make `video-context-mcp` more useful and reliable.

## Development setup

You need Node.js 22 or newer. The documented workflow uses `just`, but it is
optional; Nix is not required.

```bash
just setup
just ci
```

Without `just`, the equivalent setup and validation commands are:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

`just e2e` is network-gated. It downloads a short public YouTube video and the
managed embedding model, so run it when changing ingestion, managed tools, or
semantic search.

## Pull requests

- Keep tool responses compact and preserve follow-up handles such as video IDs
  and timestamps.
- Route every user-facing failure through `VcmError` and `toToolError`, with a
  concrete remediation.
- Never write application logs to stdout. The MCP stdio transport owns stdout;
  use stderr for diagnostics.
- Run external programs with `execFile` and argument arrays, never interpolated
  shell commands.
- Add a new `user_version` migration for database changes. Never edit an
  already-applied migration.
- Update README/tool descriptions and tests when changing a public schema.
- Run `just ci` before committing.

Small, focused pull requests are easiest to review. Bug reports with redacted
`video-context-mcp doctor --json` output are especially helpful.

## Terminal demo

`npm run demo` builds the server and runs a real agent-style MCP investigation
against the public “Why Agentic Systems Need Ontologies” talk. It requires
network access and uses an isolated temporary cache.

The README animation is generated from `docs/demo.tape` with
[VHS](https://github.com/charmbracelet/vhs):

```bash
npm run build
VCM_CACHE_DIR=/tmp/video-context-mcp-readme-demo node dist/index.js setup --json
VCM_DEMO_CACHE_DIR=/tmp/video-context-mcp-readme-demo node scripts/demo-client.mjs --prime
VCM_DEMO_CACHE_DIR=/tmp/video-context-mcp-readme-demo vhs docs/demo.tape
```
