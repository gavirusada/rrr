package com.gaviru.camstudio;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;

/**
 * Gaviru Cam Studio - Dedicated Canon DSLR 4000D Native Application
 * Runs in the background (Foreground Service) so normal Chrome browser or OBS
 * can stream 0-latency Canon video + earphone jack mic audio without interruption.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "GaviruCamMain";
    private static final int PERMISSION_REQ_CODE = 1001;
    private static final String PREFS_NAME = "GaviruCamPrefs";
    private static final String KEY_CAMERA_IP = "camera_ip";
    private static final String KEY_ROOM_NAME = "vdo_room_name";

    private ImageView imgLiveView;
    private View focusBox;
    private LinearLayout waitingOverlay;
    private TextView txtWaitingMessage;
    private TextView txtStatusBadge;
    private TextView txtDiagInfo;
    private WebView vdoWebView;

    private Button btnStreamObs;
    private Button btnAudioToggle;
    private Button btnToggleVdoView;

    private SharedPreferences prefs;
    private String cameraIp = "192.168.1.1";
    private String roomName = "gaviru_cam_pro";

    private GaviruCamForegroundService serviceInstance = null;
    private boolean isBound = false;
    private boolean isBroadcastingToObs = false;
    private boolean isViewingVdoScreen = false;
    private boolean isEarphoneMicEnabled = true;

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            GaviruCamForegroundService.LocalBinder localBinder = (GaviruCamForegroundService.LocalBinder) binder;
            serviceInstance = localBinder.getService();
            isBound = true;
            attachEngineListeners();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            serviceInstance = null;
            isBound = false;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        cameraIp = prefs.getString(KEY_CAMERA_IP, "192.168.1.1");
        roomName = prefs.getString(KEY_ROOM_NAME, "gaviru_cam_pro");
        if (roomName == null || roomName.trim().isEmpty() || roomName.contains("-")) {
            roomName = "gaviru_cam_pro";
            prefs.edit().putString(KEY_ROOM_NAME, roomName).apply();
        }

        imgLiveView = findViewById(R.id.imgLiveView);
        focusBox = findViewById(R.id.focusBox);
        waitingOverlay = findViewById(R.id.waitingOverlay);
        txtWaitingMessage = findViewById(R.id.txtWaitingMessage);
        txtStatusBadge = findViewById(R.id.txtStatusBadge);
        txtDiagInfo = findViewById(R.id.txtDiagInfo);
        vdoWebView = findViewById(R.id.vdoWebView);

        btnStreamObs = findViewById(R.id.btnStreamObs);
        btnAudioToggle = findViewById(R.id.btnAudioToggle);
        btnToggleVdoView = findViewById(R.id.btnToggleVdoView);

        setupControls();
        setupVdoNinjaBackgroundBroadcaster();
        checkAndRequestPermissions();

        // Start Foreground Service so it NEVER stops when app is in background or Chrome is active
        startAndBindForegroundService();
    }

    private void startAndBindForegroundService() {
        Intent serviceIntent = new Intent(this, GaviruCamForegroundService.class);
        serviceIntent.putExtra("camera_ip", cameraIp);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
        bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE);
    }

    private void attachEngineListeners() {
        if (serviceInstance == null) return;
        CanonPtpIpEngine engine = serviceInstance.getCanonEngine();
        if (engine == null) return;

        engine.setLogListener(line -> runOnUiThread(() -> {
            txtDiagInfo.setText("IP: " + cameraIp + ":15740 | " + line + " | Background: Active");
            if (line.contains("Live View Active") || line.contains("LIVE") || line.contains("Streaming")) {
                txtStatusBadge.setText("🟢 LIVE");
                txtStatusBadge.setBackgroundColor(0xFF102219);
                txtStatusBadge.setTextColor(0xFF6EE7B7);
            } else if (line.contains("Error") || line.contains("❌")) {
                txtStatusBadge.setText("🔴 Disconnected");
                txtStatusBadge.setBackgroundColor(0xFF251010);
                txtStatusBadge.setTextColor(0xFFFCA5A5);
            } else if (line.contains("Connecting") || line.contains("Handshaking") || line.contains("Opening")) {
                txtStatusBadge.setText("🟡 Connecting");
                txtStatusBadge.setBackgroundColor(0xFF2B2005);
                txtStatusBadge.setTextColor(0xFFFDE68A);
            }
        }));

        engine.setFrameListener(jpeg -> {
            try {
                Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
                if (bmp != null) {
                    runOnUiThread(() -> {
                        imgLiveView.setImageBitmap(bmp);
                        waitingOverlay.setVisibility(View.GONE);
                        txtStatusBadge.setText(String.format("🟢 LIVE: %.1f FPS", engine.getCurrentFps()));
                        txtStatusBadge.setBackgroundColor(0xFF102219);
                        txtStatusBadge.setTextColor(0xFF6EE7B7);
                        txtDiagInfo.setText("IP: " + cameraIp + ":15740 | Frames: " + engine.getTotalFramesReceived() +
                                String.format(" (%.1f FPS)", engine.getCurrentFps()) + " | Background: 24/7 Active");
                    });
                }
            } catch (Exception ignored) {}
        });
    }

    private void setupControls() {
        Button btnShutter = findViewById(R.id.btnShutter);
        Button btnOpenChrome = findViewById(R.id.btnOpenChrome);
        Button btnCopyCanonObsLink = findViewById(R.id.btnCopyCanonObsLink);
        Button btnFar3 = findViewById(R.id.btnFar3);
        Button btnFar1 = findViewById(R.id.btnFar1);
        Button btnNear1 = findViewById(R.id.btnNear1);
        Button btnNear3 = findViewById(R.id.btnNear3);
        Button btnSettings = findViewById(R.id.btnSettings);
        Button btnGuide = findViewById(R.id.btnGuide);

        btnShutter.setOnClickListener(v -> {
            Toast.makeText(this, "📸 Firing Shutter...", Toast.LENGTH_SHORT).show();
            playCanonBeep();
            new Thread(() -> {
                if (serviceInstance != null && serviceInstance.getCanonEngine() != null) {
                    serviceInstance.getCanonEngine().triggerShutterRelease();
                }
            }).start();
        });

        btnStreamObs.setOnClickListener(v -> toggleCanonObsStreaming());

        // One-tap launch in normal Chrome browser
        btnOpenChrome.setOnClickListener(v -> openInChromeBrowser());

        btnCopyCanonObsLink.setOnClickListener(v -> {
            String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
            showObsLinkDialog(obsLink);
        });

        btnFar3.setOnClickListener(v -> driveFocus(1, 3));
        btnFar1.setOnClickListener(v -> driveFocus(1, 1));
        btnNear1.setOnClickListener(v -> driveFocus(2, 1));
        btnNear3.setOnClickListener(v -> driveFocus(2, 3));

        if (btnAudioToggle != null) {
            btnAudioToggle.setOnClickListener(v -> {
                isEarphoneMicEnabled = !isEarphoneMicEnabled;
                if (isEarphoneMicEnabled) {
                    btnAudioToggle.setText("🎙️ Earphone Mic: ON");
                    btnAudioToggle.setBackgroundTintList(ColorStateList.valueOf(0xFF059669));
                    Toast.makeText(this, "🎙️ Earphone Jack Mic Enabled", Toast.LENGTH_SHORT).show();
                } else {
                    btnAudioToggle.setText("🔇 Earphone Mic: OFF");
                    btnAudioToggle.setBackgroundTintList(ColorStateList.valueOf(0xFF374151));
                    Toast.makeText(this, "🔇 Mic Muted", Toast.LENGTH_SHORT).show();
                }
            });
        }

        if (btnToggleVdoView != null) {
            btnToggleVdoView.setOnClickListener(v -> toggleVdoScreenView());
        }

        imgLiveView.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                float x = event.getX();
                float y = event.getY();
                showFocusBox(x, y);
                playCanonBeep();
                new Thread(() -> {
                    if (serviceInstance != null && serviceInstance.getCanonEngine() != null) {
                        boolean afOk = serviceInstance.getCanonEngine().triggerAutoFocus();
                        if (!afOk) {
                            serviceInstance.getCanonEngine().driveLensFocus(2, 1);
                        }
                    }
                }).start();
            }
            return true;
        });

        if (btnSettings != null) btnSettings.setOnClickListener(v -> showSettingsDialog());
        if (btnGuide != null) btnGuide.setOnClickListener(v -> showGuideDialog());
    }

    private void driveFocus(int dir, int step) {
        new Thread(() -> {
            if (serviceInstance != null && serviceInstance.getCanonEngine() != null) {
                serviceInstance.getCanonEngine().driveLensFocus(dir, step);
            }
        }).start();
    }

    private void openInChromeBrowser() {
        if (!isBroadcastingToObs) {
            // Auto start broadcast first so Chrome sees the live stream immediately!
            toggleCanonObsStreaming();
        }

        String vdoViewLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(vdoViewLink));
            intent.setPackage("com.android.chrome");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            // Fallback to any default browser
            Intent fallback = new Intent(Intent.ACTION_VIEW, Uri.parse(vdoViewLink));
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(fallback);
        }
        Toast.makeText(this, "🌐 Chrome හි VDO.Ninja විවෘත වේ...", Toast.LENGTH_SHORT).show();
    }

    private void toggleCanonObsStreaming() {
        isBroadcastingToObs = !isBroadcastingToObs;
        if (isBroadcastingToObs) {
            btnStreamObs.setText("⏹ Stop Canon OBS");
            btnStreamObs.setBackgroundTintList(ColorStateList.valueOf(0xFFF59E0B));

            String vdoPushUrl = "https://vdo.ninja/?push=" + roomName +
                    "&webcam&autostart&videobitrate=6000&audiobitrate=128&fps=30";
            vdoWebView.loadUrl(vdoPushUrl);

            String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
            Toast.makeText(this, "🚀 VDO.Ninja Streaming Active in Background!", Toast.LENGTH_LONG).show();
        } else {
            btnStreamObs.setText("🚀 Stream Canon ➔ OBS");
            btnStreamObs.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
            vdoWebView.loadUrl("about:blank");
            Toast.makeText(this, "OBS Broadcast Stopped", Toast.LENGTH_SHORT).show();
        }
    }

    private void toggleVdoScreenView() {
        isViewingVdoScreen = !isViewingVdoScreen;
        if (isViewingVdoScreen) {
            imgLiveView.setVisibility(View.GONE);
            btnToggleVdoView.setText("📷 Show Canon View");
            btnToggleVdoView.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
        } else {
            imgLiveView.setVisibility(View.VISIBLE);
            btnToggleVdoView.setText("👁️ Preview VDO Screen");
            btnToggleVdoView.setBackgroundTintList(ColorStateList.valueOf(0xFF334155));
        }
    }

    private void showFocusBox(float x, float y) {
        focusBox.setX(x - (focusBox.getWidth() / 2f));
        focusBox.setY(y - (focusBox.getHeight() / 2f));
        focusBox.setVisibility(View.VISIBLE);
        focusBox.postDelayed(() -> focusBox.setVisibility(View.GONE), 1600);
    }

    private void showObsLinkDialog(String obsLink) {
        String directLocalStream = "http://" + getDeviceIpAddress() + ":8787/stream";
        new AlertDialog.Builder(this)
                .setTitle("🚀 OBS & Chrome Streaming Links")
                .setMessage("Chrome Browser එකෙන් හෝ OBS එකෙන් බලන්න:\n\n"
                        + "1️⃣ VDO.Ninja (Internet / Cloud Push):\n" + obsLink + "\n\n"
                        + "2️⃣ Local Wi-Fi (No Internet / 0-Latency):\n" + directLocalStream)
                .setPositiveButton("🌐 Open in Chrome", (d, w) -> openInChromeBrowser())
                .setNeutralButton("📋 Copy VDO Link", (d, w) -> copyLinkToClipboard("VDO Link", obsLink))
                .setNegativeButton("OK", null)
                .show();
    }

    private void copyLinkToClipboard(String label, String url) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = ClipData.newPlainText(label, url);
        if (clipboard != null) {
            clipboard.setPrimaryClip(clip);
            Toast.makeText(this, "Copied: " + url, Toast.LENGTH_LONG).show();
        }
    }

    private String getDeviceIpAddress() {
        try {
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements();) {
                NetworkInterface intf = en.nextElement();
                for (Enumeration<InetAddress> enumIpAddr = intf.getInetAddresses(); enumIpAddr.hasMoreElements();) {
                    InetAddress inetAddress = enumIpAddr.nextElement();
                    if (!inetAddress.isLoopbackAddress() && inetAddress instanceof Inet4Address) {
                        String ip = inetAddress.getHostAddress();
                        if (ip != null && !ip.startsWith("127.")) return ip;
                    }
                }
            }
        } catch (Exception ignored) {}
        return "192.168.1.2";
    }

    private void setupVdoNinjaBackgroundBroadcaster() {
        WebSettings ws = vdoWebView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setDatabaseEnabled(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        vdoWebView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public String getLatestFrameBase64() {
                if (serviceInstance != null && serviceInstance.getCanonEngine() != null) {
                    byte[] frame = serviceInstance.getCanonEngine().getLatestJpegFrame();
                    if (frame != null && frame.length > 50) {
                        return android.util.Base64.encodeToString(frame, android.util.Base64.NO_WRAP);
                    }
                }
                return "";
            }
        }, "CanonBridge");

        vdoWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (url != null && !url.equals("about:blank")) injectCanonWebcamShim(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && !url.equals("about:blank")) injectCanonWebcamShim(view);
            }
        });

        vdoWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress > 30) injectCanonWebcamShim(view);
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        request.grant(request.getResources());
                    }
                });
            }
        });
    }

    private void injectCanonWebcamShim(WebView view) {
        String js =
            "(function() {" +
            "  if (!window.__realGUM && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {" +
            "    window.__realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);" +
            "  }" +
            "  if (window.__canonShimInjected) return;" +
            "  window.__canonShimInjected = true;" +
            "  const canvas = document.createElement('canvas');" +
            "  canvas.width = 1280; canvas.height = 720;" +
            "  const ctx = canvas.getContext('2d');" +
            "  ctx.fillStyle = '#0a0e17';" +
            "  ctx.fillRect(0, 0, canvas.width, canvas.height);" +
            "  ctx.fillStyle = '#10b981';" +
            "  ctx.font = 'bold 36px sans-serif';" +
            "  ctx.fillText('📷 Gaviru Cam — Canon 4000D Live', 60, 120);" +
            "  const img = new Image();" +
            "  let busy = false;" +
            "  img.onload = function() {" +
            "    try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch(e) {}" +
            "    busy = false;" +
            "  };" +
            "  img.onerror = function() { busy = false; };" +
            "  function update() {" +
            "    if (!busy && window.CanonBridge) {" +
            "      try {" +
            "        const b64 = window.CanonBridge.getLatestFrameBase64();" +
            "        if (b64 && b64.length > 50) {" +
            "          busy = true;" +
            "          img.src = 'data:image/jpeg;base64,' + b64;" +
            "        }" +
            "      } catch(e) {}" +
            "    }" +
            "  }" +
            "  setInterval(update, 25);" +
            "  function createStream() {" +
            "    const vs = canvas.captureStream(30);" +
            "    if (window.__realGUM) {" +
            "      return window.__realGUM({ audio: {" +
            "          echoCancellation: false," +
            "          noiseSuppression: false," +
            "          autoGainControl: false" +
            "        }, video: false })" +
            "        .then(function(micStream) {" +
            "          console.log('🎙️ Mic captured: ' + micStream.getAudioTracks().length + ' track(s)');" +
            "          return new MediaStream([...vs.getVideoTracks(), ...micStream.getAudioTracks()]);" +
            "        })" +
            "        .catch(function(err) {" +
            "          console.warn('Mic capture failed: ' + err);" +
            "          return new MediaStream([...vs.getVideoTracks()]);" +
            "        });" +
            "    }" +
            "    return Promise.resolve(new MediaStream([...vs.getVideoTracks()]));" +
            "  }" +
            "  if (!navigator.mediaDevices) navigator.mediaDevices = {};" +
            "  navigator.mediaDevices.enumerateDevices = function() {" +
            "    return Promise.resolve([{" +
            "      deviceId: 'canon-eos-4000d'," +
            "      kind: 'videoinput'," +
            "      label: 'Canon EOS 4000D DSLR (Gaviru Cam)'," +
            "      groupId: 'canon-group'," +
            "      toJSON: function() { return this; }" +
            "    }]);" +
            "  };" +
            "  navigator.mediaDevices.getUserMedia = function(constraints) {" +
            "    return createStream();" +
            "  };" +
            "  navigator.mediaDevices.getDisplayMedia = function(constraints) {" +
            "    return createStream();" +
            "  };" +
            "  navigator.getUserMedia = function(c, s, e) {" +
            "    createStream().then(function(st) { if (s) s(st); }).catch(function(err) { if (e) e(err); });" +
            "  };" +
            "  navigator.webkitGetUserMedia = navigator.getUserMedia;" +
            "  setInterval(function() {" +
            "    const btns = document.querySelectorAll('button, .action-button, [role=\"button\"]');" +
            "    for (let i = 0; i < btns.length; i++) {" +
            "      const t = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();" +
            "      if (t === 'start' || t === 'join room' || t.includes('start stream') || t.includes('go live')) {" +
            "        btns[i].click();" +
            "        break;" +
            "      }" +
            "    }" +
            "  }, 500);" +
            "  console.log('✓ Canon Webcam Shim armed — real mic enabled');" +
            "})();";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            view.evaluateJavascript(js, null);
        } else {
            view.loadUrl("javascript:" + js);
        }
    }

    private void showSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("⚙️ Canon Camera Settings");

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(40, 20, 40, 10);

        TextView labelIp = new TextView(this);
        labelIp.setText("📷 Canon Camera Wi-Fi IP:");
        labelIp.setTextSize(13f);
        labelIp.setTextColor(Color.WHITE);
        labelIp.setPadding(0, 10, 0, 4);
        layout.addView(labelIp);

        final EditText inputIp = new EditText(this);
        inputIp.setText(cameraIp);
        layout.addView(inputIp);

        LinearLayout presetsLayout = new LinearLayout(this);
        presetsLayout.setOrientation(LinearLayout.HORIZONTAL);
        presetsLayout.setPadding(0, 0, 0, 16);

        Button btnP1 = new Button(this, null, android.R.attr.buttonStyleSmall);
        btnP1.setText("192.168.1.1");
        btnP1.setOnClickListener(v -> inputIp.setText("192.168.1.1"));
        presetsLayout.addView(btnP1);

        Button btnP2 = new Button(this, null, android.R.attr.buttonStyleSmall);
        btnP2.setText("192.168.1.2");
        btnP2.setOnClickListener(v -> inputIp.setText("192.168.1.2"));
        presetsLayout.addView(btnP2);

        Button btnP3 = new Button(this, null, android.R.attr.buttonStyleSmall);
        btnP3.setText("192.168.1.145");
        btnP3.setOnClickListener(v -> inputIp.setText("192.168.1.145"));
        presetsLayout.addView(btnP3);

        layout.addView(presetsLayout);

        TextView labelRoom = new TextView(this);
        labelRoom.setText("🌐 VDO.Ninja Room Name:");
        labelRoom.setTextSize(13f);
        labelRoom.setTextColor(Color.WHITE);
        labelRoom.setPadding(0, 10, 0, 4);
        layout.addView(labelRoom);

        final EditText inputRoom = new EditText(this);
        inputRoom.setText(roomName);
        layout.addView(inputRoom);

        builder.setView(layout);
        builder.setPositiveButton("Save & Reconnect", (dialog, which) -> {
            roomName = inputRoom.getText().toString().trim().replace("-", "_");
            cameraIp = inputIp.getText().toString().trim();
            if (roomName.isEmpty()) roomName = "gaviru_cam_pro";
            if (cameraIp.isEmpty()) cameraIp = "192.168.1.1";

            prefs.edit().putString(KEY_ROOM_NAME, roomName).putString(KEY_CAMERA_IP, cameraIp).apply();
            if (serviceInstance != null) {
                serviceInstance.setCameraIp(cameraIp);
                serviceInstance.setRoomName(roomName);
            }
            Toast.makeText(this, "✅ Settings Saved! Reconnecting to " + cameraIp, Toast.LENGTH_SHORT).show();
        });
        builder.setNegativeButton("Cancel", null);
        builder.show();
    }

    private void showGuideDialog() {
        new AlertDialog.Builder(this)
                .setTitle("📷 Gaviru Cam Studio Help")
                .setMessage("1️⃣ Canon Wi-Fi Menu වෙත ගොස් 'Remote control (EOS Utility)' 💻 තෝරා Phone එකෙන් connect වන්න.\n\n"
                        + "2️⃣ App එකේ '🚀 Stream Canon ➔ OBS' ඔබන්න.\n\n"
                        + "3️⃣ '🌐 Open VDO in Chrome' ඔබන්න. Phone එකේ normal Chrome browser එකෙන් VDO.Ninja විවෘත වී Canon Live Stream එක කෙලින්ම දිස්වේ!\n\n"
                        + "4️⃣ Background Service එක සක්‍රිය බැවින් Chrome විවෘත කලද Stream එක කිසිවිටෙක නැවතෙන්නේ නැත.")
                .setPositiveButton("තේරුණා (OK)", null)
                .show();
    }

    public static void playCanonBeep() {
        new Thread(() -> {
            try {
                int sampleRate = 44100;
                int pip1Len = (int) (sampleRate * 0.055);
                int pauseLen = (int) (sampleRate * 0.020);
                int pip2Len = (int) (sampleRate * 0.065);
                int totalSamples = pip1Len + pauseLen + pip2Len;

                short[] buffer = new short[totalSamples];
                double freq = 2880.0;

                for (int i = 0; i < pip1Len; i++) {
                    double angle = 2.0 * Math.PI * i / (sampleRate / freq);
                    buffer[i] = (short) (Math.sin(angle) * 16000);
                }
                for (int i = pip1Len; i < pip1Len + pauseLen; i++) {
                    buffer[i] = 0;
                }
                for (int i = 0; i < pip2Len; i++) {
                    double angle = 2.0 * Math.PI * i / (sampleRate / freq);
                    buffer[pip1Len + pauseLen + i] = (short) (Math.sin(angle) * 18000);
                }

                AudioTrack track = new AudioTrack(
                        AudioManager.STREAM_MUSIC, sampleRate,
                        AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        buffer.length * 2, AudioTrack.MODE_STATIC
                );
                track.write(buffer, 0, buffer.length);
                track.play();
                Thread.sleep(200);
                track.release();
            } catch (Exception ignored) {}
        }).start();
    }

    private void checkAndRequestPermissions() {
        String[] permissions;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions = new String[]{
                    Manifest.permission.CAMERA,
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.MODIFY_AUDIO_SETTINGS,
                    Manifest.permission.ACCESS_NETWORK_STATE,
                    Manifest.permission.ACCESS_WIFI_STATE,
                    Manifest.permission.POST_NOTIFICATIONS
            };
        } else {
            permissions = new String[]{
                    Manifest.permission.CAMERA,
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.MODIFY_AUDIO_SETTINGS,
                    Manifest.permission.ACCESS_NETWORK_STATE,
                    Manifest.permission.ACCESS_WIFI_STATE
            };
        }

        boolean needRequest = false;
        for (String p : permissions) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needRequest = true;
                break;
            }
        }
        if (needRequest) {
            ActivityCompat.requestPermissions(this, permissions, PERMISSION_REQ_CODE);
        }
    }

    // CRITICAL: When user switches to Chrome or other apps, DO NOT STOP THE WEBVIEW OR SERVICE!
    @Override
    protected void onPause() {
        super.onPause();
        // Keep WebView timers running in background so WebRTC never sleeps!
        vdoWebView.resumeTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        vdoWebView.resumeTimers();
        if (isBound && serviceInstance != null) {
            attachEngineListeners();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (isBound) {
            unbindService(serviceConnection);
            isBound = false;
        }
        // Background service remains running!
    }
}
