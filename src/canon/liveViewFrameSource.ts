import { extractCanonEosJpeg, extractCanonEosScreenOrJpeg } from "./canonEos";
import type { FrameSource, VideoFrame } from "./frameSource";

const OK = 0x2001;
const RETRYABLE_RESPONSE_CODES = new Set([0xa102, 0x2019]);

export type CanonStreamMode = "sensor" | "screen";

export interface ViewfinderResponse {
  responseCode: number;
  bytes: Uint8Array;
}

export interface CanonLiveViewFrameSourceOptions {
  pollEvents(): Promise<void>;
  getViewfinderData(): Promise<ViewfinderResponse>;
  getScreenData?: () => Promise<ViewfinderResponse>;
  executeQueuedCommands?: () => Promise<void>;
  isEvfActive?: () => boolean;
  getStreamMode?: () => CanonStreamMode;
  tolerateTransientErrors?: boolean;
  retryDelayMs?: number;
  now?: () => Date;
}

interface QueuedCommandItem<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class CanonLiveViewFrameSource implements FrameSource {
  private currentFrame: VideoFrame | null = null;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly commandQueue: Array<QueuedCommandItem<unknown>> = [];
  private isDrainingQueue = false;
  private evfActive = true;
  private streamMode: CanonStreamMode = "sensor";
  private idleTickCounter = 0;

  constructor(private readonly options: CanonLiveViewFrameSourceOptions) {
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  latestFrame(): VideoFrame | null {
    return this.currentFrame;
  }

  setEvfActive(active: boolean): void {
    this.evfActive = active;
  }

  isEvfEnabled(): boolean {
    return this.options.isEvfActive ? this.options.isEvfActive() : this.evfActive;
  }

  setStreamMode(mode: CanonStreamMode): void {
    this.streamMode = mode;
  }

  currentStreamMode(): CanonStreamMode {
    return this.options.getStreamMode ? this.options.getStreamMode() : this.streamMode;
  }

  enqueueCommand<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.commandQueue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      });
    });
  }

  async drainCommandQueue(): Promise<void> {
    if (this.isDrainingQueue) {
      return;
    }
    this.isDrainingQueue = true;
    try {
      while (this.commandQueue.length > 0) {
        const item = this.commandQueue.shift();
        if (item === undefined) {
          break;
        }
        try {
          const result = await item.task();
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
      if (this.options.executeQueuedCommands !== undefined) {
        await this.options.executeQueuedCommands();
      }
    } finally {
      this.isDrainingQueue = false;
    }
  }

  async *frames(signal: AbortSignal): AsyncIterable<VideoFrame> {
    while (!signal.aborted) {
      await this.drainCommandQueue();
      if (signal.aborted) {
        return;
      }

      const mode = this.currentStreamMode();
      const evfOn = this.isEvfEnabled();

      // If EVF shutter is turned OFF and we are in sensor mode, keep session alive and process commands
      if (!evfOn && mode === "sensor") {
        this.idleTickCounter += 1;
        if (this.idleTickCounter % 8 === 0) {
          try {
            await this.options.pollEvents();
          } catch {
            // Ignore transient event poll errors while mirror is down
          }
        }
        if (!(await waitForRetry(Math.max(40, this.retryDelayMs), signal))) {
          return;
        }
        continue;
      }

      const response =
        mode === "screen" && this.options.getScreenData !== undefined
          ? await this.options.getScreenData()
          : await this.options.getViewfinderData();

      if (signal.aborted) {
        return;
      }

      await this.drainCommandQueue();

      if (RETRYABLE_RESPONSE_CODES.has(response.responseCode)) {
        await this.options.pollEvents();
        if (!(await waitForRetry(this.retryDelayMs, signal))) {
          return;
        }
        continue;
      }

      if (response.responseCode !== OK) {
        if (
          this.options.tolerateTransientErrors === true ||
          mode === "screen" ||
          !this.isEvfEnabled()
        ) {
          try {
            await this.options.pollEvents();
          } catch {
            // Ignore transient poll error
          }
          if (!(await waitForRetry(Math.max(45, this.retryDelayMs), signal))) {
            return;
          }
          continue;
        }
        throw new Error(
          `Unexpected Canon viewfinder response code: 0x${response.responseCode.toString(16)}`
        );
      }

      const bytes =
        mode === "screen"
          ? tryExtractScreenOrJpeg(response.bytes)
          : tryExtractJpeg(response.bytes);
      if (bytes === null) {
        if (mode === "screen") {
          if (!(await waitForRetry(Math.max(50, this.retryDelayMs), signal))) {
            return;
          }
        }
        continue;
      }

      const frame: VideoFrame = {
        bytes,
        contentType: "image/jpeg",
        capturedAt: this.now()
      };
      this.currentFrame = frame;
      this.idleTickCounter += 1;
      if (this.idleTickCounter % 12 === 0) {
        try {
          await this.options.pollEvents();
        } catch {
          // Ignore transient event sync error during streaming
        }
      }
      yield frame;
    }
  }
}

function tryExtractJpeg(bytes: Uint8Array): Uint8Array | null {
  try {
    return extractCanonEosJpeg(bytes);
  } catch {
    return null;
  }
}

function tryExtractScreenOrJpeg(bytes: Uint8Array): Uint8Array | null {
  return extractCanonEosScreenOrJpeg(bytes);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }

  if (delayMs <= 0) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timeout);
      resolve(false);
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
