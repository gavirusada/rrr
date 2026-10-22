import { networkInterfaces } from "node:os";
import {
  CANON_EOS_OPERATION,
  CANON_EOS_PROPERTY,
  CANON_EVF_OUTPUT,
  CANON_LENS_DRIVE_STEP,
  createCanonEosPropertyPayload,
  extractCanonEosJpeg,
  extractCanonEosScreenOrJpeg
} from "./canonEos";
import {
  CANON_SHOOTING_PRESETS,
  type CanonEosPropertyValueByteLength,
  type CanonShootingPreset,
  formatCanonPropertyValue
} from "./canonProperties";
import {
  CANON_EOS_EVENT,
  parseCanonEosPropertyEvents
} from "./canonPropertyEvents";
import type { FrameSource } from "./frameSource";
import { LiveViewBootstrap } from "./liveViewBootstrap";
import {
  CanonLiveViewFrameSource,
  type CanonStreamMode,
  type ViewfinderResponse
} from "./liveViewFrameSource";
import { MtpSession } from "./mtpSession";
import { MtpTransport } from "./mtpTransport";
import { PtpIpEventChannel } from "./ptpIpEventChannel";
import { ReconnectingFrameSource } from "./reconnectingFrameSource";
import { initializePtpIpTransport } from "./ptpIpSession";
import { SharedFrameSource } from "./sharedFrameSource";

const OK = 0x2001;
const DEVICE_BUSY = 0x2019;
const NOT_READY = 0xa102;

const ACCEPTED_EVENT_RESPONSE_CODES = [
  OK,
  DEVICE_BUSY,
  NOT_READY,
  0x2002,
  0x2005,
  0x2007,
  0x2009,
  0x200a,
  0x200c,
  0x200f,
  0x201b,
  0x201c,
  0x201d,
  0x201e,
  0xa101
];

export type CanonControlAuthorityMode = "dual" | "camera_priority";

export interface CanonCameraState {
  connected: boolean;
  cameraName: string;
  evfActive: boolean;
  cameraDisplayActive: boolean;
  controlAuthority: CanonControlAuthorityMode;
  streamMode: CanonStreamMode;
  movieRecording: boolean;
  activePreset: string;
  iso: number;
  shutterSpeed: number;
  aperture: number;
  exposureComp: number;
  flashFiring: boolean;
  flashExposureComp: number;
  whiteBalance: number;
  meteringMode: number;
  driveMode: number;
  softwareBrightness: number;
  softwareContrast: number;
  lowLightBoost: number;
  properties: Record<string, number>;
  allowedValues: Record<string, number[]>;
  formatted: {
    iso: string;
    shutterSpeed: string;
    aperture: string;
    exposureComp: string;
    flashExposureComp: string;
    whiteBalance: string;
    meteringMode: string;
    driveMode: string;
  };
  lastCommand: string | null;
  lastCommandAt: string | null;
  lastError: string | null;
  queueDepth: number;
}

export interface CanonCameraController {
  getState(): CanonCameraState;
  setProperty(
    propertyCode: number,
    value: number,
    byteLength?: CanonEosPropertyValueByteLength
  ): Promise<void>;
  setIso(value: number): Promise<void>;
  setShutterSpeed(value: number): Promise<void>;
  setAperture(value: number): Promise<void>;
  setExposureCompensation(value: number): Promise<void>;
  setFlashFiring(enabled: boolean): Promise<void>;
  setFlashExposureCompensation(value: number): Promise<void>;
  setWhiteBalance(value: number): Promise<void>;
  setMeteringMode(value: number): Promise<void>;
  setDriveMode(value: number): Promise<void>;
  applyPreset(presetId: string): Promise<CanonShootingPreset>;
  triggerShutterRelease(): Promise<void>;
  setMovieRecord(recording: boolean): Promise<void>;
  autoFocus(): Promise<void>;
  halfPressFocus(): Promise<void>;
  cancelAutoFocus(): Promise<void>;
  driveFocusLens(step: number, repeat?: number): Promise<void>;
  setLiveViewShutter(enabled: boolean): Promise<boolean>;
  toggleLiveViewShutter(): Promise<boolean>;
  setCameraDisplay(enabled: boolean): Promise<boolean>;
  toggleCameraDisplay(): Promise<boolean>;
  setControlAuthority(mode: CanonControlAuthorityMode): Promise<CanonControlAuthorityMode>;
  unlockCameraButtons(): Promise<void>;
  setStreamMode(mode: CanonStreamMode): Promise<CanonStreamMode>;
  captureScreenFrame(): Promise<Uint8Array | null>;
  pollEventsNow(): Promise<void>;
  setCameraHost(ip: string): void;
}

export interface CanonLiveViewConnectionOptions {
  host: string;
  port: number;
  localAddress?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  retryDelayMs?: number;
}

export interface CanonLiveViewConnection {
  source: FrameSource;
  controller?: CanonCameraController;
  close(): void;
}

interface ActiveSessionBindings {
  session: MtpSession;
  bootstrap: LiveViewBootstrap;
  liveViewSource: CanonLiveViewFrameSource;
  withSessionLock<T>(task: () => Promise<T>): Promise<T>;
  ensureWifiPcControlUnlocked(): Promise<void>;
  pollAndSyncEventsUnlocked(): Promise<void>;
  pumpLiveViewDuringActionUnlocked(durationMs: number, shouldAbort?: () => boolean): Promise<void>;
  writePropertyUnlocked(
    propertyCode: number,
    value: number,
    byteLength?: CanonEosPropertyValueByteLength
  ): Promise<void>;
  unlockCameraUiUnlocked(): Promise<void>;
  syncEvfOutputDeviceUnlocked(): Promise<void>;
  requestScreenDataUnlocked(): Promise<ViewfinderResponse>;
}

export async function connectCanonLiveView(
  options: CanonLiveViewConnectionOptions
): Promise<CanonLiveViewConnection> {
  const state: CanonCameraState = {
    connected: false,
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

  let activeBindings: ActiveSessionBindings | null = null;
  let outerSharedSource: SharedFrameSource | null = null;
  let abortActiveAf = false;
  let afInProgress = false;

  function updateFormattedState(): void {
    state.formatted = {
      iso: formatCanonPropertyValue(CANON_EOS_PROPERTY.ISO, state.iso),
      shutterSpeed: formatCanonPropertyValue(CANON_EOS_PROPERTY.SHUTTER_SPEED, state.shutterSpeed),
      aperture: formatCanonPropertyValue(CANON_EOS_PROPERTY.APERTURE, state.aperture),
      exposureComp: formatCanonPropertyValue(
        CANON_EOS_PROPERTY.EXPOSURE_COMPENSATION,
        state.exposureComp
      ),
      flashExposureComp: formatCanonPropertyValue(
        CANON_EOS_PROPERTY.FLASH_EXPOSURE_COMPENSATION,
        state.flashExposureComp
      ),
      whiteBalance: formatCanonPropertyValue(CANON_EOS_PROPERTY.WHITE_BALANCE, state.whiteBalance),
      meteringMode: formatCanonPropertyValue(CANON_EOS_PROPERTY.METERING_MODE, state.meteringMode),
      driveMode: formatCanonPropertyValue(CANON_EOS_PROPERTY.DRIVE_MODE, state.driveMode)
    };
  }

  async function runQueued<T>(
    label: string,
    action: (bindings: ActiveSessionBindings) => Promise<T>
  ): Promise<T> {
    const bindings = activeBindings;
    if (bindings === null) {
      throw new Error("Camera is reconnecting; please wait a moment");
    }

    state.queueDepth += 1;
    state.lastCommand = label;
    state.lastCommandAt = new Date().toISOString();
    try {
      const result = await withTimeout(
        bindings.withSessionLock(async () => {
          return await action(bindings);
        }),
        8_000,
        `Command "${label}" timed out`
      );
      state.lastError = null;
      updateFormattedState();
      return result;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      updateFormattedState();
      throw error;
    } finally {
      state.queueDepth = Math.max(0, state.queueDepth - 1);
    }
  }

  const controller: CanonCameraController = {
    getState(): CanonCameraState {
      updateFormattedState();
      return {
        ...state,
        properties: { ...state.properties },
        allowedValues: { ...state.allowedValues },
        formatted: { ...state.formatted }
      };
    },

    async setProperty(
      propertyCode: number,
      value: number,
      byteLength: CanonEosPropertyValueByteLength = 4
    ): Promise<void> {
      await runQueued(
        `SetProperty 0x${propertyCode.toString(16)} = 0x${value.toString(16)}`,
        async (bindings) => {
          await bindings.ensureWifiPcControlUnlocked();
          await bindings.writePropertyUnlocked(propertyCode, value, byteLength);
          await bindings.pollAndSyncEventsUnlocked();
          await bindings.unlockCameraUiUnlocked();
        }
      );
    },

    async setIso(value: number): Promise<void> {
      state.iso = value;
      await controller.setProperty(CANON_EOS_PROPERTY.ISO, value, 4);
    },

    async setShutterSpeed(value: number): Promise<void> {
      state.shutterSpeed = value;
      await controller.setProperty(CANON_EOS_PROPERTY.SHUTTER_SPEED, value, 4);
    },

    async setAperture(value: number): Promise<void> {
      state.aperture = value;
      await controller.setProperty(CANON_EOS_PROPERTY.APERTURE, value, 4);
    },

    async setExposureCompensation(value: number): Promise<void> {
      state.exposureComp = value;
      await controller.setProperty(CANON_EOS_PROPERTY.EXPOSURE_COMPENSATION, value, 4);
    },

    async setFlashFiring(enabled: boolean): Promise<void> {
      state.flashFiring = enabled;
      await runQueued(`Flash Firing: ${enabled ? "ON" : "OFF"}`, async (bindings) => {
        await bindings.ensureWifiPcControlUnlocked();
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.FLASH_FIRING, enabled ? 1 : 0, 4);
        await bindings.pollAndSyncEventsUnlocked();
        await bindings.unlockCameraUiUnlocked();
      });
    },

    async setFlashExposureCompensation(value: number): Promise<void> {
      state.flashExposureComp = value;
      await controller.setProperty(CANON_EOS_PROPERTY.FLASH_EXPOSURE_COMPENSATION, value, 4);
    },

    async setWhiteBalance(value: number): Promise<void> {
      state.whiteBalance = value;
      await runQueued(`White Balance: ${value}`, async (bindings) => {
        await bindings.ensureWifiPcControlUnlocked();
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.WHITE_BALANCE_MODE, value, 4);
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.WHITE_BALANCE, value, 4);
        await bindings.pollAndSyncEventsUnlocked();
        await bindings.unlockCameraUiUnlocked();
      });
    },

    async setMeteringMode(value: number): Promise<void> {
      state.meteringMode = value;
      await controller.setProperty(CANON_EOS_PROPERTY.METERING_MODE, value, 4);
    },

    async setDriveMode(value: number): Promise<void> {
      state.driveMode = value;
      await controller.setProperty(CANON_EOS_PROPERTY.DRIVE_MODE, value, 4);
    },

    async applyPreset(presetId: string): Promise<CanonShootingPreset> {
      const preset = CANON_SHOOTING_PRESETS[presetId] ?? CANON_SHOOTING_PRESETS["obs_studio"]!;
      state.activePreset = preset.id;
      state.iso = preset.iso;
      state.shutterSpeed = preset.shutterSpeed;
      state.aperture = preset.aperture;
      state.exposureComp = preset.exposureComp;
      state.whiteBalance = preset.whiteBalance;
      state.meteringMode = preset.meteringMode;
      state.driveMode = preset.driveMode;
      state.softwareBrightness = preset.softwareBrightness;
      state.softwareContrast = preset.softwareContrast;
      state.lowLightBoost = preset.lowLightBoost;

      await runQueued(`Preset: ${preset.name}`, async (bindings) => {
        await bindings.ensureWifiPcControlUnlocked();
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.ISO, preset.iso, 4);
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.SHUTTER_SPEED, preset.shutterSpeed, 4);
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.APERTURE, preset.aperture, 4);
        await bindings.writePropertyUnlocked(
          CANON_EOS_PROPERTY.EXPOSURE_COMPENSATION,
          preset.exposureComp,
          4
        );
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.WHITE_BALANCE, preset.whiteBalance, 4);
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.METERING_MODE, preset.meteringMode, 4);
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.DRIVE_MODE, preset.driveMode, 4);
        await bindings.pollAndSyncEventsUnlocked();
        await bindings.unlockCameraUiUnlocked();
      });

      return preset;
    },

    async triggerShutterRelease(): Promise<void> {
      await runQueued("Remote Shutter Release (0x910F)", async (bindings) => {
        await bindings.ensureWifiPcControlUnlocked();
        await bindings.session.executeCameraCommand({
          operationCode: CANON_EOS_OPERATION.REMOTE_RELEASE,
          parameters: [],
          acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
        });
        await bindings.pumpLiveViewDuringActionUnlocked(250);
        await bindings.pollAndSyncEventsUnlocked();
        await bindings.unlockCameraUiUnlocked();
      });
    },

    async setMovieRecord(recording: boolean): Promise<void> {
      state.movieRecording = recording;
      await runQueued(`Movie Record: ${recording ? "START" : "STOP"}`, async (bindings) => {
        await bindings.ensureWifiPcControlUnlocked();
        await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.MOVIE_RECORD, recording ? 4 : 0, 4);
        await bindings.pollAndSyncEventsUnlocked();
        await bindings.unlockCameraUiUnlocked();
      });
    },

    async autoFocus(): Promise<void> {
      abortActiveAf = false;
      await runQueued("Auto Focus Lock (0x9154)", async (bindings) => {
        afInProgress = true;
        try {
          // Pure Wi-Fi PC EVF mode (0xD1B0 = 8) so EOS 4000D AF motor accepts remote AF
          await bindings.ensureWifiPcControlUnlocked();

          // 1. Start AF search (param 1 = EvfAf_ON)
          try {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [1],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          } catch {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          }

          // 2. Pump Live View frames while camera motor seeks focus (interruptible immediately via cancelAutoFocus)
          await bindings.pumpLiveViewDuringActionUnlocked(1600, () => abortActiveAf);

          // 3. Complete and disengage AF state (param 0 = EvfAf_OFF) at the exact current lens position
          try {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [0],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          } catch {
            // Ignore if camera firmware does not require explicit stop
          }

          if (abortActiveAf) {
            try {
              await bindings.session.executeCameraCommand({
                operationCode: CANON_EOS_OPERATION.CANCEL_AF,
                parameters: [],
                acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
              });
            } catch {
              // Ignore
            }
          }

          await bindings.pollAndSyncEventsUnlocked();
          await bindings.unlockCameraUiUnlocked();
        } finally {
          afInProgress = false;
          abortActiveAf = false;
        }
      });
    },

    async halfPressFocus(): Promise<void> {
      abortActiveAf = false;
      await runQueued("Quick Focus AF (0x9154)", async (bindings) => {
        afInProgress = true;
        try {
          await bindings.ensureWifiPcControlUnlocked();

          try {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [1],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          } catch {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          }

          await bindings.pumpLiveViewDuringActionUnlocked(1000, () => abortActiveAf);

          try {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [0],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          } catch {
            // Ignore
          }

          if (abortActiveAf) {
            try {
              await bindings.session.executeCameraCommand({
                operationCode: CANON_EOS_OPERATION.CANCEL_AF,
                parameters: [],
                acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
              });
            } catch {
              // Ignore
            }
          }

          await bindings.pollAndSyncEventsUnlocked();
          await bindings.unlockCameraUiUnlocked();
        } finally {
          afInProgress = false;
          abortActiveAf = false;
        }
      });
    },

    async cancelAutoFocus(): Promise<void> {
      // Immediately signal any active AF pump loop to freeze/stop on the very next frame (~16ms)
      abortActiveAf = true;
      if (afInProgress) {
        state.lastCommand = "Freeze / Lock Focus Here (0x9160)";
        state.lastCommandAt = new Date().toISOString();
        return;
      }
      await runQueued("Cancel / Freeze AF (0x9160)", async (bindings) => {
        try {
          await bindings.session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.DO_AF,
            parameters: [0],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
        } catch {
          // Ignore
        }
        try {
          await bindings.session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.CANCEL_AF,
            parameters: [],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
        } catch {
          // Ignore
        }
        await bindings.pollAndSyncEventsUnlocked();
        await bindings.unlockCameraUiUnlocked();
      });
    },

    async driveFocusLens(step: number, repeat = 1): Promise<void> {
      const validSteps = new Set<number>(Object.values(CANON_LENS_DRIVE_STEP));
      const driveStep = validSteps.has(step) ? step : CANON_LENS_DRIVE_STEP.NEAR_2;
      const pulses = Math.max(1, Math.min(6, Math.round(repeat)));

      await runQueued(
        `Drive Focus Lens (${driveStep > 0 ? "Near" : "Far"}) x${pulses}`,
        async (bindings) => {
          await bindings.ensureWifiPcControlUnlocked();

          // Clear any leftover AF busy state before driving lens
          try {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DO_AF,
              parameters: [0],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
          } catch {
            // Ignore
          }

          for (let i = 0; i < pulses; i += 1) {
            await bindings.session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.DRIVE_LENS,
              parameters: [driveStep],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
            await delay(25);
          }

          await bindings.pollAndSyncEventsUnlocked();
          await bindings.unlockCameraUiUnlocked();
        }
      );
    },

    async setLiveViewShutter(enabled: boolean): Promise<boolean> {
      state.evfActive = enabled;
      if (activeBindings !== null) {
        activeBindings.liveViewSource.setEvfActive(enabled);
      }
      outerSharedSource?.setPaused(!enabled && !state.cameraDisplayActive && state.streamMode === "sensor");

      await runQueued(
        `Web Live View Preview: ${enabled ? "ON (evf_on)" : "OFF (evf_off)"}`,
        async (bindings) => {
          await bindings.syncEvfOutputDeviceUnlocked();
          await bindings.unlockCameraUiUnlocked();
        }
      );

      return state.evfActive;
    },

    async toggleLiveViewShutter(): Promise<boolean> {
      return await controller.setLiveViewShutter(!state.evfActive);
    },

    async setCameraDisplay(enabled: boolean): Promise<boolean> {
      state.cameraDisplayActive = enabled;
      outerSharedSource?.setPaused(!state.evfActive && !enabled && state.streamMode === "sensor");

      await runQueued(
        `Camera LCD Display Preview: ${enabled ? "ON (TFT + Wi-Fi)" : "OFF (Wi-Fi Only)"}`,
        async (bindings) => {
          await bindings.syncEvfOutputDeviceUnlocked();
          if (enabled) {
            await bindings.unlockCameraUiUnlocked();
          }
        }
      );

      return state.cameraDisplayActive;
    },

    async toggleCameraDisplay(): Promise<boolean> {
      return await controller.setCameraDisplay(!state.cameraDisplayActive);
    },

    async setControlAuthority(mode: CanonControlAuthorityMode): Promise<CanonControlAuthorityMode> {
      state.controlAuthority = mode;
      if (mode === "camera_priority") {
        state.cameraDisplayActive = true;
        state.evfActive = false;
        if (activeBindings !== null) {
          activeBindings.liveViewSource.setEvfActive(false);
        }
        outerSharedSource?.setPaused(true);

        await runQueued("Control Mode: Camera Body Full Priority", async (bindings) => {
          await bindings.session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.CANCEL_AF,
            parameters: [],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
          await bindings.writePropertyUnlocked(
            CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE,
            CANON_EVF_OUTPUT.OFF,
            4
          );
          await bindings.writePropertyUnlocked(CANON_EOS_PROPERTY.EVF_MODE, 0, 2);
          await bindings.unlockCameraUiUnlocked();
          await bindings.session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.SET_REMOTE_MODE,
            parameters: [0],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
          await bindings.pollAndSyncEventsUnlocked();
        });
      } else {
        state.evfActive = true;
        state.cameraDisplayActive = true;
        if (activeBindings !== null) {
          activeBindings.liveViewSource.setEvfActive(true);
        }
        outerSharedSource?.setPaused(false);

        await runQueued("Control Mode: Web + Camera Dual Active", async (bindings) => {
          await bindings.session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.SET_REMOTE_MODE,
            parameters: [1],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
          await bindings.session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.SET_EVENT_MODE,
            parameters: [1],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
          await bindings.syncEvfOutputDeviceUnlocked();
          await bindings.unlockCameraUiUnlocked();
        });
      }

      return state.controlAuthority;
    },

    async unlockCameraButtons(): Promise<void> {
      state.cameraDisplayActive = true;
      await runQueued("Unlock Camera Physical Buttons & LCD (0x911C)", async (bindings) => {
        await bindings.session.executeCameraCommand({
          operationCode: CANON_EOS_OPERATION.CANCEL_AF,
          parameters: [],
          acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
        });
        await bindings.syncEvfOutputDeviceUnlocked();
        await bindings.unlockCameraUiUnlocked();
        await bindings.pollAndSyncEventsUnlocked();
      });
    },

    async setStreamMode(mode: CanonStreamMode): Promise<CanonStreamMode> {
      state.streamMode = mode;
      if (activeBindings !== null) {
        activeBindings.liveViewSource.setStreamMode(mode);
      }
      outerSharedSource?.setPaused(!state.evfActive && mode === "sensor");

      await runQueued(`Stream Mode: ${mode.toUpperCase()}`, async (bindings) => {
        await bindings.syncEvfOutputDeviceUnlocked();
      });

      return state.streamMode;
    },

    async captureScreenFrame(): Promise<Uint8Array | null> {
      return await runQueued("Capture Camera Screen / OSD (0x9153/0x9156)", async (bindings) => {
        const res = await bindings.requestScreenDataUnlocked();
        await bindings.pollAndSyncEventsUnlocked();
        if (res.responseCode === OK && res.bytes.byteLength > 0) {
          const jpeg = extractCanonEosScreenOrJpeg(res.bytes);
          if (jpeg !== null) {
            const frame = {
              bytes: jpeg,
              contentType: "image/jpeg" as const,
              capturedAt: new Date()
            };
            outerSharedSource?.pushFrame(frame);
            return jpeg;
          }
        }
        return outerSharedSource?.latestFrame()?.bytes ?? null;
      });
    },

    async pollEventsNow(): Promise<void> {
      await runQueued("Sync Camera Events (0x9116)", async (bindings) => {
        await bindings.pollAndSyncEventsUnlocked();
      });
    },

    setCameraHost(ip: string): void {
      const cleanIp = ip.trim();
      if (!cleanIp) return;
      options.host = cleanIp;
      state.lastCommand = `Target Camera IP set to ${cleanIp}`;
      state.lastCommandAt = new Date().toISOString();
      if (activeBindings !== null) {
        try {
          activeBindings.session.close();
        } catch {
          // Ignore
        }
      }
    }
  };

  const reconnecting = new ReconnectingFrameSource({
    retryDelayMs: options.retryDelayMs ?? 1_000,
    async connect() {
      return await connectCanonLiveViewWithRetry(options, state, outerSharedSource, (bindings) => {
        activeBindings = bindings;
      });
    }
  });
  const source = new SharedFrameSource(reconnecting);
  outerSharedSource = source;

  return {
    source,
    controller,
    close() {
      state.connected = false;
      source.close();
    }
  };
}

async function connectCanonLiveViewWithRetry(
  options: CanonLiveViewConnectionOptions,
  state: CanonCameraState,
  outerSharedSource: SharedFrameSource | null,
  onBindings: (bindings: ActiveSessionBindings | null) => void
): Promise<CanonLiveViewConnection> {
  const deadline = Date.now() + (options.connectTimeoutMs ?? 120_000);
  let lastError: unknown;

  do {
    if (
      options.localAddress !== undefined &&
      !isLocalAddressAvailable(options.localAddress)
    ) {
      lastError = new Error(`Local address ${options.localAddress} is not available`);
      await delay(options.retryDelayMs ?? 500);
      continue;
    }

    try {
      return await connectCanonLiveViewOnce(options, state, outerSharedSource, onBindings);
    } catch (error) {
      lastError = error;
      state.connected = false;
      state.lastError = error instanceof Error ? error.message : String(error);
      if (!isRetryableConnectionError(error) || Date.now() >= deadline) {
        throw error;
      }
      await delay(options.retryDelayMs ?? 500);
    }
  } while (Date.now() < deadline);

  throw lastError;
}

async function connectCanonLiveViewOnce(
  options: CanonLiveViewConnectionOptions,
  state: CanonCameraState,
  outerSharedSource: SharedFrameSource | null,
  onBindings: (bindings: ActiveSessionBindings | null) => void
): Promise<CanonLiveViewConnection> {
  const transportOptions = {
    host: options.host,
    port: options.port,
    timeoutMs: options.timeoutMs ?? 6_000,
    ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress })
  };
  const commandTransport = new MtpTransport(transportOptions);
  const eventTransport = new MtpTransport(transportOptions);

  try {
    console.log("Canon: opening command channel");
    const ack = await initializePtpIpTransport(commandTransport);
    const hwName = ack.cameraName.replace(/\0/g, "").trim();
    state.cameraName = hwName.length > 0 ? `Gaviru E400D Cam (${hwName})` : "Gaviru E400D Cam";
    console.log(`Canon: command channel accepted as ${state.cameraName}`);
    const eventChannel = new PtpIpEventChannel(eventTransport);
    await eventChannel.initialize(ack.connectionNumber);
    console.log("Canon: event channel accepted");

    const session = new MtpSession(commandTransport, {
      sessionId: ack.connectionNumber
    });
    await session.openSession();
    console.log("Canon: MTP session open");
    await session.getDeviceInfo();
    console.log("Canon: device info received");

    const bootstrap = new LiveViewBootstrap(session);
    await bootstrap.start();
    console.log("Canon: Live View initialized");
    await delay(500);

    let lockChain: Promise<void> = Promise.resolve();
    let waitingUserCommands = 0;

    async function withSessionLock<T>(task: () => Promise<T>, isUserCommand = true): Promise<T> {
      if (isUserCommand) {
        waitingUserCommands += 1;
      }
      let release!: () => void;
      const prev = lockChain;
      lockChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      try {
        return await task();
      } finally {
        if (isUserCommand) {
          waitingUserCommands = Math.max(0, waitingUserCommands - 1);
        }
        release();
      }
    }

    async function unlockCameraUiUnlocked(): Promise<void> {
      try {
        await session.executeCameraCommand({
          operationCode: CANON_EOS_OPERATION.RESET_UI_LOCK,
          parameters: [],
          acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
        });
      } catch {
        // Ignore if camera does not need explicit UI unlock
      }
    }

    async function pollAndSyncEventsUnlocked(): Promise<void> {
      const response = await session.executeCameraCommand({
        operationCode: CANON_EOS_OPERATION.GET_EVENT,
        parameters: [],
        acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
      });
      if (response.responseCode === OK && response.bytes.byteLength >= 8) {
        try {
          const events = parseCanonEosPropertyEvents(response.bytes);
          for (const ev of events) {
            const hexKey = `0x${ev.propertyCode.toString(16)}`;
            if (ev.type === CANON_EOS_EVENT.VALUE_CHANGED) {
              state.properties[hexKey] = ev.value;
              switch (ev.propertyCode) {
                case CANON_EOS_PROPERTY.ISO:
                  state.iso = ev.value;
                  break;
                case CANON_EOS_PROPERTY.SHUTTER_SPEED:
                  state.shutterSpeed = ev.value;
                  break;
                case CANON_EOS_PROPERTY.APERTURE:
                  state.aperture = ev.value;
                  break;
                case CANON_EOS_PROPERTY.EXPOSURE_COMPENSATION:
                  state.exposureComp = ev.value;
                  break;
                case CANON_EOS_PROPERTY.FLASH_EXPOSURE_COMPENSATION:
                  state.flashExposureComp = ev.value;
                  break;
                case CANON_EOS_PROPERTY.FLASH_FIRING:
                  state.flashFiring = ev.value !== 0;
                  break;
                case CANON_EOS_PROPERTY.WHITE_BALANCE:
                  state.whiteBalance = ev.value;
                  break;
                case CANON_EOS_PROPERTY.METERING_MODE:
                  state.meteringMode = ev.value;
                  break;
                case CANON_EOS_PROPERTY.DRIVE_MODE:
                  state.driveMode = ev.value;
                  break;
                case CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE:
                  // Keep state.properties["0xd1b0"] updated without overwriting user's desired state.cameraDisplayActive
                  break;
                case CANON_EOS_PROPERTY.MOVIE_RECORD:
                  state.movieRecording = ev.value === 4;
                  break;
              }
            } else if (ev.type === CANON_EOS_EVENT.ALLOWED_VALUES_CHANGED) {
              state.allowedValues[hexKey] = ev.values;
            }
          }
        } catch {
          // Ignore non-standard event records while keeping session alive
        }
      }
    }

    async function writePropertyUnlocked(
      propertyCode: number,
      value: number,
      byteLength: CanonEosPropertyValueByteLength = 4
    ): Promise<void> {
      const payload = createCanonEosPropertyPayload(propertyCode, value, byteLength);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = await session.executeHostDataCommand({
          operationCode: CANON_EOS_OPERATION.SET_DEVICE_PROP_VALUE_EX,
          bytes: payload,
          acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
        });
        if (code === OK) {
          state.properties[`0x${propertyCode.toString(16)}`] = value;
          return;
        }
        if (code !== DEVICE_BUSY && code !== NOT_READY) {
          return;
        }
        await pollAndSyncEventsUnlocked();
        await delay(25);
      }
    }

    /**
     * Ensures the camera is in pure Wi-Fi PC EVF mode (0xD1B1 = 1, 0xD1B0 = 8) before
     * executing remote property/focus commands so the EOS 4000D never blocks them due to TFT LCD lock.
     */
    async function ensureWifiPcControlUnlocked(): Promise<void> {
      if (state.controlAuthority === "camera_priority") {
        state.controlAuthority = "dual";
        await session.executeCameraCommand({
          operationCode: CANON_EOS_OPERATION.SET_REMOTE_MODE,
          parameters: [1],
          acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
        });
        await session.executeCameraCommand({
          operationCode: CANON_EOS_OPERATION.SET_EVENT_MODE,
          parameters: [1],
          acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
        });
      }
      if (!state.evfActive) {
        state.evfActive = true;
        liveViewSource.setEvfActive(true);
        outerSharedSource?.setPaused(false);
        await writePropertyUnlocked(CANON_EOS_PROPERTY.EVF_MODE, 1, 2);
      }
      const currentEvfOut = state.properties["0xd1b0"] ?? -1;
      if (currentEvfOut !== CANON_EVF_OUTPUT.WIFI_PC) {
        await writePropertyUnlocked(
          CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE,
          CANON_EVF_OUTPUT.WIFI_PC,
          4
        );
        await pollAndSyncEventsUnlocked();
        await delay(35);
      }
    }

    async function syncEvfOutputDeviceUnlocked(): Promise<void> {
      const wantAnyEvf = state.evfActive || state.cameraDisplayActive || state.streamMode === "screen";
      if (!wantAnyEvf) {
        await writePropertyUnlocked(CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE, CANON_EVF_OUTPUT.OFF, 4);
        await writePropertyUnlocked(CANON_EOS_PROPERTY.EVF_MODE, 0, 2);
        await pollAndSyncEventsUnlocked();
        return;
      }

      await writePropertyUnlocked(CANON_EOS_PROPERTY.EVF_MODE, 1, 2);

      let outputMask = 0;
      if (state.evfActive || state.streamMode === "screen") {
        outputMask |= CANON_EVF_OUTPUT.WIFI_PC;
      }
      if (state.cameraDisplayActive) {
        outputMask |= CANON_EVF_OUTPUT.TFT_LCD;
      }

      await writePropertyUnlocked(CANON_EOS_PROPERTY.EVF_OUTPUT_DEVICE, outputMask, 4);
      await pollAndSyncEventsUnlocked();
    }

    async function pumpLiveViewDuringActionUnlocked(
      durationMs: number,
      shouldAbort?: () => boolean
    ): Promise<void> {
      const end = Date.now() + durationMs;
      let tick = 0;
      while (Date.now() < end && !(shouldAbort?.())) {
        if (tick % 4 === 0) {
          await pollAndSyncEventsUnlocked();
        }
        tick += 1;
        if (shouldAbort?.()) break;
        if (state.evfActive) {
          try {
            const vf = await session.executeCameraCommand({
              operationCode: CANON_EOS_OPERATION.GET_VIEWFINDER_DATA,
              parameters: [0x00200000, 1, 0],
              acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
            });
            if (vf.responseCode === OK && vf.bytes.byteLength > 0) {
              const jpeg = extractCanonEosJpeg(vf.bytes);
              const frame = {
                bytes: jpeg,
                contentType: "image/jpeg" as const,
                capturedAt: new Date()
              };
              outerSharedSource?.pushFrame(frame);
            }
          } catch {
            // Ignore transient busy frame during AF
          }
        }
        if (shouldAbort?.()) break;
        await delay(16);
      }
    }

    async function requestScreenDataUnlocked(): Promise<ViewfinderResponse> {
      await pollAndSyncEventsUnlocked();

      const vfOsd = await session.executeCameraCommand({
        operationCode: CANON_EOS_OPERATION.GET_VIEWFINDER_DATA,
        parameters: [0x00200000, 1, 0],
        acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
      });
      if (vfOsd.responseCode === OK && vfOsd.bytes.byteLength > 0) {
        return vfOsd;
      }

      const screenOsd = await session.executeCameraCommand({
        operationCode: CANON_EOS_OPERATION.GET_VIEWFINDER_OSD,
        parameters: [0x00200000],
        acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
      });
      if (screenOsd.responseCode === OK && screenOsd.bytes.byteLength > 0) {
        return screenOsd;
      }

      return await session.executeCameraCommand({
        operationCode: CANON_EOS_OPERATION.GET_THUMBNAIL_EX,
        parameters: [0x00000001],
        acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
      });
    }

    state.properties["0xd1b1"] = 1;
    state.properties["0xd1b0"] = CANON_EVF_OUTPUT.WIFI_PC;
    await pollAndSyncEventsUnlocked();
    if (state.cameraDisplayActive) {
      await syncEvfOutputDeviceUnlocked();
    }
    await unlockCameraUiUnlocked();

    let lastEventPollTime = 0;
    const liveViewSource = new CanonLiveViewFrameSource({
      async pollEvents() {
        if (waitingUserCommands > 0) {
          await delay(6);
          return;
        }
        const nowMs = Date.now();
        if (nowMs - lastEventPollTime < 450) {
          return;
        }
        lastEventPollTime = nowMs;
        await withSessionLock(async () => {
          await pollAndSyncEventsUnlocked();
          await unlockCameraUiUnlocked();
        }, false);
      },
      async getViewfinderData() {
        if (waitingUserCommands > 0) {
          await delay(6);
        }
        return await withSessionLock(async () => {
          return await session.executeCameraCommand({
            operationCode: CANON_EOS_OPERATION.GET_VIEWFINDER_DATA,
            parameters: [0x00200000, 1, 0],
            acceptedResponseCodes: ACCEPTED_EVENT_RESPONSE_CODES
          });
        }, false);
      },
      async getScreenData() {
        if (waitingUserCommands > 0) {
          await delay(6);
        }
        return await withSessionLock(async () => {
          return await requestScreenDataUnlocked();
        }, false);
      },
      isEvfActive: () => state.evfActive,
      getStreamMode: () => state.streamMode,
      tolerateTransientErrors: true,
      retryDelayMs: 4
    });
    liveViewSource.setEvfActive(state.evfActive);
    liveViewSource.setStreamMode(state.streamMode);

    state.connected = true;
    state.lastError = null;

    onBindings({
      session,
      bootstrap,
      liveViewSource,
      withSessionLock: (task) => withSessionLock(task, true),
      ensureWifiPcControlUnlocked,
      pollAndSyncEventsUnlocked,
      pumpLiveViewDuringActionUnlocked,
      writePropertyUnlocked,
      unlockCameraUiUnlocked,
      syncEvfOutputDeviceUnlocked,
      requestScreenDataUnlocked
    });

    return {
      source: liveViewSource,
      close() {
        state.connected = false;
        onBindings(null);
        eventChannel.close();
        session.close();
      }
    };
  } catch (error) {
    state.connected = false;
    onBindings(null);
    eventTransport.close();
    commandTransport.close();
    throw error;
  }
}

function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";
  return (
    code === "ECONNABORTED" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    error.message.startsWith("Timed out after ") ||
    error.message.startsWith("MTP transport closed")
  );
}

function isLocalAddressAvailable(address: string): boolean {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some((entry) => entry.family === "IPv4" && entry.address === address);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
