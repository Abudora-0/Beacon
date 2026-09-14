# Changelog

All notable changes to Beacon are documented here.

## [1.3.0] - 2026-09-14

### Added
- Port override: start any project on a specific port instead of its default, from a field in the project detail panel — also surfaced automatically as a retry prompt when a project exits because its port was already taken

### Changed
- Projects that share a generic subfolder name (e.g. sibling `frontend`/`backend` folders) are now disambiguated with their wrapper folder's name instead of showing the same generic name on every card
- Unmodified default framework favicons (Vite, CRA, Next.js) are now recognized and replaced with a colored initial-letter avatar, instead of showing the same stock logo on every uncustomized project
- A detected dev-server port is now verified to actually accept a connection before being shown as ready, cutting down on premature "refused to connect" errors

### Fixed
- A project could be silently auto-restarted much later if a Restart's stop call failed and left its pending-restart flag stuck
- The "Active Ports" stat card was plotting the same sparkline data as "Running Now" instead of its own history

## [1.2.1] - 2026-07-23

### Added
- Automatic update checking and installation from Settings, backed by a signed updater feed published with each GitHub release
- CI-driven releases: pushing a `v*` tag now builds, signs, and publishes the installer automatically via GitHub Actions

## [1.2.0] - 2026-07-15

Initial public release.

### Added
- Auto-discovery of Node/npm and static HTML/CSS/JS projects, with `node_modules`/`dist`/`build`/`target`/dotfolder exclusion
- Framework detection (Next.js, Vite/React, Express, and more)
- Package-manager detection (npm/pnpm/yarn/bun) via `packageManager` field or lockfile
- One-click start/stop/restart with live log streaming and port auto-detection
- Favicon resolution, including inline `data:` URIs and Vite/CRA `public/` assets
- Built-in static file server for no-build-step HTML/CSS/JS projects
- Live CPU/memory stats per running project (scoped process refresh, not full-system scans)
- System tray integration with single-instance handling and crash/port-conflict notifications
- Pin, search, and filter projects; excludable folders
- Settings page with notification status and in-app update checks
- Keyboard-accessible dark UI with a consistent design system (spacing/radius/type tokens)
- In-app update checking via the Tauri updater plugin
