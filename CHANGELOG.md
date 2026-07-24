# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Complete transcript-range export to a local UTF-8 file through
  `get_transcript(delivery="file")`.
- Structured transcript delivery metadata and resume handles.
- Selective asynchronous `repair_embeddings` without media re-download.
- Contributor, security, issue, pull-request, and release guidance.

### Changed

- Embedding failures now direct agents to selective repair instead of a full
  forced re-ingest.
- LanceDB is pinned to the latest stable release that publishes native binaries
  for every supported CI platform, including Intel macOS.
- Documentation now describes supported platforms and common first-run
  remediation.
- Repository text files are checked out with LF line endings on every platform
  so formatting checks are deterministic on Windows.
- GitHub workflows use the current Node 24-based checkout and setup-node action
  majors instead of deprecated Node 20-based releases.
- Monthly Dependabot batches are limited to minor and patch updates; major
  upgrades remain explicit compatibility work.
