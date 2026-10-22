import React, { useEffect, useRef, useState } from 'react';
import { BroadcastConfig, StreamStats } from '../types';

interface BroadcasterProps {
  config: BroadcastConfig;
  onUpdateConfig: (partial: Partial<BroadcastConfig>) => void;
  onOpenObsLink: () => void;
}

export const Broadcaster: React.FC<BroadcasterProps> = ({
  config,
  onUpdateConfig,
  onOpenObsLink
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<any>(null);

  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [isBroadcasting, setIsBroadcasting] = useState<boolean>(false);
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [stats, setStats] = useState<StreamStats>({
    isBroadcasting: false,
    activeResolution: '1920x1080',
    fps: 0,
    kbps: 0,
    streamDurationSec: 0,
    viewersCount: 0
  });

  // Acquire Screen WakeLock so mobile phone doesn't sleep during stream
  useEffect(() => {
    async function requestWakeLock() {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('WakeLock failed:', err);
      }
    }
    requestWakeLock();
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
      }
    };
  }, []);

  // Enumerate Cameras (supports external USB OTG cameras and built-in cams)
  useEffect(() => {
    async function loadDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');
        setAvailableCameras(videoInputs);
        if (videoInputs.length > 0 && !selectedCameraId) {
          // If there's an external camera or back camera, prefer it
          const external = videoInputs.find(
            (d) => d.label.toLowerCase().includes('usb') ||
                   d.label.toLowerCase().includes('cam') ||
                   d.label.toLowerCase().includes('capture') ||
                   d.label.toLowerCase().includes('uvc')
          );
          setSelectedCameraId(external ? external.deviceId : videoInputs[0].deviceId);
        }
      } catch (e) {
        console.warn('Failed to enumerate devices:', e);
      }
    }
    loadDevices();
    navigator.mediaDevices?.addEventListener('devicechange', loadDevices);
  }, [selectedCameraId]);

  // Start local camera stream
  const startCamera = async (deviceIdOverride?: string) => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      const targetW = config.resolution === '4k' ? 3840 : config.resolution === '1080p' ? 1920 : 1280;
      const targetH = config.resolution === '4k' ? 2160 : config.resolution === '1080p' ? 1080 : 720;

      const constraints: MediaStreamConstraints = {
        video: {
          deviceId: (deviceIdOverride || selectedCameraId) ? { exact: deviceIdOverride || selectedCameraId } : undefined,
          width: { ideal: config.aspectRatio === '9:16' ? targetH : targetW },
          height: { ideal: config.aspectRatio === '9:16' ? targetW : targetH },
          frameRate: { ideal: config.frameRate, max: 60 }
        },
        audio: config.audioEnabled
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              sampleRate: 48000
            }
          : false
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      if (settings?.width && settings?.height) {
        setStats((prev) => ({
          ...prev,
          activeResolution: `${settings.width}x${settings.height}`,
          fps: settings.frameRate ? Math.round(settings.frameRate) : config.frameRate
        }));
      }
    } catch (err: any) {
      console.error('Camera stream error:', err);
      // Fallback without deviceId
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: config.audioEnabled
        });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCameraActive(true);
      } catch (fallbackErr) {
        alert('කැමරාව ආරම්භ කිරීමට නොහැකි විය: ' + (err.message || err));
      }
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [config.resolution, config.aspectRatio, config.frameRate, config.audioEnabled]);

  const toggleBroadcasting = () => {
    if (!isBroadcasting) {
      setIsBroadcasting(true);
      setStats((prev) => ({ ...prev, isBroadcasting: true, streamDurationSec: 0 }));
    } else {
      setIsBroadcasting(false);
      setStats((prev) => ({ ...prev, isBroadcasting: false }));
    }
  };

  // Build the complete VDO.Ninja mobile push URL
  const vdoPushUrl = `https://vdo.ninja/?push=${encodeURIComponent(
    config.roomName
  )}&webcam&autostart&videobitrate=${config.videoBitrate}&audiobitrate=${
    config.audioBitrate
  }&scale=100&quality=0&fps=${config.frameRate}`;

  return (
    <div>
      {/* Live Video Viewport */}
      <div className={`preview-wrap ${config.aspectRatio === '9:16' ? 'portrait' : ''}`}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="preview-video"
        />

        {!cameraActive && (
          <div className="preview-placeholder">
            <span style={{ fontSize: '32px' }}>📷</span>
            <p style={{ fontSize: '13px', fontWeight: 600 }}>කැමරාව සක්‍රිය කරමින්...</p>
            <button className="btn btn-secondary" onClick={() => startCamera()}>
              කැමරාව Connect කරන්න
            </button>
          </div>
        )}

        {/* Live On-Screen HUD Overlay */}
        <div className="live-hud">
          <div className="hud-pill" style={{ color: isBroadcasting ? '#fca5a5' : '#6ee7b7' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: isBroadcasting ? '#ef4444' : '#10b981'
              }}
            />
            {isBroadcasting ? 'VDO LIVE 4K' : 'STANDBY'}
          </div>

          <div className="hud-pill" style={{ color: '#fde68a' }}>
            <span>{stats.activeResolution}</span>
            <span style={{ color: 'var(--text-muted)' }}>•</span>
            <span>{stats.fps || config.frameRate} FPS</span>
          </div>
        </div>
      </div>

      {/* Main Broadcast Controls */}
      <div className="content-body">
        {/* Action Button */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className={`btn ${isBroadcasting ? 'btn-stop' : 'btn-primary'}`}
            style={{ flex: 1.4, fontSize: '14.5px', padding: '14px' }}
            onClick={toggleBroadcasting}
          >
            {isBroadcasting ? '⏹ Stop Live Broadcast' : '🚀 Start VDO.Ninja Broadcast'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ flex: 0.8 }}
            onClick={onOpenObsLink}
            title="Get OBS Studio Browser Source Link"
          >
            📋 OBS Link
          </button>
        </div>

        {/* Hidden VDO.Ninja WebRTC Engine Frame when Broadcasting */}
        {isBroadcasting && (
          <div className="card" style={{ border: '1px solid #ef4444', background: '#130c14' }}>
            <div className="card-title" style={{ color: '#fca5a5' }}>
              <span>📡 WebRTC Live Push Active</span>
              <span style={{ fontSize: '11px', color: '#6ee7b7' }}>Direct to OBS Studio</span>
            </div>
            <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: '1.45' }}>
              ඔබගේ Mobile Phone එකෙන් වීඩියෝව VDO.Ninja මඟින් ලෝකයේ ඕනෑම තැනක OBS එකට සජීවීව 4K Quality එකෙන් Push වෙමින් පවතී.
            </p>
            <iframe
              src={vdoPushUrl}
              allow="camera; microphone; display-capture; autoplay"
              style={{
                width: '100%',
                height: '110px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                background: '#000'
              }}
              title="VDO.Ninja Broadcaster"
            />
          </div>
        )}

        {/* Camera Source Selector */}
        <div className="card">
          <div className="card-title">
            <span>📷 Camera Source (කැමරාව තෝරන්න)</span>
            <span style={{ fontSize: '11px', color: '#38bdf8' }}>
              {availableCameras.length} Camera(s) Detected
            </span>
          </div>

          <div className="control-row">
            <select
              className="input-field"
              value={selectedCameraId}
              onChange={(e) => {
                setSelectedCameraId(e.target.value);
                startCamera(e.target.value);
              }}
            >
              {availableCameras.map((cam, idx) => (
                <option key={cam.deviceId || idx} value={cam.deviceId}>
                  {cam.label || `Camera ${idx + 1} (${cam.deviceId.slice(0, 8)}...)`}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button
              className="btn btn-secondary"
              style={{ flex: 1, padding: '8px', fontSize: '11.5px' }}
              onClick={() => startCamera()}
            >
              🔄 Refresh Camera
            </button>
            <button
              className="btn btn-secondary"
              style={{ flex: 1, padding: '8px', fontSize: '11.5px' }}
              onClick={() => onUpdateConfig({ audioEnabled: !config.audioEnabled })}
            >
              {config.audioEnabled ? '🔊 Mic: ON' : '🔇 Mic: MUTED'}
            </button>
          </div>
        </div>

        {/* Quality & Resolution Settings */}
        <div className="card">
          <div className="card-title">
            <span>⚡ Broadcast Resolution & Aspect Ratio</span>
          </div>

          <div className="control-row">
            <div className="control-label">
              <span>Stream Resolution:</span>
              <span style={{ color: '#fde68a' }}>{config.resolution.toUpperCase()} Ultra</span>
            </div>
            <div className="pill-group">
              {(['4k', '1080p', '720p'] as const).map((res) => (
                <div
                  key={res}
                  className={`pill-option ${config.resolution === res ? 'active' : ''}`}
                  onClick={() => onUpdateConfig({ resolution: res })}
                >
                  {res.toUpperCase()}
                </div>
              ))}
            </div>
          </div>

          <div className="control-row" style={{ marginTop: '6px' }}>
            <div className="control-label">
              <span>Aspect Ratio (Screen Mode):</span>
              <span style={{ color: '#6ee7b7' }}>
                {config.aspectRatio === '16:9' ? '16:9 Landscape (OBS / YouTube)' : '9:16 Portrait (TikTok / Shorts)'}
              </span>
            </div>
            <div className="pill-group">
              <div
                className={`pill-option ${config.aspectRatio === '16:9' ? 'active' : ''}`}
                onClick={() => onUpdateConfig({ aspectRatio: '16:9' })}
              >
                16:9 Landscape
              </div>
              <div
                className={`pill-option ${config.aspectRatio === '9:16' ? 'active' : ''}`}
                onClick={() => onUpdateConfig({ aspectRatio: '9:16' })}
              >
                9:16 Vertical Shorts
              </div>
            </div>
          </div>

          <div className="control-row" style={{ marginTop: '8px' }}>
            <div className="control-label">
              <span>Bitrate (Speed/Quality):</span>
              <span style={{ color: '#fde68a' }}>{config.videoBitrate} kbps</span>
            </div>
            <input
              type="range"
              min="2000"
              max="25000"
              step="1000"
              value={config.videoBitrate}
              onChange={(e) => onUpdateConfig({ videoBitrate: Number(e.target.value) })}
              style={{ width: '100%', accentColor: '#ef4444' }}
            />
          </div>
        </div>

        {/* VDO.Ninja Room Settings */}
        <div className="card">
          <div className="card-title">
            <span>🥷 VDO.Ninja Room Name</span>
          </div>
          <div className="control-row">
            <input
              type="text"
              className="input-field"
              value={config.roomName}
              onChange={(e) => onUpdateConfig({ roomName: e.target.value.trim() || 'gaviru-cam-pro' })}
              placeholder="e.g. gaviru-cam-pro"
            />
            <small style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px' }}>
              මෙම Room Name එක OBS Studio Browser Source එකෙහි ද යොදාගනු ලැබේ.
            </small>
          </div>
        </div>
      </div>
    </div>
  );
};
