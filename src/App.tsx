import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type {
  ExitInfo,
  LogLine,
  ProcStat,
  ProjectInfo,
  ProjectState,
  RunningInfo,
  StartResult,
} from "./types";
import "./App.css";

const MAX_LOG_LINES = 500;
const HISTORY_LEN = 40;
const SELF_NAME = "beacon";

const FRAMEWORK_COLORS: Record<string, string> = {
  "Next.js": "#e2e8f0",
  "React (Vite)": "#61dafb",
  "React (CRA)": "#61dafb",
  React: "#61dafb",
  Vue: "#42b883",
  Nuxt: "#00dc82",
  Svelte: "#ff3e00",
  SvelteKit: "#ff3e00",
  Angular: "#dd0031",
  Astro: "#ff5d01",
  Remix: "#8c9eff",
  Express: "#facc15",
  Fastify: "#facc15",
  NestJS: "#ea2845",
  Vue2: "#42b883",
  Vite: "#a78bfa",
  Tauri: "#ffc131",
  Electron: "#9feaf9",
  Node: "#8cc84b",
  "HTML/CSS/JS": "#e34c26",
};

const frameworkColor = (fw: string) => FRAMEWORK_COLORS[fw] ?? "#94a3b8";

function fmtUptime(startedAt: number | null, now: number): string {
  if (!startedAt) return "—";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/* ------------------------------- icons -------------------------------- */

type IconName =
  | "grid"
  | "gear"
  | "power"
  | "play"
  | "stop"
  | "restart"
  | "folder"
  | "code"
  | "link"
  | "search"
  | "pin"
  | "refresh"
  | "bolt"
  | "terminal"
  | "star"
  | "eye"
  | "expand"
  | "close"
  | "bell"
  | "info";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "grid":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "power":
      return (
        <svg {...common}>
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
          <line x1="12" y1="2" x2="12" y2="12" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "restart":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <line x1="12" y1="17" x2="12" y2="22" />
          <path d="M9 9V4h6v5l3 3v2H6v-2l3-3Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...common}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <polyline points="7 9 11 12.5 7 16" />
          <line x1="12.5" y1="16" x2="17" y2="16" />
        </svg>
      );
    case "star":
      return (
        <svg {...common}>
          <path
            d="M12 3.5 14.7 9 20.8 9.9 16.4 14.2 17.4 20.3 12 17.4 6.6 20.3 7.6 14.2 3.2 9.9 9.3 9 12 3.5Z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7-10.5-7-10.5-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "expand":
      return (
        <svg {...common}>
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M16 3h3a2 2 0 0 1 2 2v3" />
          <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      );
    case "info":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <line x1="12" y1="7.5" x2="12" y2="7.51" />
        </svg>
      );
  }
}

function LogoMark({ size = 30 }: { size?: number }) {
  const uid = useId();
  const gid = `logo-bg-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <rect x="2" y="2" width="44" height="44" rx="12" fill={`url(#${gid})`} />
      <g stroke="none" fill="#06180d">
        <circle cx="24" cy="18" r="4.4" opacity="0.9" />
        <path d="M21.6 21 17.2 27.8" stroke="#06180d" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M26.4 21 30.8 27.8" stroke="#06180d" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="16.4" cy="29.6" r="3.1" />
        <circle cx="31.6" cy="29.6" r="3.1" />
      </g>
      <defs>
        <linearGradient id={gid} x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3ff08a" />
          <stop offset="1" stopColor="#16a34a" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function LogoWordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="logo-word" style={{ fontSize: size }}>
      Beacon
    </span>
  );
}

/* ---------------------------- project icon ----------------------------- */

function ProjectIcon({ p, size = 22 }: { p: ProjectState; size?: number }) {
  if (!p.info.favicon) {
    return <span className={`dot ${p.status}`} />;
  }
  return (
    <span className="proj-icon" style={{ width: size, height: size }}>
      <img src={p.info.favicon} alt="" />
      <span className={`dot corner ${p.status}`} />
    </span>
  );
}

/* ---------------------------- project card ----------------------------- */

const ProjectCard = memo(function ProjectCard({
  p,
  color,
  self,
  isSel,
  pinned,
  now,
  onSelect,
  onTogglePin,
  onStart,
  onStop,
  onRestart,
  onPreview,
}: {
  p: ProjectState;
  color: string;
  self: boolean;
  isSel: boolean;
  pinned: boolean;
  now: number;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onStart: (path: string) => void;
  onStop: (path: string) => void;
  onRestart: (path: string) => void;
  onPreview: (path: string) => void;
}) {
  return (
    <div
      className={`card ${p.status} ${isSel ? "selected" : ""}`}
      onClick={() => onSelect(p.info.path)}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(p.info.path);
        }
      }}
    >
      <div className="card-head">
        <ProjectIcon p={p} size={22} />
        <span className="card-name" title={p.info.path}>
          {p.info.name}
        </span>
        <button
          className={`pin ${pinned ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(p.info.path);
          }}
          title={pinned ? "Unpin" : "Pin to top"}
        >
          <Icon name="pin" size={14} />
        </button>
      </div>

      <div className="card-badges">
        <span className="badge" style={{ color, borderColor: color }}>
          {p.info.framework}
        </span>
        {p.status === "running" && p.started_at && (
          <span className="uptime">
            ↑ {fmtUptime(p.started_at, now)}
            {p.cpu != null && ` · ${p.cpu.toFixed(0)}%`}
            {p.memMb != null && ` · ${p.memMb.toFixed(0)}MB`}
          </span>
        )}
      </div>

      <div className="card-meta">
        {p.status === "running" && p.port ? (
          <button
            className="port-link"
            onClick={(e) => {
              e.stopPropagation();
              openUrl(`http://localhost:${p.port}`).catch(() => {});
            }}
          >
            localhost:{p.port} <Icon name="link" size={12} />
          </button>
        ) : p.status === "starting" ? (
          <span className="meta-text amber">starting…</span>
        ) : p.status === "running" ? (
          <span className="meta-text">running · detecting port…</span>
        ) : (
          <span className="meta-text">
            {p.info.kind === "static"
              ? "Static HTML/CSS/JS"
              : p.info.dev_script
                ? `${p.info.package_manager} run ${p.info.dev_script}`
                : "no dev script"}
          </span>
        )}
      </div>

      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        {p.status === "stopped" ? (
          <button
            className="btn primary grow"
            disabled={(p.info.kind === "npm" && !p.info.dev_script) || self}
            title={self ? "That's Beacon itself!" : undefined}
            onClick={() => onStart(p.info.path)}
          >
            <Icon name="play" size={13} /> Start
          </button>
        ) : (
          <>
            <button className="btn danger grow" onClick={() => onStop(p.info.path)}>
              <Icon name="stop" size={13} /> Stop
            </button>
            <button
              className="btn icon"
              onClick={() => onRestart(p.info.path)}
              title="Restart"
            >
              <Icon name="restart" size={15} />
            </button>
          </>
        )}
        {p.status === "running" && p.port && (
          <button className="btn icon" onClick={() => onPreview(p.info.path)} title="Preview site">
            <Icon name="eye" size={15} />
          </button>
        )}
        <button
          className="btn icon"
          onClick={() => revealItemInDir(p.info.path).catch(() => {})}
          title="Reveal in Explorer"
        >
          <Icon name="folder" size={15} />
        </button>
      </div>
    </div>
  );
});

/* ----------------------------- sparkline ------------------------------ */

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 120;
  const h = 38;
  const pad = 3;
  const gid = `sg-${color.replace(/[^a-z0-9]/gi, "")}`;
  if (data.length < 2) {
    return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" />;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const xAt = (i: number) => (i / (data.length - 1)) * w;
  const yAt = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2);
  const line = data.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.3" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PathList({ items, onRemove }: { items: string[]; onRemove: (path: string) => void }) {
  return (
    <div className="root-list">
      {items.map((r) => (
        <div className="root-row" key={r}>
          <code className="path-box inline">{r}</code>
          <button className="btn icon sm" onClick={() => onRemove(r)} title="Remove">
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  subColor,
  accent,
  data,
}: {
  label: string;
  value: string | number;
  sub?: string;
  subColor?: string;
  accent: string;
  data: number[];
}) {
  return (
    <div className="stat">
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {sub && (
          <span className="stat-sub" style={{ color: subColor }}>
            {sub}
          </span>
        )}
      </div>
      <div className="stat-row">
        <span className="stat-value">{value}</span>
        <Sparkline data={data} color={accent} />
      </div>
    </div>
  );
}

/* -------------------------------- app --------------------------------- */

function App() {
  const [roots, setRoots] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("beacon-roots") ?? localStorage.getItem("servo-roots");
      if (stored) return JSON.parse(stored);
    } catch {
      // fall through to legacy migration
    }
    const legacy =
      localStorage.getItem("servo-root") ?? localStorage.getItem("devdeck-root");
    return legacy ? [legacy] : [];
  });
  const [projects, setProjects] = useState<Record<string, ProjectState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fwFilter, setFwFilter] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "logs" | "settings">("dashboard");
  const [quickFilter, setQuickFilter] = useState<"all" | "running" | "pinned">("all");
  const [logsSelected, setLogsSelected] = useState<string | null>(null);
  const [notifPermission, setNotifPermission] = useState<boolean | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<
    "idle" | "checking" | "available" | "none" | "downloading" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pendingUpdate = useRef<Update | null>(null);
  const [previewProject, setPreviewProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [runHistory, setRunHistory] = useState<number[]>([]);
  const [logHistory, setLogHistory] = useState<number[]>([]);
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("beacon-pins") ?? localStorage.getItem("servo-pins");
      return new Set(JSON.parse(stored ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [excluded, setExcluded] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("beacon-excluded") ?? "[]");
    } catch {
      return [];
    }
  });

  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const restartPending = useRef<Set<string>>(new Set());
  const logCounter = useRef(0);
  const logIdCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const scan = useCallback(async (rootList: string[]) => {
    if (rootList.length === 0) {
      setProjects({});
      return;
    }
    setScanning(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        rootList.map((r) => invoke<ProjectInfo[]>("scan_projects", { root: r, excluded }))
      );
      const found: ProjectInfo[] = [];
      const failed: string[] = [];
      results.forEach((res, i) => {
        if (res.status === "fulfilled") found.push(...res.value);
        else failed.push(rootList[i]);
      });
      const running = await invoke<RunningInfo[]>("get_running");
      const runningByPath = new Map(running.map((r) => [r.path, r]));
      setProjects((prev) => {
        const next: Record<string, ProjectState> = {};
        for (const info of found) {
          const live = runningByPath.get(info.path);
          const old = prev[info.path];
          next[info.path] = {
            info,
            status: live ? "running" : "stopped",
            pid: live?.pid ?? null,
            port: live?.port ?? null,
            started_at: live?.started_at ?? null,
            logs: old?.logs ?? [],
            cpu: old?.cpu ?? null,
            memMb: old?.memMb ?? null,
          };
        }
        return next;
      });
      if (failed.length > 0) {
        setError(`Couldn't scan: ${failed.join(", ")}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [excluded]);

  useEffect(() => {
    scan(roots);
  }, [roots, scan]);

  // Ask for OS notification permission once, so crash alerts can surface
  // even when the window is hidden in the tray.
  useEffect(() => {
    isPermissionGranted()
      .then((granted) => {
        setNotifPermission(granted);
        if (!granted) {
          requestPermission()
            .then((res) => setNotifPermission(res === "granted"))
            .catch(() => setNotifPermission(false));
        }
      })
      .catch(() => setNotifPermission(false));
  }, []);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // Poll live CPU/RAM for running processes.
  useEffect(() => {
    const id = setInterval(async () => {
      const hasRunning = Object.values(projectsRef.current).some((p) => p.status !== "stopped");
      if (!hasRunning) return;
      try {
        const stats = await invoke<ProcStat[]>("get_process_stats");
        const byPath = new Map(stats.map((s) => [s.path, s]));
        setProjects((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [path, p] of Object.entries(prev)) {
            const s = byPath.get(path);
            const cpu = s ? s.cpu : null;
            const memMb = s ? s.mem_mb : null;
            if (p.cpu !== cpu || p.memMb !== memMb) {
              next[path] = { ...p, cpu, memMb };
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      } catch {
        // transient — try again next tick
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);

  // Live listeners for backend events.
  useEffect(() => {
    const unlisteners = [
      listen<{ path: string; line: string }>("project-log", (e) => {
        const { path, line } = e.payload;
        logCounter.current += 1;
        setProjects((prev) => {
          const p = prev[path];
          if (!p) return prev;
          const entry: LogLine = { id: ++logIdCounter.current, text: line };
          const logs = [...p.logs, entry].slice(-MAX_LOG_LINES);
          const status = p.status === "starting" ? "running" : p.status;
          return { ...prev, [path]: { ...p, logs, status } };
        });
      }),
      listen<{ path: string; port: number }>("project-port", (e) => {
        const { path, port } = e.payload;
        setProjects((prev) => {
          const p = prev[path];
          if (!p) return prev;
          return { ...prev, [path]: { ...p, port, status: "running" } };
        });
      }),
      listen<ExitInfo>("project-exited", (e) => {
        const { path, unexpected, reason, code } = e.payload;
        const name = projectsRef.current[path]?.info.name ?? path;
        const warnLine =
          reason === "port_conflict"
            ? "⚠ Exited — port already in use by another process."
            : `⚠ Exited unexpectedly${code != null ? ` (code ${code})` : ""}.`;
        setProjects((prev) => {
          const p = prev[path];
          if (!p) return prev;
          return {
            ...prev,
            [path]: {
              ...p,
              status: "stopped",
              pid: null,
              port: null,
              started_at: null,
              cpu: null,
              memMb: null,
              logs: unexpected
                ? [...p.logs, { id: ++logIdCounter.current, text: warnLine }].slice(
                    -MAX_LOG_LINES
                  )
                : p.logs,
            },
          };
        });
        if (unexpected) {
          try {
            sendNotification({
              title: name,
              body:
                reason === "port_conflict"
                  ? "Port already in use by another process."
                  : `Exited unexpectedly${code != null ? ` (code ${code})` : ""}.`,
            });
          } catch {
            // notifications are best-effort — a failure here shouldn't matter
          }
        }
        if (restartPending.current.has(path)) {
          restartPending.current.delete(path);
          setTimeout(() => startProject(path), 450);
        }
      }),
    ];
    return () => {
      unlisteners.forEach((u) => u.then((fn) => fn()).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1s clock for uptime.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 2s sampler for the sparklines.
  useEffect(() => {
    const id = setInterval(() => {
      const running = Object.values(projectsRef.current).filter(
        (p) => p.status !== "stopped"
      ).length;
      setRunHistory((h) => [...h, running].slice(-HISTORY_LEN));
      setLogHistory((h) => [...h, logCounter.current].slice(-HISTORY_LEN));
      logCounter.current = 0;
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Auto-follow the log tail, but only when the user hasn't scrolled up to
  // read history, and only in response to the currently visible project's
  // own log growth (not every unrelated stats/port/exit update).
  const logScrollKeyRef = useRef<string>("");
  const activeLogsPath = view === "logs" ? logsSelected : selected;
  const currentLogsLen = (activeLogsPath ? projects[activeLogsPath]?.logs.length : undefined) ?? 0;

  useEffect(() => {
    const key = `${view}:${activeLogsPath ?? ""}`;
    const switched = logScrollKeyRef.current !== key;
    logScrollKeyRef.current = key;

    const container = logEndRef.current?.parentElement;
    if (!container) return;

    const nearBottom =
      switched || container.scrollHeight - container.scrollTop - container.clientHeight < 48;

    if (nearBottom) {
      logEndRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, logsSelected, view, currentLogsLen]);

  // Auto-close the preview modal if its project stops or loses its port.
  useEffect(() => {
    if (!previewProject) return;
    const p = projects[previewProject];
    if (!p || p.status !== "running" || !p.port) setPreviewProject(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, previewProject]);

  // Keep the Logs page pointed at a running project.
  useEffect(() => {
    if (view !== "logs") return;
    const stillRunning = logsSelected && projects[logsSelected]?.status !== "stopped";
    if (!stillRunning) {
      const firstRunning = Object.values(projects).find((p) => p.status !== "stopped");
      setLogsSelected(firstRunning?.info.path ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, projects]);

  function persistRoots(next: string[]) {
    localStorage.setItem("beacon-roots", JSON.stringify(next));
  }

  async function addRoot() {
    const selectedFolder = await openDialog({
      directory: true,
      title: "Choose a projects folder",
    });
    if (typeof selectedFolder === "string") {
      setRoots((prev) => {
        if (prev.includes(selectedFolder)) return prev;
        const next = [...prev, selectedFolder];
        persistRoots(next);
        return next;
      });
      setView("dashboard");
    }
  }

  function removeRoot(r: string) {
    setRoots((prev) => {
      const next = prev.filter((x) => x !== r);
      persistRoots(next);
      return next;
    });
  }

  function persistExcluded(next: string[]) {
    localStorage.setItem("beacon-excluded", JSON.stringify(next));
  }

  async function addExcluded() {
    const selectedFolder = await openDialog({
      directory: true,
      title: "Choose a folder to exclude from scanning",
    });
    if (typeof selectedFolder === "string") {
      setExcluded((prev) => {
        if (prev.includes(selectedFolder)) return prev;
        const next = [...prev, selectedFolder];
        persistExcluded(next);
        return next;
      });
    }
  }

  function removeExcluded(r: string) {
    setExcluded((prev) => {
      const next = prev.filter((x) => x !== r);
      persistExcluded(next);
      return next;
    });
  }

  const startProject = useCallback(async (path: string) => {
    const p = projectsRef.current[path];
    if (!p) return;
    if (p.info.kind === "npm" && !p.info.dev_script) return;
    setError(null);
    setProjects((prev) => ({
      ...prev,
      [path]: {
        ...prev[path],
        status: "starting",
        logs: [],
        port: null,
        started_at: null,
        cpu: null,
        memMb: null,
      },
    }));
    try {
      const res =
        p.info.kind === "static"
          ? await invoke<StartResult>("start_static_project", { path })
          : await invoke<StartResult>("start_project", {
              path,
              script: p.info.dev_script as string,
              packageManager: p.info.package_manager,
            });
      setProjects((prev) => {
        const cur = prev[path];
        if (!cur) return prev;
        return { ...prev, [path]: { ...cur, pid: res.pid, started_at: res.started_at } };
      });
    } catch (e) {
      setError(String(e));
      setProjects((prev) => {
        const cur = prev[path];
        if (!cur) return prev;
        return { ...prev, [path]: { ...cur, status: "stopped" } };
      });
    }
  }, []);

  const stopProject = useCallback(async (path: string) => {
    const p = projectsRef.current[path];
    try {
      if (p?.info.kind === "static") {
        await invoke("stop_static_project", { path });
      } else {
        await invoke("stop_project", { path });
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const restartProject = useCallback(
    async (path: string) => {
      restartPending.current.add(path);
      await stopProject(path);
    },
    [stopProject]
  );

  const togglePin = useCallback((path: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem("beacon-pins", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setUpdateState("checking");
    setUpdateError(null);
    try {
      const update = await checkUpdate();
      if (update) {
        pendingUpdate.current = update;
        setUpdateInfo({ version: update.version });
        setUpdateState("available");
      } else {
        pendingUpdate.current = null;
        setUpdateState("none");
      }
    } catch (e) {
      setUpdateError(String(e));
      setUpdateState("error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdate.current;
    if (!update) return;
    setUpdateState("downloading");
    setUpdateError(null);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpdateError(String(e));
      setUpdateState("error");
    }
  }, []);

  const isSelf = (p: ProjectState) => p.info.name === SELF_NAME;

  const list = Object.values(projects);
  const runningCount = list.filter((p) => p.status !== "stopped").length;
  const activePorts = list.filter((p) => p.status === "running" && p.port).length;

  // Framework chips with counts.
  const fwCounts = new Map<string, number>();
  for (const p of list) fwCounts.set(p.info.framework, (fwCounts.get(p.info.framework) ?? 0) + 1);
  const frameworks = [...fwCounts.entries()].sort((a, b) => b[1] - a[1]);

  const statusRank = (s: ProjectState["status"]) => (s === "stopped" ? 2 : s === "starting" ? 1 : 0);
  const visible = list
    .filter((p) => !search || p.info.name.toLowerCase().includes(search.toLowerCase()))
    .filter((p) => !fwFilter || p.info.framework === fwFilter)
    .filter((p) => quickFilter === "all" || (quickFilter === "running" ? p.status !== "stopped" : pinned.has(p.info.path)))
    .sort((a, b) => {
      const pa = pinned.has(a.info.path) ? 0 : 1;
      const pb = pinned.has(b.info.path) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const sr = statusRank(a.status) - statusRank(b.status);
      if (sr !== 0) return sr;
      return a.info.name.toLowerCase().localeCompare(b.info.name.toLowerCase());
    });

  const startableAll = list.filter(
    (p) =>
      p.status === "stopped" &&
      (p.info.kind === "static" || p.info.dev_script) &&
      !isSelf(p)
  );
  const stoppableAll = list.filter((p) => p.status !== "stopped" && !isSelf(p));

  const sel = selected ? projects[selected] : null;

  return (
    <div className="app">
      {/* ---------------------------- sidebar ---------------------------- */}
      <aside className="sidebar">
        <div className="logo">
          <LogoMark size={35} />
          <LogoWordmark size={27} />
        </div>
        <div className="nav-label">Menu</div>
        <nav className="nav">
          <button
            className={`nav-item ${view === "dashboard" && quickFilter === "all" ? "active" : ""}`}
            onClick={() => {
              setView("dashboard");
              setQuickFilter("all");
            }}
          >
            <Icon name="grid" />
            <span className="nav-item-label">Dashboard</span>
          </button>
          <button
            className={`nav-item ${view === "dashboard" && quickFilter === "running" ? "active" : ""}`}
            onClick={() => {
              setView("dashboard");
              setQuickFilter("running");
            }}
          >
            <Icon name="bolt" />
            <span className="nav-item-label">Running</span>
            {runningCount > 0 && <span className="nav-badge">{runningCount}</span>}
          </button>
          <button
            className={`nav-item ${view === "dashboard" && quickFilter === "pinned" ? "active" : ""}`}
            onClick={() => {
              setView("dashboard");
              setQuickFilter("pinned");
            }}
          >
            <Icon name="star" />
            <span className="nav-item-label">Pinned</span>
            {pinned.size > 0 && <span className="nav-badge">{pinned.size}</span>}
          </button>
          <button
            className={`nav-item ${view === "logs" ? "active" : ""}`}
            onClick={() => setView("logs")}
          >
            <Icon name="terminal" />
            <span className="nav-item-label">Logs</span>
          </button>
          <div className="nav-label">General</div>
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            <Icon name="gear" />
            <span className="nav-item-label">Settings</span>
          </button>
        </nav>
        <button
          className="nav-item power"
          onClick={() => invoke("quit_app").catch((e) => setError(String(e)))}
          title="Quit Beacon (stops all servers)"
        >
          <Icon name="power" />
          <span className="nav-item-label">Quit</span>
        </button>
      </aside>

      {/* ----------------------------- main ------------------------------ */}
      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>
              {view === "settings"
                ? "Settings"
                : view === "logs"
                  ? "Logs"
                  : quickFilter === "running"
                    ? "Running"
                    : quickFilter === "pinned"
                      ? "Pinned"
                      : "Dashboard"}
            </h1>
            <p className="subtitle" title={roots.join("\n")}>
              {roots.length === 0
                ? "No folder selected yet"
                : roots.length === 1
                  ? roots[0]
                  : `${roots.length} folders`}
            </p>
          </div>
          {view === "dashboard" && (
            <div className="topbar-actions">
              <div className="search">
                <Icon name="search" size={15} />
                <input
                  placeholder="Search projects…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button
                className="btn success"
                onClick={() => startableAll.forEach((p) => startProject(p.info.path))}
                disabled={startableAll.length === 0}
                title="Start every stopped project"
              >
                <Icon name="play" size={14} /> Start all
              </button>
              <button
                className="btn danger"
                onClick={() => stoppableAll.forEach((p) => stopProject(p.info.path))}
                disabled={stoppableAll.length === 0}
                title="Stop every running project"
              >
                <Icon name="stop" size={14} /> Stop all
              </button>
              <button
                className="btn info"
                onClick={() => scan(roots)}
                disabled={roots.length === 0 || scanning}
              >
                <Icon name="refresh" size={15} /> {scanning ? "Scanning…" : "Rescan"}
              </button>
            </div>
          )}
        </header>

        {error && (
          <div className="error-bar" onClick={() => setError(null)}>
            <span>{error}</span>
            <span className="error-dismiss">✕</span>
          </div>
        )}

        {view === "settings" ? (
          <div className="settings">
            <div className="settings-card">
              <div className="settings-card-head">
                <span className="settings-card-icon">
                  <Icon name="folder" size={16} />
                </span>
                <h3>Projects folders</h3>
              </div>
              <p className="muted">
                Beacon scans each of these folders (and nested subfolders) for Node projects.
              </p>
              {roots.length === 0 ? (
                <p className="muted small">No folders added yet.</p>
              ) : (
                <PathList items={roots} onRemove={removeRoot} />
              )}
              <div className="row-gap">
                <button className="btn primary" onClick={addRoot}>
                  <Icon name="folder" size={15} /> Add folder
                </button>
                <button
                  className="btn"
                  onClick={() => scan(roots)}
                  disabled={roots.length === 0 || scanning}
                >
                  <Icon name="refresh" size={15} /> Rescan now
                </button>
              </div>
            </div>
            <div className="settings-card">
              <div className="settings-card-head">
                <span className="settings-card-icon">
                  <Icon name="folder" size={16} />
                </span>
                <h3>Excluded folders</h3>
              </div>
              <p className="muted">
                Anything inside these folders is skipped when scanning — handy for a "Practice" or
                sandbox folder you don't want cluttering the dashboard.
              </p>
              {excluded.length === 0 ? (
                <p className="muted small">Nothing excluded.</p>
              ) : (
                <PathList items={excluded} onRemove={removeExcluded} />
              )}
              <div className="row-gap">
                <button className="btn" onClick={addExcluded}>
                  <Icon name="folder" size={15} /> Exclude a folder
                </button>
              </div>
            </div>
            <div className="settings-card">
              <div className="settings-card-head">
                <span className="settings-card-icon">
                  <Icon name="bell" size={16} />
                </span>
                <h3>Notifications</h3>
              </div>
              <p className="muted">
                Beacon can alert you when a running project crashes or its port is taken, even
                while the window is hidden in the tray.
              </p>
              <div
                className={`settings-status ${
                  notifPermission === true ? "ok" : notifPermission === false ? "warn" : "pending"
                }`}
              >
                <span
                  className={`dot ${notifPermission === true ? "running" : notifPermission === false ? "" : "starting"}`}
                />
                {notifPermission === true
                  ? "Notifications enabled"
                  : notifPermission === false
                    ? "Notifications blocked"
                    : "Checking permission…"}
              </div>
              {notifPermission === false && (
                <div className="row-gap">
                  <button
                    className="btn"
                    onClick={() =>
                      requestPermission().then((res) => setNotifPermission(res === "granted"))
                    }
                  >
                    <Icon name="bell" size={15} /> Enable notifications
                  </button>
                </div>
              )}
            </div>
            <div className="settings-card">
              <div className="settings-card-head">
                <span className="settings-card-icon">
                  <Icon name="power" size={16} />
                </span>
                <h3>Background &amp; tray</h3>
              </div>
              <p className="muted">
                Closing this window keeps Beacon running in the system tray so your servers stay up.
                Right-click the tray icon to start/stop everything or quit for real.
              </p>
            </div>
            <div className="settings-card">
              <div className="settings-card-head">
                <span className="settings-card-icon">
                  <Icon name="info" size={16} />
                </span>
                <h3>About Beacon</h3>
              </div>
              <p className="muted">
                A local dev-server control center. Detects your project's framework, launches its dev
                script, auto-discovers the port, and streams logs — no terminal juggling.
              </p>
              <p className="muted small">
                Version {appVersion ?? "…"} · Built with Tauri + React
              </p>
              <div
                className={`settings-status ${
                  updateState === "available"
                    ? "warn"
                    : updateState === "none"
                      ? "ok"
                      : "pending"
                }`}
              >
                <span
                  className={`dot ${
                    updateState === "available"
                      ? "starting"
                      : updateState === "none"
                        ? "running"
                        : ""
                  }`}
                />
                {updateState === "checking"
                  ? "Checking for updates…"
                  : updateState === "available"
                    ? `Update available: v${updateInfo?.version}`
                    : updateState === "downloading"
                      ? "Downloading update…"
                      : updateState === "error"
                        ? `Update check failed${updateError ? `: ${updateError}` : ""}`
                        : updateState === "none"
                          ? "You're up to date"
                          : "Not checked yet"}
              </div>
              <div className="row-gap">
                {updateState === "available" ? (
                  <button className="btn primary" onClick={installUpdate}>
                    <Icon name="refresh" size={15} /> Install update
                  </button>
                ) : (
                  <button
                    className="btn"
                    onClick={checkForUpdates}
                    disabled={updateState === "checking" || updateState === "downloading"}
                  >
                    <Icon name="refresh" size={15} /> Check for updates
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : roots.length === 0 ? (
          <div className="empty">
            <LogoMark size={54} />
            <p>Pick the folder where your projects live to get started.</p>
            <button className="btn primary" onClick={addRoot}>
              <Icon name="folder" size={15} /> Choose folder
            </button>
          </div>
        ) : view === "logs" ? (
          <LogsView
            list={list}
            selected={logsSelected}
            onSelect={setLogsSelected}
            logEndRef={logEndRef}
          />
        ) : (
          <div className="content">
            <div className="content-main">
              {/* overview */}
              <section className="stats">
                <StatCard
                  label="Total Projects"
                  value={list.length}
                  accent="#58a6ff"
                  data={[list.length, list.length]}
                />
                <StatCard
                  label="Running Now"
                  value={runningCount}
                  sub={runningCount > 0 ? "live" : "idle"}
                  subColor={runningCount > 0 ? "#3ff08a" : undefined}
                  accent="#3ff08a"
                  data={runHistory}
                />
                <StatCard
                  label="Active Ports"
                  value={activePorts}
                  accent="#c084fc"
                  data={runHistory}
                />
                <StatCard
                  label="Log Activity"
                  value={logHistory.length ? logHistory[logHistory.length - 1] : 0}
                  sub="lines / 2s"
                  accent="#f0b429"
                  data={logHistory}
                />
              </section>

              {/* framework filter chips */}
              {frameworks.length > 0 && (
                <div className="chips">
                  <button
                    className={`chip ${fwFilter === null ? "active" : ""}`}
                    onClick={() => setFwFilter(null)}
                  >
                    All <span className="chip-count">{list.length}</span>
                  </button>
                  {frameworks.map(([fw, count]) => (
                    <button
                      key={fw}
                      className={`chip ${fwFilter === fw ? "active" : ""}`}
                      onClick={() => setFwFilter(fwFilter === fw ? null : fw)}
                    >
                      <span className="chip-dot" style={{ background: frameworkColor(fw) }} />
                      {fw} <span className="chip-count">{count}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* grid */}
              {visible.length === 0 ? (
                <div className="empty small">
                  <p>
                    {list.length === 0
                      ? "No projects with a package.json found in this folder."
                      : "No projects match your filter."}
                  </p>
                </div>
              ) : (
                <section className="grid">
                  {visible.map((p) => (
                    <ProjectCard
                      key={p.info.path}
                      p={p}
                      color={frameworkColor(p.info.framework)}
                      self={isSelf(p)}
                      isSel={selected === p.info.path}
                      pinned={pinned.has(p.info.path)}
                      now={p.status === "running" ? now : 0}
                      onSelect={setSelected}
                      onTogglePin={togglePin}
                      onStart={startProject}
                      onStop={stopProject}
                      onRestart={restartProject}
                      onPreview={setPreviewProject}
                    />
                  ))}
                </section>
              )}
            </div>

            {/* --------------------------- detail --------------------------- */}
            <aside className="detail">
              {sel ? (
                <ProjectDetail
                  key={sel.info.path}
                  p={sel}
                  now={now}
                  self={isSelf(sel)}
                  pinned={pinned.has(sel.info.path)}
                  onStart={() => startProject(sel.info.path)}
                  onStop={() => stopProject(sel.info.path)}
                  onRestart={() => restartProject(sel.info.path)}
                  onReveal={() => revealItemInDir(sel.info.path).catch(() => {})}
                  onEditor={async () => {
                    try {
                      await invoke("open_in_editor", { path: sel.info.path });
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                  onPin={() => togglePin(sel.info.path)}
                  onClose={() => setSelected(null)}
                  onExpandPreview={() => setPreviewProject(sel.info.path)}
                  logEndRef={logEndRef}
                />
              ) : (
                <div className="detail-empty">
                  <Icon name="bolt" size={30} />
                  <p>Select a project to see live details and logs.</p>
                  {runningCount > 0 && (
                    <div className="running-summary">
                      <span className="running-summary-label">Running</span>
                      {list
                        .filter((p) => p.status !== "stopped")
                        .map((p) => (
                          <button
                            key={p.info.path}
                            className="running-summary-item"
                            onClick={() => setSelected(p.info.path)}
                          >
                            <ProjectIcon p={p} size={18} />
                            <span className="rs-name">{p.info.name}</span>
                            {p.port && <span className="rs-port">:{p.port}</span>}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>

      {previewProject && projects[previewProject] && (
        <PreviewModal p={projects[previewProject]} onClose={() => setPreviewProject(null)} />
      )}
    </div>
  );
}

/* --------------------------- detail panel ----------------------------- */

function ProjectDetail({
  p,
  now,
  self,
  pinned,
  onStart,
  onStop,
  onRestart,
  onReveal,
  onEditor,
  onPin,
  onClose,
  onExpandPreview,
  logEndRef,
}: {
  p: ProjectState;
  now: number;
  self: boolean;
  pinned: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onReveal: () => void;
  onEditor: () => void;
  onPin: () => void;
  onClose: () => void;
  onExpandPreview: () => void;
  logEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const color = frameworkColor(p.info.framework);
  const running = p.status !== "stopped";
  const [tab, setTab] = useState<"logs" | "preview">("logs");
  const [previewNonce, setPreviewNonce] = useState(0);
  return (
    <div className="detail-inner">
      <div className="detail-hero" style={{ background: `linear-gradient(135deg, ${color}22, transparent)` }}>
        <button className="detail-close" onClick={onClose} title="Close">
          <Icon name="close" size={14} />
        </button>
        <button className={`pin big ${pinned ? "on" : ""}`} onClick={onPin} title={pinned ? "Unpin" : "Pin"}>
          <Icon name="pin" size={15} />
        </button>
        <ProjectIcon p={p} size={36} />
        <h2 className="detail-name">{p.info.name}</h2>
        <span className="badge" style={{ color, borderColor: color }}>
          {p.info.framework}
        </span>
      </div>

      <div className="detail-stats">
        <div className="ds">
          <span className="ds-label">Status</span>
          <span className={`ds-value ${p.status}`}>{p.status}</span>
        </div>
        <div className="ds">
          <span className="ds-label">Uptime</span>
          <span className="ds-value">{running ? fmtUptime(p.started_at, now) : "—"}</span>
        </div>
        <div className="ds">
          <span className="ds-label">Port</span>
          <span className="ds-value">
            {p.port ? (
              <button
                className="port-link"
                onClick={() => openUrl(`http://localhost:${p.port}`).catch(() => {})}
              >
                {p.port} <Icon name="link" size={11} />
              </button>
            ) : (
              "—"
            )}
          </span>
        </div>
        <div className="ds">
          <span className="ds-label">PID</span>
          <span className="ds-value">{p.pid ?? "—"}</span>
        </div>
        <div className="ds">
          <span className="ds-label">CPU</span>
          <span className="ds-value">{running && p.cpu != null ? `${p.cpu.toFixed(1)}%` : "—"}</span>
        </div>
        <div className="ds">
          <span className="ds-label">Memory</span>
          <span className="ds-value">
            {running && p.memMb != null ? `${p.memMb.toFixed(0)} MB` : "—"}
          </span>
        </div>
      </div>

      <div className="detail-actions">
        {p.status === "stopped" ? (
          <button
            className="btn primary grow"
            disabled={(p.info.kind === "npm" && !p.info.dev_script) || self}
            onClick={onStart}
          >
            <Icon name="play" size={13} /> Start
          </button>
        ) : (
          <>
            <button className="btn danger grow" onClick={onStop}>
              <Icon name="stop" size={13} /> Stop
            </button>
            <button className="btn" onClick={onRestart} title="Restart">
              <Icon name="restart" size={15} />
            </button>
          </>
        )}
        <button className="btn" onClick={onEditor} title="Open in VS Code">
          <Icon name="code" size={15} />
        </button>
        <button className="btn" onClick={onReveal} title="Reveal folder">
          <Icon name="folder" size={15} />
        </button>
      </div>

      <div className="detail-logs">
        <div className="detail-logs-head">
          <div className="tab-switch">
            <button className={`tab ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>
              Logs
            </button>
            <button
              className={`tab ${tab === "preview" ? "active" : ""}`}
              onClick={() => setTab("preview")}
              disabled={!p.port}
              title={p.port ? undefined : "Start the server to preview it"}
            >
              Preview
            </button>
          </div>
          {tab === "logs" ? (
            <span className="muted small">{p.logs.length} lines</span>
          ) : (
            <div className="preview-tab-actions">
              <button
                className="btn icon sm"
                onClick={() => setPreviewNonce((n) => n + 1)}
                title="Refresh preview"
              >
                <Icon name="refresh" size={13} />
              </button>
              <button className="btn icon sm" onClick={onExpandPreview} title="Expand preview">
                <Icon name="expand" size={13} />
              </button>
            </div>
          )}
        </div>
        {tab === "logs" ? (
          <div className="log-body">
            {p.logs.length === 0 ? (
              <div className="log-line dim">
                {running ? "Waiting for output…" : "Start the server to see logs."}
              </div>
            ) : (
              p.logs.map((line) => (
                <div className="log-line" key={line.id}>
                  {line.text}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        ) : p.port ? (
          <iframe
            key={previewNonce}
            src={`http://localhost:${p.port}`}
            className="preview-iframe-inline"
            title={p.info.name}
          />
        ) : (
          <div className="empty small">
            <p>Start the server to preview it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- preview modal ----------------------------- */

function PreviewModal({ p, onClose }: { p: ProjectState; onClose: () => void }) {
  const [nonce, setNonce] = useState(0);
  const url = `http://localhost:${p.port}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal-head">
          <ProjectIcon p={p} size={22} />
          <span className="preview-modal-name">{p.info.name}</span>
          <span className="preview-modal-url">{url}</span>
          <button className="btn icon sm" onClick={() => setNonce((n) => n + 1)} title="Refresh">
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="btn icon sm"
            onClick={() => openUrl(url).catch(() => {})}
            title="Open in browser"
          >
            <Icon name="link" size={14} />
          </button>
          <button className="btn icon sm" onClick={onClose} title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <iframe key={nonce} src={url} className="preview-iframe" title={p.info.name} />
      </div>
    </div>
  );
}

/* ----------------------------- logs page ------------------------------- */

function LogsView({
  list,
  selected,
  onSelect,
  logEndRef,
}: {
  list: ProjectState[];
  selected: string | null;
  onSelect: (path: string) => void;
  logEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const running = list.filter((p) => p.status !== "stopped");
  const active = selected ? list.find((p) => p.info.path === selected) ?? null : null;

  if (running.length === 0) {
    return (
      <div className="empty">
        <Icon name="terminal" size={34} />
        <p>No running projects. Start one to see its live logs here.</p>
      </div>
    );
  }

  return (
    <div className="logs-view">
      <div className="logs-sidebar">
        {running.map((p) => {
          const color = frameworkColor(p.info.framework);
          return (
            <button
              key={p.info.path}
              className={`logs-tab ${active?.info.path === p.info.path ? "active" : ""}`}
              onClick={() => onSelect(p.info.path)}
            >
              <ProjectIcon p={p} size={18} />
              <span className="logs-tab-name">{p.info.name}</span>
              <span className="badge sm" style={{ color, borderColor: color }}>
                {p.info.framework}
              </span>
            </button>
          );
        })}
      </div>
      <div className="logs-main">
        {active ? (
          <>
            <div className="detail-logs-head">
              <span>{active.info.name}</span>
              <span className="muted small">
                {active.port ? `localhost:${active.port} · ` : ""}
                {active.logs.length} lines
              </span>
            </div>
            <div className="log-body">
              {active.logs.length === 0 ? (
                <div className="log-line dim">Waiting for output…</div>
              ) : (
                active.logs.map((line) => (
                  <div className="log-line" key={line.id}>
                    {line.text}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </>
        ) : (
          <div className="empty small">
            <p>Select a project on the left.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
