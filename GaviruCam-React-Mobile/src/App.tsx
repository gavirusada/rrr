import React, { useEffect, useState } from 'react';
import { Broadcaster } from './components/Broadcaster';
import { CanonWifiGuide } from './components/CanonWifiGuide';
import { ObsLinkModal } from './components/ObsLinkModal';
import { BroadcastConfig } from './types';
import './styles.css';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'broadcast' | 'guide'>('broadcast');
  const [showObsModal, setShowObsModal] = useState<boolean>(false);
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  const [config, setConfig] = useState<BroadcastConfig>({
    roomName: 'gaviru-cam-pro',
    resolution: '1080p',
    aspectRatio: '16:9',
    videoBitrate: 8000,
    audioBitrate: 192,
    frameRate: 60,
    cameraSource: 'external',
    audioEnabled: true,
    torchEnabled: false,
    lowLightBoost: false
  });

  // Listen for PWA Install Prompt (Android Chrome / Samsung Internet)
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallApp = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPrompt(null);
      }
    } else {
      alert('📱 Android මත Install කරගැනීමට:\nChrome මෙනුවේ (⋮) "Install app" හෝ "Add to Home screen" ක්ලික් කරන්න!');
    }
  };

  const updateConfig = (partial: Partial<BroadcastConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  };

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header">
        <div className="brand-wrap">
          <div className="brand-icon">🎥</div>
          <div>
            <h1 className="brand-title">Gaviru Cam Mobile</h1>
            <p className="brand-sub">No-PC VDO.Ninja Broadcaster</p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 10px', fontSize: '11px', borderRadius: '6px' }}
            onClick={handleInstallApp}
            title="Install as native app on Android Home Screen without Android Studio"
          >
            📲 Install App
          </button>
        </div>
      </header>

      {/* Nav Tabs */}
      <nav className="nav-tabs">
        <button
          className={`tab-btn ${activeTab === 'broadcast' ? 'active' : ''}`}
          onClick={() => setActiveTab('broadcast')}
        >
          🎥 Live Broadcast
        </button>
        <button
          className={`tab-btn ${activeTab === 'guide' ? 'active' : ''}`}
          onClick={() => setActiveTab('guide')}
        >
          📖 No-PC Setup Guide
        </button>
        <button
          className="tab-btn"
          style={{ color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}
          onClick={() => setShowObsModal(true)}
        >
          🎬 OBS Link
        </button>
      </nav>

      {/* Main Content Area */}
      <main style={{ flex: 1 }}>
        {activeTab === 'broadcast' && (
          <Broadcaster
            config={config}
            onUpdateConfig={updateConfig}
            onOpenObsLink={() => setShowObsModal(true)}
          />
        )}

        {activeTab === 'guide' && (
          <CanonWifiGuide roomName={config.roomName} />
        )}
      </main>

      {/* OBS Browser Source Modal */}
      {showObsModal && (
        <ObsLinkModal
          roomName={config.roomName}
          onClose={() => setShowObsModal(false)}
        />
      )}
    </div>
  );
};

export default App;
