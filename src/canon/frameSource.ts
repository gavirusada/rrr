export interface VideoFrame {
  bytes: Uint8Array;
  contentType: "image/jpeg";
  capturedAt: Date;
}

export interface FrameSource {
  latestFrame(): VideoFrame | null;
  frames(signal: AbortSignal): AsyncIterable<VideoFrame>;
}

export interface FrameSourceStats {
  status: "starting" | "streaming" | "stalled" | "failed" | "stopped";
  totalFrames: number;
  averageFrameBytes: number;
  fps: number;
  width: number | null;
  height: number | null;
  lastFrameAt: Date | null;
  error: string | null;
}
