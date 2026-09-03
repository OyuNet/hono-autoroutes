# Changelog

All notable changes to this project are documented in this file.

## 0.5.0 - 2026-09-03

### Added

- Public types for entries, route modules, middleware modules, and registration functions.
- Load statistics returned from `mountAutoRoutes` and `mountAutoRoutesFromEntries`.
- `silent` mode for applications that do not want discovery logs.
- `strict` mode to fail application startup when discovered modules cannot be loaded or registered.
- Node 18, 20, and 22 smoke-test coverage plus Windows CI coverage.
- Tokenless npm trusted-publishing workflow with automatic provenance.

### Fixed

- Empty `entries` maps no longer fall back to Node filesystem discovery.
- Global and sticky filename regular expressions match consistently across multiple files.
- Windows-style and dot-prefixed entries keys retain their original map lookup keys after normalization.

### Changed

- Plain Node TypeScript-loading requirements are now documented explicitly.
- The Node 18-incompatible Rimraf development dependency was replaced with a built-in Node cleanup command.

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
