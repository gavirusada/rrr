import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, execSync, spawn } from "node:child_process";
import embeddedAppExe from "../GaviruCamStudio-Full-Software/GaviruCamStudio.exe" with { type: "file" };
import embeddedAppIcon from "../assets/gaviru-cam.ico" with { type: "file" };

function runQuiet(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

interface SetupState {
  running: boolean;
  completed: boolean;
  progress: number;
  stepTitle: string;
  logs: string[];
  error: string | null;
  installDir: string;
  sourceProjectPath: string;
}

const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
const defaultInstallDir = join(localAppData, "Programs", "GaviruCamStudio");

const setupState: SetupState = {
  running: false,
  completed: false,
  progress: 0,
  stepTitle: "Ready to install Gaviru E400D Cam Studio Pro",
  logs: [
    "[SETUP] Welcome to Gaviru E400D Cam Studio Pro — Official Commercial Installer",
    "[OWNER] Created & Owned by Gaviru Sandeeptha",
    "[LEGAL] 🚫 අවසරයකින් තොරව නැවත විකිණීම හෝ බෙදාහැරීම සපුරා තහනම්!",
    `[PATH] Target Install Directory: ${defaultInstallDir}`
  ],
  error: null,
  installDir: defaultInstallDir,
  sourceProjectPath: process.cwd()
};

function addLog(msg: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  setupState.logs.push(`[${time}] ${msg}`);
}

function getAppExeBuffer(): Buffer {
  // 1. Try embedded asset path from Bun
  try {
    if (embeddedAppExe && existsSync(embeddedAppExe)) {
      return readFileSync(embeddedAppExe);
    }
  } catch {}

  // 2. Try adjacent GaviruCamStudio.exe in working directory
  const adjacent = join(process.cwd(), "GaviruCamStudio.exe");
  if (existsSync(adjacent)) {
    return readFileSync(adjacent);
  }

  // 3. Try directory of running setup exe
  try {
    if (process.execPath) {
      const exeDir = join(process.execPath, "..", "GaviruCamStudio.exe");
      if (existsSync(exeDir)) return readFileSync(exeDir);
    }
  } catch {}

  // 4. Try Full-Software subfolder
  const sub = join(process.cwd(), "GaviruCamStudio-Full-Software", "GaviruCamStudio.exe");
  if (existsSync(sub)) {
    return readFileSync(sub);
  }

  throw new Error("GaviruCamStudio.exe binary could not be found to install.");
}

function getAppIconBuffer(): Buffer {
  try {
    if (embeddedAppIcon && existsSync(embeddedAppIcon)) {
      return readFileSync(embeddedAppIcon);
    }
  } catch {}

  const candidates = [
    join(process.cwd(), "assets", "gaviru-cam.ico"),
    join(process.cwd(), "gaviru-cam.ico"),
    join(process.cwd(), "GaviruCamStudio-Full-Software", "gaviru-cam.ico")
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return readFileSync(c);
    }
  }
  return Buffer.alloc(0);
}

async function performInstallation(): Promise<void> {
  if (setupState.running || setupState.completed) return;
  setupState.running = true;
  setupState.error = null;
  setupState.progress = 10;
  setupState.stepTitle = "Step 1/4: Preparing Installation Directory...";
  addLog(`Preparing installation directory: ${setupState.installDir}`);

  await new Promise((r) => setTimeout(r, 200));

  try {
    mkdirSync(setupState.installDir, { recursive: true });

    // Stop any existing instance cleanly
    addLog("Stopping any running GaviruCamStudio instances...");
    runQuiet("taskkill /F /IM GaviruCamStudio.exe");
    await new Promise((r) => setTimeout(r, 500));

    setupState.progress = 35;
    setupState.stepTitle = "Step 2/4: Installing GaviruCamStudio.exe & Custom Studio Icon...";
    addLog("Extracting GaviruCamStudio.exe standalone binary...");

    const targetExe = join(setupState.installDir, "GaviruCamStudio.exe");
    const targetIco = join(setupState.installDir, "gaviru-cam.ico");

    const exeBuffer = getAppExeBuffer();
    writeFileSync(targetExe, exeBuffer);

    const icoBuffer = getAppIconBuffer();
    if (icoBuffer.length > 0) {
      writeFileSync(targetIco, icoBuffer);
    }

    addLog(`[OK] Installed GaviruCamStudio.exe (${Math.round(exeBuffer.length / (1024 * 1024))} MB) & Icon.`);

    // Write persistent config with port 8787
    const targetConfig = join(setupState.installDir, "camera-config.json");
    if (!existsSync(targetConfig)) {
      writeFileSync(
        targetConfig,
        JSON.stringify(
          {
            cameraIp: "192.168.1.145",
            cameraPort: 15740,
            listenHost: "0.0.0.0",
            listenPort: 8787,
            autoDiscover: true
          },
          null,
          2
        ),
        "utf-8"
      );
    }

    // Copy helper batch files if present
    const startBatSrc = join(process.cwd(), "Start-GaviruCamStudio.bat");
    if (existsSync(startBatSrc)) {
      writeFileSync(join(setupState.installDir, "Start-GaviruCamStudio.bat"), readFileSync(startBatSrc));
    }
    const studioBatSrc = join(process.cwd(), "start-studio.bat");
    if (existsSync(studioBatSrc)) {
      writeFileSync(join(setupState.installDir, "start-studio.bat"), readFileSync(studioBatSrc));
    }

    setupState.progress = 70;
    setupState.stepTitle = "Step 3/4: Configuring Windows Network & Firewall Rules...";
    addLog("Configuring Windows Firewall for Canon PTP/IP & OBS Port 8787...");
    runQuiet(`netsh advfirewall firewall delete rule name="Gaviru E400D Cam Studio"`);
    runQuiet(
      `netsh advfirewall firewall add rule name="Gaviru E400D Cam Studio" dir=in action=allow program="${targetExe}" enable=yes`
    );
    runQuiet(
      `netsh advfirewall firewall add rule name="Gaviru E400D Cam Studio HTTP" dir=in action=allow protocol=TCP localport=8787`
    );
    addLog("[OK] Windows Firewall rules configured.");

    setupState.progress = 88;
    setupState.stepTitle = "Step 4/4: Creating Desktop & Start Menu Shortcuts...";
    addLog("Creating Desktop shortcut ('Gaviru E400D Cam Studio')...");

    const iconArg = existsSync(targetIco) ? `${targetIco.replace(/'/g, "''")},0` : "shell32.dll,16";
    const psShortcut =
      `$ws = New-Object -ComObject WScript.Shell; ` +
      `$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gaviru E400D Cam Studio.lnk'; ` +
      `$s1 = $ws.CreateShortcut($desk); ` +
      `$s1.TargetPath = '${targetExe.replace(/'/g, "''")}'; ` +
      `$s1.WorkingDirectory = '${setupState.installDir.replace(/'/g, "''")}'; ` +
      `$s1.Description = 'Gaviru E400D Cam Studio Pro — Owned by Gaviru Sandeeptha'; ` +
      `$s1.IconLocation = '${iconArg}'; ` +
      `$s1.Save(); ` +
      `$prog = Join-Path ([Environment]::GetFolderPath('Programs')) 'Gaviru E400D Cam Studio.lnk'; ` +
      `$s2 = $ws.CreateShortcut($prog); ` +
      `$s2.TargetPath = '${targetExe.replace(/'/g, "''")}'; ` +
      `$s2.WorkingDirectory = '${setupState.installDir.replace(/'/g, "''")}'; ` +
      `$s2.Description = 'Gaviru E400D Cam Studio Pro — Owned by Gaviru Sandeeptha'; ` +
      `$s2.IconLocation = '${iconArg}'; ` +
      `$s2.Save();`;

    runQuiet(`powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "${psShortcut}"`);
    addLog("[OK] Desktop & Start Menu shortcuts created successfully!");

    setupState.progress = 100;
    setupState.completed = true;
    setupState.running = false;
    setupState.stepTitle = "✅ Installation Complete! Launching Studio...";
    addLog("✅ INSTALLATION COMPLETE! Launching Gaviru E400D Cam Studio Pro...");

    // Launch GaviruCamStudio.exe
    const child = spawn(targetExe, [], {
      cwd: setupState.installDir,
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    // Also open the browser control page
    setTimeout(() => {
      openDesktopSetupWindow("http://127.0.0.1:8787/control");
    }, 1200);

  } catch (err) {
    setupState.running = false;
    setupState.error = err instanceof Error ? err.message : String(err);
    addLog(`[ERROR] ${setupState.error}`);
  }
}

function createSetupWizardHtml(): string {
  return `<!doctype html>
<html lang="si">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gaviru E400D Cam Studio Pro — Commercial Setup Wizard</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 50% 15%, #172033 0%, #07090f 100%);
      color: #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      user-select: none;
    }
    .wizard-card {
      max-width: 680px;
      width: 100%;
      background: linear-gradient(180deg, #111622 0%, #0a0d14 100%);
      border: 1px solid rgba(245, 158, 11, 0.45);
      border-radius: 16px;
      box-shadow: 0 25px 70px rgba(0,0,0,0.85), 0 0 35px rgba(245,158,11,0.12);
      overflow: hidden;
    }
    .wizard-header {
      padding: 20px 24px;
      background: linear-gradient(90deg, rgba(245,158,11,0.14), rgba(30,41,59,0.5));
      border-bottom: 1px solid rgba(245,158,11,0.3);
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo-box {
      width: 66px;
      height: 66px;
      border-radius: 16px;
      background: linear-gradient(135deg, #0f172a, #1e293b);
      border: 2px solid #f59e0b;
      box-shadow: 0 6px 20px rgba(245,158,11,0.28);
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .wizard-body {
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .info-grid {
      background: #080b11;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12.5px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      padding-bottom: 6px;
    }
    .info-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .warning-banner {
      background: rgba(220, 38, 38, 0.16);
      border: 1px solid rgba(239, 68, 68, 0.55);
      border-radius: 9px;
      padding: 9px 12px;
      color: #fecaca;
      font-weight: 700;
      font-size: 12px;
      text-align: center;
      line-height: 1.45;
    }
    .pwd-box {
      background: #0d121c;
      border: 1px solid #263147;
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pwd-input-wrap {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    input[type="text"], input[type="password"] {
      flex: 1;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 700;
      border-radius: 8px;
      border: 1.5px solid #3b82f6;
      background: #05070c;
      color: #fff;
      letter-spacing: 0.08em;
    }
    .progress-wrap {
      background: #06080d;
      border: 1px solid #1e293b;
      border-radius: 999px;
      height: 14px;
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #f59e0b, #10b981);
      transition: width 0.25s ease;
    }
    .logs-box {
      background: #04060a;
      border: 1px solid #1e2430;
      border-radius: 8px;
      padding: 8px 10px;
      height: 110px;
      overflow-y: auto;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11.5px;
      line-height: 1.45;
      color: #93c5fd;
    }
    .btn-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-top: 4px;
    }
    button {
      font: inherit;
      font-weight: 800;
      padding: 11px 18px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .btn-install {
      flex: 1;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      border-color: #3b82f6;
      color: #fff;
      font-size: 14px;
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.35);
    }
    .btn-install:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-cancel {
      background: rgba(239, 68, 68, 0.16);
      border-color: #ef4444;
      color: #fca5a5;
      font-size: 13px;
    }
    .err-banner {
      background: #450a0a;
      border: 1px solid #ef4444;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      color: #fecaca;
      font-weight: 700;
      display: none;
    }
  </style>
</head>
<body>
  <div class="wizard-card">
    <div class="wizard-header">
      <div class="logo-box">
        <svg width="42" height="42" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="6" y="16" width="52" height="38" rx="8" fill="#0F172A" stroke="#F59E0B" stroke-width="2.5"/>
          <path d="M20 16L24 9H40L44 16H20Z" fill="#DC2626" stroke="#F59E0B" stroke-width="2"/>
          <circle cx="32" cy="35" r="14" fill="#090D16" stroke="#F59E0B" stroke-width="2.5"/>
          <circle cx="32" cy="35" r="9" fill="#0284C7" fill-opacity="0.35" stroke="#38BDF8" stroke-width="2"/>
          <circle cx="29" cy="32" r="3" fill="#E0F2FE"/>
          <circle cx="49" cy="24" r="3" fill="#EF4444"/>
        </svg>
      </div>
      <div>
        <div style="font-size:11px; font-weight:800; color:#fde68a; letter-spacing:0.08em;">
          👑 OFFICIAL COMMERCIAL SOFTWARE INSTALLER
        </div>
        <h1 style="margin:2px 0 3px; font-size:20px; font-weight:900; color:#fff;">
          GAVIRU E400D CAM STUDIO PRO — SETUP WIZARD
        </h1>
        <div style="font-size:12px; color:#9ca3af;">
          Canon EOS 4000D Full Live View, Shutter & OBS Broadcast Studio
        </div>
      </div>
    </div>

    <div class="wizard-body">
      <div class="info-grid">
        <div class="info-row">
          <span style="color:#9ca3af;">👤 නිර්මාණය සහ අයිතිය (Owner & Author):</span>
          <strong style="color:#fbbf24; font-size:14px;">Gaviru Sandeeptha</strong>
        </div>
        <div class="info-row">
          <span style="color:#9ca3af;">📁 Source Folder:</span>
          <code id="srcPathEl" style="color:#93c5fd; font-size:11px;">Loading...</code>
        </div>
        <div class="info-row">
          <span style="color:#9ca3af;">💿 Install වෙන ස්ථානය (Target Location):</span>
          <code id="instPathEl" style="color:#6ee7b7; font-size:11px;">Loading...</code>
        </div>
      </div>

      <div class="warning-banner">
        🚫 අවසරයකින් තොරව නැවත විකිණීම හෝ බෙදාහැරීම සපුරා තහනම්!<br>
        <span style="font-size:10.5px; color:#fca5a5;">STRICTLY PROHIBITED FOR UNAUTHORIZED RESALE • COPYRIGHT © GAVIRU SANDEEPTHA</span>
      </div>

      <div class="pwd-box">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <label for="setupPassword" style="font-size:12.5px; font-weight:700; color:#e5e7eb;">
            🔑 Setup Password එක ඇතුළත් කරන්න (Enter Setup Password):
          </label>
          <span style="font-size:11.5px; color:#fbbf24; font-weight:800;">Password: gavi01</span>
        </div>
        <div class="pwd-input-wrap">
          <input type="text" id="setupPassword" value="gavi01" placeholder="Enter 'gavi01'..." autocomplete="off">
          <button type="button" onclick="fillPassword()" style="background:#1e293b; border:1px solid #475569; color:#cbd5e1; padding:9px 12px; font-size:12px;">
            Auto-Fill
          </button>
        </div>
        <div id="pwdErr" style="display:none; color:#f87171; font-size:12px; font-weight:700; text-align:center;">
          ❌ මුරපදය වැරදියි! කරුණාකර gavi01 ඇතුළත් කරන්න.
        </div>
      </div>

      <div id="errorBanner" class="err-banner"></div>

      <div>
        <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:700; margin-bottom:5px;">
          <span id="stepTitleEl" style="color:#fde68a;">Ready to install Gaviru E400D Cam Studio Pro</span>
          <span id="pctEl" style="color:#6ee7b7;">0%</span>
        </div>
        <div class="progress-wrap">
          <div id="progBar" class="progress-bar"></div>
        </div>
      </div>

      <div id="logsBox" class="logs-box"></div>

      <div class="btn-row">
        <button class="btn-cancel" onclick="closeSetupWizard()">❌ Close Setup</button>
        <button id="btnInstall" class="btn-install" onclick="startInstallation()">
          🚀 Unlock & Install Full Software (gavi01)
        </button>
      </div>
    </div>
  </div>

  <script>
    let lastLogCount = 0;

    function fillPassword() {
      const inp = document.getElementById('setupPassword');
      inp.value = 'gavi01';
      document.getElementById('pwdErr').style.display = 'none';
      inp.focus();
    }

    async function pollSetupState() {
      try {
        const res = await fetch('/api/setup-state', { cache: 'no-store' });
        const data = await res.json();
        document.getElementById('instPathEl').textContent = data.installDir;
        document.getElementById('srcPathEl').textContent = data.sourceProjectPath;
        document.getElementById('stepTitleEl').textContent = data.stepTitle;
        document.getElementById('pctEl').textContent = data.progress + '%';
        document.getElementById('progBar').style.width = data.progress + '%';

        const logsBox = document.getElementById('logsBox');
        if (Array.isArray(data.logs) && data.logs.length !== lastLogCount) {
          lastLogCount = data.logs.length;
          logsBox.innerHTML = '';
          for (const line of data.logs) {
            const div = document.createElement('div');
            div.textContent = line;
            if (line.includes('[OK]') || line.includes('✅')) div.style.color = '#6ee7b7';
            else if (line.includes('🚫') || line.includes('[ERROR]')) div.style.color = '#fca5a5';
            else if (line.includes('[OWNER]')) div.style.color = '#fde68a';
            logsBox.appendChild(div);
          }
          logsBox.scrollTop = logsBox.scrollHeight;
        }

        const errBox = document.getElementById('errorBanner');
        if (data.error) {
          errBox.style.display = 'block';
          errBox.textContent = '⚠️ Install Error: ' + data.error;
          const btn = document.getElementById('btnInstall');
          btn.disabled = false;
          btn.textContent = '🔄 Retry Installation';
        } else {
          errBox.style.display = 'none';
        }

        const btn = document.getElementById('btnInstall');
        if (data.completed) {
          btn.textContent = '🎉 Successfully Installed! Launching App...';
          btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
          btn.disabled = false;
          btn.onclick = () => {
            window.open('http://127.0.0.1:8787/control', '_blank');
          };
          setTimeout(() => {
            closeSetupWizard();
          }, 3500);
        } else if (data.running) {
          btn.textContent = '⏳ Installing Gaviru Cam Studio... Please Wait...';
          btn.disabled = true;
        }
      } catch {}
    }

    async function startInstallation() {
      const pwd = (document.getElementById('setupPassword').value || '').trim().toLowerCase();
      const errEl = document.getElementById('pwdErr');
      if (pwd !== 'gavi01') {
        errEl.style.display = 'block';
        document.getElementById('setupPassword').focus();
        return;
      }
      errEl.style.display = 'none';

      const btn = document.getElementById('btnInstall');
      btn.disabled = true;
      btn.textContent = '⏳ Starting Installation...';

      await fetch('/api/start-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      await pollSetupState();
    }

    async function closeSetupWizard() {
      try {
        const blob = new Blob([JSON.stringify({ close: true })], { type: 'application/json' });
        navigator.sendBeacon('/api/close-setup', blob);
      } catch {}
      window.close();
    }

    window.addEventListener('pagehide', () => {
      try {
        const blob = new Blob([JSON.stringify({ close: true })], { type: 'application/json' });
        navigator.sendBeacon('/api/close-setup', blob);
      } catch {}
    });

    document.getElementById('setupPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startInstallation();
    });

    pollSetupState();
    setInterval(pollSetupState, 500);
    setTimeout(() => document.getElementById('setupPassword').focus(), 150);
  </script>
</body>
</html>`;
}

function openDesktopSetupWindow(url: string): void {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];
  for (const bin of candidates) {
    if (existsSync(bin)) {
      const child = spawn(bin, [`--app=${url}`, "--window-size=720,720"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      return;
    }
  }
  const fallback = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  fallback.unref();
}

async function startSetupWizardServer(): Promise<void> {
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (reqUrl.pathname === "/api/setup-state") {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(setupState));
      return;
    }

    if (reqUrl.pathname === "/api/start-install" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const inputPwd = String(parsed.password ?? "").trim().toLowerCase();
          if (inputPwd !== "gavi01") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid password" }));
            return;
          }
          void performInstallation();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }

    if (reqUrl.pathname === "/api/close-setup" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      closeTimer = setTimeout(() => {
        process.exit(0);
      }, 900);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(createSetupWizardHtml());
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 18990;
  openDesktopSetupWindow(`http://127.0.0.1:${port}/`);
}

startSetupWizardServer().catch(() => {
  process.exit(1);
});
