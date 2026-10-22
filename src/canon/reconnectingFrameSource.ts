import type { FrameSource, VideoFrame } from "./frameSource";

export interface ReconnectableFrameSource {
  source: FrameSource;
  close(): void;
}

export interface ReconnectingFrameSourceOptions {
  connect(): Promise<ReconnectableFrameSource>;
  retryDelayMs?: number;
}

export class ReconnectingFrameSource implements FrameSource {
  private current: VideoFrame | null = null;

  constructor(private readonly options: ReconnectingFrameSourceOptions) {}

  latestFrame(): VideoFrame | null {
    return this.current;
  }

  async *frames(signal: AbortSignal): AsyncIterable<VideoFrame> {
    while (!signal.aborted) {
      let connection: ReconnectableFrameSource | null = null;
      try {
        connection = await this.options.connect();
        for await (const frame of connection.source.frames(signal)) {
          this.current = frame;
          yield frame;
        }
      } catch {
        if (signal.aborted) {
          return;
        }
      } finally {
        connection?.close();
      }

      if (!(await waitForRetry(this.options.retryDelayMs ?? 1_000, signal))) {
        return;
      }
    }
  }
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
