# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.4](https://github.com/nickderobertis/onepipeline-ui/compare/v0.6.3...v0.6.4) - 2026-08-29

### Changed

- *(release)* declare release targets in the canonical release-targets.toml ([#40](https://github.com/nickderobertis/onepipeline-ui/pull/40))

## [0.6.3](https://github.com/nickderobertis/onepipeline-ui/compare/v0.6.2...v0.6.3) - 2026-08-23

### Added

- show the release that carried each landed node, and every release event ([#36](https://github.com/nickderobertis/onepipeline-ui/pull/36))

## [0.6.2](https://github.com/nickderobertis/onepipeline-ui/compare/v0.6.1...v0.6.2) - 2026-08-21

### Fixed

- *(api)* serve a settled dispatch from the report that holds its transcript ([#33](https://github.com/nickderobertis/onepipeline-ui/pull/33))

## [0.6.1](https://github.com/nickderobertis/onepipeline-ui/compare/v0.6.0...v0.6.1) - 2026-08-21

### Added

- *(api)* serve a dispatch's prose, tool results and per-turn cost while it is still running ([#31](https://github.com/nickderobertis/onepipeline-ui/pull/31))

## [0.6.0](https://github.com/nickderobertis/onepipeline-ui/compare/v0.5.0...v0.6.0) - 2026-08-21

### Fixed

- *(api)* serve the transcript, the spans and the marker reading a run actually recorded ([#29](https://github.com/nickderobertis/onepipeline-ui/pull/29))

## [0.5.0](https://github.com/nickderobertis/onepipeline-ui/compare/v0.4.0...v0.5.0) - 2026-08-19

### Added

- [**breaking**] read the DAG Observatory's artifacts, and seal the confinement proof ([#23](https://github.com/nickderobertis/onepipeline-ui/pull/23))

## [0.4.0](https://github.com/nickderobertis/onepipeline-ui/compare/v0.3.4...v0.4.0) - 2026-08-15

### Added

- [**breaking**] adopt the roundless onepipeline SDK and expose stream filters ([#17](https://github.com/nickderobertis/onepipeline-ui/pull/17))

## [0.3.3](https://github.com/nickderobertis/onepipeline-ui/compare/v0.3.2...v0.3.3) - 2026-08-12

### Added

- surface turn interruption in the read API ([#12](https://github.com/nickderobertis/onepipeline-ui/pull/12))

## [0.3.2](https://github.com/nickderobertis/onepipeline-ui/compare/v0.3.1...v0.3.2) - 2026-08-11

### Fixed

- pass a supervisor's stop through the npm launcher ([#10](https://github.com/nickderobertis/onepipeline-ui/pull/10))

## [0.3.1](https://github.com/nickderobertis/onepipeline-ui/compare/v0.3.0...v0.3.1) - 2026-08-11

### Fixed

- make the release trigger cover everything a release publishes ([#8](https://github.com/nickderobertis/onepipeline-ui/pull/8))

## [0.3.0](https://github.com/nickderobertis/onepipeline-ui/compare/v0.2.0...v0.3.0) - 2026-08-10

### Added

- [**breaking**] consume the sibling's telemetry document, and serve schema 11 ([#4](https://github.com/nickderobertis/onepipeline-ui/pull/4))

## [0.2.0](https://github.com/nickderobertis/onepipeline-ui/compare/v0.1.0...v0.2.0) - 2026-08-09

### Added

- [**breaking**] ship the DAG Observatory, and publish the read API as onepipeline-api-cli ([#2](https://github.com/nickderobertis/onepipeline-ui/pull/2))

## [0.1.0](https://github.com/nickderobertis/onepipeline-ui/releases/tag/v0.1.0) - 2026-08-08

### Added

- bootstrap onepipeline-ui with the read-API contract landed interface-only

### Fixed

- make the runs root unrepresentable unless it was read
- clear the llmlint findings the first whole-tree judge pass raised
# Changelog

All notable changes to this project are documented here.

This file is maintained by [release-plz](https://release-plz.dev): it writes a
section from the conventional commits since the last release, in the version-bump
PR whose merge cuts the release. Do not hand-edit it.
