import type { FrameSource, FrameSourceStats, VideoFrame } from "./frameSource";

interface Subscriber {
  latest: VideoFrame | null;
  resolve: ((frame: VideoFrame | null) => void) | null;
}

export class SharedFrameSource implements FrameSource {
  private readonly abortController = new AbortController();
  private readonly subscribers = new Set<Subscriber>();
  private readonly now: () => number;
  private readonly stalledAfterMs: number;
  private readonly frameTimes: number[] = [];
  private currentFrame: VideoFrame | null = null;
  private failure: unknown = null;
  private stopped = false;
  private paused = false;
  private totalBytes = 0;
  private totalFrames = 0;
  private width: number | null = null;
  private height: number | null = null;

  constructor(
    private readonly upstream: FrameSource,
    options: { now?: () => number; stalledAfterMs?: number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.stalledAfterMs = options.stalledAfterMs ?? 2_000;
    void this.capture();
  }

  latestFrame(): VideoFrame | null {
    return this.currentFrame;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pushFrame(frame: VideoFrame): void {
    this.currentFrame = frame;
    this.recordFrame(frame);
    this.notifySubscribers(frame);
  }

  async *frames(signal: AbortSignal): AsyncIterable<VideoFrame> {
    const subscriber: Subscriber = {
      latest: this.currentFrame,
      resolve: null
    };
    this.subscribers.add(subscriber);

    try {
      while (!signal.aborted && !this.abortController.signal.aborted) {
        if (this.failure !== null) {
          throw this.failure;
        }

        const frame = subscriber.latest ?? await waitForFrame(subscriber, signal);
        subscriber.latest = null;
        if (frame === null) {
          return;
        }
        yield frame;
      }
    } finally {
      this.subscribers.delete(subscriber);
    }
  }

  close(): void {
    this.stopped = true;
    this.abortController.abort();
    this.notifySubscribers(null);
  }

  stats(): FrameSourceStats {
    const lastFrameAt = this.currentFrame?.capturedAt ?? null;
    return {
      status: this.status(),
      totalFrames: this.totalFrames,
      averageFrameBytes: this.totalFrames === 0 ? 0 : Math.round(this.totalBytes / this.totalFrames),
      fps: this.currentFps(),
      width: this.width,
      height: this.height,
      lastFrameAt,
      error: this.failure instanceof Error ? this.failure.message : this.failure === null ? null : String(this.failure)
    };
  }

  private async capture(): Promise<void> {
    try {
      for await (const frame of this.upstream.frames(this.abortController.signal)) {
        this.currentFrame = frame;
        this.recordFrame(frame);
        this.notifySubscribers(frame);
      }
    } catch (error) {
      this.failure = error;
      this.notifySubscribers(null);
    }
  }

  private recordFrame(frame: VideoFrame): void {
    this.totalFrames += 1;
    this.totalBytes += frame.bytes.byteLength;
    const dimensions = readJpegDimensions(frame.bytes);
    this.width = dimensions?.width ?? this.width;
    this.height = dimensions?.height ?? this.height;

    const now = this.now();
    this.frameTimes.push(now);
    const cutoff = now - 5_000;
    while (this.frameTimes.length > 0 && (this.frameTimes[0] ?? now) < cutoff) {
      this.frameTimes.shift();
    }
  }

  private status(): FrameSourceStats["status"] {
    if (this.failure !== null) {
      return "failed";
    }
    if (this.stopped || this.paused) {
      return "stopped";
    }
    if (this.currentFrame === null) {
      return "starting";
    }
    if (this.now() - this.currentFrame.capturedAt.getTime() > this.stalledAfterMs) {
      return "stalled";
    }
    return "streaming";
  }

  private currentFps(): number {
    if (this.paused || this.frameTimes.length < 2) {
      return 0;
    }
    const first = this.frameTimes[0] ?? 0;
    const last = this.frameTimes[this.frameTimes.length - 1] ?? first;
    const seconds = (last - first) / 1_000;
    if (seconds <= 0) {
      return 0;
    }
    return Number(((this.frameTimes.length - 1) / seconds).toFixed(1));
  }

  private notifySubscribers(frame: VideoFrame | null): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.resolve !== null) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve(frame);
      } else {
        subscriber.latest = frame;
      }
    }
  }
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > bytes.byteLength) {
      return null;
    }

    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
      };
    }

    offset += 2 + length;
  }
  return null;
}

async function waitForFrame(
  subscriber: Subscriber,
  signal: AbortSignal
): Promise<VideoFrame | null> {
  return await new Promise<VideoFrame | null>((resolve) => {
    const onAbort = (): void => {
      subscriber.resolve = null;
      resolve(null);
    };
    subscriber.resolve = (frame) => {
      signal.removeEventListener("abort", onAbort);
      resolve(frame);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
