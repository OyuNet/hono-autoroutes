# Changelog

All notable changes to this project are documented in this file.

## 0.4.0 - 2026-09-03

### Added

- Route groups using parenthesized directories, such as `(app)`, without adding the group name to the URL.
- Bun test coverage for filesystem and entries modes, middleware ordering, duplicate strategies, and route groups.
- GitHub Actions checks for build, tests, lint, and the Node smoke test.
- Biome formatting and linting configuration.

### Changed

- Route and middleware collisions created by route groups now follow `duplicateStrategy` consistently.
- Filesystem collision resolution is deterministic.
- Development dependencies were updated to current compatible releases.
- The smoke test now validates the built package with assertions and cleans up its temporary files.

### Fixed

- Root-level entries are resolved correctly when `virtualRoot` has a trailing slash.
- Filesystem duplicate routes are included in skipped-route summary counts.
