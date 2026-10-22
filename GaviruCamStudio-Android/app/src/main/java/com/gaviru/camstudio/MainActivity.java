package com.gaviru.camstudio;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
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

/**
 * Gaviru Cam Studio - Android Native Application
 * Connects directly to Canon EOS Camera Wi-Fi, renders 0-latency live view via native ImageView,
 * provides Tap-to-Focus, mechanical Shutter Release, and broadcasts to OBS Studio via VDO.Ninja.
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

    private SharedPreferences prefs;
    private String cameraIp = "192.168.1.1";
    private String roomName = "gaviru-cam-pro";

    private CanonPtpIpEngine canonEngine;
    private LocalHttpServer localServer;
    private ConnectivityManager.NetworkCallback wifiNetworkCallback;

    private boolean isBroadcastingToObs = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        cameraIp = prefs.getString(KEY_CAMERA_IP, "192.168.1.1");
        roomName = prefs.getString(KEY_ROOM_NAME, "gaviru-cam-pro");

        imgLiveView = findViewById(R.id.imgLiveView);
        focusBox = findViewById(R.id.focusBox);
        waitingOverlay = findViewById(R.id.waitingOverlay);
        txtWaitingMessage = findViewById(R.id.txtWaitingMessage);
        txtStatusBadge = findViewById(R.id.txtStatusBadge);
        txtDiagInfo = findViewById(R.id.txtDiagInfo);
        vdoWebView = findViewById(R.id.vdoWebView);

        setupControls();
        setupVdoNinjaBackgroundBroadcaster();
        checkAndRequestPermissions();

        // 1. Listen for Camera Wi-Fi Network & Auto Detect Gateway IP
        registerWifiNetworkCallback();

        // 2. Start Canon Wi-Fi PTP/IP Engine & Local Server
        startLocalServices();
    }

    private void registerWifiNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkRequest request = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build();

            wifiNetworkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    Log.i(TAG, "Wi-Fi Network active: " + network);
                    if (canonEngine != null) {
                        canonEngine.setWifiNetwork(network);
                    }
                    detectGatewayIp();
                }

                @Override
                public void onLost(@NonNull Network network) {
                    Log.w(TAG, "Wi-Fi Network lost");
                    if (canonEngine != null) {
                        canonEngine.setWifiNetwork(null);
                    }
                }
            };

            cm.registerNetworkCallback(request, wifiNetworkCallback);
        } catch (Exception e) {
            Log.w(TAG, "Error registering network callback: " + e.getMessage());
        }
    }

    private void detectGatewayIp() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                DhcpInfo dhcp = wm.getDhcpInfo();
                if (dhcp != null && dhcp.gateway != 0) {
                    int g = dhcp.gateway;
                    String detected = String.format("%d.%d.%d.%d", (g & 0xFF), (g >> 8 & 0xFF), (g >> 16 & 0xFF), (g >> 24 & 0xFF));
                    if (!detected.equals("0.0.0.0") && !detected.equals(cameraIp)) {
                        cameraIp = detected;
                        prefs.edit().putString(KEY_CAMERA_IP, cameraIp).apply();
                        Log.i(TAG, "Auto-detected Canon Camera Gateway IP: " + cameraIp);
                        runOnUiThread(() -> {
                            Toast.makeText(this, "Camera Gateway: " + cameraIp, Toast.LENGTH_SHORT).show();
                            startLocalServices();
                        });
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void startLocalServices() {
        try {
            if (canonEngine != null) {
                canonEngine.stop();
            }
            if (localServer != null) {
                localServer.stop();
            }

            canonEngine = new CanonPtpIpEngine(this, cameraIp, 15740);

            // Set frame listener for 0-latency native rendering!
            canonEngine.setFrameListener(jpeg -> {
                try {
                    Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
                    if (bmp != null) {
                        runOnUiThread(() -> {
                            imgLiveView.setImageBitmap(bmp);
                            waitingOverlay.setVisibility(View.GONE);
                            txtStatusBadge.setText(String.format("🟢 LIVE: %.1f FPS", canonEngine.getCurrentFps()));
                            txtStatusBadge.setBackgroundColor(0xFF102219);
                            txtStatusBadge.setTextColor(0xFF6EE7B7);
                            txtDiagInfo.setText("IP: " + canonEngine.getCameraIp() + ":" + canonEngine.getCameraPort() +
                                    " | Shutter: OPEN | Frames: " + canonEngine.getTotalFramesReceived());
                        });
                    }
                } catch (Exception ignored) {}
            });

            canonEngine.start();

            localServer = new LocalHttpServer(this, canonEngine);
            localServer.setRoomName(roomName);
            localServer.start();

            txtDiagInfo.setText("Target: " + cameraIp + ":15740 | Connecting...");
            Toast.makeText(this, "Connecting to Canon Wi-Fi (" + cameraIp + ":15740)...", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Service start error: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void setupControls() {
        Button btnShutter = findViewById(R.id.btnShutter);
        Button btnStreamObs = findViewById(R.id.btnStreamObs);
        Button btnSettings = findViewById(R.id.btnSettings);

        Button btnFar3 = findViewById(R.id.btnFar3);
        Button btnFar1 = findViewById(R.id.btnFar1);
        Button btnNear1 = findViewById(R.id.btnNear1);
        Button btnNear3 = findViewById(R.id.btnNear3);

        // 1. Shutter Button
        btnShutter.setOnClickListener(v -> {
            Toast.makeText(this, "📸 Firing Shutter...", Toast.LENGTH_SHORT).show();
            playCanonBeep();
            new Thread(() -> {
                if (canonEngine != null) {
                    canonEngine.triggerShutterRelease();
                }
            }).start();
        });

        // 2. Focus Drive Buttons
        btnFar3.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(1, 3); }).start());
        btnFar1.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(1, 1); }).start());
        btnNear1.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(2, 1); }).start());
        btnNear3.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(2, 3); }).start());

        // 3. Tap to Focus on ImageView
        imgLiveView.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                float x = event.getX();
                float y = event.getY();
                showFocusBox(x, y);
                playCanonBeep();
                new Thread(() -> {
                    if (canonEngine != null) {
                        canonEngine.driveLensFocus(2, 1);
                    }
                }).start();
            }
            return true;
        });

        // 4. Stream to OBS (VDO.Ninja) Button
        btnStreamObs.setOnClickListener(v -> toggleObsStreaming(btnStreamObs));

        // 5. Settings Button
        btnSettings.setOnClickListener(v -> showSettingsDialog());
    }

    private void showFocusBox(float x, float y) {
        focusBox.setX(x - (focusBox.getWidth() / 2f));
        focusBox.setY(y - (focusBox.getHeight() / 2f));
        focusBox.setVisibility(View.VISIBLE);
        focusBox.postDelayed(() -> focusBox.setVisibility(View.GONE), 1600);
    }

    private void toggleObsStreaming(Button btnStreamObs) {
        isBroadcastingToObs = !isBroadcastingToObs;
        if (isBroadcastingToObs) {
            btnStreamObs.setText("⏹ Stop OBS Stream");
            btnStreamObs.setBackgroundTintList(android.content.res.ColorStateList.valueOf(0xFFF59E0B));
            String vdoPushUrl = "https://vdo.ninja/?push=" + roomName + "&webcam&autostart&videobitrate=15000&scale=100";
            vdoWebView.loadUrl(vdoPushUrl);

            String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
            new AlertDialog.Builder(this)
                    .setTitle("🚀 Streaming Canon Camera to OBS!")
                    .setMessage("Canon Live Feed එක VDO.Ninja හරහා OBS Studio එකට stream වෙමින් පවතී!\n\nOBS Studio එකේ Browser Source එකට මෙම Link එක ලබා දෙන්න:\n\n" + obsLink)
                    .setPositiveButton("📋 Copy OBS Link", (dialog, which) -> {
                        android.content.ClipboardManager clipboard = (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        android.content.ClipData clip = android.content.ClipData.newPlainText("OBS Link", obsLink);
                        clipboard.setPrimaryClip(clip);
                        Toast.makeText(this, "OBS Link Copied!", Toast.LENGTH_SHORT).show();
                    })
                    .setNegativeButton("OK", null)
                    .show();
        } else {
            btnStreamObs.setText("🚀 Stream Canon ➔ OBS");
            btnStreamObs.setBackgroundTintList(android.content.res.ColorStateList.valueOf(0xFF10B981));
            vdoWebView.loadUrl("about:blank");
            Toast.makeText(this, "OBS Broadcast Stopped", Toast.LENGTH_SHORT).show();
        }
    }

    private void setupVdoNinjaBackgroundBroadcaster() {
        WebSettings ws = vdoWebView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        vdoWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                injectCanonWebcamShim(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectCanonWebcamShim(view);
            }
        });

        vdoWebView.setWebChromeClient(new WebChromeClient() {
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
            "  if (window.__canonShimReady) return;" +
            "  window.__canonShimReady = true;" +
            "  const canvas = document.createElement('canvas');" +
            "  canvas.width = 1280; canvas.height = 720;" +
            "  const ctx = canvas.getContext('2d');" +
            "  const img = new Image();" +
            "  img.crossOrigin = 'anonymous';" +
            "  let busy = false;" +
            "  function fetchFrame() {" +
            "    if (!busy) {" +
            "      busy = true;" +
            "      img.src = 'http://127.0.0.1:8787/snapshot.jpg?t=' + Date.now();" +
            "    }" +
            "  }" +
            "  img.onload = function() {" +
            "    if (img.naturalWidth > 0) {" +
            "      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;" +
            "      ctx.drawImage(img, 0, 0);" +
            "    }" +
            "    busy = false;" +
            "  };" +
            "  img.onerror = function() { busy = false; };" +
            "  setInterval(fetchFrame, 25);" +
            "  const canonStream = canvas.captureStream(30);" +
            "  const origGUM = navigator.mediaDevices ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;" +
            "  if (navigator.mediaDevices) {" +
            "    navigator.mediaDevices.getUserMedia = async function(c) {" +
            "      if (c && c.audio && origGUM) {" +
            "        try {" +
            "          const aud = await origGUM({ audio: true });" +
            "          aud.getAudioTracks().forEach(t => canonStream.addTrack(t));" +
            "        } catch(e) {}" +
            "      }" +
            "      return canonStream;" +
            "    };" +
            "  }" +
            "})();";
        view.evaluateJavascript(js, null);
    }

    private void showSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Canon Wi-Fi & VDO.Ninja Settings");

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(40, 20, 40, 20);

        final EditText inputIp = new EditText(this);
        inputIp.setHint("Camera Wi-Fi IP (default: 192.168.1.1)");
        inputIp.setText(cameraIp);
        layout.addView(inputIp);

        final EditText inputRoom = new EditText(this);
        inputRoom.setHint("VDO.Ninja Room Name (default: gaviru-cam-pro)");
        inputRoom.setText(roomName);
        layout.addView(inputRoom);

        builder.setView(layout);
        builder.setPositiveButton("Save & Reconnect", (dialog, which) -> {
            cameraIp = inputIp.getText().toString().trim();
            roomName = inputRoom.getText().toString().trim();
            if (cameraIp.isEmpty()) cameraIp = "192.168.1.1";
            if (roomName.isEmpty()) roomName = "gaviru-cam-pro";

            prefs.edit()
                    .putString(KEY_CAMERA_IP, cameraIp)
                    .putString(KEY_ROOM_NAME, roomName)
                    .apply();

            startLocalServices();
        });
        builder.setNegativeButton("Cancel", (dialog, which) -> dialog.cancel());
        builder.show();
    }

    /**
     * Programmatic Authentic Canon "Pip-Pip" Double Beep Audio
     */
    public static void playCanonBeep() {
        new Thread(() -> {
            try {
                int sampleRate = 44100;
                int pip1Len = (int) (sampleRate * 0.055); // 55ms
                int pauseLen = (int) (sampleRate * 0.020); // 20ms
                int pip2Len = (int) (sampleRate * 0.065); // 65ms
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
        String[] permissions = {
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.MODIFY_AUDIO_SETTINGS,
                Manifest.permission.ACCESS_NETWORK_STATE,
                Manifest.permission.ACCESS_WIFI_STATE
        };
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

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQ_CODE) {
            Toast.makeText(this, "Permissions granted!", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            if (wifiNetworkCallback != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(wifiNetworkCallback);
            }
        } catch (Exception ignored) {}
        if (canonEngine != null) canonEngine.stop();
        if (localServer != null) localServer.stop();
    }
}
