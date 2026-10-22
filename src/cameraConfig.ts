import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";

export interface PersistentCameraConfig {
  cameraIp: string;
  cameraPort: number;
  listenHost: string;
  listenPort: number;
  autoDiscover: boolean;
}

export const DEFAULT_PERSISTENT_CONFIG: PersistentCameraConfig = {
  cameraIp: "192.168.1.145",
  cameraPort: 15740,
  listenHost: "0.0.0.0",
  listenPort: 8080,
  autoDiscover: true
};

export function getPersistentConfigPath(): string {
  return join(process.cwd(), "camera-config.json");
}

export function loadPersistentConfig(): PersistentCameraConfig {
  try {
    const configPath = getPersistentConfigPath();
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<PersistentCameraConfig>;
      return {
        ...DEFAULT_PERSISTENT_CONFIG,
        ...parsed
      };
    }
  } catch {
    // Ignore and fallback
  }
  return { ...DEFAULT_PERSISTENT_CONFIG };
}

export function savePersistentConfig(patch: Partial<PersistentCameraConfig>): PersistentCameraConfig {
  const current = loadPersistentConfig();
  const updated: PersistentCameraConfig = {
    ...current,
    ...patch
  };
  try {
    writeFileSync(getPersistentConfigPath(), JSON.stringify(updated, null, 2), "utf-8");
  } catch {
    // Ignore write failure on readonly filesystems
  }
  return updated;
}

export interface StudioLogEntry {
  id: number;
  time: string;
  level: "INFO" | "WARN" | "ERROR" | "CMD";
  message: string;
}

const MAX_STUDIO_LOGS = 160;
const studioLogs: StudioLogEntry[] = [];
let nextLogId = 1;
let consoleCaptureInstalled = false;

function formatLogTime(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function appendStudioLog(level: StudioLogEntry["level"], message: string): void {
  const clean = String(message ?? "").trim();
  if (!clean) return;
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^=+$/.test(trimmed)) continue;
    studioLogs.push({
      id: nextLogId++,
      time: formatLogTime(),
      level,
      message: trimmed
    });
    if (studioLogs.length > MAX_STUDIO_LOGS) {
      studioLogs.splice(0, studioLogs.length - MAX_STUDIO_LOGS);
    }
  }
}

export function getStudioLogs(): StudioLogEntry[] {
  return studioLogs.slice(-120);
}

export function clearStudioLogs(): void {
  studioLogs.length = 0;
  appendStudioLog("INFO", "Console logs cleared.");
}

export function installStudioConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    appendStudioLog("INFO", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    appendStudioLog("WARN", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    appendStudioLog("ERROR", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
}

/**
 * Automatically ensures Node.js LTS is installed on any new PC and creates a Desktop shortcut
 * for Gaviru E400D Cam Studio so the user never has to manually install anything.
 */
export function ensurePcEnvironmentAndShortcut(): void {
  if (process.platform !== "win32") return;

  // 1. Check if Node.js is installed; if missing on a new PC, install Node.js LTS automatically in the background
  exec("where node", { windowsHide: true }, (nodeErr, stdout) => {
    if (nodeErr) {
      appendStudioLog("WARN", "Node.js not found on this PC — automatically installing Node.js LTS in background...");
      const autoNodeCmd =
        `where winget >nul 2>nul && (` +
        `winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent` +
        `) || (` +
        `powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "` +
        `$ProgressPreference='SilentlyContinue'; ` +
        `$msi=Join-Path $env:TEMP 'nodejs-lts-x64.msi'; ` +
        `Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile $msi; ` +
        `Start-Process msiexec.exe -ArgumentList '/i',$msi,'/qn','/norestart' -WindowStyle Hidden -Wait; ` +
        `Remove-Item $msi -ErrorAction SilentlyContinue"` +
        `)`;
      exec(autoNodeCmd, { windowsHide: true }, () => {
        appendStudioLog("INFO", "Node.js LTS automatic installation completed.");
      });
    } else {
      const firstPath = stdout.split(/\r?\n/)[0]?.trim() || "node";
      appendStudioLog("INFO", `Node.js runtime verified on PC (${firstPath})`);
    }
  });

  // 2. Ensure Desktop Shortcut exists on this PC
  const exePath = process.execPath;
  if (exePath && exePath.toLowerCase().endsWith("gavirucamstudio.exe")) {
    const workDir = process.cwd();
    const psShortcut =
      `$ws = New-Object -ComObject WScript.Shell; ` +
      `$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gaviru E400D Cam Studio.lnk'; ` +
      `if (-not (Test-Path $lnk)) { ` +
      `$s = $ws.CreateShortcut($lnk); ` +
      `$s.TargetPath = '${exePath.replace(/'/g, "''")}'; ` +
      `$s.WorkingDirectory = '${workDir.replace(/'/g, "''")}'; ` +
      `$s.Description = 'Gaviru E400D Cam Studio'; ` +
      `$s.IconLocation = 'shell32.dll,16'; ` +
      `$s.Save(); ` +
      `}`;
    exec(`powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "${psShortcut}"`, {
      windowsHide: true
    });
  }
}

/**
 * Opens the URL in Microsoft Edge App Mode, Google Chrome App Mode, or system default browser.
 * App Mode runs without URL bars or tabs, looking like a native Windows Desktop App!
 */
export function openDesktopAppWindow(url: string): void {
  // 1. Try Microsoft Edge in standalone App Mode
  exec(`start msedge --app="${url}"`, { windowsHide: true }, (edgeError) => {
    if (!edgeError) return;

    // 2. Try Google Chrome in standalone App Mode
    exec(`start chrome --app="${url}"`, { windowsHide: true }, (chromeError) => {
      if (!chromeError) return;

      // 3. Fallback to default system browser
      exec(`start "" "${url}"`, { windowsHide: true });
    });
  });
}
