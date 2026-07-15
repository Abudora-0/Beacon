<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" alt="Beacon icon" />

# Beacon

**A local dev-server control center for Windows.**
Scan a folder, and Beacon finds every project inside it, launches the right dev server with the right package manager, and keeps a live dashboard of logs, ports, and resource usage — all without touching a terminal.

[![License: MIT](https://img.shields.io/badge/License-MIT-3ff08a.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-3ff08a.svg)](#)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-3ff08a.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-3ff08a.svg)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-19-3ff08a.svg)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3ff08a.svg)](https://www.typescriptlang.org)

<img src=".github/screenshot.png" width="900" alt="Beacon dashboard screenshot" />

</div>

## What it does

Point Beacon at a folder full of side projects, and it takes care of the rest:

- 🔍 **Auto-discovery** — recursively scans for Node/npm projects and plain static HTML/CSS/JS sites, skipping `node_modules`, `dist`, `build`, `target`, and dotfolders along the way.
- 🧭 **Framework detection** — recognizes Next.js, Vite/React, Express, and more, and labels each project accordingly.
- 📦 **Package-manager aware** — reads `packageManager` (or falls back to the lockfile) and starts each project with the correct binary — npm, pnpm, yarn, or bun — instead of guessing.
- ▶️ **One-click start/stop/restart** — spawns the dev script, auto-detects the port it lands on, and streams stdout/stderr live.
- 🖼️ **Favicon everywhere** — pulls each project's real favicon, including inline `data:` URIs and Vite/CRA assets served from `public/`.
- 🌐 **Zero-config static server** — plain HTML/CSS/JS projects with no build step get served instantly by a built-in local file server.
- 📊 **Live stats** — per-project CPU and memory usage, sampled efficiently (no full-system scans).
- 🔔 **Background & tray** — closing the window keeps servers running in the tray; get a native notification if something crashes or a port collides.
- 📌 **Pin, search, filter** — pin favorites, search by name, filter by framework or running state.
- ⌨️ **Keyboard accessible** — every interactive element is reachable and operable without a mouse.

## Tech stack

| Layer | Stack |
|---|---|
| Shell | [Tauri 2](https://tauri.app) (Rust) |
| UI | React 19 + TypeScript + Vite |
| Process management | Native Rust process spawning, no shell dependencies beyond your package manager |
| Styling | Hand-rolled CSS design system (spacing/radius/type scale, no framework) |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Windows (the current target platform)

### Run in development

```bash
npm install
npm run tauri dev
```

### Build a production installer

```bash
npm run tauri build
```

The signed NSIS installer will be at `src-tauri/target/release/bundle/nsis/`.

## Project structure

```
beacon/
├── src/               React frontend (single-page dashboard)
├── src-tauri/         Rust backend — scanning, process management, tray, static server
└── .github/           README assets
```

## License

MIT — see [LICENSE](LICENSE).
