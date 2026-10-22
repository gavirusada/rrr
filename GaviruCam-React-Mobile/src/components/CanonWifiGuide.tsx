import React, { useState } from 'react';

interface CanonWifiGuideProps {
  roomName: string;
}

export const CanonWifiGuide: React.FC<CanonWifiGuideProps> = ({ roomName }) => {
  const [activeTab, setActiveTab] = useState<'usb' | 'wifi' | 'remote_obs'>('usb');

  return (
    <div className="content-body">
      <div className="card" style={{ border: '1px solid #f59e0b', background: '#120f18' }}>
        <div className="card-title" style={{ color: '#fde68a' }}>
          <span>🚫 PC එකක් නැතිව Field එකේදී Live Streaming කරන ක්‍රම</span>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          ඔබ ළඟ Laptop එකක් හෝ PC එකක් නැති විට, Mobile Phone එක සහ Camera එක පමණක් රැගෙන ගොස් VDO.Ninja මඟින් ලෝකයේ ඕනෑම තැනක OBS Studio එකකට Live Stream එක යැවිය හැක.
        </p>

        <div className="pill-group" style={{ marginTop: '8px' }}>
          <div
            className={`pill-option ${activeTab === 'usb' ? 'active' : ''}`}
            onClick={() => setActiveTab('usb')}
          >
            🔌 1. USB-C OTG (හොඳම ක්‍රමය)
          </div>
          <div
            className={`pill-option ${activeTab === 'wifi' ? 'active' : ''}`}
            onClick={() => setActiveTab('wifi')}
          >
            📡 2. Canon Wi-Fi
          </div>
          <div
            className={`pill-option ${activeTab === 'remote_obs' ? 'active' : ''}`}
            onClick={() => setActiveTab('remote_obs')}
          >
            🎬 3. Remote OBS Link
          </div>
        </div>
      </div>

      {activeTab === 'usb' && (
        <div className="card">
          <div className="card-title">
            <span>🔌 ක්‍රමය 1: USB-C OTG Direct Cable (100% Zero-Lag & Best Quality)</span>
          </div>

          <div style={{ fontSize: '12.5px', color: '#e2e8f0', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p>
              <strong>අවශ්‍ය ද්‍රව්‍ය:</strong><br />
              • ඔබගේ Canon කැමරාව<br />
              • USB-C to Mini-USB Cable (හෝ කුඩා USB-C HDMI Video Capture Card එකක්)<br />
              • ඔබගේ Android ස්මාර්ට්ෆෝන් එක
            </p>

            <div style={{ background: '#0a0d14', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px' }}>
              <strong>පියවර:</strong><br />
              1. කැමරාවේ Mini-USB හෝ HDMI එක ඔබගේ Phone එකේ USB-C Port එකට සම්බන්ධ කරන්න.<br />
              2. මෙම React ඇප් එකේ <strong>"Camera Source"</strong> Dropdown එකෙන් <strong>"USB Video / External Camera"</strong> තෝරන්න.<br />
              3. <strong>"Start VDO.Ninja Broadcast"</strong> ක්ලික් කරන්න!<br />
              4. දුරකථනයේ 4G/5G හෝ Wi-Fi මඟින් කෙලින්ම OBS Studio එකට 60FPS වලින් Full HD / 4K Stream එක යයි. කිසිදු PC එකක් අවශ්‍ය නොවේ!
            </div>
          </div>
        </div>
      )}

      {activeTab === 'wifi' && (
        <div className="card">
          <div className="card-title">
            <span>📡 ක්‍රමය 2: Canon Wi-Fi Direct Hotspot සම්බන්ධතාව</span>
          </div>

          <div style={{ fontSize: '12.5px', color: '#e2e8f0', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p>
              <strong>Canon Wi-Fi සමඟ ක්‍රියා කරන ආකාරය:</strong><br />
              1. කැමරාවේ Menu එකෙන් <strong>Wi-Fi function ➔ Connect to smartphone</strong> තෝරන්න.<br />
              2. කැමරාවෙන් පෙන්වන Wi-Fi SSID සහ Password එක මඟින් දුරකථනය කැමරාවේ Wi-Fi එකට සම්බන්ධ කරන්න.<br />
              3. දුරකථනයේ Settings හි <strong>"Mobile data always active"</strong> (Developer Options) සක්‍රිය කර තබන්න (කැමරාව Wi-Fi එකෙන් ගන්නා අතරතුර අන්තර්ජාලය 4G/5G වලින් VDO.Ninja වෙත යැවීමට).
            </p>
          </div>
        </div>
      )}

      {activeTab === 'remote_obs' && (
        <div className="card">
          <div className="card-title">
            <span>🎬 ක්‍රමය 3: OBS Studio එකට මෙම Stream එක ගන්නා ආකාරය</span>
          </div>

          <div style={{ fontSize: '12.5px', color: '#e2e8f0', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p>
              ලෝකයේ වෙනත් ඕනෑම තැනක සිටින ඔබේ Stream Operator ට මෙම ලින්ක් එක ලබා දෙන්න:
            </p>
            <div className="code-box">
              <span>https://vdo.ninja/?view={encodeURIComponent(roomName)}&cleanoutput&scale=100</span>
            </div>
            <p>
              <strong>OBS Studio Settings:</strong><br />
              1. OBS හි Sources යටතේ <strong>Browser</strong> තෝරන්න.<br />
              2. URL එකට ඉහත ලින්ක් එක Paste කරන්න.<br />
              3. Width: <code>1920</code> (හෝ <code>3840</code>), Height: <code>1080</code> (හෝ <code>2160</code>) සකසන්න.<br />
              4. "Control audio via OBS" Tick කරන්න.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
