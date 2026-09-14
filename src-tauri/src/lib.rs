use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const SELF_NAME: &str = "beacon";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
struct ProjectInfo {
    name: String,
    path: String,
    framework: String,
    dev_script: Option<String>,
    scripts: HashMap<String, String>,
    favicon: Option<String>,
    /// "npm" (has package.json, started via `npm run <script>`) or
    /// "static" (a plain index.html folder, served by our own tiny
    /// built-in file server since there's no dev script to run).
    kind: String,
    /// "npm" | "yarn" | "pnpm" | "bun" — whichever one actually owns this
    /// project, so `<package_manager> run <script>` is used to start it
    /// instead of always assuming npm (a pnpm-workspace script like
    /// `pnpm --filter x dev` still runs fine under `npm run dev`, but a
    /// project that expects `yarn`/`pnpm` semantics for the run itself
    /// needs the real binary). Unused for "static" projects.
    package_manager: String,
}

/// A running static-file-server project. Parallels `RunningProcess` but
/// there's no OS child process to track — just a background thread we
/// signal to stop via `stop_flag`.
struct StaticServer {
    port: u16,
    started_at: u64,
    stop_flag: Arc<AtomicBool>,
}

type StaticServerMap = Mutex<HashMap<String, StaticServer>>;

#[derive(Serialize, Clone)]
struct RunningInfo {
    path: String,
    pid: u32,
    port: Option<u16>,
    script: String,
    started_at: u64,
}

#[derive(Serialize, Clone)]
struct StartResult {
    pid: u32,
    started_at: u64,
}

#[derive(Serialize, Clone)]
struct ProcStat {
    path: String,
    cpu: f32,
    mem_mb: f64,
}

struct RunningProcess {
    child: Child,
    port: Option<u16>,
    script: String,
    started_at: u64,
    /// Set just before we deliberately kill this process, so the reader
    /// thread can tell an intentional stop apart from a crash.
    stopping: bool,
    /// Set when the process's own output mentions its port is already
    /// taken, so we can surface a clearer reason than "crashed".
    port_conflict: bool,
}

type ProcessMap = Mutex<HashMap<String, RunningProcess>>;
type LastScan = Mutex<HashMap<String, ProjectInfo>>;
type SysState = Mutex<System>;

#[derive(Serialize, Clone)]
struct LogPayload {
    path: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct PortPayload {
    path: String,
    port: u16,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    path: String,
    unexpected: bool,
    reason: Option<String>,
    code: Option<i32>,
}

fn port_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})").unwrap()
    })
}

fn port_conflict_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)EADDRINUSE|address already in use|port .* is already in use").unwrap())
}

fn strip_ansi(line: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07]*\x07").unwrap());
    re.replace_all(line, "").to_string()
}

fn detect_framework(deps: &HashMap<String, serde_json::Value>) -> String {
    let has = |k: &str| deps.contains_key(k);
    if has("next") {
        "Next.js"
    } else if has("nuxt") {
        "Nuxt"
    } else if has("@remix-run/react") {
        "Remix"
    } else if has("astro") {
        "Astro"
    } else if has("@sveltejs/kit") {
        "SvelteKit"
    } else if has("svelte") {
        "Svelte"
    } else if has("@angular/core") {
        "Angular"
    } else if has("react-scripts") {
        "React (CRA)"
    } else if has("react") && has("vite") {
        "React (Vite)"
    } else if has("vue") {
        "Vue"
    } else if has("react") {
        "React"
    } else if has("@nestjs/core") {
        "NestJS"
    } else if has("express") {
        "Express"
    } else if has("fastify") {
        "Fastify"
    } else if has("vite") {
        "Vite"
    } else if has("@tauri-apps/api") {
        "Tauri"
    } else if has("electron") {
        "Electron"
    } else {
        "Node"
    }
    .to_string()
}

// Covers flat layouts, Next.js App Router (with or without a `src/`
// directory), common monorepo/static-asset conventions, and Tauri
// desktop apps (whose real icon lives under src-tauri/icons/, not any
// web-style favicon path — this is also where Beacon's own icon lives).
const FAVICON_DIRS: &[&str] = &[
    "",
    "public/",
    "static/",
    "app/",
    "src/app/",
    "src/",
    "src-tauri/icons/",
];
const FAVICON_FILES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "icon.svg",
    "icon.png",
    "icon.ico",
];

// Skip anything bigger than this rather than reading+base64-encoding a
// multi-MB brand logo into every scan — a real favicon is always tiny.
const MAX_FAVICON_BYTES: u64 = 512 * 1024;

fn read_favicon_bytes(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FAVICON_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

fn favicon_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "image/x-icon",
    }
}

/// Extracts the `href` of the first `<link rel="...icon...">` tag found in
/// `html`. Handles either quote style around attribute values (SVG data
/// URIs routinely contain literal single quotes inside a double-quoted
/// href, which a naive `[^"']*` pattern would truncate on).
fn html_favicon_href(html: &str) -> Option<String> {
    static LINK_RE: OnceLock<Regex> = OnceLock::new();
    let link_re = LINK_RE.get_or_init(|| Regex::new(r"(?is)<link\b([^>]*)>").unwrap());
    static REL_RE: OnceLock<Regex> = OnceLock::new();
    let rel_re = REL_RE
        .get_or_init(|| Regex::new(r#"(?i)\brel\s*=\s*(?:"[^"]*icon[^"]*"|'[^']*icon[^']*')"#).unwrap());
    static HREF_RE: OnceLock<Regex> = OnceLock::new();
    let href_re =
        HREF_RE.get_or_init(|| Regex::new(r#"(?i)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap());

    for cap in link_re.captures_iter(html) {
        let attrs = &cap[1];
        if !rel_re.is_match(attrs) {
            continue;
        }
        if let Some(h) = href_re.captures(attrs) {
            if let Some(href) = h.get(1).or_else(|| h.get(2)) {
                return Some(href.as_str().to_string());
            }
        }
    }
    None
}

// Bundlers like Vite/CRA serve everything under `public/` at the site
// root, so `index.html` commonly references e.g. `/vite.svg` even though
// the file physically lives at `<project>/public/vite.svg`. Retried in
// order after the direct root-relative resolution fails.
const HTML_ASSET_FALLBACK_DIRS: &[&str] = &["public/"];

/// Many plain HTML projects (no build step) inline their favicon directly
/// as a `data:` URI on the `<link rel="icon">` tag rather than shipping a
/// separate file — or point it at a relative path we didn't already try.
/// Parses `html_path` for that tag and resolves whatever it finds.
fn favicon_from_html(html_path: &Path, root: &Path) -> Option<String> {
    let html = std::fs::read_to_string(html_path).ok()?;
    let href = html_favicon_href(&html)?;
    if href.starts_with("data:") {
        return Some(href);
    }
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("//") {
        return None;
    }
    let clean = href.split(['?', '#']).next().unwrap_or(&href);
    let clean = clean.trim_start_matches('/');

    let mut candidates = vec![root.join(clean)];
    for dir in HTML_ASSET_FALLBACK_DIRS {
        candidates.push(root.join(dir).join(clean));
    }

    for path in candidates {
        if let Some(bytes) = read_favicon_bytes(&path) {
            if let Some(uri) = favicon_data_uri(bytes, &path) {
                return Some(uri);
            }
        }
    }
    None
}

// Known "unmodified scaffold" favicons. If a resolved icon's bytes match one
// of these byte-for-byte, the project never replaced its framework's stock
// icon — which is exactly why unrelated projects that also never customized
// it end up looking identical in the dashboard. Treated the same as having
// no favicon at all, so the UI falls back to a colored initial-letter avatar
// instead of a misleading default logo.
//
// The legacy Vite icon is checked directly against this repo's own leftover
// `public/vite.svg` scaffold file via `include_bytes!` (Beacon itself was
// originally scaffolded with `npm create vite`) — guaranteed byte-accurate,
// no hash to keep in sync. The rest are SHA-256 digests of each tool's
// official default template asset, computed once from upstream sources.
const DEFAULT_VITE_SVG_LEGACY: &[u8] = include_bytes!("../../public/vite.svg");

const DEFAULT_FAVICON_HASHES: &[&str] = &[
    // Vite (current) — create-vite/template-react-ts/public/favicon.svg
    "61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66",
    // Create React App — cra-template/template/public/logo192.png
    "c386396ec70db3608075b5fbfaac4ab1ccaa86ba05a68ab393ec551eb66c3e00",
    // Create React App — cra-template/template/public/favicon.ico
    "3d10f7da6c603178340081668c4ac5b3ae9743ca9a262ab0fcd312fbb9f48bdd",
    // Next.js (App Router) — create-next-app/templates/app/ts/app/favicon.ico
    "c28fdd2a4f31e2dc64f653962286da5c82a4cdfc518b242d32812c624e9a19a4",
];

fn is_default_scaffold_icon(bytes: &[u8]) -> bool {
    if bytes == DEFAULT_VITE_SVG_LEGACY {
        return true;
    }
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(bytes));
    DEFAULT_FAVICON_HASHES.contains(&digest.as_str())
}

/// Turns favicon bytes into a data URI, unless they're an unmodified
/// default scaffold icon — in which case this returns `None` so the caller
/// keeps looking (or falls back to no icon at all).
fn favicon_data_uri(bytes: Vec<u8>, path: &Path) -> Option<String> {
    if is_default_scaffold_icon(&bytes) {
        return None;
    }
    let mime = favicon_mime(path);
    Some(format!("data:{};base64,{}", mime, BASE64.encode(bytes)))
}

fn find_favicon(dir: &Path) -> Option<String> {
    for d in FAVICON_DIRS {
        for f in FAVICON_FILES {
            let path = dir.join(format!("{d}{f}"));
            if let Some(bytes) = read_favicon_bytes(&path) {
                if let Some(uri) = favicon_data_uri(bytes, &path) {
                    return Some(uri);
                }
            }
        }
    }
    // Fall back to parsing an inline/relative <link rel="icon"> straight
    // out of the HTML — very common for simple static projects.
    for candidate in ["index.html", "public/index.html"] {
        if let Some(icon) = favicon_from_html(&dir.join(candidate), dir) {
            return Some(icon);
        }
    }
    None
}

/// Figures out which package manager actually owns this project, so it can
/// be started with the right binary instead of always assuming npm.
/// Corepack's `packageManager` field in package.json (e.g. "pnpm@9.15.4")
/// is authoritative when present; otherwise fall back to whichever
/// lockfile is on disk.
fn detect_package_manager(dir: &Path, pkg: &serde_json::Value) -> String {
    if let Some(pm) = pkg.get("packageManager").and_then(|v| v.as_str()) {
        if let Some(name) = pm.split('@').next() {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm".to_string()
    } else if dir.join("yarn.lock").is_file() {
        "yarn".to_string()
    } else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
        "bun".to_string()
    } else {
        "npm".to_string()
    }
}

fn read_project(dir: &Path) -> Option<ProjectInfo> {
    let pkg_path = dir.join("package.json");
    let raw = std::fs::read_to_string(&pkg_path).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let mut deps: HashMap<String, serde_json::Value> = HashMap::new();
    for key in ["dependencies", "devDependencies"] {
        if let Some(obj) = pkg.get(key).and_then(|v| v.as_object()) {
            for (k, v) in obj {
                deps.insert(k.clone(), v.clone());
            }
        }
    }

    let scripts: HashMap<String, String> = pkg
        .get("scripts")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let dev_script = ["dev", "start", "serve"]
        .iter()
        .find(|s| scripts.contains_key(**s))
        .map(|s| s.to_string());

    // Use the actual folder name rather than package.json's "name" field —
    // that field is often stale (set once at scaffold time) or a scoped/
    // slugified value that no longer matches what's on disk, which confuses
    // users who renamed the folder after creating the project.
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();

    let package_manager = detect_package_manager(dir, &pkg);

    Some(ProjectInfo {
        name,
        path: dir.to_string_lossy().to_string(),
        framework: detect_framework(&deps),
        dev_script,
        scripts,
        favicon: find_favicon(dir),
        kind: "npm".to_string(),
        package_manager,
    })
}

/// A plain folder with an index.html and no package.json — a static
/// HTML/CSS/JS site with no build tooling, started via our own tiny
/// built-in file server rather than `npm run <script>`.
fn read_static_project(dir: &Path) -> Option<ProjectInfo> {
    if !dir.join("index.html").is_file() {
        return None;
    }
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    Some(ProjectInfo {
        name,
        path: dir.to_string_lossy().to_string(),
        framework: "HTML/CSS/JS".to_string(),
        dev_script: None,
        scripts: HashMap::new(),
        favicon: find_favicon(dir),
        kind: "static".to_string(),
        package_manager: "npm".to_string(),
    })
}

// Folder names that are meaningful inside a project but say nothing on
// their own in a flat dashboard list — two unrelated repos that both use
// a frontend/backend split would otherwise show two identically-named
// "frontend" cards. Matched case-insensitively against the literal
// subfolder name.
const GENERIC_NAMES: &[&str] = &[
    "frontend", "backend", "client", "server", "web", "app", "api", "ui",
    "src", "admin", "dashboard", "core", "www",
];

fn is_generic_name(name: &str) -> bool {
    GENERIC_NAMES.contains(&name.to_lowercase().as_str())
}

fn normalize_path(p: &Path) -> String {
    p.to_string_lossy().to_lowercase().replace('/', "\\")
}

/// Counts `dir`'s immediate subdirectories, ignoring node_modules and
/// dotfolders — used to tell a single-project "wrapper" folder (a couple
/// of items: the real code + maybe a README/notes file) apart from a
/// category folder that just happens to hold only one npm project among
/// many non-npm siblings.
fn count_subdirs(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    e.path().is_dir()
                        && !e.file_name().to_string_lossy().starts_with('.')
                        && e.file_name() != "node_modules"
                })
                .count()
        })
        .unwrap_or(0)
}

/// Scans `dir` for projects, up to `depth` levels down. Returns the
/// projects found directly within `dir`'s subtree (not including `dir`
/// itself, which the caller already checked).
///
/// A folder with its own package.json is always treated as an npm
/// project leaf — no further recursion. Otherwise we recurse *first*
/// (when depth allows) and only fall back to treating `dir` itself as a
/// static (index.html) project if recursion turned up nothing deeper.
/// This matters because a category folder (e.g. "HTML CSS JS Projects"
/// holding 30 unrelated demo folders) can itself have a stray top-level
/// index.html — a landing/index page for the whole collection — which
/// must not shadow the real projects nested one level below it.
///
/// If `dir` has no package.json of its own, its subtree contains exactly
/// one project nested deeper inside it, AND `dir` itself is a tight
/// single-purpose wrapper (few subdirectories — e.g. a folder named
/// "Veloci" whose real npm root ended up at "Veloci/app"), that project
/// is renamed to `dir`'s own folder name — that's almost always the
/// meaningful, user-chosen project name, whereas the deeply nested
/// folder ("app", "frontend", a lowercase slug, ...) is just scaffold
/// structure. The subdirectory-count check keeps this from misfiring on
/// a real category folder that just happens to contain only one project
/// among many unrelated siblings.
fn scan_dir(dir: &Path, depth: u32, excluded: &std::collections::HashSet<String>) -> Vec<ProjectInfo> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || matches!(name.as_str(), "node_modules" | "dist" | "build" | "target")
        {
            continue;
        }
        if excluded.contains(&normalize_path(&path)) {
            continue;
        }
        if path.join("package.json").is_file() {
            if let Some(info) = read_project(&path) {
                found.push(info);
            }
            continue;
        }
        let mut nested = if depth > 1 {
            scan_dir(&path, depth - 1, excluded)
        } else {
            Vec::new()
        };
        if nested.is_empty() {
            if let Some(info) = read_static_project(&path) {
                found.push(info);
            }
        } else {
            if nested.len() == 1 && count_subdirs(&path) <= 3 {
                nested[0].name = name.clone();
            } else if nested.len() > 1 {
                // Several sibling projects under one wrapper folder (e.g. a
                // frontend/backend split) — a generically-named one on its
                // own is ambiguous once it's flattened into the dashboard's
                // single project list, so tag it with the wrapper's name.
                for project in nested.iter_mut() {
                    if is_generic_name(&project.name) {
                        project.name = format!("{} ({})", name, project.name);
                    }
                }
            }
            found.append(&mut nested);
        }
    }
    found
}

#[tauri::command]
fn scan_projects(app: AppHandle, root: String, excluded: Vec<String>) -> Result<Vec<ProjectInfo>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("Folder not found: {}", root));
    }
    let excluded_set: std::collections::HashSet<String> =
        excluded.iter().map(|p| normalize_path(Path::new(p))).collect();

    let mut results = Vec::new();
    // The chosen folder may itself be a project rather than a folder of projects.
    if root_path.join("package.json").is_file() {
        if let Some(info) = read_project(root_path) {
            results.push(info);
        }
    } else if let Some(info) = read_static_project(root_path) {
        results.push(info);
    }
    // Deep enough to handle "category / wrapper-folder / actual-project"
    // layouts (common when a project's real root got nested a level
    // deeper than its containing folder) without being a real perf cost —
    // node_modules and dotfolders are always skipped.
    results.extend(scan_dir(root_path, 5, &excluded_set));
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let last_scan: State<'_, LastScan> = app.state();
    let mut map = last_scan.lock().unwrap();
    for info in &results {
        map.insert(info.path.clone(), info.clone());
    }

    Ok(results)
}

/// A dev server printing its port banner doesn't mean it's accepting
/// connections yet (it may still be compiling the first request). Poll the
/// port briefly on a background thread before telling the frontend it's
/// ready, so a click on "Open"/"Preview" is less likely to land on a bare
/// connection refusal. Bounded so a port that never becomes reachable some
/// other way doesn't leave the UI stuck at "detecting port…" forever — it's
/// still announced once the window elapses, just without that extra
/// confidence. Re-checks that the project is still running before emitting,
/// so a project that crashed mid-verification doesn't get resurrected by a
/// stale port event racing the exit event.
fn spawn_port_verifier(app: AppHandle, path: String, port: u16) {
    std::thread::spawn(move || {
        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        let still_running = {
            let state: State<'_, ProcessMap> = app.state();
            let running = state.lock().unwrap().contains_key(&path);
            running
        };
        if still_running {
            let _ = app.emit("project-port", PortPayload { path, port });
        }
    });
}

fn spawn_reader_threads(app: &AppHandle, child: &mut Child, path: &str) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    for pipe in [
        stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        let path = path.to_string();
        std::thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for raw_line in reader.lines().map_while(Result::ok) {
                let line = strip_ansi(&raw_line);
                if let Some(caps) = port_regex().captures(&line) {
                    if let Ok(port) = caps[1].parse::<u16>() {
                        let should_verify = {
                            let state: State<'_, ProcessMap> = app.state();
                            let mut map = state.lock().unwrap();
                            match map.get_mut(&path) {
                                Some(proc) if proc.port.is_none() => {
                                    proc.port = Some(port);
                                    true
                                }
                                _ => false,
                            }
                        };
                        if should_verify {
                            spawn_port_verifier(app.clone(), path.clone(), port);
                        }
                    }
                }
                if port_conflict_regex().is_match(&line) {
                    let state: State<'_, ProcessMap> = app.state();
                    let mut map = state.lock().unwrap();
                    if let Some(proc) = map.get_mut(&path) {
                        proc.port_conflict = true;
                    }
                }
                let _ = app.emit("project-log", LogPayload { path: path.clone(), line });
            }
            // Pipe closed — the process is exiting. Only the stdout-side
            // cleanup matters; whichever thread gets here first wins.
            let state: State<'_, ProcessMap> = app.state();
            let mut map = state.lock().unwrap();
            if let Some(mut proc) = map.remove(&path) {
                let status = proc.child.wait().ok();
                let unexpected = !proc.stopping;
                let reason = if proc.port_conflict {
                    Some("port_conflict".to_string())
                } else if unexpected {
                    Some("crashed".to_string())
                } else {
                    None
                };
                let code = status.and_then(|s| s.code());
                let _ = app.emit(
                    "project-exited",
                    ExitPayload { path: path.clone(), unexpected, reason, code },
                );
            }
        });
    }
}

fn do_start(
    app: &AppHandle,
    path: String,
    script: String,
    package_manager: String,
    port: Option<u16>,
) -> Result<StartResult, String> {
    let state: State<'_, ProcessMap> = app.state();
    {
        let map = state.lock().unwrap();
        if map.contains_key(&path) {
            return Err("Project is already running".into());
        }
    }

    let mut cmd = Command::new("cmd");
    cmd.args(["/C", &package_manager, "run", &script])
        .current_dir(&path)
        .env("NO_COLOR", "1")
        .env_remove("FORCE_COLOR")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Respected by Vite, CRA, Express, and most Node servers that read
    // `process.env.PORT`. A plain `next dev` doesn't honor it (it only
    // listens to the `-p` flag), so this is a best-effort override rather
    // than a guarantee — still the right lever for the common case where
    // the project's default port is already taken by something else.
    if let Some(p) = port {
        cmd.env("PORT", p.to_string());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start: {}", e))?;
    let pid = child.id();
    let started_at = now_ms();

    spawn_reader_threads(app, &mut child, &path);

    let mut map = state.lock().unwrap();
    map.insert(
        path,
        RunningProcess {
            child,
            port: None,
            script,
            started_at,
            stopping: false,
            port_conflict: false,
        },
    );
    Ok(StartResult { pid, started_at })
}

#[tauri::command]
fn start_project(
    app: AppHandle,
    path: String,
    script: String,
    package_manager: String,
    port: Option<u16>,
) -> Result<StartResult, String> {
    do_start(&app, path, script, package_manager, port)
}

fn static_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Resolves a URL path against `root`, rejecting any `..` segment so a
/// request can never escape the project folder. Directory-like requests
/// (empty path, or a path pointing at a real directory) fall back to
/// index.html.
fn resolve_static_path(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = url_decode(url_path.split('?').next().unwrap_or("/"));
    let mut file_path = root.to_path_buf();
    for seg in decoded.trim_start_matches('/').split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        file_path.push(seg);
    }
    if file_path.is_dir() {
        file_path.push("index.html");
    }
    Some(file_path)
}

fn handle_static_request(mut stream: TcpStream, root: &Path, app: &AppHandle, log_path: &str) {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let request = String::from_utf8_lossy(&buf[..n]);
    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let raw_path = parts.next().unwrap_or("/");

    let Some(file_path) = resolve_static_path(root, raw_path) else {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };

    let (status_line, content_type, body) = match std::fs::read(&file_path) {
        Ok(bytes) => ("HTTP/1.1 200 OK", static_mime(&file_path), bytes),
        Err(_) => (
            "HTTP/1.1 404 Not Found",
            "text/plain; charset=utf-8",
            b"404 Not Found".to_vec(),
        ),
    };

    let _ = app.emit(
        "project-log",
        LogPayload {
            path: log_path.to_string(),
            line: format!("{method} {raw_path} -> {}", &status_line[9..12]),
        },
    );

    let header = format!(
        "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&body);
}

fn serve_static(app: AppHandle, path: String, listener: TcpListener, stop_flag: Arc<AtomicBool>) {
    listener.set_nonblocking(true).ok();
    let root = PathBuf::from(&path);
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let root = root.clone();
                let app2 = app.clone();
                let path2 = path.clone();
                std::thread::spawn(move || handle_static_request(stream, &root, &app2, &path2));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    let state: State<'_, StaticServerMap> = app.state();
    state.lock().unwrap().remove(&path);
    let _ = app.emit(
        "project-exited",
        ExitPayload { path, unexpected: false, reason: None, code: None },
    );
}

fn do_start_static(app: &AppHandle, path: String, port: Option<u16>) -> Result<StartResult, String> {
    {
        let state: State<'_, ProcessMap> = app.state();
        let sstate: State<'_, StaticServerMap> = app.state();
        if state.lock().unwrap().contains_key(&path) || sstate.lock().unwrap().contains_key(&path)
        {
            return Err("Project is already running".into());
        }
    }

    let addr = format!("127.0.0.1:{}", port.unwrap_or(0));
    let listener = TcpListener::bind(&addr).map_err(|e| match port {
        Some(p) => format!("Port {p} is already in use"),
        None => format!("Failed to start: {e}"),
    })?;
    let bound_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to start: {}", e))?
        .port();
    let started_at = now_ms();
    let stop_flag = Arc::new(AtomicBool::new(false));

    {
        let sstate: State<'_, StaticServerMap> = app.state();
        sstate.lock().unwrap().insert(
            path.clone(),
            StaticServer { port: bound_port, started_at, stop_flag: stop_flag.clone() },
        );
    }

    let app2 = app.clone();
    let path2 = path.clone();
    std::thread::spawn(move || serve_static(app2, path2, listener, stop_flag));

    let _ = app.emit("project-port", PortPayload { path: path.clone(), port: bound_port });

    Ok(StartResult { pid: 0, started_at })
}

#[tauri::command]
fn start_static_project(app: AppHandle, path: String, port: Option<u16>) -> Result<StartResult, String> {
    do_start_static(&app, path, port)
}

fn do_stop_static(app: &AppHandle, path: &str) -> Result<(), String> {
    let sstate: State<'_, StaticServerMap> = app.state();
    let map = sstate.lock().unwrap();
    let server = map.get(path).ok_or("Project is not running")?;
    server.stop_flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn stop_static_project(app: AppHandle, path: String) -> Result<(), String> {
    do_stop_static(&app, &path)
}

fn kill_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd.output();
}

fn do_stop(app: &AppHandle, path: &str) -> Result<(), String> {
    let state: State<'_, ProcessMap> = app.state();
    let pid = {
        let mut map = state.lock().unwrap();
        let proc = map.get_mut(path).ok_or("Project is not running")?;
        proc.stopping = true;
        proc.child.id()
    };
    // taskkill /T kills the whole npm -> node tree; the reader thread
    // notices the closed pipe and removes the entry + emits the event.
    kill_tree(pid);
    Ok(())
}

#[tauri::command]
fn stop_project(app: AppHandle, path: String) -> Result<(), String> {
    do_stop(&app, &path)
}

#[tauri::command]
fn get_running(state: State<'_, ProcessMap>, static_state: State<'_, StaticServerMap>) -> Vec<RunningInfo> {
    let mut result: Vec<RunningInfo> = state
        .lock()
        .unwrap()
        .iter()
        .map(|(path, proc)| RunningInfo {
            path: path.clone(),
            pid: proc.child.id(),
            port: proc.port,
            script: proc.script.clone(),
            started_at: proc.started_at,
        })
        .collect();
    result.extend(static_state.lock().unwrap().iter().map(|(path, s)| RunningInfo {
        path: path.clone(),
        pid: 0,
        port: Some(s.port),
        script: "static".to_string(),
        started_at: s.started_at,
    }));
    result
}

#[tauri::command]
fn get_process_stats(state: State<'_, ProcessMap>, sys: State<'_, SysState>) -> Vec<ProcStat> {
    let map = state.lock().unwrap();
    if map.is_empty() {
        return Vec::new();
    }
    let pids: Vec<Pid> = map
        .values()
        .map(|proc| Pid::from_u32(proc.child.id()))
        .collect();
    let mut system = sys.lock().unwrap();
    system.refresh_processes(ProcessesToUpdate::Some(&pids), true);
    map.iter()
        .filter_map(|(path, proc)| {
            let pid = Pid::from_u32(proc.child.id());
            system.process(pid).map(|p| ProcStat {
                path: path.clone(),
                cpu: p.cpu_usage(),
                mem_mb: p.memory() as f64 / 1024.0 / 1024.0,
            })
        })
        .collect()
}

/// Open the project folder in VS Code (`code .`). No-op error if `code` is not on PATH.
#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "code", "."]).current_dir(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open VS Code: {}", e))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn tray_start_all(app: &AppHandle) {
    let (already_running, candidates): (std::collections::HashSet<String>, Vec<ProjectInfo>) = {
        let state: State<'_, ProcessMap> = app.state();
        let sstate: State<'_, StaticServerMap> = app.state();
        let mut running: std::collections::HashSet<String> =
            state.lock().unwrap().keys().cloned().collect();
        running.extend(sstate.lock().unwrap().keys().cloned());
        let last_scan: State<'_, LastScan> = app.state();
        let all = last_scan.lock().unwrap().values().cloned().collect();
        (running, all)
    };
    for info in candidates {
        if info.name == SELF_NAME || already_running.contains(&info.path) {
            continue;
        }
        if info.kind == "static" {
            let _ = do_start_static(app, info.path, None);
        } else if let Some(script) = info.dev_script.clone() {
            let _ = do_start(app, info.path, script, info.package_manager.clone(), None);
        }
    }
}

fn tray_stop_all(app: &AppHandle) {
    let state: State<'_, ProcessMap> = app.state();
    let paths: Vec<String> = state.lock().unwrap().keys().cloned().collect();
    for path in paths {
        let _ = do_stop(app, &path);
    }
    let sstate: State<'_, StaticServerMap> = app.state();
    let spaths: Vec<String> = sstate.lock().unwrap().keys().cloned().collect();
    for path in spaths {
        let _ = do_stop_static(app, &path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered. If Beacon is launched again
        // while an instance is already running (e.g. hidden in the tray),
        // this fires in the *original* instance instead of starting a
        // second one — so relaunching from the Start Menu / desktop icon
        // is always a reliable way to bring the window back.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ProcessMap::default())
        .manage(StaticServerMap::default())
        .manage(LastScan::default())
        .manage(SysState::new(System::new_all()))
        .invoke_handler(tauri::generate_handler![
            scan_projects,
            start_project,
            stop_project,
            start_static_project,
            stop_static_project,
            get_running,
            get_process_stats,
            open_in_editor,
            quit_app
        ])
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show Beacon", true, None::<&str>)?;
            let start_all_item =
                MenuItem::with_id(app, "start_all", "Start All Servers", true, None::<&str>)?;
            let stop_all_item =
                MenuItem::with_id(app, "stop_all", "Stop All Servers", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Beacon", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &PredefinedMenuItem::separator(app)?,
                    &start_all_item,
                    &stop_all_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Beacon")
                // Right-click already shows the menu natively; without this,
                // some platforms also pop the menu on left-click, which
                // fights with our own left-click show/hide toggle below.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "start_all" => tray_start_all(app),
                    "stop_all" => tray_stop_all(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // A tray click fires this event on both button-down and
                    // button-up — matching unconditionally toggled the
                    // window twice per click (show then immediately hide
                    // again), which looked like nothing happened. Only act
                    // on the left-button release.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            if visible {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Kill every dev server we spawned so nothing is orphaned.
                let state: State<'_, ProcessMap> = app.state();
                let pids: Vec<u32> = state
                    .lock()
                    .unwrap()
                    .values()
                    .map(|p| p.child.id())
                    .collect();
                for pid in pids {
                    kill_tree(pid);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_test_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("beacon-test-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_package_json(dir: &Path, name: &str) {
        fs::write(
            dir.join("package.json"),
            format!(
                r#"{{"name":"{name}","scripts":{{"dev":"vite"}},"dependencies":{{"react":"^18","vite":"^5"}}}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn generic_name_detection_is_case_insensitive() {
        assert!(is_generic_name("frontend"));
        assert!(is_generic_name("Frontend"));
        assert!(is_generic_name("BACKEND"));
        assert!(!is_generic_name("my-cool-app"));
        assert!(!is_generic_name(""));
    }

    #[test]
    fn sibling_generic_projects_get_disambiguated() {
        let root = temp_test_dir("siblings");
        let wrapper = root.join("PortfolioSite");
        fs::create_dir_all(wrapper.join("frontend")).unwrap();
        fs::create_dir_all(wrapper.join("backend")).unwrap();
        write_package_json(&wrapper.join("frontend"), "frontend");
        write_package_json(&wrapper.join("backend"), "backend");

        let excluded = std::collections::HashSet::new();
        let found = scan_dir(&root, 5, &excluded);

        let mut names: Vec<String> = found.iter().map(|p| p.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["PortfolioSite (backend)", "PortfolioSite (frontend)"]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn non_generic_sibling_names_are_untouched() {
        let root = temp_test_dir("siblings-named");
        let wrapper = root.join("Monorepo");
        fs::create_dir_all(wrapper.join("shop-storefront")).unwrap();
        fs::create_dir_all(wrapper.join("shop-admin")).unwrap();
        write_package_json(&wrapper.join("shop-storefront"), "shop-storefront");
        write_package_json(&wrapper.join("shop-admin"), "shop-admin");

        let excluded = std::collections::HashSet::new();
        let found = scan_dir(&root, 5, &excluded);

        let mut names: Vec<String> = found.iter().map(|p| p.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["shop-admin", "shop-storefront"]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn single_nested_project_still_uses_wrapper_name() {
        let root = temp_test_dir("single-nested");
        let wrapper = root.join("Veloci");
        fs::create_dir_all(wrapper.join("app")).unwrap();
        write_package_json(&wrapper.join("app"), "app");

        let excluded = std::collections::HashSet::new();
        let found = scan_dir(&root, 5, &excluded);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Veloci");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn default_vite_favicon_is_suppressed() {
        assert!(is_default_scaffold_icon(DEFAULT_VITE_SVG_LEGACY));
        assert!(!is_default_scaffold_icon(b"<svg>a totally custom logo</svg>"));
    }
}
