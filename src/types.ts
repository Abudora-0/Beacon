export interface ProjectInfo {
  name: string;
  path: string;
  framework: string;
  dev_script: string | null;
  scripts: Record<string, string>;
  favicon: string | null;
  kind: "npm" | "static";
  package_manager: string;
}

export interface RunningInfo {
  path: string;
  pid: number;
  port: number | null;
  script: string;
  started_at: number;
}

export interface StartResult {
  pid: number;
  started_at: number;
}

export interface ProcStat {
  path: string;
  cpu: number;
  mem_mb: number;
}

export interface ExitInfo {
  path: string;
  unexpected: boolean;
  reason: "port_conflict" | "crashed" | null;
  code: number | null;
}

export type Status = "stopped" | "starting" | "running";

export interface LogLine {
  id: number;
  text: string;
}

export interface ProjectState {
  info: ProjectInfo;
  status: Status;
  pid: number | null;
  port: number | null;
  started_at: number | null;
  logs: LogLine[];
  cpu: number | null;
  memMb: number | null;
}
