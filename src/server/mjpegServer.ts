import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { CanonCameraController, CanonCameraState } from "../canon/canonLiveViewConnection";
import {
  CANON_APERTURE_OPTIONS,
  CANON_DRIVE_MODE_OPTIONS,
  CANON_EXPOSURE_COMP_OPTIONS,
  CANON_FLASH_EXPOSURE_COMP_OPTIONS,
  CANON_ISO_OPTIONS,
  CANON_METERING_MODE_OPTIONS,
  CANON_SHOOTING_PRESETS,
  CANON_SHUTTER_SPEED_OPTIONS,
  CANON_WHITE_BALANCE_OPTIONS
} from "../canon/canonProperties";
import type { FrameSource, FrameSourceStats } from "../canon/frameSource";
import { discoverCanonCameras } from "../canon/ssdpDiscovery";
import {
  appendStudioLog,
  clearStudioLogs,
  getStudioLogs,
  loadPersistentConfig,
  savePersistentConfig
} from "../cameraConfig";

interface ObservableFrameSource extends FrameSource {
  stats?(): FrameSourceStats;
}

export interface MjpegServerOptions {
  host: string;
  port: number;
  source: ObservableFrameSource;
  controller?: CanonCameraController;
  initialCameraIp?: string;
}

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

export interface ServerStatus {
  ok: boolean;
  streamUrl: string;
  snapshotUrl: string;
  frame: FrameSourceStats | null;
}

interface TunnelSession {
  running: boolean;
  provider: string | null;
  url: string | null;
  error: string | null;
  logs: string[];
  process: ChildProcess | null;
}

export function createMjpegResponse(frame: Uint8Array, boundary: string): Response {
  const body = new Blob([
    `--${boundary}\r\n`,
    "Content-Type: image/jpeg\r\n",
    `Content-Length: ${frame.byteLength}\r\n\r\n`,
    toArrayBuffer(frame),
    "\r\n"
  ]);

  return new Response(body, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Connection": "close",
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Pragma": "no-cache"
    }
  });
}

export async function startMjpegServer(options: MjpegServerOptions): Promise<RunningServer> {
  const boundary = "rivet-frame";
  const tunnel: TunnelSession = {
    running: false,
    provider: null,
    url: null,
    error: null,
    logs: [],
    process: null
  };

  let resolvedPort = options.port;

  const fallbackState: CanonCameraState = {
    connected: true,
    cameraName: "Gaviru E400D Cam",
    evfActive: true,
    cameraDisplayActive: true,
    controlAuthority: "dual",
    streamMode: "sensor",
    movieRecording: false,
    activePreset: "obs_studio",
    iso: 0x58,
    shutterSpeed: 0x68,
    aperture: 0x25,
    exposureComp: 0x00,
    flashFiring: false,
    flashExposureComp: 0x00,
    whiteBalance: 0,
    meteringMode: 3,
    driveMode: 0x00,
    softwareBrightness: 100,
    softwareContrast: 100,
    lowLightBoost: 0,
    properties: {},
    allowedValues: {},
    formatted: {
      iso: "ISO 400",
      shutterSpeed: "1/60",
      aperture: "f/3.5",
      exposureComp: "0.0 EV",
      flashExposureComp: "0.0 EV",
      whiteBalance: "AWB (Auto)",
      meteringMode: "Evaluative Metering",
      driveMode: "Single Shooting"
    },
    lastCommand: "Ready — Gaviru E400D Cam",
    lastCommandAt: new Date().toISOString(),
    lastError: null,
    queueDepth: 0
  };

  let currentCameraIp = options.initialCameraIp ?? loadPersistentConfig().cameraIp;

  const studioVisualState: StudioVisualAndAudioState = {
    softwareBrightness: 100,
    softwareContrast: 100,
    lowLightBoost: 0,
    hdSharpness: 135,
    digitalZoom: 1.0,
    isPortrait: false,
    portraitRotation: "crop",
    outputAspect: "16:9",
    outputResolution: "4k",
    colorGrading: "vivid",
    vdoNinjaRoom: "gaviru-cam-" + Math.floor(1000 + Math.random() * 9000),
    audioEnabled: true,
    audioVolume: 100,
    audioDeviceId: "default"
  };

  const audioListeners = new Set<ServerResponse>();
  let windowCloseShutdownTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPendingWindowClose = (): void => {
    if (windowCloseShutdownTimer !== null) {
      clearTimeout(windowCloseShutdownTimer);
      windowCloseShutdownTimer = null;
    }
  };

  const scheduleWindowCloseShutdown = (): void => {
    cancelPendingWindowClose();
    windowCloseShutdownTimer = setTimeout(() => {
      appendStudioLog("INFO", "App window closed by user — shutting down server and background process.");
      stopTunnelProcess(tunnel);
      process.exit(0);
    }, 1600);
  };

  const server = createServer((request, response) => {
    void handleHttpRequest(
      request,
      response,
      options,
      boundary,
      tunnel,
      fallbackState,
      studioVisualState,
      audioListeners,
      () => resolvedPort,
      () => currentCameraIp,
      (newIp) => {
        currentCameraIp = newIp;
      },
      cancelPendingWindowClose,
      scheduleWindowCloseShutdown
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  resolvedPort = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    url: `http://${options.host}:${resolvedPort}`,
    async stop() {
      cancelPendingWindowClose();
      stopTunnelProcess(tunnel);
      for (const listener of audioListeners) {
        try {
          listener.end();
        } catch {
          // ignore
        }
      }
      audioListeners.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  };
}

interface StudioVisualAndAudioState {
  softwareBrightness: number;
  softwareContrast: number;
  lowLightBoost: number;
  hdSharpness: number;
  digitalZoom: number;
  isPortrait: boolean;
  portraitRotation: "crop" | "cw" | "ccw";
  outputAspect: "16:9" | "9:16" | "3:2";
  outputResolution: "4k" | "2k" | "1080p";
  colorGrading: "standard" | "vivid" | "cinema" | "warm";
  vdoNinjaRoom: string;
  audioEnabled: boolean;
  audioVolume: number;
  audioDeviceId: string;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MjpegServerOptions,
  boundary: string,
  tunnel: TunnelSession,
  fallbackState: CanonCameraState,
  studioVisualState: StudioVisualAndAudioState,
  audioListeners: Set<ServerResponse>,
  getPort: () => number,
  getCameraIp: () => string,
  setCameraIp: (ip: string) => void,
  cancelPendingWindowClose: () => void,
  scheduleWindowCloseShutdown: () => void
): Promise<void> {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const port = getPort();

  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/window-closed" && request.method === "POST") {
    scheduleWindowCloseShutdown();
    sendJson(response, 200, { ok: true, shuttingDownInMs: 1600 });
    return;
  }

  if (url.pathname === "/status.json") {
    sendJson(response, 200, createServerStatus(options.source, options.host, port));
    return;
  }

  if (url.pathname === "/api/camera/discover") {
    try {
      const cameras = await discoverCanonCameras({ timeoutMs: 2500 });
      sendJson(response, 200, { ok: true, cameras });
    } catch (err) {
      sendJson(response, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (url.pathname === "/api/camera/set-ip" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const newIp = String(body.ip ?? "").trim();
      if (!newIp) {
        sendJson(response, 400, { ok: false, error: "Please enter a valid IP address" });
        return;
      }
      setCameraIp(newIp);
      savePersistentConfig({ cameraIp: newIp });
      appendStudioLog("INFO", `Camera IP updated to ${newIp} — reconnecting PTP/IP session...`);
      if (options.controller !== undefined) {
        options.controller.setCameraHost(newIp);
      }
      sendJson(response, 200, { ok: true, ip: newIp });
    } catch (err) {
      sendJson(response, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (url.pathname === "/api/state") {
    cancelPendingWindowClose();
    const rawCameraState = options.controller ? options.controller.getState() : fallbackState;
    const cameraState: CanonCameraState = {
      ...rawCameraState,
      softwareBrightness: studioVisualState.softwareBrightness,
      softwareContrast: studioVisualState.softwareContrast,
      lowLightBoost: studioVisualState.lowLightBoost
    };
    const lanIps = getLocalLanAddresses();
    const baseHost = options.host === "0.0.0.0" ? (lanIps[0] ?? "127.0.0.1") : options.host;
    sendJson(response, 200, {
      ok: true,
      ownerName: "Gaviru Sandeeptha",
      projectPath: process.cwd(),
      currentCameraIp: getCameraIp(),
      camera: cameraState,
      visual: studioVisualState,
      frame: options.source.stats?.() ?? null,
      logs: getStudioLogs(),
      tunnel: {
        running: tunnel.running,
        provider: tunnel.provider,
        url: tunnel.url,
        error: tunnel.error,
        logs: tunnel.logs.slice(-12)
      },
      hasAudioListeners: audioListeners.size > 0,
      network: {
        host: baseHost,
        port,
        lanUrls: lanIps.map((ip) => `http://${ip}:${port}`),
        streamUrl: `http://${baseHost}:${port}/stream`,
        liveMjpgUrl: `http://${baseHost}:${port}/live.mjpg`,
        controlUrl: `http://${baseHost}:${port}/control`,
        watchUrl: `http://${baseHost}:${port}/watch`,
        cleanUrl: `http://${baseHost}:${port}/clean`,
        vdoUrl: `http://${baseHost}:${port}/vdo`,
        vdoNinjaViewUrl: `https://vdo.ninja/?view=${encodeURIComponent(studioVisualState.vdoNinjaRoom)}&cleanoutput&scale=100`,
        vdoNinjaPushUrl: `https://vdo.ninja/?push=${encodeURIComponent(studioVisualState.vdoNinjaRoom)}&webcam&autostart&videobitrate=25000&audiobitrate=320&scale=100&quality=0&fps=30`
      },
      options: {
        iso: CANON_ISO_OPTIONS,
        shutterSpeed: CANON_SHUTTER_SPEED_OPTIONS,
        aperture: CANON_APERTURE_OPTIONS,
        exposureComp: CANON_EXPOSURE_COMP_OPTIONS,
        flashExposureComp: CANON_FLASH_EXPOSURE_COMP_OPTIONS,
        whiteBalance: CANON_WHITE_BALANCE_OPTIONS,
        meteringMode: CANON_METERING_MODE_OPTIONS,
        driveMode: CANON_DRIVE_MODE_OPTIONS,
        presets: Object.values(CANON_SHOOTING_PRESETS)
      }
    });
    return;
  }

  if (url.pathname === "/api/liveview/toggle" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const desired =
        typeof body.enabled === "boolean"
          ? body.enabled
          : !(options.controller ? options.controller.getState().evfActive : fallbackState.evfActive);

      if (options.controller !== undefined) {
        await options.controller.setLiveViewShutter(desired);
      } else {
        fallbackState.evfActive = desired;
      }

      const camera = options.controller ? options.controller.getState() : fallbackState;
      sendJson(response, 200, { ok: true, evfActive: camera.evfActive, camera });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (url.pathname === "/api/display/toggle" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const desired =
        typeof body.enabled === "boolean"
          ? body.enabled
          : !(options.controller
              ? options.controller.getState().cameraDisplayActive
              : fallbackState.cameraDisplayActive);

      if (options.controller !== undefined) {
        await options.controller.setCameraDisplay(desired);
      } else {
        fallbackState.cameraDisplayActive = desired;
      }

      const camera = options.controller ? options.controller.getState() : fallbackState;
      sendJson(response, 200, {
        ok: true,
        cameraDisplayActive: camera.cameraDisplayActive,
        camera
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (url.pathname === "/api/screen/mode" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const mode = body.mode === "screen" ? "screen" : "sensor";
      if (options.controller !== undefined) {
        await options.controller.setStreamMode(mode);
      } else {
        fallbackState.streamMode = mode;
      }
      const camera = options.controller ? options.controller.getState() : fallbackState;
      sendJson(response, 200, { ok: true, streamMode: camera.streamMode, camera });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (url.pathname === "/api/tunnel/start" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const preferred = typeof body.provider === "string" ? body.provider : "auto";
      const result = await startCloudTunnel(tunnel, port, preferred);
      sendJson(response, 200, { ok: true, tunnel: result });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (url.pathname === "/api/tunnel/stop" && request.method === "POST") {
    stopTunnelProcess(tunnel);
    sendJson(response, 200, {
      ok: true,
      tunnel: {
        running: tunnel.running,
        provider: tunnel.provider,
        url: tunnel.url,
        error: tunnel.error
      }
    });
    return;
  }

  if (url.pathname === "/api/command" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const action = String(body.action ?? "");
      const ctrl = options.controller;

      switch (action) {
        case "set_property": {
          const propertyCode = Number(body.propertyCode);
          const value = Number(body.value);
          const byteLength = (body.byteLength === 1 || body.byteLength === 2 ? body.byteLength : 4) as 1 | 2 | 4;
          if (ctrl !== undefined) {
            await ctrl.setProperty(propertyCode, value, byteLength);
          }
          break;
        }
        case "iso": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setIso(val);
          else fallbackState.iso = val;
          break;
        }
        case "shutter_speed": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setShutterSpeed(val);
          else fallbackState.shutterSpeed = val;
          break;
        }
        case "aperture": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setAperture(val);
          else fallbackState.aperture = val;
          break;
        }
        case "exposure_comp": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setExposureCompensation(val);
          else fallbackState.exposureComp = val;
          break;
        }
        case "flash_firing": {
          const enabled = Boolean(body.enabled);
          if (ctrl !== undefined) await ctrl.setFlashFiring(enabled);
          else fallbackState.flashFiring = enabled;
          break;
        }
        case "flash_comp": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setFlashExposureCompensation(val);
          else fallbackState.flashExposureComp = val;
          break;
        }
        case "white_balance": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setWhiteBalance(val);
          else fallbackState.whiteBalance = val;
          break;
        }
        case "metering_mode": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setMeteringMode(val);
          else fallbackState.meteringMode = val;
          break;
        }
        case "drive_mode": {
          const val = Number(body.value);
          if (ctrl !== undefined) await ctrl.setDriveMode(val);
          else fallbackState.driveMode = val;
          break;
        }
        case "preset": {
          const presetId = String(body.presetId ?? "obs_studio");
          const p = CANON_SHOOTING_PRESETS[presetId];
          if (p !== undefined) {
            studioVisualState.softwareBrightness = p.softwareBrightness;
            studioVisualState.softwareContrast = p.softwareContrast;
            studioVisualState.lowLightBoost = p.lowLightBoost;
          }
          if (ctrl !== undefined) {
            await ctrl.applyPreset(presetId);
          } else if (p !== undefined) {
            fallbackState.activePreset = p.id;
            fallbackState.iso = p.iso;
            fallbackState.shutterSpeed = p.shutterSpeed;
            fallbackState.aperture = p.aperture;
            fallbackState.exposureComp = p.exposureComp;
            fallbackState.whiteBalance = p.whiteBalance;
            fallbackState.meteringMode = p.meteringMode;
            fallbackState.driveMode = p.driveMode;
            fallbackState.softwareBrightness = p.softwareBrightness;
            fallbackState.softwareContrast = p.softwareContrast;
            fallbackState.lowLightBoost = p.lowLightBoost;
          }
          break;
        }
        case "visual_settings": {
          if (typeof body.softwareBrightness === "number" && Number.isFinite(body.softwareBrightness)) {
            studioVisualState.softwareBrightness = Math.max(35, Math.min(200, body.softwareBrightness));
            fallbackState.softwareBrightness = studioVisualState.softwareBrightness;
          }
          if (typeof body.softwareContrast === "number" && Number.isFinite(body.softwareContrast)) {
            studioVisualState.softwareContrast = Math.max(50, Math.min(200, body.softwareContrast));
            fallbackState.softwareContrast = studioVisualState.softwareContrast;
          }
          if (typeof body.lowLightBoost === "number" && Number.isFinite(body.lowLightBoost)) {
            studioVisualState.lowLightBoost = Math.max(0, Math.min(100, body.lowLightBoost));
            fallbackState.lowLightBoost = studioVisualState.lowLightBoost;
          }
          if (typeof body.hdSharpness === "number" && Number.isFinite(body.hdSharpness)) {
            studioVisualState.hdSharpness = Math.max(0, Math.min(200, body.hdSharpness));
          }
          if (typeof body.digitalZoom === "number" && Number.isFinite(body.digitalZoom)) {
            studioVisualState.digitalZoom = Math.max(1.0, Math.min(3.0, body.digitalZoom));
          }
          if (typeof body.isPortrait === "boolean") {
            studioVisualState.isPortrait = body.isPortrait;
          }
          if (body.portraitRotation === "crop" || body.portraitRotation === "cw" || body.portraitRotation === "ccw") {
            studioVisualState.portraitRotation = body.portraitRotation;
          }
          if (body.outputAspect === "16:9" || body.outputAspect === "9:16" || body.outputAspect === "3:2") {
            studioVisualState.outputAspect = body.outputAspect;
            studioVisualState.isPortrait = body.outputAspect === "9:16";
          }
          if (body.outputResolution === "4k" || body.outputResolution === "2k" || body.outputResolution === "1080p") {
            studioVisualState.outputResolution = body.outputResolution;
          }
          if (body.colorGrading === "vivid" || body.colorGrading === "cinema" || body.colorGrading === "warm" || body.colorGrading === "standard") {
            studioVisualState.colorGrading = body.colorGrading;
          }
          if (typeof body.vdoNinjaRoom === "string" && body.vdoNinjaRoom.trim().length > 0) {
            studioVisualState.vdoNinjaRoom = body.vdoNinjaRoom.trim();
          }
          if (typeof body.audioEnabled === "boolean") {
            studioVisualState.audioEnabled = body.audioEnabled;
          }
          if (typeof body.audioVolume === "number" && Number.isFinite(body.audioVolume)) {
            studioVisualState.audioVolume = Math.max(0, Math.min(200, body.audioVolume));
          }
          if (typeof body.audioDeviceId === "string" && body.audioDeviceId.length > 0) {
            studioVisualState.audioDeviceId = body.audioDeviceId;
          }
          break;
        }
        case "shutter_release": {
          if (ctrl !== undefined) await ctrl.triggerShutterRelease();
          break;
        }
        case "movie_record": {
          const recording =
            typeof body.recording === "boolean"
              ? body.recording
              : !(ctrl ? ctrl.getState().movieRecording : fallbackState.movieRecording);
          if (ctrl !== undefined) await ctrl.setMovieRecord(recording);
          else fallbackState.movieRecording = recording;
          break;
        }
        case "auto_focus": {
          if (ctrl !== undefined) await ctrl.autoFocus();
          break;
        }
        case "half_press_focus": {
          if (ctrl !== undefined) await ctrl.halfPressFocus();
          break;
        }
        case "cancel_af": {
          if (ctrl !== undefined) await ctrl.cancelAutoFocus();
          break;
        }
        case "drive_lens": {
          const step = Number(body.step ?? 0x0002);
          const repeat = Number(body.repeat ?? 1);
          if (ctrl !== undefined) await ctrl.driveFocusLens(step, repeat);
          break;
        }
        case "evf_on": {
          if (ctrl !== undefined) await ctrl.setLiveViewShutter(true);
          else fallbackState.evfActive = true;
          break;
        }
        case "evf_off": {
          if (ctrl !== undefined) await ctrl.setLiveViewShutter(false);
          else fallbackState.evfActive = false;
          break;
        }
        case "evf_toggle": {
          if (ctrl !== undefined) await ctrl.toggleLiveViewShutter();
          else fallbackState.evfActive = !fallbackState.evfActive;
          break;
        }
        case "camera_display_on": {
          if (ctrl !== undefined) await ctrl.setCameraDisplay(true);
          else fallbackState.cameraDisplayActive = true;
          break;
        }
        case "camera_display_off": {
          if (ctrl !== undefined) await ctrl.setCameraDisplay(false);
          else fallbackState.cameraDisplayActive = false;
          break;
        }
        case "camera_display_toggle": {
          if (ctrl !== undefined) await ctrl.toggleCameraDisplay();
          else fallbackState.cameraDisplayActive = !fallbackState.cameraDisplayActive;
          break;
        }
        case "unlock_camera_buttons": {
          if (ctrl !== undefined) await ctrl.unlockCameraButtons();
          else {
            fallbackState.cameraDisplayActive = true;
            fallbackState.controlAuthority = "dual";
          }
          break;
        }
        case "set_control_authority": {
          const authMode = body.mode === "camera_priority" ? "camera_priority" : "dual";
          if (ctrl !== undefined) await ctrl.setControlAuthority(authMode);
          else fallbackState.controlAuthority = authMode;
          break;
        }
        case "stream_mode": {
          const mode = body.mode === "screen" ? "screen" : "sensor";
          if (ctrl !== undefined) await ctrl.setStreamMode(mode);
          else fallbackState.streamMode = mode;
          break;
        }
        case "capture_screen": {
          if (ctrl !== undefined) await ctrl.captureScreenFrame();
          break;
        }
        case "poll_events": {
          if (ctrl !== undefined) await ctrl.pollEventsNow();
          break;
        }
        case "clear_logs": {
          clearStudioLogs();
          break;
        }
        case "shutdown_app": {
          appendStudioLog("WARN", "Shutting down Gaviru E400D Cam Studio background server...");
          sendJson(response, 200, { ok: true, action: "shutdown_app" });
          setTimeout(() => {
            process.exit(0);
          }, 200);
          return;
        }
        default:
          sendJson(response, 400, { ok: false, error: `Unknown command action: ${action}` });
          return;
      }

      if (action !== "visual_settings" && action !== "clear_logs") {
        const latestCmd = (ctrl ? ctrl.getState().lastCommand : fallbackState.lastCommand) || action;
        appendStudioLog("CMD", `Executed: ${action} (${latestCmd})`);
      }

      const rawCamera = ctrl ? ctrl.getState() : fallbackState;
      const camera: CanonCameraState = {
        ...rawCamera,
        softwareBrightness: studioVisualState.softwareBrightness,
        softwareContrast: studioVisualState.softwareContrast,
        lowLightBoost: studioVisualState.lowLightBoost
      };
      sendJson(response, 200, { ok: true, action, camera, visual: studioVisualState, logs: getStudioLogs() });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      appendStudioLog("ERROR", `Command failed: ${errMsg}`);
      sendJson(response, 500, {
        ok: false,
        error: errMsg
      });
    }
    return;
  }

  if (url.pathname === "/") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(createStatusPage());
    return;
  }

  if (url.pathname === "/control") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(createStudioControlPage());
    return;
  }

  if (url.pathname === "/watch") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(createRemoteWatchPage());
    return;
  }

  if (url.pathname === "/clean") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(createCleanPopoutPage());
    return;
  }

  if (url.pathname === "/vdo") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(createVdoNinjaPage());
    return;
  }

  if (url.pathname === "/manifest.json") {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/manifest+json; charset=utf-8"
    });
    response.end(
      JSON.stringify({
        name: "Gaviru Cam Studio Pro",
        short_name: "GaviruCam",
        description: "Canon DSLR Wi-Fi 4K Live View & VDO.Ninja Suite",
        start_url: "/control",
        scope: "/",
        display: "standalone",
        background_color: "#090b10",
        theme_color: "#ef4444",
        icons: [
          {
            src: "/assets/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/assets/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          }
        ]
      })
    );
    return;
  }

  if (url.pathname === "/sw.js") {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8"
    });
    response.end(`// Gaviru Cam Studio Service Worker
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/stream') || e.request.url.includes('/api/') || e.request.url.includes('/audio')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});`);
    return;
  }

  if (url.pathname === "/assets/icon-192.png" || url.pathname === "/assets/icon-512.png") {
    const iconName = url.pathname.endsWith("512.png") ? "icon-512.png" : "icon-192.png";
    const possiblePaths = [
      join(process.cwd(), "assets", iconName),
      join(process.cwd(), "GaviruCamStudio-Full-Software", iconName),
      join(process.cwd(), iconName)
    ];
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        const buf = readFileSync(p);
        response.writeHead(200, {
          "Cache-Control": "public, max-age=86400",
          "Content-Type": "image/png",
          "Content-Length": buf.byteLength
        });
        response.end(buf);
        return;
      }
    }
  }

  if (url.pathname === "/snapshot.jpg") {
    const frame = options.source.latestFrame();
    if (frame === null) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No frame available");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": frame.bytes.byteLength,
      "Content-Type": frame.contentType
    });
    response.end(frame.bytes);
    return;
  }

  if (url.pathname === "/api/audio/push" && request.method === "POST") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      if (chunks.length > 0 && audioListeners.size > 0 && studioVisualState.audioEnabled) {
        const pcmPayload = Buffer.concat(chunks);
        for (const listener of audioListeners) {
          if (listener.writableEnded || listener.destroyed) {
            audioListeners.delete(listener);
            continue;
          }
          try {
            listener.write(pcmPayload);
          } catch {
            audioListeners.delete(listener);
          }
        }
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }

  if (url.pathname === "/audio.wav") {
    response.writeHead(200, {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "audio/wav"
    });
    response.write(createStreamingWavHeader(48000, 2, 16));
    audioListeners.add(response);
    const cleanup = (): void => {
      audioListeners.delete(response);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
    return;
  }

  if (url.pathname === "/stream") {
    const acceptHeader = String(request.headers.accept ?? "");
    const secFetchDest = String(request.headers["sec-fetch-dest"] ?? "");
    const wantsHtmlPage =
      url.searchParams.get("raw") !== "1" &&
      (secFetchDest === "document" || secFetchDest === "iframe" || acceptHeader.includes("text/html"));
    if (wantsHtmlPage) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8"
      });
      response.end(createCleanPopoutPage());
      return;
    }
    streamFrames(options.source, boundary, response);
    return;
  }

  if (url.pathname === "/live.mjpg") {
    streamFrames(options.source, boundary, response);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function createStreamingWavHeader(sampleRate = 48000, channels = 2, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = 0x7fffffff;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0, 4, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, 4, "ascii");
  buf.write("fmt ", 12, 4, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, 4, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export function createServerStatus(
  source: ObservableFrameSource,
  host: string,
  port: number
): ServerStatus {
  return {
    ok: true,
    streamUrl: `http://${host}:${port}/live.mjpg`,
    snapshotUrl: `http://${host}:${port}/snapshot.jpg`,
    frame: source.stats?.() ?? null
  };
}

export function createStatusPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gaviru E400D Cam — Rivet Studio Bridge</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", Tahoma, sans-serif; background: #090b10; color: #f2f0ea; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top right, #1a1025, #090b10 60%); }
    main { max-width: 1060px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .logo-pill { background: linear-gradient(135deg, #ef4444, #d97706); color: #fff; font-weight: 800; padding: 6px 12px; border-radius: 6px; letter-spacing: 0.05em; font-size: 13px; }
    h1 { margin: 0; font-size: 26px; font-weight: 800; background: linear-gradient(90deg, #fff, #fbbf24); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .badge { font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid #3c8f6c; color: #9df0c0; background: #12251c; font-weight: 600; text-transform: uppercase; }
    .nav-btns { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { text-decoration: none; padding: 9px 16px; border-radius: 8px; font-size: 13px; font-weight: 700; border: 1px solid #ef4444; background: linear-gradient(135deg, #dc2626, #b91c1c); color: #fff; transition: 0.15s; }
    .btn:hover { filter: brightness(1.1); }
    .btn.secondary { border-color: #374151; background: #1f2937; color: #e5e7eb; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, .95fr); gap: 18px; }
    .preview { background: #050607; border: 1px solid #26292e; border-radius: 10px; min-height: 360px; display: grid; place-items: center; overflow: hidden; }
    .preview img { width: 100%; display: block; image-rendering: auto; }
    .panel { border: 1px solid #26292e; border-radius: 10px; background: #13161d; padding: 18px; }
    dl { display: grid; grid-template-columns: 1fr auto; gap: 10px 14px; margin: 0; font-size: 14px; }
    dt { color: #9ca3af; }
    dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
    code { color: #f6d37a; overflow-wrap: anywhere; font-size: 12px; background: #0d0f12; padding: 6px 8px; border-radius: 4px; border: 1px solid #26292e; }
    .links { margin-top: 18px; display: grid; gap: 8px; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } main { padding: 18px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">
        <span class="logo-pill">RIVET STUDIO</span>
        <h1>Gaviru E400D Cam</h1>
        <div class="badge" id="status">starting</div>
      </div>
      <div class="nav-btns">
        <a class="btn" href="/control">🎛️ Open Gaviru E400D Cam Studio</a>
        <a class="btn secondary" href="/watch">📡 WebRTC / Remote Monitor</a>
        <a class="btn secondary" href="/stream" target="_blank">🎥 Clean OBS Stream (/stream)</a>
      </div>
    </header>
    <section class="grid">
      <div class="preview"><img src="/snapshot.jpg" id="preview" alt="Gaviru E400D Cam Live View"></div>
      <aside class="panel">
        <dl>
          <dt>Camera</dt><dd>Gaviru E400D Cam</dd>
          <dt>FPS</dt><dd id="fps">0</dd>
          <dt>Resolution</dt><dd id="resolution">unknown</dd>
          <dt>Frames</dt><dd id="frames">0</dd>
          <dt>Avg frame</dt><dd id="bytes">0 KB</dd>
          <dt>Last frame</dt><dd id="last">none</dd>
        </dl>
        <div class="links">
          <code id="stream">http://127.0.0.1:8787/live.mjpg</code>
          <code id="snapshot">http://127.0.0.1:8787/snapshot.jpg</code>
        </div>
      </aside>
    </section>
  </main>
  <script>
    async function refresh() {
      const response = await fetch('/status.json', { cache: 'no-store' });
      const status = await response.json();
      const frame = status.frame || {};
      document.getElementById('status').textContent = frame.status || 'unknown';
      document.getElementById('fps').textContent = frame.fps ?? 0;
      document.getElementById('resolution').textContent = frame.width && frame.height ? frame.width + 'x' + frame.height : 'unknown';
      document.getElementById('frames').textContent = frame.totalFrames ?? 0;
      document.getElementById('bytes').textContent = Math.round((frame.averageFrameBytes || 0) / 1024) + ' KB';
      document.getElementById('last').textContent = frame.lastFrameAt ? new Date(frame.lastFrameAt).toLocaleTimeString() : 'none';
      document.getElementById('stream').textContent = status.streamUrl;
      document.getElementById('snapshot').textContent = status.snapshotUrl;
      document.getElementById('preview').src = '/snapshot.jpg?t=' + Date.now();
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

export function createStudioControlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gaviru E400D Cam — Pro Studio Control Panel</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Gaviru Cam">
  <meta name="theme-color" content="#ef4444">
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png">
  <link rel="apple-touch-icon" href="/assets/icon-192.png">
  <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js" defer></script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080a0f;
      --panel: #11151e;
      --panel-alt: #171c28;
      --border: #262f42;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #ef4444;
      --gold: #f59e0b;
      --blue: #3b82f6;
      --cyan: #06b6d4;
      --green: #10b981;
      --purple: #8b5cf6;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 15% 0%, #191224 0%, #080a0f 55%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Luxury Studio Top Bar */
    .topbar {
      background: rgba(17, 21, 30, 0.92);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
      position: sticky;
      top: 0;
      z-index: 40;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    }
    .brand-group { display: flex; align-items: center; gap: 12px; }
    .canon-logo {
      background: linear-gradient(135deg, #ef4444 0%, #d97706 100%);
      color: #fff;
      font-weight: 900;
      font-size: 12px;
      letter-spacing: 0.08em;
      padding: 6px 11px;
      border-radius: 6px;
      box-shadow: 0 2px 12px rgba(239, 68, 68, 0.4);
    }
    .brand-title-wrap {
      display: flex;
      flex-direction: column;
    }
    .camera-title {
      font-weight: 900;
      font-size: 18px;
      letter-spacing: -0.01em;
      background: linear-gradient(90deg, #ffffff 0%, #fde68a 60%, #f59e0b 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .camera-subtitle {
      font-size: 10.5px;
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .status-pill {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.16);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.45);
      text-transform: uppercase;
    }
    .status-pill.paused {
      background: rgba(245, 158, 11, 0.16);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.45);
    }

    .action-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button, select, input[type="text"] {
      font: inherit;
      color: var(--text);
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 13px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover { border-color: #475569; background: #21293a; }
    button:active { transform: translateY(1px); }
    .btn-shutter {
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      border-color: #f87171;
      color: #fff;
      box-shadow: 0 2px 10px rgba(239, 68, 68, 0.35);
    }
    .btn-shutter:hover { filter: brightness(1.1); }
    .btn-evf-on { background: rgba(16, 185, 129, 0.2); border-color: #10b981; color: #6ee7b7; }
    .btn-evf-off { background: rgba(245, 158, 11, 0.2); border-color: #f59e0b; color: #fde68a; }
    .btn-lcd-on { background: rgba(6, 182, 212, 0.22); border-color: #06b6d4; color: #67e8f9; box-shadow: 0 0 12px rgba(6, 182, 212, 0.25); }
    .btn-lcd-off { background: var(--panel-alt); border-color: var(--border); color: var(--muted); }
    .btn-tunnel { background: rgba(139, 92, 246, 0.22); border-color: #8b5cf6; color: #ddd6fe; }
    .btn-record.recording { background: #dc2626; border-color: #f87171; color: #fff; animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.65; } }

    /* Main Workspace Layout */
    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 425px;
      gap: 16px;
      padding: 16px;
      flex: 1;
      max-width: 1740px;
      width: 100%;
      margin: 0 auto;
    }
    @media (max-width: 1140px) {
      .workspace { grid-template-columns: 1fr; }
    }

    /* Monitor Section */
    .monitor-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }
    .monitor-toolbar {
      padding: 10px 14px;
      background: var(--panel-alt);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .mode-switch {
      display: inline-flex;
      background: #080a0f;
      padding: 3px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .mode-switch button {
      border: none;
      background: transparent;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .mode-switch button.active {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
    }

    .viewport-stage {
      position: relative;
      background: #030407;
      min-height: 500px;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      padding: 12px;
    }
    .canvas-wrap {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      max-height: 75vh;
      border: 1px solid #262f42;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      box-shadow: 0 14px 40px rgba(0,0,0,0.7);
      cursor: crosshair;
    }
    .canvas-wrap.portrait {
      aspect-ratio: 9 / 16;
      height: 75vh;
      width: auto;
    }
    .canvas-wrap.landscape {
      aspect-ratio: 3 / 2;
      width: 100%;
      max-width: 1120px;
    }
    #monitorCanvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      image-rendering: high-quality;
    }
    #rawStreamImg {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0.001;
      pointer-events: none;
      z-index: -1;
    }

    /* Animated Touch AF Focus Box on Monitor */
    .af-focus-box {
      position: absolute;
      width: 74px;
      height: 54px;
      border: 2px solid #fbbf24;
      border-radius: 4px;
      transform: translate(-50%, -50%);
      pointer-events: none;
      display: none;
      box-shadow: 0 0 14px rgba(251, 191, 36, 0.7);
      z-index: 15;
    }
    .af-focus-box.locked {
      border-color: #10b981;
      box-shadow: 0 0 16px rgba(16, 185, 129, 0.85);
    }
    .af-focus-box::after {
      content: "AF";
      position: absolute;
      top: -18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 10px;
      font-weight: 800;
      padding: 1px 5px;
      border-radius: 3px;
      background: #fbbf24;
      color: #000;
    }
    .af-focus-box.locked::after {
      content: "AF LOCKED";
      background: #10b981;
      color: #000;
    }

    /* Grid Overlay */
    .grid-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      display: none;
    }
    .grid-overlay.visible { display: block; }
    .grid-line-v1, .grid-line-v2 {
      position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,0.28);
    }
    .grid-line-v1 { left: 33.333%; }
    .grid-line-v2 { left: 66.666%; }
    .grid-line-h1, .grid-line-h2 {
      position: absolute; left: 0; right: 0; height: 1px; background: rgba(255,255,255,0.28);
    }
    .grid-line-h1 { top: 33.333%; }
    .grid-line-h2 { top: 66.666%; }
    .grid-center {
      position: absolute; top: 50%; left: 50%; width: 28px; height: 28px;
      transform: translate(-50%, -50%);
      border: 1px solid rgba(59, 130, 246, 0.75);
      border-radius: 50%;
    }

    /* Canon EOS 4000D LCD Screen / Menu / OSD Overlay */
    .canon-osd-screen {
      position: absolute;
      inset: 0;
      background: rgba(10, 13, 18, 0.88);
      backdrop-filter: blur(4px);
      display: none;
      flex-direction: column;
      justify-content: space-between;
      padding: 16px;
      color: #f9fafb;
      z-index: 20;
      user-select: none;
    }
    .canon-osd-screen.active { display: flex; }
    .canon-osd-screen.transparent-bg {
      background: rgba(8, 10, 14, 0.50);
      backdrop-filter: none;
    }
    .osd-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #f59e0b;
      padding-bottom: 8px;
    }
    .osd-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .osd-tab {
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      background: #1f2937;
      border: 1px solid #374151;
    }
    .osd-tab.active { background: #f59e0b; color: #000; border-color: #f59e0b; }
    .osd-q-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
    }
    .osd-tile {
      background: rgba(24, 30, 40, 0.92);
      border: 1px solid #3b4252;
      border-radius: 6px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      cursor: pointer;
    }
    .osd-tile:hover {
      border-color: #f59e0b;
      box-shadow: 0 0 0 1px #f59e0b inset;
    }
    .osd-tile-label { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.04em; }
    .osd-tile-value { font-size: 18px; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums; }
    .osd-menu-list {
      display: none;
      flex-direction: column;
      gap: 6px;
      background: #111827;
      border: 1px solid #374151;
      border-radius: 6px;
      padding: 12px;
    }
    .osd-menu-row {
      display: flex;
      justify-content: space-between;
      padding: 7px 10px;
      border-bottom: 1px solid #1f2937;
      font-size: 13px;
    }
    .osd-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      border-top: 1px solid #374151;
      padding-top: 8px;
      color: #d1d5db;
    }

    /* Monitor Footer Telemetry */
    .monitor-footer {
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      background: var(--panel-alt);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--muted);
    }
    .telemetry-badges { display: flex; gap: 14px; flex-wrap: wrap; }
    .telemetry-badges strong { color: var(--text); }

    /* Right Control Sidebar */
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .tab-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      background: var(--panel);
      padding: 6px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .tab-btn {
      padding: 8px 6px;
      font-size: 11.5px;
      text-align: center;
      border: none;
      background: transparent;
      color: var(--muted);
      border-radius: 6px;
    }
    .tab-btn.active {
      background: var(--blue);
      color: #fff;
    }

    .studio-section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .section-header {
      padding: 11px 14px;
      background: var(--panel-alt);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
    }
    .section-body {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .section-body.collapsed { display: none; }

    .control-row {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .control-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
    }
    .control-label span.val { color: var(--text); font-variant-numeric: tabular-nums; }
    select, input[type="range"] { width: 100%; }
    input[type="range"] { accent-color: var(--blue); cursor: pointer; }

    .preset-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 7px;
    }
    .preset-btn {
      text-align: left;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .preset-btn.active {
      border-color: var(--blue);
      background: rgba(59, 130, 246, 0.18);
    }
    .preset-btn small { font-size: 10px; color: var(--muted); font-weight: 400; }

    .focus-drive-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 5px;
    }
    .focus-drive-grid button {
      padding: 9px 4px;
      font-size: 11px;
      text-align: center;
      user-select: none;
    }
    .tip-banner {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 7px;
      padding: 8px 10px;
      font-size: 11.5px;
      color: #fde68a;
      line-height: 1.4;
    }

    .code-box {
      background: #080a0d;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: #fcd34d;
      word-break: break-all;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .qr-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: #0d1016;
      border: 1px solid var(--border);
      border-radius: 8px;
      text-align: center;
    }
    .qr-box img {
      width: 148px;
      height: 148px;
      border-radius: 6px;
      background: #fff;
      padding: 6px;
    }
  </style>
</head>
<body>
  <!-- Commercial Software License & Password Protection Lock Screen (Password: gavi01) -->
  <div id="licenseLockModal" style="position:fixed; inset:0; z-index:99999; background:radial-gradient(circle at 50% 25%, rgba(28,36,56,0.97) 0%, rgba(5,7,11,0.99) 100%); backdrop-filter:blur(18px); display:flex; align-items:center; justify-content:center; padding:20px;">
    <div style="max-width:520px; width:100%; background:linear-gradient(180deg, #121722 0%, #0b0e15 100%); border:1px solid rgba(251,191,36,0.45); border-radius:16px; box-shadow:0 25px 70px rgba(0,0,0,0.85), 0 0 40px rgba(245,158,11,0.12); padding:28px 28px 24px; text-align:center; position:relative;">
      <!-- Custom Studio DSLR Camera Logo SVG -->
      <div style="display:flex; justify-content:center; margin-bottom:14px;">
        <div style="width:78px; height:78px; border-radius:20px; background:linear-gradient(135deg, #111827, #1e293b); border:2px solid #f59e0b; box-shadow:0 8px 25px rgba(245,158,11,0.28); display:grid; place-items:center;">
          <svg width="48" height="48" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="16" width="52" height="38" rx="8" fill="#0F172A" stroke="#F59E0B" stroke-width="2.5"/>
            <path d="M20 16L24 9H40L44 16H20Z" fill="#DC2626" stroke="#F59E0B" stroke-width="2"/>
            <circle cx="32" cy="35" r="14" fill="#090D16" stroke="#F59E0B" stroke-width="2.5"/>
            <circle cx="32" cy="35" r="9" fill="#0284C7" fill-opacity="0.35" stroke="#38BDF8" stroke-width="2"/>
            <circle cx="29" cy="32" r="3" fill="#E0F2FE"/>
            <circle cx="49" cy="24" r="3" fill="#EF4444"/>
          </svg>
        </div>
      </div>

      <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.45); color:#fde68a; font-size:11px; font-weight:800; padding:3px 12px; border-radius:999px; letter-spacing:0.08em; margin-bottom:8px;">
        👑 OFFICIAL COMMERCIAL EDITION • LICENSED SOFTWARE
      </div>

      <h1 style="margin:0 0 4px; font-size:22px; font-weight:900; color:#ffffff; letter-spacing:0.02em;">
        GAVIRU E400D CAM STUDIO PRO
      </h1>
      <p style="margin:0 0 14px; font-size:12.5px; color:#9ca3af;">
        Canon EOS 4000D Full HD 1080p Broadcast, Audio & Remote Control Suite
      </p>

      <!-- Owner / Developer & Anti-Resale Legal Box -->
      <div style="background:rgba(15,23,42,0.85); border:1px solid #263042; border-radius:10px; padding:12px 14px; text-align:left; margin-bottom:14px; display:flex; flex-direction:column; gap:7px; font-size:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.07); padding-bottom:6px;">
          <span style="color:#9ca3af;">👤 නිර්මාණය සහ අයිතිය (Owner):</span>
          <strong style="color:#fbbf24; font-size:13.5px; letter-spacing:0.03em;">Gaviru Sandeeptha</strong>
        </div>
        <div style="display:flex; flex-direction:column; gap:2px; border-bottom:1px solid rgba(255,255,255,0.07); padding-bottom:6px;">
          <span style="color:#9ca3af;">📁 Project / Software ගත්ත තැන (Location):</span>
          <code id="licenseProjectPath" style="color:#6ee7b7; font-size:11px; word-break:break-all; background:#06090f; padding:4px 7px; border-radius:5px; border:1px solid #1e293b;">c:\Users\gavir\Downloads\rivet-main (1)\rivet-main</code>
        </div>
        <div style="background:rgba(220,38,38,0.16); border:1px solid rgba(239,68,68,0.5); border-radius:7px; padding:7px 10px; color:#fecaca; font-weight:700; font-size:11.5px; text-align:center; line-height:1.45;">
          🚫 අවසරයකින් තොරව නැවත විකිණීම හෝ බෙදාහැරීම සපුරා තහනම්!<br>
          <span style="font-size:10.5px; color:#fca5a5; font-weight:600;">STRICTLY PROHIBITED FOR UNAUTHORIZED RESALE • © GAVIRU SANDEEPTHA</span>
        </div>
      </div>

      <!-- Password Form -->
      <form onsubmit="event.preventDefault(); unlockCommercialLicense();" style="display:flex; flex-direction:column; gap:10px;">
        <div style="text-align:left;">
          <label for="licensePasswordInput" style="display:block; font-size:11.5px; font-weight:700; color:#d1d5db; margin-bottom:5px;">
            🔐 මෘදුකාංග මුරපදය ඇතුළත් කරන්න (Enter License Password):
          </label>
          <input
            type="password"
            id="licensePasswordInput"
            placeholder="Enter password to unlock Studio..."
            autocomplete="off"
            style="width:100%; padding:11px 14px; font-size:14px; font-weight:700; border-radius:8px; border:1px solid #3b82f6; background:#06080e; color:#fff; text-align:center; letter-spacing:0.12em;"
          >
        </div>
        <div id="licenseErrorMsg" style="display:none; color:#f87171; font-size:12px; font-weight:700;">
          ❌ මුරපදය වැරදියි! නිවැරදි මුරපදය ඇතුළත් කරන්න. (Invalid Password)
        </div>
        <button type="submit" style="padding:11px 18px; font-size:14px; font-weight:800; border-radius:8px; border:1px solid #f59e0b; background:linear-gradient(135deg, #d97706, #b45309); color:#fff; cursor:pointer; box-shadow:0 6px 20px rgba(217,119,6,0.35);">
          🔓 Unlock Gaviru Cam Studio Pro
        </button>
      </form>
    </div>
  </div>

  <!-- Top Action Bar -->
  <header class="topbar">
    <div class="brand-group">
      <!-- Custom Studio Camera SVG Logo Badge -->
      <div style="display:flex; align-items:center; gap:8px; background:linear-gradient(135deg, #111827, #1e293b); border:1.5px solid #f59e0b; padding:4px 10px; border-radius:8px; box-shadow:0 2px 10px rgba(245,158,11,0.2);">
        <svg width="26" height="26" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="6" y="16" width="52" height="38" rx="8" fill="#0F172A" stroke="#F59E0B" stroke-width="4"/>
          <path d="M20 16L24 9H40L44 16H20Z" fill="#DC2626" stroke="#F59E0B" stroke-width="3"/>
          <circle cx="32" cy="35" r="13" fill="#090D16" stroke="#F59E0B" stroke-width="3.5"/>
          <circle cx="32" cy="35" r="7" fill="#38BDF8"/>
          <circle cx="49" cy="24" r="3.5" fill="#EF4444"/>
        </svg>
        <span style="font-weight:900; font-size:13px; letter-spacing:0.06em; color:#fde68a;">GAVIRU STUDIO</span>
      </div>
      <div class="brand-title-wrap">
        <span class="camera-title" id="cameraName">Gaviru E400D Cam</span>
        <span class="camera-subtitle">Owner: <strong style="color:#fbbf24;">Gaviru Sandeeptha</strong> • <span style="color:#fca5a5; font-weight:700;">🚫 විකිණීම තහනම්</span></span>
      </div>
      <span class="status-pill" id="connectionBadge">LIVE STREAMING</span>
      <span class="status-pill" id="queueBadge" style="background:rgba(59,130,246,0.15);color:#93c5fd;border-color:rgba(59,130,246,0.4);">QUEUE: 0</span>
    </div>

    <div class="action-bar">
      <!-- Toggle 1: Web Live View Stream ON / OFF -->
      <button id="btnEvfToggle" class="btn-evf-on" onclick="toggleEvfShutter()" title="Toggle Web Live View Stream (Mirror Up/Down)">
        👁️ Live View Preview: ON
      </button>
      <!-- Toggle 2: Camera Physical LCD Display Preview ON / OFF -->
      <button id="btnCamLcdToggle" class="btn-lcd-on" onclick="toggleCameraLcdDisplay()" title="Turn the Preview on Camera's Physical Back LCD Screen ON or OFF">
        📺 Cam Display: ON
      </button>
      <!-- Toggle 3: Physical Camera Body Control Unlock -->
      <button id="btnCamControlTop" class="btn-evf-on" onclick="toggleCamHardwareMode()" title="Switch between Dual Control (Web + Camera) and Full Camera Body Menu/Buttons Control">
        🎮 Cam + Web Control
      </button>
      <button onclick="triggerTouchAfCenter()" style="border-color:#fbbf24; color:#fde68a;" title="Auto Focus Now">
        🎯 Auto Focus
      </button>
      <button class="btn-shutter" onclick="sendCommand({ action: 'shutter_release' })">
        📸 Take Photo (0x910F)
      </button>
      <button onclick="takePcSnapshot()">
        🖼️ PC Snapshot (.jpg)
      </button>
      <button id="btnRecordVideo" class="btn-record" onclick="toggleVideoRecording()">
        🔴 Record Video
      </button>
      <button id="btnFlashQuick" onclick="toggleFlashQuick()">
        ⚡ Flash: OFF
      </button>
      <button class="btn-tunnel" onclick="startTunnel()">
        🌐 Cloud Tunnel Link
      </button>
      <button id="btnInstallPwa" onclick="installMobileApp()" style="border-color:#10b981; color:#6ee7b7; font-weight:700;" title="Install on Android or iPhone Home Screen as a native mobile app">
        📲 Mobile App
      </button>
      <button id="btnToggleLogsTop" class="btn-evf-on" onclick="toggleStudioLogsDrawer()" title="Show or Hide Live System & Camera Console Logs on Screen">
        🖥️ Logs: ON
      </button>
      <button onclick="lockCommercialLicense()" style="border-color:#f59e0b; color:#fde68a;" title="Lock App with Password (gavi01)">
        🔒 Lock
      </button>
      <button onclick="shutdownStudioApp()" style="border-color:#ef4444; background:rgba(239,68,68,0.18); color:#fca5a5;" title="Completely close Gaviru E400D Cam Studio background app">
        ❌ Exit App
      </button>
    </div>
  </header>

  <!-- Main Studio Workspace -->
  <div class="workspace">
    <!-- Left Monitor Area -->
    <section class="monitor-card">
      <div class="monitor-toolbar">
        <div class="mode-switch">
          <button id="modeSensorBtn" class="active" onclick="setStreamViewMode('sensor')">
            🎥 Live View Sensor Stream
          </button>
          <button id="modeScreenBtn" onclick="setStreamViewMode('screen')">
            📱 Camera Screen / Menu Preview (Photo OSD Mode)
          </button>
        </div>

        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button id="btnAudioToggle" class="btn-evf-on" onclick="toggleCameraAudio()" title="Continuous Natural Camera Audio (48kHz Stereo Unprocessed)">
            🔊 Cam Sound: ON
          </button>
          <select id="audioDeviceSelect" onchange="changeAudioDevice(this.value)" style="max-width:170px; padding:5px 8px; font-size:11.5px;" title="Select Camera / Microphone Audio Source">
            <option value="default">🎙️ Default Camera/Mic Audio</option>
          </select>
          <label style="font-size:11.5px; color:var(--muted); display:flex; align-items:center; gap:4px;" title="Live Audio Gain / Volume Boost">
            🎚️ Vol
            <input type="range" id="audioVolumeSlider" min="0" max="200" step="5" value="100" style="width:65px;" oninput="updateAudioVolume(this.value)">
            <span id="audioVolumeVal" style="color:#6ee7b7; font-weight:700; min-width:34px;">100%</span>
          </label>
          <div style="width:52px; height:8px; background:#080a0f; border:1px solid var(--border); border-radius:99px; overflow:hidden;" title="Live Audio Level Meter">
            <div id="audioLevelMeter" style="width:0%; height:100%; background:linear-gradient(90deg, #10b981, #f59e0b, #ef4444); transition:width 0.06s linear;"></div>
          </div>
          <!-- Aspect Ratio Switcher (16:9 Landscape / 9:16 Portrait / 3:2 Native) -->
          <select id="selectOutputAspect" onchange="setOutputAspect(this.value)" style="background:#111827; color:#fbbf24; border:1px solid #f59e0b; padding:4px 8px; border-radius:6px; font-size:11.5px; font-weight:700;" title="Output Aspect Ratio (16:9 for OBS / YouTube, 9:16 for TikTok / Shorts)">
            <option value="16:9">📐 16:9 Landscape (OBS / YT)</option>
            <option value="9:16">📱 9:16 Portrait (Shorts / TikTok)</option>
            <option value="3:2">📷 3:2 Native DSLR Sensor</option>
          </select>

          <!-- Master Resolution Engine (4K UHD / 2K QHD / 1080p HD) -->
          <select id="selectOutputRes" onchange="setOutputResolution(this.value)" style="background:#0f172a; color:#38bdf8; border:1px solid #0284c7; padding:4px 8px; border-radius:6px; font-size:11.5px; font-weight:700;" title="Master Quality / Super-Resolution Engine">
            <option value="4k">🌟 4K UHD Master (3840x2160)</option>
            <option value="2k">💎 2K QHD Studio (2560x1440)</option>
            <option value="1080p">📺 1080p Full HD Broadcast</option>
          </select>

          <!-- Studio Color Grading & Vibrance Profile -->
          <select id="selectColorGrading" onchange="setColorGrading(this.value)" style="background:#1c1917; color:#fb7185; border:1px solid #e11d48; padding:4px 8px; border-radius:6px; font-size:11.5px; font-weight:700;" title="Color Profile & Vibrance Tuning">
            <option value="vivid">🎨 Vivid Studio Pro</option>
            <option value="cinema">🎬 Cinematic Warmth</option>
            <option value="warm">☀️ Golden Studio</option>
            <option value="standard">📷 Standard Neutral</option>
          </select>

          <select id="portraitRotation" onchange="updateCanvasTransform()" title="Portrait Rotation / Fit">
            <option value="crop">9:16 Center Crop</option>
            <option value="cw">Rotate 90° CW</option>
            <option value="ccw">Rotate 90° CCW</option>
          </select>
          <button id="btnGrid" onclick="toggleGrid()">
            #️⃣ Grid
          </button>
          <label style="font-size:12px; color:var(--muted); display:flex; align-items:center; gap:5px;">
            🔍 Zoom
            <input type="range" id="zoomSlider" min="1" max="3" step="0.1" value="1" style="width:75px;" oninput="updateZoom(this.value)">
            <span id="zoomVal">1.0x</span>
          </label>
        </div>
      </div>

      <!-- Monitor Stage -->
      <div class="viewport-stage">
        <div id="canvasContainer" class="canvas-wrap landscape" onclick="onMonitorCanvasClick(event)" title="Click anywhere on preview to Auto Focus!">
          <img id="rawStreamImg" src="/stream?raw=1" crossorigin="anonymous" decoding="sync" fetchpriority="high" alt="Raw MJPEG Stream">
          <canvas id="monitorCanvas" width="1280" height="854"></canvas>
          <audio id="liveCamAudio" autoplay playsinline style="display:none;"></audio>

          <!-- Animated AF Reticle Box -->
          <div id="afFocusBox" class="af-focus-box"></div>

          <div id="gridOverlay" class="grid-overlay">
            <div class="grid-line-v1"></div>
            <div class="grid-line-v2"></div>
            <div class="grid-line-h1"></div>
            <div class="grid-line-h2"></div>
            <div class="grid-center"></div>
          </div>

          <!-- Gaviru E400D Cam Real-time LCD Screen / Menu / OSD Display -->
          <div id="canonOsdOverlay" class="canon-osd-screen" onclick="event.stopPropagation()">
            <div class="osd-header">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="background:#f59e0b; color:#000; font-weight:900; padding:2px 8px; border-radius:3px; font-size:14px;">M</span>
                <span style="font-weight:800; font-size:13px;">GAVIRU E400D CAM — LCD SCREEN / OSD MONITOR</span>
              </div>
              <div class="osd-tabs">
                <button class="osd-tab active" id="osdTabQ" onclick="switchOsdSubView('q')">[Q] Quick Control OSD</button>
                <button class="osd-tab" id="osdTabMenu" onclick="switchOsdSubView('menu')">[MENU] Camera Menu</button>
                <button class="osd-tab" id="osdTabBlend" onclick="toggleOsdBackdrop()">👁️ Overlay Blend</button>
                <button class="osd-tab" onclick="toggleCameraLcdDisplay()">📺 Cam LCD Toggle</button>
                <button class="osd-tab" onclick="sendCommand({ action: 'capture_screen' })">🔄 Sync OSD (0x9156)</button>
              </div>
            </div>

            <!-- Q-Screen Interactive Tiles -->
            <div id="osdQView" class="osd-q-grid">
              <div class="osd-tile" onclick="focusSidebarControl('ctrlShutter')">
                <span class="osd-tile-label">Shutter Speed (0xD102)</span>
                <span class="osd-tile-value" id="osdShutter">1/60</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlAperture')">
                <span class="osd-tile-label">Aperture / F-Stop (0xD101)</span>
                <span class="osd-tile-value" id="osdAperture">f/3.5</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlIso')">
                <span class="osd-tile-label">ISO Speed (0xD103)</span>
                <span class="osd-tile-value" id="osdIso">ISO 400</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlExpComp')">
                <span class="osd-tile-label">Exposure Comp (0xD104)</span>
                <span class="osd-tile-value" id="osdExpComp">0.0 EV</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlWb')">
                <span class="osd-tile-label">White Balance (0xD10A)</span>
                <span class="osd-tile-value" id="osdWb" style="font-size:14px;">AWB (Auto)</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlFlashComp')">
                <span class="osd-tile-label">Flash / EV (0xD138 / 0xD10D)</span>
                <span class="osd-tile-value" id="osdFlash" style="font-size:14px;">OFF (0.0 EV)</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlMetering')">
                <span class="osd-tile-label">Metering Mode (0xD107)</span>
                <span class="osd-tile-value" id="osdMetering" style="font-size:13px;">Evaluative</span>
              </div>
              <div class="osd-tile" onclick="focusSidebarControl('ctrlDrive')">
                <span class="osd-tile-label">Drive / AF (0xD106)</span>
                <span class="osd-tile-value" id="osdDrive" style="font-size:13px;">Single Shooting</span>
              </div>
            </div>

            <!-- Camera Menu View -->
            <div id="osdMenuView" class="osd-menu-list">
              <div style="display:flex; gap:8px; margin-bottom:6px;">
                <span style="background:#dc2626; padding:3px 8px; border-radius:3px; font-size:11px; font-weight:700;">SHOOT 1</span>
                <span style="background:#1f2937; padding:3px 8px; border-radius:3px; font-size:11px;">SHOOT 2</span>
                <span style="background:#1f2937; padding:3px 8px; border-radius:3px; font-size:11px;">LCD DISPLAY</span>
                <span style="background:#1f2937; padding:3px 8px; border-radius:3px; font-size:11px;">GAVIRU E400D</span>
              </div>
              <div class="osd-menu-row"><span>Camera Name</span><strong>Gaviru E400D Cam</strong></div>
              <div class="osd-menu-row"><span>Web Live View Stream (0xD1B1)</span><strong id="osdMenuLv">Enable (Wi-Fi EVF Active)</strong></div>
              <div class="osd-menu-row"><span>Camera Physical LCD Screen (0xD1B0)</span><strong id="osdMenuEvfOut">OFF (Wi-Fi Only)</strong></div>
              <div class="osd-menu-row"><span>Flash Control (0xD138 / 0xD10D)</span><strong id="osdMenuFlash">Built-in Flash Control</strong></div>
              <div class="osd-menu-row"><span>AF Operation / Lens Drive</span><strong>Live Contrast AF + 6-Step Motor</strong></div>
              <div class="osd-menu-row"><span>Last PTP/MTP Command</span><strong id="osdMenuLastCmd">Ready</strong></div>
            </div>

            <div class="osd-footer">
              <span>📶 Gaviru E400D Cam Connected</span>
              <span id="osdEvScale">Click anywhere on video to Auto Focus 🎯</span>
              <span>🔋 Bat: FULL | [ 999 ]</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Monitor Telemetry Bar -->
      <div class="monitor-footer">
        <div class="telemetry-badges">
          <span>👤 Owner: <strong style="color:#fbbf24;">Gaviru Sandeeptha</strong></span>
          <span style="color:#fca5a5; font-weight:700;">🚫 විකිණීම සපුරා තහනම්</span>
          <span>📁 Path: <strong id="projectPathBadge" style="color:#6ee7b7; font-size:11px;">Loading...</strong></span>
          <span>Status: <strong id="statStatus">streaming</strong></span>
          <span>FPS: <strong id="statFps">0.0</strong></span>
          <span>Frame: <strong id="statRes">--</strong></span>
          <span>Size: <strong id="statBytes">0 KB</strong></span>
          <span>Last Cmd: <strong id="statLastCmd">Ready</strong></span>
        </div>
        <div>
          <a href="/stream" target="_blank" style="color:#60a5fa; text-decoration:none; margin-right:12px;">🔗 Clean OBS Stream (/stream)</a>
          <a href="/clean" target="_blank" style="color:#a78bfa; text-decoration:none;">🪟 VDO.Ninja Pop-out (/clean)</a>
        </div>
      </div>

      <!-- Built-in On-Screen System & Camera Console Logs (replaces hidden Windows CMD window) -->
      <div id="studioLogsDrawer" style="background:#06080d; border-top:1px solid var(--border); padding:8px 14px; display:flex; flex-direction:column; gap:6px; max-height:135px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px; font-size:11.5px; font-weight:700; color:#93c5fd;">
            <span>🖥️ Live System & Camera Console Logs (සජීවී පද්ධති සහ කැමරා ලොග්)</span>
            <span id="logErrorIndicator" style="display:none; background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid #ef4444; padding:1px 6px; border-radius:4px; font-size:10.5px;"></span>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button onclick="sendCommand({ action: 'poll_events' })" style="padding:2px 8px; font-size:11px;">🔄 Sync Cam</button>
            <button onclick="clearStudioLogsUi()" style="padding:2px 8px; font-size:11px;">🧹 Clear</button>
            <button onclick="toggleStudioLogsDrawer()" style="padding:2px 8px; font-size:11px;">🔽 Hide</button>
          </div>
        </div>
        <div id="studioLogsList" style="flex:1; overflow-y:auto; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:11.5px; line-height:1.45; color:#d1d5db; background:#030407; border:1px solid #1e2430; border-radius:6px; padding:6px 10px; display:flex; flex-direction:column; gap:2px;">
          <div style="color:#6ee7b7;">[SYSTEM] Gaviru E400D Cam Studio initialized — waiting for live telemetry...</div>
        </div>
      </div>
    </section>

    <!-- Right Studio Controls Sidebar -->
    <aside class="sidebar">
      <div class="tab-bar">
        <button class="tab-btn active" onclick="filterStudioTab('all', this)">All Panels</button>
        <button class="tab-btn" onclick="filterStudioTab('focus', this)">🎯 Focus & LCD</button>
        <button class="tab-btn" onclick="filterStudioTab('exposure', this)">☀️ Exposure</button>
        <button class="tab-btn" onclick="filterStudioTab('remote', this)">📡 Stream</button>
      </div>

      <!-- 1. Focus, Lens Motor Drive & Camera LCD Display Control -->
      <div class="studio-section" data-tab="focus">
        <div class="section-header" onclick="toggleSection(this)">
          <span>🎯 Pro Focus & Camera LCD Display Control</span>
          <span>▾</span>
        </div>
        <div class="section-body">
          <!-- Camera Physical Display & Web Live View Dual Switches -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
            <button id="btnPanelCamLcd" class="btn-lcd-on" onclick="toggleCameraLcdDisplay()">
              📺 Cam LCD Display: ON
            </button>
            <button id="btnPanelEvf" class="btn-evf-on" onclick="toggleEvfShutter()">
              👁️ Web Preview: ON
            </button>
          </div>

          <!-- Physical Camera Body + Web Control Mode Selector -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
            <button id="btnDualControl" class="btn-evf-on" onclick="sendCommand({ action: 'set_control_authority', mode: 'dual' })" title="Control from BOTH Physical Camera Dials/Shutter AND Web Panel while streaming">
              🎮 Cam + Web Dual Control
            </button>
            <button id="btnCamPriority" onclick=" toggleCamHardwareMode()" title="Unlock 100% of physical Camera [MENU] / [Q] / Buttons on camera body">
              🔓 Unlock Cam Body Menu
            </button>
          </div>

          <div class="tip-banner">
            💡 <strong>Focus & Freeze Tip:</strong> ෆෝකස් වෙද්දී රූපය සහ එළිය ලස්සනටම ආපු ගමන් <strong>වීඩියෝ එක උඩ ආයෙත් Click කරන්න</strong> (හෝ <strong>Spacebar</strong> ඔබන්න / පහත <strong>🛑 මෙතනින් නවත්තන්න</strong> ඔබන්න) — ඒ තත්පරයේම ෆෝකස් එක සහ එළිය එහෙම්මම Lock වේ!
          </div>

          <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:6px;">
            <button onclick="triggerTouchAfCenter()" style="border-color:#10b981; background:rgba(16,185,129,0.18); color:#6ee7b7; font-weight:700;">
              🎯 Auto Focus (0x9154)
            </button>
            <button onclick="triggerHalfPressAf()" style="border-color:#3b82f6; background:rgba(59,130,246,0.18); font-weight:700;">
              🔘 Half-Press AF (Lock)
            </button>
          </div>

          <button id="btnFreezeFocusNow" onclick="freezeFocusAndLightNow()" style="width:100%; padding:10px; font-size:13px; font-weight:800; border:2px solid #f59e0b; background:linear-gradient(135deg, rgba(245,158,11,0.28), rgba(239,68,68,0.28)); color:#fef08a; border-radius:8px; cursor:pointer; box-shadow:0 2px 10px rgba(245,158,11,0.2);">
            🛑 මෙතනින් නවත්තන්න / Lock Focus & Light Here (Spacebar)
          </button>

          <div class="control-row">
            <div class="control-label">
              <span>Manual Focus Motor Power (Pulses per Click)</span>
              <span class="val" id="lblFocusRepeat">3x Step</span>
            </div>
            <input type="range" id="sliderFocusRepeat" min="1" max="6" value="3" oninput="document.getElementById('lblFocusRepeat').textContent = this.value + 'x Step'">
          </div>

          <div class="control-row">
            <div class="control-label">
              <span>6-Step Manual Lens Drive (Click or Hold)</span>
              <span class="val">Near ◀ / ▶ Far</span>
            </div>
            <div class="focus-drive-grid">
              <button onmousedown="startHoldFocus(0x0003)" onmouseup="stopHoldFocus()" onmouseleave="stopHoldFocus()" ontouchstart="startHoldFocus(0x0003)" ontouchend="stopHoldFocus()" title="Near Fast">⏪ N3</button>
              <button onmousedown="startHoldFocus(0x0002)" onmouseup="stopHoldFocus()" onmouseleave="stopHoldFocus()" ontouchstart="startHoldFocus(0x0002)" ontouchend="stopHoldFocus()" title="Near Medium">◀◀ N2</button>
              <button onmousedown="startHoldFocus(0x0001)" onmouseup="stopHoldFocus()" onmouseleave="stopHoldFocus()" ontouchstart="startHoldFocus(0x0001)" ontouchend="stopHoldFocus()" title="Near Fine">◀ N1</button>
              <button onmousedown="startHoldFocus(0x8001)" onmouseup="stopHoldFocus()" onmouseleave="stopHoldFocus()" ontouchstart="startHoldFocus(0x8001)" ontouchend="stopHoldFocus()" title="Far Fine">F1 ▶</button>
              <button onmousedown="startHoldFocus(0x8002)" onmouseup="stopHoldFocus()" onmouseleave="stopHoldFocus()" ontouchstart="startHoldFocus(0x8002)" ontouchend="stopHoldFocus()" title="Far Medium">F2 ▶▶</button>
              <button onmousedown="startHoldFocus(0x8003)" onmouseup="stopHoldFocus()" onmouseleave="stopHoldFocus()" ontouchstart="startHoldFocus(0x8003)" ontouchend="stopHoldFocus()" title="Far Fast">F3 ⏩</button>
            </div>
          </div>

          <hr style="border:none; border-top:1px solid var(--border); width:100%; margin:6px 0;">

          <!-- Custom Focus Light & AF Confirmation Beep Controls -->
          <div style="background:rgba(245, 158, 11, 0.08); border:1px solid rgba(245, 158, 11, 0.35); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
              <strong style="font-size:12.5px; color:#fde68a;">💡 Focus Light & Beep Effect (ෆෝකස් එළිය පාලනය)</strong>
              <button id="btnAfBeepToggle" class="btn-evf-on" style="padding:4px 9px; font-size:11px;" onclick="toggleAfBeepSound()" title="Canon Focus Confirmation Double-Beep Sound when Focus Locks">
                🔔 AF Beep: ON
              </button>
            </div>

            <div class="control-row">
              <div class="control-label">
                <span>Focus Light Mode (ක්‍රමය)</span>
                <span class="val" id="lblFocusLightStatus">Keep Focus Light</span>
              </div>
              <select id="focusLightMode" onchange="onFocusLightModeChange(this.value)" style="font-size:12px; padding:6px 8px;">
                <option value="lock_dim" selected>🔒 Keep Focus Light Locked (ෆෝකස් වෙද්දි හැදෙන ලස්සන එළිය එහෙම්මම තියාගන්න)</option>
                <option value="lamp_smart">🪔 Smart Lamp / Point Auto-Light (පහනක් / Click කරන තැන අනුව එළිය හැදීම)</option>
                <option value="custom">✨ Custom Dim ➔ Bright on Beep (ෆෝකස් වෙද්දි අඩු වෙලා Beep එකත් එක්ක වැඩි වීම)</option>
                <option value="off">⏹ Off (සාමාන්‍ය Manual Brightness පමණක්)</option>
              </select>
            </div>

            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:5px;">
              <button onclick="applyFocusLightPreset('keep_sweet_spot')" style="padding:6px 4px; font-size:11px; border-color:#10b981; color:#6ee7b7;" title="Keep the exact focus light without jumping back to bright">
                🔒 Keep Light
              </button>
              <button onclick="applyFocusLightPreset('lamp_focus')" style="padding:6px 4px; font-size:11px; border-color:#f59e0b; color:#fde68a;" title="Best for focusing on an Oil Lamp / Candle / Bright Light">
                🪔 පහනක් / Lamp
              </button>
              <button onclick="applyFocusLightPreset('dim_to_bright')" style="padding:6px 4px; font-size:11px; border-color:#3b82f6; color:#93c5fd;" title="Dim to 72% while focusing, then brighten to 118% on Beep">
                ✨ Dim ➔ Bright
              </button>
            </div>

            <div class="control-row">
              <div class="control-label">
                <span>1️⃣ ෆෝකස් වෙද්දි / Lock වෙන එළිය (Focus Sweet-Spot Light)</span>
                <span class="val" id="lblFocusDimLight">82%</span>
              </div>
              <input type="range" id="sliderFocusDimLight" min="35" max="160" value="82" oninput="onWhileFocusLightSliderChange(this.value)">
            </div>

            <div class="control-row">
              <div class="control-label">
                <span>2️⃣ ෆෝකස් ඉවර වුණාම එළිය (After Focus Light - Custom Mode)</span>
                <span class="val" id="lblFocusBrightLight">82%</span>
              </div>
              <input type="range" id="sliderFocusBrightLight" min="40" max="200" value="82" oninput="onAfterFocusLightSliderChange(this.value)">
            </div>

            <div class="control-row">
              <div class="control-label">
                <span>3️⃣ එළිය වෙනස් වෙන වේගය (Smooth Transition Speed)</span>
                <span class="val" id="lblFocusLightSpeed">350 ms</span>
              </div>
              <input type="range" id="sliderFocusLightSpeed" min="50" max="1500" step="50" value="350" oninput="document.getElementById('lblFocusLightSpeed').textContent = this.value + ' ms'">
            </div>
          </div>

          <div class="control-row">
            <div class="control-label"><span>White Balance (0xD105 / 0xD10A)</span><span class="val" id="valWb">AWB</span></div>
            <select id="ctrlWb" onchange="sendCommand({ action: 'white_balance', value: Number(this.value) })"></select>
          </div>

          <div class="control-row">
            <div class="control-label"><span>Metering Mode (0xD107)</span><span class="val" id="valMetering">Evaluative</span></div>
            <select id="ctrlMetering" onchange="sendCommand({ action: 'metering_mode', value: Number(this.value) })"></select>
          </div>

          <div class="control-row">
            <div class="control-label"><span>Drive Mode (0xD106)</span><span class="val" id="valDrive">Single</span></div>
            <select id="ctrlDrive" onchange="sendCommand({ action: 'drive_mode', value: Number(this.value) })"></select>
          </div>
        </div>
      </div>

      <!-- 2. Exposure, Brightness & Shooting Mode Presets -->
      <div class="studio-section" data-tab="exposure">
        <div class="section-header" onclick="toggleSection(this)">
          <span>☀️ Exposure, Brightness & Mode Presets</span>
          <span>▾</span>
        </div>
        <div class="section-body">
          <div class="control-row">
            <div class="control-label"><span>Shooting Mode Presets</span><span class="val" id="presetLabel">OBS Studio Live</span></div>
            <div class="preset-grid" id="presetContainer">
              <button class="preset-btn" onclick="applyPreset('manual')">
                <strong>Manual (M)</strong><small>ISO 400 · 1/60 · f/4.0</small>
              </button>
              <button class="preset-btn active" onclick="applyPreset('obs_studio')">
                <strong>OBS Studio Live</strong><small>ISO 400 · 1/60 · f/3.5</small>
              </button>
              <button class="preset-btn" onclick="applyPreset('portrait')">
                <strong>Portrait</strong><small>ISO 200 · 1/125 · f/3.5</small>
              </button>
              <button class="preset-btn" onclick="applyPreset('low_light')">
                <strong>Low Light / Night</strong><small>ISO 3200 · 1/30 · Boost</small>
              </button>
              <button class="preset-btn" style="grid-column: span 2;" onclick="applyPreset('sports')">
                <strong>Sports / Fast Action</strong><small>ISO 1600 · 1/500 · Continuous Drive</small>
              </button>
            </div>
          </div>

          <div class="control-row">
            <div class="control-label"><span>ISO Sensitivity (0xD103)</span><span class="val" id="valIso">ISO 400</span></div>
            <select id="ctrlIso" onchange="sendCommand({ action: 'iso', value: Number(this.value) })"></select>
          </div>

          <div class="control-row">
            <div class="control-label"><span>Shutter Speed (0xD102)</span><span class="val" id="valShutter">1/60</span></div>
            <select id="ctrlShutter" onchange="sendCommand({ action: 'shutter_speed', value: Number(this.value) })"></select>
          </div>

          <div class="control-row">
            <div class="control-label"><span>Aperture / F-Stop (0xD101)</span><span class="val" id="valAperture">f/3.5</span></div>
            <select id="ctrlAperture" onchange="sendCommand({ action: 'aperture', value: Number(this.value) })"></select>
          </div>

          <div class="control-row">
            <div class="control-label"><span>Exposure Compensation (0xD104)</span><span class="val" id="valExpComp">0.0 EV</span></div>
            <select id="ctrlExpComp" onchange="sendCommand({ action: 'exposure_comp', value: Number(this.value) })"></select>
          </div>

          <hr style="border:none; border-top:1px solid var(--border); width:100%; margin:4px 0;">

          <div class="control-row">
            <div class="control-label"><span>✨ Ultra HD 1080p Detail & Sharpness (OBS Pro)</span><span class="val" id="lblHdSharpness">100%</span></div>
            <input type="range" id="sliderHdSharpness" min="0" max="200" value="100" oninput="updateSoftwareFilters()">
          </div>
          <div class="control-row">
            <div class="control-label"><span>Software Brightness</span><span class="val" id="lblBrightness">100%</span></div>
            <input type="range" id="sliderBrightness" min="35" max="200" value="100" oninput="updateSoftwareFilters()">
          </div>
          <div class="control-row">
            <div class="control-label"><span>Software Contrast</span><span class="val" id="lblContrast">100%</span></div>
            <input type="range" id="sliderContrast" min="50" max="200" value="100" oninput="updateSoftwareFilters()">
          </div>
          <div class="control-row">
            <div class="control-label"><span>Low-Light Night Boost</span><span class="val" id="lblBoost">0%</span></div>
            <input type="range" id="sliderBoost" min="0" max="100" value="0" oninput="updateSoftwareFilters()">
          </div>
          <button onclick="resetSoftwareFilters()" style="font-size:11px; padding:5px;">↺ Reset Software Filters</button>
        </div>
      </div>

      <!-- 3. Flash Control & Light Intensity -->
      <div class="studio-section" data-tab="exposure">
        <div class="section-header" onclick="toggleSection(this)">
          <span>⚡ Flash Firing & Light Intensity (-2 to +2 EV)</span>
          <span>▾</span>
        </div>
        <div class="section-body">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12.5px; font-weight:600;">Flash Firing (0xD10A / 0xD138)</span>
            <button id="btnFlashPanel" onclick="toggleFlashQuick()">⚡ Flash: OFF</button>
          </div>
          <div class="control-row">
            <div class="control-label"><span>Flash Exposure Compensation (0xD10D)</span><span class="val" id="valFlashComp">0.0 EV</span></div>
            <select id="ctrlFlashComp" onchange="sendCommand({ action: 'flash_comp', value: Number(this.value) })"></select>
          </div>
        </div>
      </div>

      <!-- 4. OBS Studio 4K Output & VDO.Ninja Live Streaming Suite -->
      <div class="studio-section" data-tab="remote">
        <div class="section-header" onclick="toggleSection(this)">
          <span>🎬 OBS Studio 4K Output & VDO.Ninja Suite</span>
          <span>▾</span>
        </div>
        <div class="section-body">
          <!-- OBS Direct Browser Source (Ultra 4K / 1080p Canvas) -->
          <div class="control-row">
            <div class="control-label">
              <span>🌟 Local OBS Studio Clean 4K/1080p Browser Source</span>
              <span class="val" style="color:#6ee7b7; font-weight:700;">Zero Lag Direct</span>
            </div>
            <div class="code-box">
              <span id="obsStreamUrl">http://127.0.0.1:8787/clean</span>
              <button onclick="copyText('obsStreamUrl')" style="padding:3px 8px; font-size:11px;">Copy Link</button>
            </div>
            <div style="font-size:11px; color:#93c5fd; background:#080d1a; border:1px solid #1e293b; border-radius:6px; padding:6px 8px; margin-top:4px; line-height:1.45;">
              💡 <strong>OBS Browser Source Settings:</strong><br>
              • <strong>16:9 Landscape:</strong> Width: <code>1920</code> (හෝ <code>3840</code>), Height: <code>1080</code> (හෝ <code>2160</code>)<br>
              • <strong>9:16 Portrait (Shorts/TikTok):</strong> Width: <code>1080</code> (හෝ <code>2160</code>), Height: <code>1920</code> (හෝ <code>3840</code>)
            </div>
            <div style="display:flex; gap:6px; margin-top:6px;">
              <button style="flex:1;" onclick="window.open('/clean', '_blank')" title="Open Standalone Clean Full Screen Pop-out">
                🪟 Open 4K Full Clean Pop-out
              </button>
              <button style="flex:1;" onclick="window.open('/stream?raw=1', '_blank')" title="Open Direct Raw MJPEG Stream">
                🎥 Raw Camera Stream
              </button>
            </div>
          </div>

          <!-- OBS Video Capture Device & Window Capture Guide -->
          <div class="control-row" style="background:#0b111e; border:1px solid #1e3a5f; border-radius:8px; padding:10px;">
            <div class="control-label">
              <span style="color:#93c5fd; font-weight:800;">🎥 OBS Video Capture Device / Window Capture</span>
              <span class="val" style="color:#38bdf8; font-weight:700;">60 FPS GPU</span>
            </div>
            <div style="font-size:11.5px; color:#cbd5e1; line-height:1.5; margin-top:4px;">
              <strong>ක්‍රම 2 කින් OBS Studio එකට Add කරගන්න:</strong><br>
              <strong>1. Window Capture (Hardware Direct):</strong><br>
              OBS Studio ➔ Sources (+) ➔ <strong>Window Capture</strong> ➔ Select <code>[GaviruCamStudio.exe]</code> හෝ <code>Clean OBS Output Pop-out</code>. කිසිදු Driver එකක් නැතිව 0% CPU එකකින් 60FPS වලින් Full Quality එයි!<br>
              <strong>2. Video Capture Device (Virtual Cam):</strong><br>
              OBS Studio හි පහළ දකුණේ ඇති <strong>"Start Virtual Camera"</strong> ක්ලික් කරන්න. එවිට ඕනෑම App එකක Video Capture Device එකක් ලෙස මෙය භාවිතා කළ හැක.
            </div>
            <div style="display:flex; gap:6px; margin-top:8px;">
              <button style="flex:1; background:#0369a1; border-color:#38bdf8;" onclick="window.open('/clean', 'GaviruCleanObs', 'width=1920,height=1080,menubar=no,toolbar=no')">
                🪟 Launch Dedicated OBS Window
              </button>
            </div>
          </div>

          <!-- VDO.Ninja Ultra 4K WebRTC Live Integration -->
          <div class="control-row" style="background:#090d14; border:1px solid #1e293b; border-radius:8px; padding:10px;">
            <div class="control-label">
              <span style="color:#fde68a; font-weight:800;">🥷 VDO.Ninja 4K Live Broadcast & OBS Link</span>
              <span class="val" style="color:#10b981; font-weight:700;">Worldwide WebRTC</span>
            </div>
            <div style="display:flex; gap:6px; align-items:center; margin-top:4px;">
              <label style="font-size:11.5px; color:var(--muted); min-width:70px;">Room Name:</label>
              <input type="text" id="vdoNinjaRoomInput" value="gaviru-cam-pro" style="flex:1; padding:5px 8px; font-size:12px;" onchange="updateVdoNinjaRoom(this.value)">
            </div>
            <div class="code-box" style="margin-top:6px;">
              <span id="vdoNinjaViewUrlText" style="font-size:11px;">https://vdo.ninja/?view=gaviru-cam-pro&cleanoutput&scale=100</span>
              <button onclick="copyText('vdoNinjaViewUrlText')" style="padding:3px 8px; font-size:11px;">📋 Copy Link</button>
            </div>
            <div style="display:flex; gap:6px; margin-top:6px;">
              <button class="btn-tunnel" style="flex:1;" onclick="launchVdoNinjaBroadcaster()" title="Broadcast live 4K stream + audio into VDO.Ninja">
                🚀 Launch VDO.Ninja 4K Stream
              </button>
              <button style="flex:1;" onclick="openVdoNinjaDirectPush()" title="Open VDO.Ninja Web Push Studio">
                🌐 Direct Web Push
              </button>
            </div>
          </div>

          <!-- Mobile Phone VDO.Ninja & Android App Integration -->
          <div class="control-row" style="background:#0e1320; border:1px solid #10b981; border-radius:8px; padding:10px;">
            <div class="control-label">
              <span style="color:#6ee7b7; font-weight:800;">📱 Mobile VDO.Ninja & Android App Suite</span>
              <span class="val" style="color:#34d399; font-weight:700;">Android / iOS</span>
            </div>
            <div style="font-size:11.5px; color:#e2e8f0; line-height:1.5; margin-top:4px;">
              <strong>ස්මාර්ට්ෆෝන් එකෙන් භාවිතා කළ හැකි ක්‍රම 2:</strong><br>
              <strong>1. 1-Click Install Mobile App (PWA):</strong><br>
              ඕනෑම Android / iPhone එකක Chrome/Safari වලින් මෙහි Public URL එක හෝ Local IP එක Open කර <strong>"📲 Install Mobile App"</strong> ක්ලික් කරන්න. කිසිදු Download එකක් නැතිව Phone එකේ Home Screen එකට App එකක් ලෙස Install වේ!<br>
              <strong>2. Mobile VDO.Ninja Wireless Camera to OBS:</strong><br>
              ඔබේ Mobile Phone Camera එක OBS Studio එකට Wireless WebCam එකක් ලෙස සම්බන්ධ කරගැනීමට පහත Mobile Push Link එක භාවිතා කරන්න:
            </div>
            <div class="code-box" style="margin-top:6px;">
              <span id="vdoMobilePushUrl" style="font-size:11px;">https://vdo.ninja/?push=gaviru-cam-pro&webcam&autostart</span>
              <button onclick="copyText('vdoMobilePushUrl')" style="padding:3px 8px; font-size:11px;">📋 Copy Link</button>
            </div>
            <div style="display:flex; gap:6px; margin-top:6px;">
              <button style="flex:1; background:#059669; border-color:#10b981; color:#fff;" onclick="window.open('https://vdo.ninja/?push=' + encodeURIComponent(vdoNinjaRoom) + '&webcam&autostart', '_blank')">
                📷 Open Phone Cam Push
              </button>
              <button style="flex:1; background:#1e293b; border-color:#475569;" onclick="installMobileApp()">
                📲 Install App on Phone
              </button>
            </div>
          </div>

          <!-- Cloud Tunnel for Public Internet Streaming -->
          <div class="control-row">
            <div class="control-label">
              <span style="color:#a78bfa; font-weight:700;">🌍 Worldwide Public OBS Stream & Remote Link</span>
              <span class="val" id="tunnelStatusText">Stopped</span>
            </div>
            <div style="display:flex; gap:6px;">
              <button class="btn-tunnel" style="flex:1;" onclick="startTunnel()">🚀 Start Public Worldwide Tunnel</button>
              <button onclick="stopTunnel()">⏹ Stop</button>
            </div>
            <div id="tunnelResultBox" style="display:none; margin-top:8px; flex-direction:column; gap:6px;" class="qr-box">
              <div style="font-size:11.5px; color:#a78bfa; font-weight:700;">🎬 Public OBS Browser Source Link (ලෝකයේ ඕනෑම තැනක OBS එකකට):</div>
              <div class="code-box" style="width:100%;">
                <span id="tunnelObsCleanUrl" style="color:#6ee7b7; font-weight:700;">https://.../clean</span>
                <button onclick="copyText('tunnelObsCleanUrl')" style="padding:3px 8px; font-size:11px;">📋 Copy OBS Link</button>
              </div>
              <div style="font-size:11.5px; color:#fde68a; font-weight:700; margin-top:4px;">📱 Public Phone Remote Control Link:</div>
              <div class="code-box" style="width:100%;">
                <span id="tunnelPublicUrl">https://.../control</span>
                <button onclick="copyText('tunnelPublicUrl')" style="padding:3px 8px; font-size:11px;">📋 Copy Phone Link</button>
              </div>
              <img id="tunnelQrImg" alt="Public Stream QR Code" src="" style="align-self:center; margin-top:4px;">
              <small style="color:var(--muted); font-size:11px; text-align:center;">Scan with Mobile phone or paste Public OBS Link into remote OBS PC</small>
            </div>
          </div>
        </div>
      </div>
      <!-- Hidden SVG Pro Unsharp Mask Filter for Full HD 1080p Upscaling -->
      <svg style="position:absolute;width:0;height:0;pointer-events:none;" aria-hidden="true">
        <defs>
          <filter id="canonHdSharpFilter" color-interpolation-filters="sRGB">
            <feConvolveMatrix id="canonHdSharpMatrix" order="3 3" kernelMatrix="0 -0.28 0 -0.28 2.12 -0.28 0 -0.28 0" preserveAlpha="true"/>
          </filter>
        </defs>
      </svg>
    </aside>
  </div>

  <script>
    let appState = null;
    let isPortrait = false;
    let outputAspect = '16:9';
    let outputResolution = '4k';
    let colorGrading = 'vivid';
    let vdoNinjaRoom = 'gaviru-cam-pro';

    function setOutputAspect(val) {
      outputAspect = val;
      isPortrait = val === '9:16';
      const wrap = document.getElementById('canvasContainer');
      if (wrap) {
        wrap.classList.toggle('portrait', isPortrait);
        wrap.classList.toggle('landscape', !isPortrait);
      }
      const sel = document.getElementById('selectOutputAspect');
      if (sel && sel.value !== val) sel.value = val;
      scheduleVisualSync();
    }

    function setOutputResolution(val) {
      outputResolution = val;
      const sel = document.getElementById('selectOutputRes');
      if (sel && sel.value !== val) sel.value = val;
      scheduleVisualSync();
    }

    function setColorGrading(val) {
      colorGrading = val;
      const sel = document.getElementById('selectColorGrading');
      if (sel && sel.value !== val) sel.value = val;
      scheduleVisualSync();
    }

    function updateVdoNinjaRoom(val) {
      vdoNinjaRoom = (val || 'gaviru-cam-pro').trim();
      const txt = document.getElementById('vdoNinjaViewUrlText');
      if (txt) {
        txt.textContent = 'https://vdo.ninja/?view=' + encodeURIComponent(vdoNinjaRoom) + '&cleanoutput&scale=100';
      }
      scheduleVisualSync();
    }

    function launchVdoNinjaBroadcaster() {
      window.open('/vdo?room=' + encodeURIComponent(vdoNinjaRoom), '_blank');
    }

    function openVdoNinjaDirectPush() {
      const url = 'https://vdo.ninja/?push=' + encodeURIComponent(vdoNinjaRoom) + '&webcam&autostart&videobitrate=25000&audiobitrate=320&scale=100&quality=0&fps=30';
      window.open(url, '_blank');
    }
    let showGrid = false;
    let digitalZoom = 1.0;
    let mediaRecorder = null;
    let recordedChunks = [];
    let isRecordingVideo = false;
    let peerInstance = null;
    let activePeerCalls = [];
    let holdFocusTimer = null;
    let afBoxTimeout = null;

    const rawImg = document.getElementById('rawStreamImg');
    const canvas = document.getElementById('monitorCanvas');
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    let lastUserCommandTime = 0;
    let focusStepInFlight = false;
    let userFrozeFocus = false;
    let visualSyncTimer = null;

    // Studio Natural Audio State (Continuous 48kHz Stereo Unprocessed)
    let audioEnabled = true;
    let audioVolume = 100;
    let selectedAudioDeviceId = 'default';
    let rawAudioStream = null;
    let audioCtx = null;
    let audioGainNode = null;
    let audioAnalyser = null;
    let audioDestNode = null;
    let audioInitInProgress = false;
    let hasListenersOnServer = false;

    function updateSharpnessMatrix(sharpVal) {
      const mat = document.getElementById('canonHdSharpMatrix');
      if (!mat) return;
      const s = Math.max(0, Math.min(200, Number(sharpVal ?? 100)));
      const k = Number(((s / 100) * 0.28).toFixed(3));
      const c = Number((1 + 4 * k).toFixed(3));
      mat.setAttribute('kernelMatrix', \`0 -\${k} 0 -\${k} \${c} -\${k} 0 -\${k} 0\`);
    }

    function scheduleVisualSync() {
      lastUserCommandTime = Date.now();
      const sharpVal = Number(document.getElementById('sliderHdSharpness')?.value ?? 100);
      updateSharpnessMatrix(sharpVal);
      if (visualSyncTimer) clearTimeout(visualSyncTimer);
      visualSyncTimer = setTimeout(() => {
        const payload = {
          action: 'visual_settings',
          softwareBrightness: Number(document.getElementById('sliderBrightness')?.value || 100),
          softwareContrast: Number(document.getElementById('sliderContrast')?.value || 100),
          lowLightBoost: Number(document.getElementById('sliderBoost')?.value || 0),
          hdSharpness: sharpVal,
          digitalZoom: Number(digitalZoom || 1.0),
          isPortrait: outputAspect === '9:16',
          portraitRotation: document.getElementById('portraitRotation')?.value || 'crop',
          outputAspect,
          outputResolution,
          colorGrading,
          vdoNinjaRoom,
          audioEnabled: Boolean(audioEnabled),
          audioVolume: Number(audioVolume),
          audioDeviceId: String(selectedAudioDeviceId || 'default')
        };
        fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      }, 50);
    }

    async function refreshAudioDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === 'audioinput');
        const select = document.getElementById('audioDeviceSelect');
        if (!select) return;
        const prev = selectedAudioDeviceId || select.value || 'default';
        select.innerHTML = '';
        const defOpt = document.createElement('option');
        defOpt.value = 'default';
        defOpt.textContent = '🎙️ Default Camera/Mic Audio';
        select.appendChild(defOpt);
        audioInputs.forEach((dev, idx) => {
          if (!dev.deviceId || dev.deviceId === 'default') return;
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          opt.textContent = '🎙️ ' + (dev.label || ('Audio Input ' + (idx + 1)));
          select.appendChild(opt);
        });
        if ([...select.options].some((o) => o.value === prev)) {
          select.value = prev;
        }
      } catch (e) {
        console.warn('Could not enumerate audio devices:', e);
      }
    }

    async function initNaturalCameraAudio(deviceIdOverride) {
      const btn = document.getElementById('btnAudioToggle');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (btn && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
          btn.textContent = '🔊 Use localhost for Mic';
          btn.title = 'Click to open http://localhost:' + (location.port || '8080') + '/control so browser allows Microphone';
        }
        return;
      }
      if (audioInitInProgress) return;
      audioInitInProgress = true;
      try {
        if (deviceIdOverride !== undefined) {
          selectedAudioDeviceId = deviceIdOverride;
        }
        const constraints = {
          audio: {
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false },
            sampleRate: { ideal: 48000 },
            channelCount: { ideal: 2 },
            ...(selectedAudioDeviceId && selectedAudioDeviceId !== 'default'
              ? { deviceId: { exact: selectedAudioDeviceId } }
              : {})
          },
          video: false
        };

        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            },
            video: false
          });
        }

        if (rawAudioStream) {
          rawAudioStream.getTracks().forEach((t) => t.stop());
        }
        rawAudioStream = stream;

        // Automatically recover if audio track ever ends or disconnects
        stream.getAudioTracks().forEach((track) => {
          track.onended = () => {
            setTimeout(() => {
              if (audioEnabled) initNaturalCameraAudio(selectedAudioDeviceId);
            }, 1000);
          };
        });

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!audioCtx && AudioContextClass) {
          audioCtx = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 48000 });
        }
        if (audioCtx) {
          if (audioCtx.state === 'suspended') {
            await audioCtx.resume().catch(() => {});
          }
          if (window._studioAudioSource) {
            try { window._studioAudioSource.disconnect(); } catch {}
          }
          if (window._studioAudioProcessor) {
            try { window._studioAudioProcessor.disconnect(); } catch {}
          }
          if (audioGainNode) {
            try { audioGainNode.disconnect(); } catch {}
          }

          const source = audioCtx.createMediaStreamSource(stream);
          window._studioAudioSource = source;
          audioGainNode = audioCtx.createGain();
          audioGainNode.gain.value = audioEnabled ? (audioVolume / 100) : 0;
          audioAnalyser = audioCtx.createAnalyser();
          audioAnalyser.fftSize = 256;
          audioDestNode = audioCtx.createMediaStreamDestination();

          source.connect(audioGainNode);
          audioGainNode.connect(audioAnalyser);
          audioGainNode.connect(audioDestNode);
          // Connect directly to Web Audio hardware destination so sound is heard immediately
          audioGainNode.connect(audioCtx.destination);

          // Also relay 16-bit 48kHz stereo PCM to /api/audio/push so OBS Browser Source (/stream) gets live audio without needing OBS mic permission
          try {
            const processor = audioCtx.createScriptProcessor(4096, 2, 2);
            window._studioAudioProcessor = processor;
            audioGainNode.connect(processor);
            processor.connect(audioCtx.destination);
            let pushInFlight = false;
            processor.onaudioprocess = (ev) => {
              if (!audioEnabled || pushInFlight || !hasListenersOnServer) return;
              const left = ev.inputBuffer.getChannelData(0);
              const right = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : left;
              const pcm16 = new Int16Array(left.length * 2);
              for (let i = 0; i < left.length; i++) {
                const sL = Math.max(-1, Math.min(1, left[i]));
                const sR = Math.max(-1, Math.min(1, right[i]));
                pcm16[i * 2] = sL < 0 ? sL * 0x8000 : sL * 0x7fff;
                pcm16[i * 2 + 1] = sR < 0 ? sR * 0x8000 : sR * 0x7fff;
              }
              pushInFlight = true;
              fetch('/api/audio/push', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: pcm16.buffer
              }).catch(() => {}).finally(() => {
                pushInFlight = false;
              });
            };
          } catch {}

          const audioEl = document.getElementById('liveCamAudio');
          if (audioEl) {
            audioEl.srcObject = audioDestNode.stream;
            audioEl.muted = !audioEnabled;
            audioEl.volume = 1.0;
            audioEl.play().catch(() => {});
          }
        }

        if (btn) {
          btn.textContent = audioEnabled ? '🔊 Cam Sound: ON' : '🔇 Cam Sound: MUTED';
          btn.className = audioEnabled ? 'btn-evf-on' : 'btn-evf-off';
        }
        await refreshAudioDevices();
      } catch (err) {
        console.warn('Camera audio capture waiting for permission or device:', err);
        if (btn) {
          btn.textContent = '🔊 Click to Allow Mic';
          btn.className = 'btn-evf-off';
        }
      } finally {
        audioInitInProgress = false;
      }
    }

    function updateAudioMeterLoop() {
      const meter = document.getElementById('audioLevelMeter');
      if (meter && audioAnalyser && audioEnabled) {
        const data = new Uint8Array(audioAnalyser.frequencyBinCount);
        audioAnalyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const pct = Math.min(100, Math.round((avg / 140) * 100));
        meter.style.width = pct + '%';
      } else if (meter) {
        meter.style.width = '0%';
      }
      requestAnimationFrame(updateAudioMeterLoop);
    }
    requestAnimationFrame(updateAudioMeterLoop);

    function toggleCameraAudio() {
      if (!navigator.mediaDevices && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        location.href = 'http://localhost:' + (location.port || '8080') + '/control';
        return;
      }
      if (!rawAudioStream) {
        audioEnabled = true;
        initNaturalCameraAudio(selectedAudioDeviceId);
        scheduleVisualSync();
        return;
      }
      audioEnabled = !audioEnabled;
      const btn = document.getElementById('btnAudioToggle');
      if (btn) {
        btn.textContent = audioEnabled ? '🔊 Cam Sound: ON' : '🔇 Cam Sound: MUTED';
        btn.className = audioEnabled ? 'btn-evf-on' : 'btn-evf-off';
      }
      if (audioGainNode && audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        audioGainNode.gain.setTargetAtTime(audioEnabled ? (audioVolume / 100) : 0, audioCtx.currentTime, 0.02);
      }
      const audioEl = document.getElementById('liveCamAudio');
      if (audioEl) {
        audioEl.muted = !audioEnabled;
        if (audioEnabled) audioEl.play().catch(() => {});
      }
      scheduleVisualSync();
    }

    function updateAudioVolume(val) {
      audioVolume = Number(val);
      const lbl = document.getElementById('audioVolumeVal');
      if (lbl) lbl.textContent = audioVolume + '%';
      if (audioGainNode && audioCtx) {
        audioGainNode.gain.setTargetAtTime(audioEnabled ? (audioVolume / 100) : 0, audioCtx.currentTime, 0.02);
      }
      scheduleVisualSync();
    }

    function changeAudioDevice(deviceId) {
      selectedAudioDeviceId = deviceId;
      initNaturalCameraAudio(deviceId);
      scheduleVisualSync();
    }

    // Resume audio context automatically on any user interaction if browser suspended it
    window.addEventListener('pointerdown', () => {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      const audioEl = document.getElementById('liveCamAudio');
      if (audioEl && audioEnabled && audioEl.paused) {
        audioEl.play().catch(() => {});
      }
      if (audioEnabled && !rawAudioStream) {
        initNaturalCameraAudio(selectedAudioDeviceId);
      }
    }, { passive: true });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        refreshAudioDevices();
        if (audioEnabled) initNaturalCameraAudio(selectedAudioDeviceId);
      });
    }

    function populateSelect(id, options, selectedValue) {
      const el = document.getElementById(id);
      if (!el || !options) return;
      if (el.options.length !== options.length) {
        el.innerHTML = '';
        for (const opt of options) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = opt.label;
          el.appendChild(o);
        }
      }
      // Do not overwrite dropdown value while user is actively clicking/changing it
      if (document.activeElement === el || Date.now() - lastUserCommandTime < 2200) {
        return;
      }
      el.value = String(selectedValue);
    }

    let lastMonitorRenderTime = 0;
    function renderMonitorLoop(now) {
      requestAnimationFrame(renderMonitorLoop);
      if (now && now - lastMonitorRenderTime < 32) {
        return;
      }
      lastMonitorRenderTime = now;

      const brightness = Number(document.getElementById('sliderBrightness').value || 100);
      const contrast = Number(document.getElementById('sliderContrast').value || 100);
      const boost = Number(document.getElementById('sliderBoost').value || 0);
      const sharp = Number(document.getElementById('sliderHdSharpness')?.value ?? 100);
      const effectiveBrightness = brightness + Math.round(boost * 0.65);
      const effectiveContrast = contrast + Math.round(boost * 0.2);

      // Apply GPU SVG Pro Unsharp Mask filter to canvas for Full HD clarity
      const desiredCanvasFilter = sharp > 0 ? 'url(#canonHdSharpFilter)' : 'none';
      if (canvas.style.filter !== desiredCanvasFilter) {
        canvas.style.filter = desiredCanvasFilter;
      }

      const hasFrame = rawImg.complete && rawImg.naturalWidth > 0;
      // High-performance UI monitor resolution (leaves full 4K exclusively for /clean and OBS, preventing PC lag)
      let targetW = 1280;
      let targetH = 720;
      if (outputAspect === '9:16') {
        targetW = 720;
        targetH = 1280;
      } else if (outputAspect === '3:2') {
        targetW = 1080;
        targetH = 720;
      }
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      let filterStr = '';
      if (effectiveBrightness !== 100) filterStr += 'brightness(' + effectiveBrightness + '%) ';
      if (effectiveContrast !== 100) filterStr += 'contrast(' + effectiveContrast + '%) ';
      if (colorGrading === 'vivid') {
        filterStr += 'saturate(122%) contrast(106%) ';
      } else if (colorGrading === 'cinema') {
        filterStr += 'saturate(115%) contrast(110%) ';
      } else if (colorGrading === 'warm') {
        filterStr += 'saturate(112%) sepia(8%) contrast(105%) ';
      }
      ctx.filter = filterStr.trim() || 'none';

      if (hasFrame) {
        const srcW = rawImg.naturalWidth;
        const srcH = rawImg.naturalHeight;
        const rotMode = document.getElementById('portraitRotation').value;

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(digitalZoom, digitalZoom);

        if (outputAspect === '9:16') {
          if (rotMode === 'cw') {
            ctx.rotate(Math.PI / 2);
            ctx.drawImage(rawImg, -canvas.height / 2, -canvas.width / 2, canvas.height, canvas.width);
          } else if (rotMode === 'ccw') {
            ctx.rotate(-Math.PI / 2);
            ctx.drawImage(rawImg, -canvas.height / 2, -canvas.width / 2, canvas.height, canvas.width);
          } else {
            // 9:16 Center Crop from 3:2 camera sensor - NO BLACK BARS
            const cropW = Math.round(srcH * (9 / 16));
            const sx = Math.max(0, Math.round((srcW - cropW) / 2));
            ctx.drawImage(rawImg, sx, 0, cropW, srcH, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
          }
        } else if (outputAspect === '16:9') {
          // 16:9 Center Crop from 3:2 camera sensor - NO BLACK BARS
          const cropH = Math.round(srcW * (9 / 16));
          const sy = Math.max(0, Math.round((srcH - cropH) / 2));
          ctx.drawImage(rawImg, 0, sy, srcW, cropH, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
        } else {
          // 3:2 Native DSLR Sensor fit
          const scale = Math.min(canvas.width / srcW, canvas.height / srcH);
          const drawW = Math.round(srcW * scale);
          const drawH = Math.round(srcH * scale);
          ctx.drawImage(rawImg, -drawW / 2, -drawH / 2, drawW, drawH);
        }
      } else {
        ctx.filter = 'none';
        ctx.fillStyle = '#94a3b8';
        ctx.font = '700 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Gaviru E400D Cam — Waiting for Live View Stream...', canvas.width / 2, canvas.height / 2);
      }
      ctx.restore();
    }
    requestAnimationFrame(renderMonitorLoop);

    async function fetchStudioState() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        const data = await res.json();
        if (!data.ok) return;
        appState = data;

        const cam = data.camera;
        const opts = data.options;
        const frame = data.frame || {};

        document.getElementById('cameraName').textContent = cam.cameraName || 'Gaviru E400D Cam';
        document.getElementById('queueBadge').textContent = 'QUEUE: ' + (cam.queueDepth ?? 0);

        const badge = document.getElementById('connectionBadge');
        if (!cam.evfActive) {
          badge.textContent = 'WEB PREVIEW PAUSED';
          badge.className = 'status-pill paused';
        } else {
          badge.textContent = (frame.status || 'STREAMING').toUpperCase();
          badge.className = 'status-pill';
        }

        // Web Live View Toggle button
        const evfBtn = document.getElementById('btnEvfToggle');
        const panelEvfBtn = document.getElementById('btnPanelEvf');
        if (cam.evfActive) {
          evfBtn.textContent = '👁️ Live View Preview: ON';
          evfBtn.className = 'btn-evf-on';
          if (panelEvfBtn) {
            panelEvfBtn.textContent = '👁️ Web Preview: ON';
            panelEvfBtn.className = 'btn-evf-on';
          }
        } else {
          evfBtn.textContent = '👁️ Live View Preview: OFF';
          evfBtn.className = 'btn-evf-off';
          if (panelEvfBtn) {
            panelEvfBtn.textContent = '👁️ Web Preview: OFF';
            panelEvfBtn.className = 'btn-evf-off';
          }
        }

        // Camera Physical LCD Display Toggle button
        const lcdBtn = document.getElementById('btnCamLcdToggle');
        const panelLcdBtn = document.getElementById('btnPanelCamLcd');
        if (cam.cameraDisplayActive) {
          lcdBtn.textContent = '📺 Cam Display: ON';
          lcdBtn.className = 'btn-lcd-on';
          if (panelLcdBtn) {
            panelLcdBtn.textContent = '📺 Cam LCD Display: ON';
            panelLcdBtn.className = 'btn-lcd-on';
          }
        } else {
          lcdBtn.textContent = '📺 Cam Display: OFF';
          lcdBtn.className = 'btn-lcd-off';
          if (panelLcdBtn) {
            panelLcdBtn.textContent = '📺 Cam LCD Display: OFF';
            panelLcdBtn.className = 'btn-lcd-off';
          }
        }

        // Camera Physical Control Authority buttons
        const topCtrlBtn = document.getElementById('btnCamControlTop');
        const dualBtn = document.getElementById('btnDualControl');
        const prioBtn = document.getElementById('btnCamPriority');
        if (cam.controlAuthority === 'camera_priority') {
          if (topCtrlBtn) {
            topCtrlBtn.textContent = '🔓 Cam Body Menu: UNLOCKED';
            topCtrlBtn.className = 'btn-evf-off';
          }
          if (dualBtn) dualBtn.className = '';
          if (prioBtn) prioBtn.className = 'btn-evf-off';
        } else {
          if (topCtrlBtn) {
            topCtrlBtn.textContent = '🎮 Cam + Web Control';
            topCtrlBtn.className = 'btn-evf-on';
          }
          if (dualBtn) dualBtn.className = 'btn-evf-on';
          if (prioBtn) prioBtn.className = '';
        }

        // Sync Stream Mode UI
        document.getElementById('modeSensorBtn').classList.toggle('active', cam.streamMode === 'sensor');
        document.getElementById('modeScreenBtn').classList.toggle('active', cam.streamMode === 'screen');
        document.getElementById('canonOsdOverlay').classList.toggle('active', cam.streamMode === 'screen');

        // Populate dropdowns
        populateSelect('ctrlIso', opts.iso, cam.iso);
        populateSelect('ctrlShutter', opts.shutterSpeed, cam.shutterSpeed);
        populateSelect('ctrlAperture', opts.aperture, cam.aperture);
        populateSelect('ctrlExpComp', opts.exposureComp, cam.exposureComp);
        populateSelect('ctrlFlashComp', opts.flashExposureComp, cam.flashExposureComp);
        populateSelect('ctrlWb', opts.whiteBalance, cam.whiteBalance);
        populateSelect('ctrlMetering', opts.meteringMode, cam.meteringMode);
        populateSelect('ctrlDrive', opts.driveMode, cam.driveMode);

        // Formatted labels
        document.getElementById('valIso').textContent = cam.formatted.iso;
        document.getElementById('valShutter').textContent = cam.formatted.shutterSpeed;
        document.getElementById('valAperture').textContent = cam.formatted.aperture;
        document.getElementById('valExpComp').textContent = cam.formatted.exposureComp;
        document.getElementById('valFlashComp').textContent = cam.formatted.flashExposureComp;
        document.getElementById('valWb').textContent = cam.formatted.whiteBalance;
        document.getElementById('valMetering').textContent = cam.formatted.meteringMode;
        document.getElementById('valDrive').textContent = cam.formatted.driveMode;

        // Update Canon Screen OSD Overlay values
        document.getElementById('osdShutter').textContent = cam.formatted.shutterSpeed;
        document.getElementById('osdAperture').textContent = cam.formatted.aperture;
        document.getElementById('osdIso').textContent = cam.formatted.iso;
        document.getElementById('osdExpComp').textContent = cam.formatted.exposureComp;
        document.getElementById('osdWb').textContent = cam.formatted.whiteBalance;
        document.getElementById('osdFlash').textContent = (cam.flashFiring ? '⚡ ON' : 'OFF') + ' (' + cam.formatted.flashExposureComp + ')';
        document.getElementById('osdMetering').textContent = cam.formatted.meteringMode;
        document.getElementById('osdDrive').textContent = cam.formatted.driveMode;
        document.getElementById('osdMenuLv').textContent = cam.evfActive ? 'Enable (EVF Mirror UP)' : 'Disable (Mirror DOWN)';
        document.getElementById('osdMenuEvfOut').textContent = cam.cameraDisplayActive ? 'ON (Camera LCD + Wi-Fi 0x09)' : 'OFF (Wi-Fi PC Only 0x08)';
        document.getElementById('osdMenuLastCmd').textContent = cam.lastCommand || 'Ready';

        // Flash buttons
        const flashText = cam.flashFiring ? '⚡ Flash: ON' : '⚡ Flash: OFF';
        document.getElementById('btnFlashQuick').textContent = flashText;
        document.getElementById('btnFlashPanel').textContent = flashText;

        // Telemetry & Project Location
        document.getElementById('statStatus').textContent = frame.status || 'ready';
        document.getElementById('statFps').textContent = frame.fps ?? 0;
        document.getElementById('statRes').textContent = (frame.width && frame.height ? frame.width + 'x' + frame.height : '640x424') + ' ➔ ' + outputResolution.toUpperCase() + ' (' + outputAspect + ')';
        document.getElementById('statBytes').textContent = Math.round((frame.averageFrameBytes || 0) / 1024) + ' KB';
        document.getElementById('statLastCmd').textContent = cam.lastCommand || 'Ready';
        if (data.projectPath) {
          const pathBadge = document.getElementById('projectPathBadge');
          const licPath = document.getElementById('licenseProjectPath');
          if (pathBadge) pathBadge.textContent = data.projectPath;
          if (licPath) licPath.textContent = data.projectPath;
        }

        if (data.network) {
          const obsCleanUrl = data.network.cleanUrl || data.network.streamUrl;
          const obsEl = document.getElementById('obsStreamUrl');
          if (obsEl) obsEl.textContent = obsCleanUrl;
          const vdoViewEl = document.getElementById('vdoNinjaViewUrlText');
          if (vdoViewEl && data.network.vdoNinjaViewUrl) {
            vdoViewEl.textContent = data.network.vdoNinjaViewUrl;
          }
        }

        if (data.visual && Date.now() - lastUserCommandTime > 2500) {
          if (data.visual.outputAspect && document.activeElement?.id !== 'selectOutputAspect') {
            outputAspect = data.visual.outputAspect;
            isPortrait = outputAspect === '9:16';
            const selA = document.getElementById('selectOutputAspect');
            if (selA) selA.value = outputAspect;
          }
          if (data.visual.outputResolution && document.activeElement?.id !== 'selectOutputRes') {
            outputResolution = data.visual.outputResolution;
            const selR = document.getElementById('selectOutputRes');
            if (selR) selR.value = outputResolution;
          }
          if (data.visual.colorGrading && document.activeElement?.id !== 'selectColorGrading') {
            colorGrading = data.visual.colorGrading;
            const selC = document.getElementById('selectColorGrading');
            if (selC) selC.value = colorGrading;
          }
          if (data.visual.vdoNinjaRoom && document.activeElement?.id !== 'vdoNinjaRoomInput') {
            vdoNinjaRoom = data.visual.vdoNinjaRoom;
            const rIn = document.getElementById('vdoNinjaRoomInput');
            if (rIn) rIn.value = vdoNinjaRoom;
          }
        }

        // Render Live System & Camera Console Logs inside the App Screen
        renderStudioLogsOnScreen(data.logs || [], cam.lastError);

        // Tunnel status
        if (data.tunnel && data.tunnel.running && data.tunnel.url) {
          document.getElementById('tunnelStatusText').textContent = 'Active (' + data.tunnel.provider + ')';
          document.getElementById('tunnelResultBox').style.display = 'flex';
          const pubControl = data.tunnel.url + '/control';
          const pubCleanObs = data.tunnel.url + '/clean';
          document.getElementById('tunnelPublicUrl').textContent = pubControl;
          const obsCleanEl = document.getElementById('tunnelObsCleanUrl');
          if (obsCleanEl) obsCleanEl.textContent = pubCleanObs;
          const qrTarget = encodeURIComponent(pubCleanObs);
          const qrImg = document.getElementById('tunnelQrImg');
          if (!qrImg.src.includes(qrTarget)) {
            qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + qrTarget;
          }
        } else {
          document.getElementById('tunnelStatusText').textContent = data.tunnel?.running ? 'Starting...' : 'Stopped';
        }

        hasListenersOnServer = Boolean(data.hasAudioListeners);
      } catch (e) {
        console.warn('State poll failed', e);
      }
    }

    const COMMERCIAL_LICENSE_KEY = 'gaviru_studio_unlocked_v1';

    function checkSavedCommercialLicense() {
      const modal = document.getElementById('licenseLockModal');
      if (!modal) return;
      if (sessionStorage.getItem(COMMERCIAL_LICENSE_KEY) === 'gavi01') {
        modal.style.display = 'none';
      } else {
        modal.style.display = 'flex';
        setTimeout(() => {
          document.getElementById('licensePasswordInput')?.focus();
        }, 120);
      }
    }

    function unlockCommercialLicense() {
      const input = document.getElementById('licensePasswordInput');
      const errEl = document.getElementById('licenseErrorMsg');
      const modal = document.getElementById('licenseLockModal');
      const entered = (input?.value || '').trim();
      if (entered === 'gavi01') {
        sessionStorage.setItem(COMMERCIAL_LICENSE_KEY, 'gavi01');
        if (errEl) errEl.style.display = 'none';
        if (modal) modal.style.display = 'none';
        playFocusConfirmBeep();
      } else {
        if (errEl) errEl.style.display = 'block';
        if (input) {
          input.value = '';
          input.focus();
        }
      }
    }

    function lockCommercialLicense() {
      sessionStorage.removeItem(COMMERCIAL_LICENSE_KEY);
      const input = document.getElementById('licensePasswordInput');
      if (input) input.value = '';
      checkSavedCommercialLicense();
    }

    checkSavedCommercialLicense();

    // Automatically shut down background server & terminal process when the App Window is closed (X button)
    function notifyServerWindowClosed() {
      try {
        const blob = new Blob([JSON.stringify({ closedAt: Date.now() })], { type: 'application/json' });
        navigator.sendBeacon('/api/window-closed', blob);
      } catch {}
    }
    window.addEventListener('pagehide', notifyServerWindowClosed);
    window.addEventListener('beforeunload', notifyServerWindowClosed);

    let lastRenderedLogId = -1;
    let logsDrawerVisible = true;

    function renderStudioLogsOnScreen(logs, lastError) {
      const errBadge = document.getElementById('logErrorIndicator');
      if (errBadge) {
        if (lastError) {
          errBadge.style.display = 'inline-block';
          errBadge.textContent = '⚠️ ' + lastError;
        } else {
          errBadge.style.display = 'none';
        }
      }
      const listEl = document.getElementById('studioLogsList');
      if (!listEl || !Array.isArray(logs)) return;
      const latestId = logs.length > 0 ? logs[logs.length - 1].id : 0;
      if (latestId === lastRenderedLogId) return;
      lastRenderedLogId = latestId;

      listEl.innerHTML = '';
      if (logs.length === 0) {
        const empty = document.createElement('div');
        empty.style.color = '#6b7280';
        empty.textContent = 'No log entries.';
        listEl.appendChild(empty);
        return;
      }
      for (const entry of logs) {
        const row = document.createElement('div');
        const color =
          entry.level === 'ERROR'
            ? '#fca5a5'
            : entry.level === 'WARN'
              ? '#fde68a'
              : entry.level === 'CMD'
                ? '#6ee7b7'
                : '#93c5fd';
        row.style.color = color;
        row.textContent = '[' + entry.time + '] [' + entry.level + '] ' + entry.message;
        listEl.appendChild(row);
      }
      listEl.scrollTop = listEl.scrollHeight;
    }

    function toggleStudioLogsDrawer() {
      logsDrawerVisible = !logsDrawerVisible;
      const drawer = document.getElementById('studioLogsDrawer');
      const topBtn = document.getElementById('btnToggleLogsTop');
      if (drawer) {
        drawer.style.display = logsDrawerVisible ? 'flex' : 'none';
      }
      if (topBtn) {
        topBtn.textContent = logsDrawerVisible ? '🖥️ Logs: ON' : '🖥️ Logs: OFF';
        topBtn.className = logsDrawerVisible ? 'btn-evf-on' : 'btn-evf-off';
      }
    }

    async function clearStudioLogsUi() {
      lastRenderedLogId = -1;
      await sendCommand({ action: 'clear_logs' });
    }

    async function shutdownStudioApp() {
      if (!confirm('Gaviru E400D Cam Studio App එක සම්පූර්ණයෙන්ම Close කරන්නද?')) return;
      try {
        await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'shutdown_app' })
        });
      } catch {}
      window.close();
    }

    async function sendCommand(payload) {
      lastUserCommandTime = Date.now();
      try {
        const res = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        await fetchStudioState();
        return data;
      } catch (e) {
        console.warn('Command error:', e);
        return { ok: false };
      }
    }

    async function toggleEvfShutter() {
      lastUserCommandTime = Date.now();
      await fetch('/api/liveview/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      await fetchStudioState();
    }

    async function toggleCameraLcdDisplay() {
      lastUserCommandTime = Date.now();
      await fetch('/api/display/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      await fetchStudioState();
    }

    async function toggleCamHardwareMode() {
      const current = appState?.camera?.controlAuthority || 'dual';
      const next = current === 'camera_priority' ? 'dual' : 'camera_priority';
      await sendCommand({ action: 'set_control_authority', mode: next });
    }

    let afBeepEnabled = true;
    let focusLightAnimTimer = null;

    function toggleAfBeepSound() {
      afBeepEnabled = !afBeepEnabled;
      const btn = document.getElementById('btnAfBeepToggle');
      if (btn) {
        btn.textContent = afBeepEnabled ? '🔔 AF Beep: ON' : '🔕 AF Beep: OFF';
        btn.className = afBeepEnabled ? 'btn-evf-on' : 'btn-evf-off';
      }
      if (afBeepEnabled) {
        playFocusConfirmBeep();
      }
    }

    function playFocusConfirmBeep() {
      if (!afBeepEnabled) return;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!audioCtx && AudioContextClass) {
          audioCtx = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 48000 });
        }
        if (!audioCtx) return;
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        const now = audioCtx.currentTime;
        // Authentic Canon DSLR Double-Beep ("Pip-Pip" at ~2880 Hz)
        const playPip = (startTime, duration) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(2880, startTime);
          gain.gain.setValueAtTime(0.001, startTime);
          gain.gain.exponentialRampToValueAtTime(0.22, startTime + 0.008);
          gain.gain.setValueAtTime(0.22, startTime + duration - 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          if (audioDestNode) {
            try { gain.connect(audioDestNode); } catch {}
          }
          osc.start(startTime);
          osc.stop(startTime + duration + 0.005);
        };
        playPip(now, 0.055);
        playPip(now + 0.075, 0.065);
      } catch (e) {
        console.warn('AF beep error:', e);
      }
    }

    function animateBrightnessTo(targetVal, durationMs, statusLabel) {
      const slider = document.getElementById('sliderBrightness');
      const lbl = document.getElementById('lblBrightness');
      const statusEl = document.getElementById('lblFocusLightStatus');
      if (!slider) return;
      if (focusLightAnimTimer) {
        clearInterval(focusLightAnimTimer);
        focusLightAnimTimer = null;
      }
      if (statusEl && statusLabel) {
        statusEl.textContent = statusLabel;
      }
      const startVal = Number(slider.value || 100);
      const endVal = Math.max(35, Math.min(200, Math.round(targetVal)));
      const dur = Math.max(40, Number(durationMs || 300));
      const steps = Math.max(3, Math.round(dur / 35));
      let stepIdx = 0;

      focusLightAnimTimer = setInterval(() => {
        stepIdx += 1;
        const t = Math.min(1, stepIdx / steps);
        // Smooth ease-out curve
        const eased = 1 - Math.pow(1 - t, 2);
        const cur = Math.round(startVal + (endVal - startVal) * eased);
        slider.value = String(cur);
        if (lbl) lbl.textContent = cur + '%';
        scheduleVisualSync();
        if (stepIdx >= steps) {
          clearInterval(focusLightAnimTimer);
          focusLightAnimTimer = null;
        }
      }, 35);
    }

    function measurePointLuminance(xPct, yPct) {
      try {
        if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return 128;
        const cx = Math.max(20, Math.min(canvas.width - 20, Math.round((xPct / 100) * canvas.width)));
        const cy = Math.max(20, Math.min(canvas.height - 20, Math.round((yPct / 100) * canvas.height)));
        const imgData = ctx.getImageData(cx - 16, cy - 16, 32, 32).data;
        let totalLuma = 0;
        const count = imgData.length / 4;
        for (let i = 0; i < imgData.length; i += 4) {
          totalLuma += 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
        }
        return Math.round(totalLuma / Math.max(1, count));
      } catch {
        return 128;
      }
    }

    function onFocusLightModeChange(mode) {
      const statusEl = document.getElementById('lblFocusLightStatus');
      if (!statusEl) return;
      if (mode === 'off') statusEl.textContent = 'Off';
      else if (mode === 'lamp_smart') statusEl.textContent = 'Smart Point Auto';
      else if (mode === 'lock_dim') statusEl.textContent = 'Keep Focus Light';
      else statusEl.textContent = 'Custom Curve';
    }

    function onWhileFocusLightSliderChange(val) {
      const lbl = document.getElementById('lblFocusDimLight');
      if (lbl) lbl.textContent = val + '%';
      const mode = document.getElementById('focusLightMode')?.value || 'lock_dim';
      if (mode === 'lock_dim') {
        const brightEl = document.getElementById('sliderFocusBrightLight');
        const brightLbl = document.getElementById('lblFocusBrightLight');
        if (brightEl) brightEl.value = String(val);
        if (brightLbl) brightLbl.textContent = val + '%';
      }
      const bSlider = document.getElementById('sliderBrightness');
      if (bSlider) {
        bSlider.value = String(val);
        updateSoftwareFilters();
      }
    }

    function onAfterFocusLightSliderChange(val) {
      const lbl = document.getElementById('lblFocusBrightLight');
      if (lbl) lbl.textContent = val + '%';
      // Preview the after-focus brightness immediately as user drags it
      const bSlider = document.getElementById('sliderBrightness');
      if (bSlider) {
        bSlider.value = String(val);
        updateSoftwareFilters();
      }
    }

    function applyFocusLightPreset(presetName) {
      const modeEl = document.getElementById('focusLightMode');
      const dimEl = document.getElementById('sliderFocusDimLight');
      const brightEl = document.getElementById('sliderFocusBrightLight');
      const speedEl = document.getElementById('sliderFocusLightSpeed');
      const contrastEl = document.getElementById('sliderContrast');

      if (presetName === 'keep_sweet_spot') {
        if (modeEl) modeEl.value = 'lock_dim';
        if (dimEl) dimEl.value = '82';
        if (brightEl) brightEl.value = '82';
        if (speedEl) speedEl.value = '250';
      } else if (presetName === 'dim_to_bright') {
        if (modeEl) modeEl.value = 'custom';
        if (dimEl) dimEl.value = '72';
        if (brightEl) brightEl.value = '118';
        if (speedEl) speedEl.value = '350';
      } else if (presetName === 'lamp_focus') {
        if (modeEl) modeEl.value = 'lamp_smart';
        if (dimEl) dimEl.value = '68';
        if (brightEl) brightEl.value = '82';
        if (speedEl) speedEl.value = '300';
        if (contrastEl) {
          contrastEl.value = '112';
          document.getElementById('lblContrast').textContent = '112%';
        }
      }
      document.getElementById('lblFocusDimLight').textContent = (dimEl?.value || 82) + '%';
      document.getElementById('lblFocusBrightLight').textContent = (brightEl?.value || 82) + '%';
      document.getElementById('lblFocusLightSpeed').textContent = (speedEl?.value || 350) + ' ms';
      onFocusLightModeChange(modeEl?.value || 'lock_dim');
    }

    function beginFocusLightEffect(xPct, yPct) {
      userFrozeFocus = false;
      const mode = document.getElementById('focusLightMode')?.value || 'lock_dim';
      if (mode === 'off') return null;

      let dimTarget = Number(document.getElementById('sliderFocusDimLight')?.value || 82);
      let afterTarget = Number(document.getElementById('sliderFocusBrightLight')?.value || 82);

      if (mode === 'lamp_smart') {
        const luma = measurePointLuminance(xPct, yPct);
        if (luma > 155) {
          dimTarget = Math.min(dimTarget, 68);
          afterTarget = dimTarget;
        } else if (luma < 75) {
          afterTarget = Math.max(afterTarget, 112);
        } else {
          afterTarget = dimTarget;
        }
      } else if (mode === 'lock_dim') {
        afterTarget = dimTarget;
      }

      animateBrightnessTo(dimTarget, 140, 'Focusing (' + dimTarget + '%) — Click/Space to Freeze!');
      return afterTarget;
    }

    function finishFocusLightEffect(afterTarget) {
      if (userFrozeFocus) {
        return;
      }
      playFocusConfirmBeep();
      const mode = document.getElementById('focusLightMode')?.value || 'lock_dim';
      if (mode === 'off' || afterTarget === null) return;
      const speedMs = Number(document.getElementById('sliderFocusLightSpeed')?.value || 350);
      animateBrightnessTo(afterTarget, speedMs, '🔔 Locked (' + afterTarget + '%)');
    }

    // Immediately stops the camera focus motor AND freezes the exact current light/brightness at that moment
    async function freezeFocusAndLightNow() {
      userFrozeFocus = true;
      if (focusLightAnimTimer) {
        clearInterval(focusLightAnimTimer);
        focusLightAnimTimer = null;
      }
      const curBrightness = Number(document.getElementById('sliderBrightness')?.value || 100);
      const statusEl = document.getElementById('lblFocusLightStatus');
      if (statusEl) {
        statusEl.textContent = '🔒 Frozen Here (' + curBrightness + '%)';
      }
      markAfBoxLocked();
      playFocusConfirmBeep();
      scheduleVisualSync();
      await sendCommand({ action: 'cancel_af' });
    }

    // Allow pressing Spacebar anytime to immediately freeze/lock focus & light at the sweet spot
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'SELECT') {
        e.preventDefault();
        freezeFocusAndLightNow();
      }
    });

    function showAfBoxAt(xPercent, yPercent) {
      const box = document.getElementById('afFocusBox');
      if (!box) return;
      if (afBoxTimeout) clearTimeout(afBoxTimeout);
      box.style.left = xPercent + '%';
      box.style.top = yPercent + '%';
      box.classList.remove('locked');
      box.style.display = 'block';
    }

    function markAfBoxLocked() {
      const box = document.getElementById('afFocusBox');
      if (!box) return;
      box.classList.add('locked');
      if (afBoxTimeout) clearTimeout(afBoxTimeout);
      afBoxTimeout = setTimeout(() => {
        box.style.display = 'none';
      }, 1500);
    }

    async function onMonitorCanvasClick(event) {
      // If camera is currently focusing, clicking the monitor immediately freezes focus & light right there!
      if (focusStepInFlight) {
        await freezeFocusAndLightNow();
        return;
      }
      focusStepInFlight = true;
      try {
        const rect = event.currentTarget.getBoundingClientRect();
        const xPct = Math.max(12, Math.min(88, ((event.clientX - rect.left) / rect.width) * 100));
        const yPct = Math.max(12, Math.min(88, ((event.clientY - rect.top) / rect.height) * 100));
        showAfBoxAt(xPct, yPct);
        const afterTarget = beginFocusLightEffect(xPct, yPct);
        await sendCommand({ action: 'auto_focus' });
        if (!userFrozeFocus) {
          markAfBoxLocked();
          finishFocusLightEffect(afterTarget);
        }
      } finally {
        focusStepInFlight = false;
      }
    }

    async function triggerTouchAfCenter() {
      if (focusStepInFlight) {
        await freezeFocusAndLightNow();
        return;
      }
      focusStepInFlight = true;
      try {
        showAfBoxAt(50, 50);
        const afterTarget = beginFocusLightEffect(50, 50);
        await sendCommand({ action: 'auto_focus' });
        if (!userFrozeFocus) {
          markAfBoxLocked();
          finishFocusLightEffect(afterTarget);
        }
      } finally {
        focusStepInFlight = false;
      }
    }

    async function triggerHalfPressAf() {
      if (focusStepInFlight) {
        await freezeFocusAndLightNow();
        return;
      }
      focusStepInFlight = true;
      try {
        showAfBoxAt(50, 50);
        const afterTarget = beginFocusLightEffect(50, 50);
        await sendCommand({ action: 'half_press_focus' });
        if (!userFrozeFocus) {
          markAfBoxLocked();
          finishFocusLightEffect(afterTarget);
        }
      } finally {
        focusStepInFlight = false;
      }
    }

    async function runSingleFocusStep(step) {
      if (focusStepInFlight) return;
      focusStepInFlight = true;
      try {
        const repeat = Number(document.getElementById('sliderFocusRepeat')?.value || 2);
        await sendCommand({ action: 'drive_lens', step, repeat });
      } finally {
        focusStepInFlight = false;
      }
    }

    function startHoldFocus(step) {
      stopHoldFocus();
      void runSingleFocusStep(step);
      holdFocusTimer = setInterval(() => {
        if (!focusStepInFlight) {
          void runSingleFocusStep(step);
        }
      }, 320);
    }

    function stopHoldFocus() {
      if (holdFocusTimer !== null) {
        clearInterval(holdFocusTimer);
        holdFocusTimer = null;
      }
    }

    async function setStreamViewMode(mode) {
      await fetch('/api/screen/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      await fetchStudioState();
    }

    async function applyPreset(presetId) {
      const res = await sendCommand({ action: 'preset', presetId });
      if (res && res.camera) {
        document.getElementById('sliderBrightness').value = res.camera.softwareBrightness || 100;
        document.getElementById('sliderContrast').value = res.camera.softwareContrast || 100;
        document.getElementById('sliderBoost').value = res.camera.lowLightBoost || 0;
        updateSoftwareFilters();
      }
    }

    function toggleFlashQuick() {
      const current = appState?.camera?.flashFiring ?? false;
      sendCommand({ action: 'flash_firing', enabled: !current });
    }

    function toggleOrientation() {
      isPortrait = !isPortrait;
      const wrap = document.getElementById('canvasContainer');
      const btn = document.getElementById('btnOrientation');
      if (isPortrait) {
        wrap.classList.remove('landscape');
        wrap.classList.add('portrait');
        btn.textContent = '📱 Portrait 9:16: ON (Vertical)';
        btn.style.borderColor = '#3b82f6';
      } else {
        wrap.classList.remove('portrait');
        wrap.classList.add('landscape');
        btn.textContent = '📱 Portrait 9:16: OFF (Landscape)';
        btn.style.borderColor = '';
      }
      scheduleVisualSync();
    }

    function updateCanvasTransform() {
      scheduleVisualSync();
    }

    function toggleGrid() {
      showGrid = !showGrid;
      document.getElementById('gridOverlay').classList.toggle('visible', showGrid);
    }

    function updateZoom(val) {
      digitalZoom = Number(val);
      document.getElementById('zoomVal').textContent = digitalZoom.toFixed(1) + 'x';
      scheduleVisualSync();
    }

    function updateSoftwareFilters() {
      const sharpEl = document.getElementById('sliderHdSharpness');
      if (sharpEl) {
        document.getElementById('lblHdSharpness').textContent = sharpEl.value + '%';
        updateSharpnessMatrix(sharpEl.value);
      }
      document.getElementById('lblBrightness').textContent = document.getElementById('sliderBrightness').value + '%';
      document.getElementById('lblContrast').textContent = document.getElementById('sliderContrast').value + '%';
      document.getElementById('lblBoost').textContent = document.getElementById('sliderBoost').value + '%';
      scheduleVisualSync();
    }

    function resetSoftwareFilters() {
      const sharpEl = document.getElementById('sliderHdSharpness');
      if (sharpEl) sharpEl.value = 100;
      document.getElementById('sliderBrightness').value = 100;
      document.getElementById('sliderContrast').value = 100;
      document.getElementById('sliderBoost').value = 0;
      updateSoftwareFilters();
    }

    function takePcSnapshot() {
      const a = document.createElement('a');
      a.download = 'gaviru-e400d-cam-' + Date.now() + '.jpg';
      a.href = canvas.toDataURL('image/jpeg', 0.98);
      a.click();
    }

    function buildCombinedMediaStream(fps) {
      const combined = canvas.captureStream(fps || 30);
      const audioTracks = audioDestNode?.stream?.getAudioTracks?.() || rawAudioStream?.getAudioTracks?.() || [];
      for (const track of audioTracks) {
        combined.addTrack(track);
      }
      return combined;
    }

    async function toggleVideoRecording() {
      const btn = document.getElementById('btnRecordVideo');
      if (!isRecordingVideo) {
        recordedChunks = [];
        const stream = buildCombinedMediaStream(30);
        const preferredMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : 'video/webm';
        mediaRecorder = new MediaRecorder(stream, {
          mimeType: preferredMime,
          videoBitsPerSecond: 12000000,
          audioBitsPerSecond: 192000
        });
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'gaviru-e400d-cam-' + Date.now() + '.webm';
          a.click();
        };
        mediaRecorder.start(250);
        isRecordingVideo = true;
        btn.classList.add('recording');
        btn.textContent = '⏹ Stop Recording';
        sendCommand({ action: 'movie_record', recording: true });
      } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        isRecordingVideo = false;
        btn.classList.remove('recording');
        btn.textContent = '🔴 Record Video';
        sendCommand({ action: 'movie_record', recording: false });
      }
    }

    async function startTunnel() {
      document.getElementById('tunnelStatusText').textContent = 'Spawning tunnel...';
      const res = await fetch('/api/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'auto' })
      });
      await fetchStudioState();
      return await res.json();
    }

    async function stopTunnel() {
      await fetch('/api/tunnel/stop', { method: 'POST' });
      document.getElementById('tunnelResultBox').style.display = 'none';
      await fetchStudioState();
    }

    function startWebRtcHost() {
      if (typeof Peer === 'undefined') {
        alert('PeerJS is still loading');
        return;
      }
      const roomId = document.getElementById('peerRoomId').value.trim() || 'gaviru-e400d-cam';
      if (peerInstance) peerInstance.destroy();
      const stream = buildCombinedMediaStream(30);
      peerInstance = new Peer(roomId);
      document.getElementById('webrtcStatus').textContent = 'Connecting...';
      peerInstance.on('open', (id) => {
        document.getElementById('webrtcStatus').textContent = 'Hosting: ' + id;
      });
      peerInstance.on('connection', (conn) => {
        conn.on('data', (msg) => {
          if (msg === 'request-stream') {
            const call = peerInstance.call(conn.peer, stream);
            activePeerCalls.push(call);
          }
        });
      });
    }

    function switchOsdSubView(view) {
      document.getElementById('osdQView').style.display = view === 'q' ? 'grid' : 'none';
      document.getElementById('osdMenuView').style.display = view === 'menu' ? 'flex' : 'none';
      document.getElementById('osdTabQ').classList.toggle('active', view === 'q');
      document.getElementById('osdTabMenu').classList.toggle('active', view === 'menu');
    }

    function toggleOsdBackdrop() {
      document.getElementById('canonOsdOverlay').classList.toggle('transparent-bg');
    }

    function focusSidebarControl(id) {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
      }
    }

    function toggleSection(headerEl) {
      const body = headerEl.nextElementSibling;
      if (body) body.classList.toggle('collapsed');
    }

    function filterStudioTab(tab, btn) {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.studio-section').forEach((sec) => {
        if (tab === 'all' || sec.getAttribute('data-tab') === tab) {
          sec.style.display = 'block';
        } else {
          sec.style.display = 'none';
        }
      });
    }

    function copyText(id) {
      const text = document.getElementById(id).textContent;
      navigator.clipboard.writeText(text);
    }

    // PWA Mobile App Install Handler
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const btn = document.getElementById('btnInstallPwa');
      if (btn) btn.style.display = 'inline-flex';
    });

    async function installMobileApp() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          const btn = document.getElementById('btnInstallPwa');
          if (btn) btn.style.display = 'none';
        }
        deferredInstallPrompt = null;
      } else {
        alert('📱 Android / iOS මත Install කර ගැනීමට:\n\n1. Google Chrome හෝ Safari browser එකේ මෙනුව (⋮ හෝ Share icon) ක්ලික් කරන්න.\n2. "Install app" හෝ "Add to Home screen" තෝරන්න.\n3. එවිට ඔබේ දුරකථනයේ වෙනම Mobile App එකක් ලෙස මෙය Install වේ!');
      }
    }

    initNaturalCameraAudio('default');
    fetchStudioState();
    setInterval(fetchStudioState, 1000);
  </script>
</body>
</html>`;
}

export function createRemoteWatchPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gaviru E400D Cam — WebRTC & Remote Stream Watcher</title>
  <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js" defer></script>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #07090c; color: #f3f4f6; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 12px 20px; background: #12151c; border-bottom: 1px solid #262b35; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
    main { flex: 1; display: grid; place-items: center; padding: 16px; }
    .stage { position: relative; max-width: 1080px; width: 100%; background: #000; border: 1px solid #262b35; border-radius: 8px; overflow: hidden; display: grid; place-items: center; }
    .stage.portrait { max-width: 440px; aspect-ratio: 9 / 16; }
    video, img { width: 100%; height: 100%; object-fit: contain; display: block; }
    button, input { font: inherit; padding: 7px 12px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: #fff; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <div><strong>📡 Gaviru E400D Cam — Remote Watcher</strong> <span id="watchMode" style="font-size:12px; color:#9ca3af;">(MJPEG Direct Stream)</span></div>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <input type="text" id="roomInput" value="gaviru-e400d-cam" placeholder="WebRTC Room ID">
      <button onclick="connectPeer()">🔗 Join WebRTC P2P</button>
      <button onclick="document.getElementById('stageBox').classList.toggle('portrait')">📱 Toggle 9:16 Portrait</button>
      <a href="/control" style="color:#60a5fa; text-decoration:none; font-size:13px;">🎛️ Control Panel</a>
    </div>
  </header>
  <main>
    <div id="stageBox" class="stage">
      <video id="webrtcVideo" autoplay playsinline muted style="display:none;"></video>
      <img id="mjpegFallback" src="/stream?raw=1" alt="Gaviru E400D Cam Stream">
    </div>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    if (params.get('room')) document.getElementById('roomInput').value = params.get('room');

    function connectPeer() {
      const room = document.getElementById('roomInput').value.trim();
      if (!room || typeof Peer === 'undefined') return;
      const peer = new Peer();
      peer.on('open', () => {
        const conn = peer.connect(room);
        conn.on('open', () => conn.send('request-stream'));
      });
      peer.on('call', (call) => {
        call.answer();
        call.on('stream', (remoteStream) => {
          const v = document.getElementById('webrtcVideo');
          v.srcObject = remoteStream;
          v.muted = false;
          v.style.display = 'block';
          document.getElementById('mjpegFallback').style.display = 'none';
          document.getElementById('watchMode').textContent = '(WebRTC P2P Active + Live Audio)';
        });
      });
    }
  </script>
</body>
</html>`;
}

export function createCleanPopoutPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Gaviru E400D Cam — Clean OBS Studio 4K / Full HD Output</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #obsStage {
      position: relative;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    #obsStage.portrait {
      aspect-ratio: 9 / 16;
      height: 100vh;
      width: auto;
    }
    #obsMasterCanvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      transform-origin: center center;
      will-change: transform, filter;
      backface-visibility: hidden;
    }
    #obsStreamImg {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0.01;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <!-- GPU Full HD / 4K Pro Unsharp Mask Filter for OBS Studio -->
  <svg style="position:absolute;width:0;height:0;pointer-events:none;" aria-hidden="true">
    <defs>
      <filter id="obsHdSharpFilter" color-interpolation-filters="sRGB">
        <feConvolveMatrix id="obsHdSharpMatrix" order="3 3" kernelMatrix="0 -0.28 0 -0.28 2.12 -0.28 0 -0.28 0" preserveAlpha="true"/>
      </filter>
    </defs>
  </svg>

  <div id="obsStage">
    <canvas id="obsMasterCanvas" width="3840" height="2160"></canvas>
    <img id="obsStreamImg" src="/stream?raw=1" crossorigin="anonymous" decoding="sync" fetchpriority="high" alt="Raw Source">
  </div>
  <audio id="obsLiveAudio" autoplay playsinline style="display:none;"></audio>

  <script>
    const stage = document.getElementById('obsStage');
    const canvas = document.getElementById('obsMasterCanvas');
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const img = document.getElementById('obsStreamImg');
    const audioEl = document.getElementById('obsLiveAudio');
    const sharpMat = document.getElementById('obsHdSharpMatrix');

    let obsAudioCtx = null;
    let obsGainNode = null;
    let obsAudioStream = null;
    let currentDeviceId = '';
    let audioStarting = false;
    let usingWavRelay = false;

    let currentVisual = {
      softwareBrightness: 100,
      softwareContrast: 100,
      lowLightBoost: 0,
      hdSharpness: 135,
      digitalZoom: 1.0,
      isPortrait: false,
      portraitRotation: 'crop',
      outputAspect: '16:9',
      outputResolution: '4k',
      colorGrading: 'vivid'
    };

    function activateWavRelay(enabled) {
      if (!audioEl) return;
      if (!enabled) {
        audioEl.muted = true;
        return;
      }
      audioEl.muted = false;
      if (!usingWavRelay) {
        usingWavRelay = true;
        audioEl.srcObject = null;
        audioEl.src = '/audio.wav?t=' + Date.now();
        audioEl.volume = 1.0;
        audioEl.play().catch(() => {});
      } else if (audioEl.paused) {
        audioEl.play().catch(() => {});
      }
    }

    async function ensureObsAudio(deviceId, enabled, volume) {
      if (!enabled) {
        if (obsGainNode && obsAudioCtx) {
          obsGainNode.gain.setTargetAtTime(0, obsAudioCtx.currentTime, 0.02);
        }
        if (audioEl) audioEl.muted = true;
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        activateWavRelay(true);
        return;
      }
      if (obsGainNode && obsAudioCtx) {
        obsGainNode.gain.setTargetAtTime((volume ?? 100) / 100, obsAudioCtx.currentTime, 0.02);
      }
      if (audioEl) {
        audioEl.muted = false;
        if (audioEl.paused) audioEl.play().catch(() => {});
      }
      if (obsAudioStream && currentDeviceId === (deviceId || 'default')) {
        return;
      }
      if (audioStarting) return;
      audioStarting = true;
      try {
        currentDeviceId = deviceId || 'default';
        const constraints = {
          audio: {
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false },
            sampleRate: { ideal: 48000 },
            channelCount: { ideal: 2 },
            ...(currentDeviceId !== 'default' ? { deviceId: { exact: currentDeviceId } } : {})
          },
          video: false
        };
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            video: false
          });
        }
        usingWavRelay = false;
        if (obsAudioStream) {
          obsAudioStream.getTracks().forEach((t) => t.stop());
        }
        obsAudioStream = stream;
        stream.getAudioTracks().forEach((track) => {
          track.onended = () => {
            obsAudioStream = null;
          };
        });

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!obsAudioCtx && AudioContextClass) {
          obsAudioCtx = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 48000 });
        }
        if (obsAudioCtx) {
          if (obsAudioCtx.state === 'suspended') await obsAudioCtx.resume().catch(() => {});
          if (obsGainNode) {
            try { obsGainNode.disconnect(); } catch {}
          }
          const src = obsAudioCtx.createMediaStreamSource(stream);
          obsGainNode = obsAudioCtx.createGain();
          obsGainNode.gain.value = (volume ?? 100) / 100;
          const dest = obsAudioCtx.createMediaStreamDestination();
          src.connect(obsGainNode);
          obsGainNode.connect(dest);
          obsGainNode.connect(obsAudioCtx.destination);
          audioEl.srcObject = dest.stream;
          audioEl.muted = false;
          audioEl.volume = 1.0;
          audioEl.play().catch(() => {});
        }
      } catch {
        activateWavRelay(enabled);
      } finally {
        audioStarting = false;
      }
    }

    let lastObsRenderTime = 0;
    function renderObsCanvasLoop(now) {
      requestAnimationFrame(renderObsCanvasLoop);
      if (now && now - lastObsRenderTime < 28) {
        return;
      }
      lastObsRenderTime = now;

      const v = currentVisual;
      const aspect = v.outputAspect || '16:9';
      const res = v.outputResolution || '4k';
      const colorGrade = v.colorGrading || 'vivid';
      const sharp = Number(v.hdSharpness ?? 135);

      // Determine Master Canvas dimensions
      let targetW = 3840;
      let targetH = 2160;
      if (res === '4k') {
        targetW = aspect === '9:16' ? 2160 : 3840;
        targetH = aspect === '9:16' ? 3840 : 2160;
      } else if (res === '2k') {
        targetW = aspect === '9:16' ? 1440 : 2560;
        targetH = aspect === '9:16' ? 2560 : 1440;
      } else {
        targetW = aspect === '9:16' ? 1080 : 1920;
        targetH = aspect === '9:16' ? 1920 : 1080;
      }
      if (aspect === '3:2') {
        targetW = res === '4k' ? 3240 : res === '2k' ? 2160 : 1620;
        targetH = res === '4k' ? 2160 : res === '2k' ? 1440 : 1080;
      }

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      stage.classList.toggle('portrait', aspect === '9:16');

      const b = Number(v.softwareBrightness || 100);
      const c = Number(v.softwareContrast || 100);
      const boost = Number(v.lowLightBoost || 0);
      const effB = b + Math.round(boost * 0.65);
      const effC = c + Math.round(boost * 0.2);

      // Update SVG Unsharp Kernel
      if (sharpMat && sharp > 0) {
        const k = Number(((Math.min(200, sharp) / 100) * 0.28).toFixed(3));
        const coeff = Number((1 + 4 * k).toFixed(3));
        sharpMat.setAttribute('kernelMatrix', '0 -' + k + ' 0 -' + k + ' ' + coeff + ' -' + k + ' 0 -' + k + ' 0');
      }

      const canvasFilter = sharp > 0 ? 'url(#obsHdSharpFilter)' : 'none';
      if (canvas.style.filter !== canvasFilter) {
        canvas.style.filter = canvasFilter;
      }

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let filterStr = '';
      if (effB !== 100) filterStr += 'brightness(' + effB + '%) ';
      if (effC !== 100) filterStr += 'contrast(' + effC + '%) ';
      if (colorGrade === 'vivid') {
        filterStr += 'saturate(122%) contrast(106%) ';
      } else if (colorGrade === 'cinema') {
        filterStr += 'saturate(115%) contrast(110%) ';
      } else if (colorGrade === 'warm') {
        filterStr += 'saturate(112%) sepia(8%) contrast(105%) ';
      }
      ctx.filter = filterStr.trim() || 'none';

      if (img.complete && img.naturalWidth > 0) {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;
        const rot = v.portraitRotation || 'crop';
        const zoom = Number(v.digitalZoom || 1.0);

        ctx.translate(canvas.width / 2, canvas.height / 2);
        if (zoom !== 1.0) ctx.scale(zoom, zoom);

        if (aspect === '9:16') {
          if (rot === 'cw') {
            ctx.rotate(Math.PI / 2);
            ctx.drawImage(img, -canvas.height / 2, -canvas.width / 2, canvas.height, canvas.width);
          } else if (rot === 'ccw') {
            ctx.rotate(-Math.PI / 2);
            ctx.drawImage(img, -canvas.height / 2, -canvas.width / 2, canvas.height, canvas.width);
          } else {
            // 9:16 center crop - edge-to-edge with no black bars
            const cropW = Math.round(srcH * (9 / 16));
            const sx = Math.max(0, Math.round((srcW - cropW) / 2));
            ctx.drawImage(img, sx, 0, cropW, srcH, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
          }
        } else if (aspect === '16:9') {
          // 16:9 center crop from 3:2 camera sensor - edge-to-edge with no black bars
          const cropH = Math.round(srcW * (9 / 16));
          const sy = Math.max(0, Math.round((srcH - cropH) / 2));
          ctx.drawImage(img, 0, sy, srcW, cropH, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
        } else {
          // 3:2 native sensor fit
          const scale = Math.min(canvas.width / srcW, canvas.height / srcH);
          const drawW = Math.round(srcW * scale);
          const drawH = Math.round(srcH * scale);
          ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        }
      }
      ctx.restore();
    }
    requestAnimationFrame(renderObsCanvasLoop);

    async function syncObsState() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        const data = await res.json();
        if (!data || !data.ok) return;
        const v = data.visual || {};
        currentVisual = Object.assign(currentVisual, v);

        await ensureObsAudio(v.audioDeviceId || 'default', v.audioEnabled !== false, v.audioVolume ?? 100);
      } catch {}
    }

    window.addEventListener('pointerdown', () => {
      if (obsAudioCtx && obsAudioCtx.state === 'suspended') obsAudioCtx.resume().catch(() => {});
      if (audioEl && audioEl.paused) audioEl.play().catch(() => {});
    }, { passive: true });

    syncObsState();
    setInterval(syncObsState, 250);
  </script>
</body>
</html>`;
}

export function createVdoNinjaPage(): string {
  return `<!doctype html>
<html lang="si">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gaviru E400D Cam — VDO.Ninja 4K Ultra Broadcaster</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, sans-serif; background: #07090e; color: #f3f4f6; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 14px 20px; background: #0f141f; border-bottom: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    main { flex: 1; display: grid; place-items: center; padding: 18px; }
    .stage-card { max-width: 980px; width: 100%; background: #0b0f17; border: 1px solid #1e293b; border-radius: 14px; overflow: hidden; box-shadow: 0 15px 50px rgba(0,0,0,0.7); }
    .stage-view { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .stage-view.portrait { aspect-ratio: 9 / 16; max-height: 70vh; }
    canvas { width: 100%; height: 100%; object-fit: contain; display: block; }
    .vdo-panel { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; background: #0f141f; border-top: 1px solid #1e293b; }
    .code-box { background: #05070c; border: 1px solid #1e293b; border-radius: 8px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #93c5fd; word-break: break-all; }
    button { font: inherit; font-weight: 700; padding: 9px 16px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
    .btn-push { background: linear-gradient(135deg, #10b981, #059669); color: #fff; font-size: 14px; box-shadow: 0 4px 15px rgba(16,185,129,0.3); }
    .btn-copy { background: #1e293b; border-color: #3b82f6; color: #93c5fd; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div style="display:flex; align-items:center; gap:10px;">
      <span style="background:#f59e0b; color:#000; font-weight:900; padding:3px 8px; border-radius:4px; font-size:12px;">4K PRO</span>
      <h1 style="margin:0; font-size:17px; font-weight:800;">Gaviru E400D Cam — VDO.Ninja Ultra Broadcaster</h1>
    </div>
    <div style="display:flex; gap:8px; align-items:center;">
      <a href="/control" style="color:#60a5fa; text-decoration:none; font-size:13px; font-weight:700;">🎛️ Control Panel</a>
      <a href="/clean" target="_blank" style="color:#34d399; text-decoration:none; font-size:13px; font-weight:700;">🪟 Clean Pop-out</a>
    </div>
  </header>

  <main>
    <div class="stage-card">
      <div id="vdoStage" class="stage-view">
        <canvas id="vdoCanvas" width="3840" height="2160"></canvas>
        <img id="vdoStreamImg" src="/stream?raw=1" crossorigin="anonymous" decoding="sync" fetchpriority="high" style="display:none;" alt="Raw Stream">
      </div>

      <div class="vdo-panel">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <strong style="color:#fde68a; font-size:14px;">🥷 1. OBS Studio එකට දාන VDO.Ninja Browser Source Link එක:</strong>
            <div style="color:#9ca3af; font-size:11.5px;">මෙම Link එක Copy කර OBS Studio එකේ Browser Source එකක් ලෙස එක් කරන්න.</div>
          </div>
          <button class="btn-copy" onclick="copyObsLink()">📋 Copy OBS VDO Link</button>
        </div>

        <div class="code-box">
          <span id="vdoObsViewLink">https://vdo.ninja/?view=gaviru-cam-pro&cleanoutput&scale=100</span>
        </div>

        <div style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.4); border-radius:8px; padding:10px 14px; font-size:12px; line-height:1.5; color:#a7f3d0;">
          💡 <strong>OBS එකට Link එක දාන නිවැරදි ක්‍රමය:</strong><br>
          1. OBS Studio විවෘත කර <strong>Sources</strong> යටතේ <strong>+ (Add) ➔ Browser</strong> තෝරන්න.<br>
          2. URL එකට ඉහත Copy කරගත් Link එක Paste කරන්න.<br>
          3. <strong>Width: 1920 (හෝ 3840)</strong> සහ <strong>Height: 1080 (හෝ 2160)</strong> ලබා දෙන්න.<br>
          4. <strong>Control Audio via OBS</strong> මත හරිය ලකුණ (Check) යොදන්න.
        </div>

        <div style="display:flex; gap:10px; margin-top:4px;">
          <button class="btn-push" style="flex:1;" onclick="openVdoNinjaPush()">
            🚀 2. Start VDO.Ninja 4K Live Push (Send Video to VDO.Ninja)
          </button>
          <button class="btn-copy" onclick="toggleAspect()">
            📐 Toggle 16:9 / 9:16
          </button>
        </div>
      </div>
    </div>
  </main>

  <script>
    const canvas = document.getElementById('vdoCanvas');
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const img = document.getElementById('vdoStreamImg');
    const stage = document.getElementById('vdoStage');

    let currentRoom = 'gaviru-cam-pro';
    let currentAspect = '16:9';
    let currentRes = '4k';
    let currentColor = 'vivid';

    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('room')) currentRoom = urlParams.get('room');

    function updateObsUrlDisplay() {
      const viewUrl = 'https://vdo.ninja/?view=' + encodeURIComponent(currentRoom) + '&cleanoutput&transparent=0&scale=100';
      document.getElementById('vdoObsViewLink').textContent = viewUrl;
    }
    updateObsUrlDisplay();

    function copyObsLink() {
      const text = document.getElementById('vdoObsViewLink').textContent;
      navigator.clipboard.writeText(text);
      alert('OBS VDO.Ninja Link එක Copy විය! දැන් OBS Studio එකේ Browser Source එකක් ලෙස Paste කරන්න.');
    }

    function openVdoNinjaPush() {
      const pushUrl = 'https://vdo.ninja/?push=' + encodeURIComponent(currentRoom) + '&webcam&autostart&videobitrate=25000&audiobitrate=320&scale=100&quality=0&fps=30';
      window.open(pushUrl, '_blank', 'width=1280,height=720');
    }

    function toggleAspect() {
      currentAspect = currentAspect === '16:9' ? '9:16' : '16:9';
      stage.classList.toggle('portrait', currentAspect === '9:16');
    }

    function renderLoop() {
      const targetW = currentAspect === '9:16' ? 2160 : 3840;
      const targetH = currentAspect === '9:16' ? 3840 : 2160;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (currentColor === 'vivid') {
        ctx.filter = 'saturate(122%) contrast(106%)';
      } else if (currentColor === 'cinema') {
        ctx.filter = 'saturate(115%) contrast(110%)';
      }

      if (img.complete && img.naturalWidth > 0) {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;
        ctx.translate(canvas.width / 2, canvas.height / 2);

        if (currentAspect === '9:16') {
          const cropW = Math.round(srcH * (9 / 16));
          const sx = Math.max(0, Math.round((srcW - cropW) / 2));
          ctx.drawImage(img, sx, 0, cropW, srcH, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
        } else {
          const cropH = Math.round(srcW * (9 / 16));
          const sy = Math.max(0, Math.round((srcH - cropH) / 2));
          ctx.drawImage(img, 0, sy, srcW, cropH, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
        }
      }
      ctx.restore();
      requestAnimationFrame(renderLoop);
    }
    requestAnimationFrame(renderLoop);

    async function pollState() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        const data = await res.json();
        if (data && data.visual) {
          if (data.visual.vdoNinjaRoom && !urlParams.get('room')) {
            currentRoom = data.visual.vdoNinjaRoom;
            updateObsUrlDisplay();
          }
          if (data.visual.outputAspect) {
            currentAspect = data.visual.outputAspect;
            stage.classList.toggle('portrait', currentAspect === '9:16');
          }
          if (data.visual.outputResolution) currentRes = data.visual.outputResolution;
          if (data.visual.colorGrading) currentColor = data.visual.colorGrading;
        }
      } catch {}
    }
    pollState();
    setInterval(pollState, 1000);
  </script>
</body>
</html>`;
}

async function startCloudTunnel(
  tunnel: TunnelSession,
  port: number,
  preferredProvider: string
): Promise<{ running: boolean; provider: string | null; url: string | null; error: string | null }> {
  if (tunnel.running && tunnel.url !== null) {
    return {
      running: tunnel.running,
      provider: tunnel.provider,
      url: tunnel.url,
      error: tunnel.error
    };
  }

  stopTunnelProcess(tunnel);
  tunnel.running = true;
  tunnel.error = null;
  tunnel.logs = [];

  const localTarget = `http://127.0.0.1:${port}`;
  const candidates: Array<{ name: string; cmd: string; args: string[] }> =
    preferredProvider === "localtunnel"
      ? [
          { name: "localtunnel", cmd: "npx", args: ["--yes", "localtunnel", "--port", String(port)] },
          { name: "localhost.run", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=no", "-R", `80:127.0.0.1:${port}`, "nokey@localhost.run"] },
          { name: "pinggy", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=no", "-p", "443", `-R0:127.0.0.1:${port}`, "a.pinggy.io"] },
          { name: "cloudflared", cmd: "cloudflared", args: ["tunnel", "--url", localTarget] }
        ]
      : preferredProvider === "cloudflared"
        ? [
            { name: "cloudflared", cmd: "cloudflared", args: ["tunnel", "--url", localTarget] },
            { name: "localhost.run", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=no", "-R", `80:127.0.0.1:${port}`, "nokey@localhost.run"] },
            { name: "pinggy", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=no", "-p", "443", `-R0:127.0.0.1:${port}`, "a.pinggy.io"] },
            { name: "localtunnel", cmd: "npx", args: ["--yes", "localtunnel", "--port", String(port)] }
          ]
        : [
            { name: "localhost.run", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=no", "-R", `80:127.0.0.1:${port}`, "nokey@localhost.run"] },
            { name: "cloudflared", cmd: "cloudflared", args: ["tunnel", "--url", localTarget] },
            { name: "pinggy", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=no", "-p", "443", `-R0:127.0.0.1:${port}`, "a.pinggy.io"] },
            { name: "localtunnel", cmd: "npx", args: ["--yes", "localtunnel", "--port", String(port)] }
          ];

  for (const candidate of candidates) {
    const discovered = await trySpawnTunnelCandidate(tunnel, candidate);
    if (discovered !== null) {
      return {
        running: tunnel.running,
        provider: tunnel.provider,
        url: tunnel.url,
        error: tunnel.error
      };
    }
  }

  tunnel.running = false;
  tunnel.error = "Public tunnel could not be spawned; check internet connection or OpenSSH.";
  return {
    running: false,
    provider: null,
    url: null,
    error: tunnel.error
  };
}

async function trySpawnTunnelCandidate(
  tunnel: TunnelSession,
  candidate: { name: string; cmd: string; args: string[] }
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let settled = false;
    let proc: ChildProcess;
    try {
      proc = spawn(candidate.cmd, candidate.args, {
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolve(null);
      return;
    }

    tunnel.process = proc;
    tunnel.provider = candidate.name;

    const finish = (url: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };

    const inspectChunk = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      tunnel.logs.push(text.trim());
      const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.(?:trycloudflare\.com|loca\.lt|lhr\.life|pinggy\.link|free\.pinggy\.link|a\.free\.pinggy\.link)/);
      if (match !== null && match[0] !== undefined) {
        tunnel.url = match[0];
        finish(match[0]);
      }
    };

    proc.stdout?.on("data", inspectChunk);
    proc.stderr?.on("data", inspectChunk);
    proc.once("error", () => {
      finish(null);
    });
    proc.once("exit", () => {
      if (!settled) {
        finish(null);
      } else {
        tunnel.running = false;
      }
    });

    const timer = setTimeout(() => {
      if (tunnel.url === null) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        finish(null);
      }
    }, 8_000);
  });
}

function stopTunnelProcess(tunnel: TunnelSession): void {
  if (tunnel.process !== null) {
    try {
      tunnel.process.kill();
    } catch {
      // ignore
    }
    tunnel.process = null;
  }
  tunnel.running = false;
  tunnel.url = null;
  tunnel.provider = null;
}

function streamFrames(source: ObservableFrameSource, boundary: string, response: ServerResponse): void {
  const abortController = new AbortController();
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Connection": "keep-alive",
    "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "Pragma": "no-cache"
  });

  response.once("close", () => {
    abortController.abort();
  });

  void (async () => {
    try {
      for await (const frame of source.frames(abortController.signal)) {
        response.write(`--${boundary}\r\n`);
        response.write("Content-Type: image/jpeg\r\n");
        response.write(`Content-Length: ${frame.bytes.byteLength}\r\n\r\n`);
        response.write(frame.bytes);
        response.write("\r\n");
      }
      response.end();
    } catch (error) {
      console.error("MJPEG stream failed", error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Bypass-Tunnel-Reminder");
}

function sendJson(response: ServerResponse, statusCode: number, data: unknown): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function getLocalLanAddresses(): string[] {
  const results: string[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        results.push(entry.address);
      }
    }
  }
  return results;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
