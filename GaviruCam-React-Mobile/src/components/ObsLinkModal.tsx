import React, { useState } from 'react';

interface ObsLinkModalProps {
  roomName: string;
  onClose: () => void;
}

export const ObsLinkModal: React.FC<ObsLinkModalProps> = ({ roomName, onClose }) => {
  const [copied, setCopied] = useState<boolean>(false);

  const obsViewUrl = `https://vdo.ninja/?view=${encodeURIComponent(
    roomName
  )}&cleanoutput&scale=100`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(obsViewUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px'
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: '100%', maxWidth: '420px', border: '1px solid #ef4444' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-title">
          <span>🎬 OBS Studio Browser Source Link</span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '18px',
              cursor: 'pointer'
            }}
          >
            ✕
          </button>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          මෙම ලින්ක් එක OBS Studio හි <strong>Browser Source</strong> එකට ඇතුළත් කළ විට, ඔබගේ Mobile Phone Camera එකෙන් එන 4K/1080p සජීවී වීඩියෝව OBS Studio එකට ලැබේ:
        </p>

        <div className="code-box">
          <span style={{ fontSize: '11px' }}>{obsViewUrl}</span>
        </div>

        <button
          className={`btn ${copied ? 'btn-accent' : 'btn-primary'}`}
          onClick={copyToClipboard}
        >
          {copied ? '✅ Copied to Clipboard!' : '📋 Copy OBS Link'}
        </button>

        <div style={{ textAlign: 'center', marginTop: '6px' }}>
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(
              obsViewUrl
            )}`}
            alt="OBS Link QR Code"
            style={{ width: '140px', height: '140px', borderRadius: '8px', border: '1px solid var(--border)' }}
          />
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Scan with another device or OBS PC
          </p>
        </div>

        <button className="btn btn-secondary" onClick={onClose} style={{ marginTop: '4px' }}>
          Close
        </button>
      </div>
    </div>
  );
};
