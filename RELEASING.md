# Release Checklist

Publishing is intentionally a separate final step. Do not tag or publish from a
working feature branch.

1. Confirm `main` is clean and synchronized with the remote.
2. Review `CHANGELOG.md` and move Unreleased entries under the target version
   and date.
3. Set the version with `npm version --no-git-tag-version <version>`, update
   `src/version.ts` to the same version, and review both diffs.
4. Run `just ci` and `just e2e`.
5. Inspect `npm pack --dry-run` and the generated tarball contents. Runtime
   binaries, models, caches, tests, and local configuration must not be packed.
6. Confirm GitHub private vulnerability reporting and required branch checks
   are enabled.
7. Update the README from source-install language to the verified npm install
   command and add the npm version badge.
8. Commit the release, create a signed `v<version>` tag, and push both.
9. Wait for the four-platform managed-runtime smoke workflow to pass on the
   tag.
10. Publish with provenance from the approved release workflow, then create the
    GitHub release from the changelog entry.
11. Install the published package into a fresh temporary prefix and verify
    `video-context-mcp doctor --json` and MCP initialization.
