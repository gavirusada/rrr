export type StreamResolution = '4k' | '1080p' | '720p';
export type AspectRatio = '16:9' | '9:16';
export type CameraSourceType = 'external' | 'phone_back' | 'phone_front';

export interface BroadcastConfig {
  roomName: string;
  resolution: StreamResolution;
  aspectRatio: AspectRatio;
  videoBitrate: number; // kbps
  audioBitrate: number; // kbps
  frameRate: number;
  cameraSource: CameraSourceType;
  audioEnabled: boolean;
  torchEnabled: boolean;
  lowLightBoost: boolean;
}

export interface StreamStats {
  isBroadcasting: boolean;
  activeResolution: string;
  fps: number;
  kbps: number;
  streamDurationSec: number;
  viewersCount: number;
}
