package com.gaviru.camstudio;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * Gaviru Cam Studio - Android Native Application
 * Connects directly to Canon EOS Camera Wi-Fi, provides Lens Focus & Camera Controls,
 * and streams the connected Canon Camera live feed directly to VDO.Ninja & OBS Studio.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "GaviruCamMain";
    private static final int PERMISSION_REQ_CODE = 1001;
    private static final String PREFS_NAME = "GaviruCamPrefs";
    private static final String KEY_CAMERA_IP = "camera_ip";
    private static final String KEY_ROOM_NAME = "vdo_room_name";

    private WebView webView;
    private ProgressBar progressBar;
    private SharedPreferences prefs;

    private String cameraIp = "192.168.1.1";
    private String roomName = "gaviru-cam-pro";

    private CanonPtpIpEngine canonEngine;
    private LocalHttpServer localServer;
    private ConnectivityManager.NetworkCallback wifiNetworkCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        cameraIp = prefs.getString(KEY_CAMERA_IP, "192.168.1.1");
        roomName = prefs.getString(KEY_ROOM_NAME, "gaviru-cam-pro");

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        setupButtons();
        setupWebView();
        checkAndRequestPermissions();

        // 1. Listen for Camera Wi-Fi Network & Auto Detect Gateway IP
        registerWifiNetworkCallback();

        // 2. Start Canon Wi-Fi PTP/IP Engine & Local Server
        startLocalServices();

        // 3. Load Canon Focus Studio UI
        loadLocalStudio();
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
                            Toast.makeText(this, "Camera Gateway Detected: " + cameraIp, Toast.LENGTH_SHORT).show();
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
            canonEngine.start();

            localServer = new LocalHttpServer(this, canonEngine);
            localServer.setRoomName(roomName);
            localServer.start();

            Toast.makeText(this, "Connecting to Canon Wi-Fi (" + cameraIp + ":15740)...", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Service start error: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void setupButtons() {
        Button btnRemoteControl = findViewById(R.id.btnRemoteControl);
        Button btnPhoneCamPush = findViewById(R.id.btnPhoneCamPush);
        Button btnVdoLive = findViewById(R.id.btnVdoLive);
        Button btnSettings = findViewById(R.id.btnSettings);

        btnRemoteControl.setOnClickListener(v -> loadLocalStudio());
        btnPhoneCamPush.setOnClickListener(v -> loadCanonCameraVdoPush());
        btnVdoLive.setOnClickListener(v -> loadVdoNinjaMonitor());
        btnSettings.setOnClickListener(v -> showSettingsDialog());
    }

    private void setupWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.startsWith("gaviru://vdo_broadcast")) {
                    loadCanonCameraVdoPush();
                    return true;
                }
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                injectCanonWebcamShim(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                injectCanonWebcamShim(view);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
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

    /**
     * Injects a virtual camera shim into VDO.Ninja so that VDO.Ninja streams
     * the connected Canon Camera live feed (from local HTTP server) instead of the phone's camera!
     */
    private void injectCanonWebcamShim(WebView view) {
        String js =
            "(function() {" +
            "  if (window.__canonShimReady) return;" +
            "  window.__canonShimReady = true;" +
            "  console.log('[Gaviru] Installing Canon Camera Virtual Stream Shim');" +
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
            "      console.log('[Gaviru] Providing Canon Camera stream to VDO.Ninja!', c);" +
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

    private void loadLocalStudio() {
        webView.loadUrl("http://127.0.0.1:8787/control");
        Toast.makeText(this, "Canon Studio & Focus Controller Ready!", Toast.LENGTH_SHORT).show();
    }

    /**
     * Broadcasts the Canon Camera live stream to VDO.Ninja (and onward to OBS Studio)
     */
    private void loadCanonCameraVdoPush() {
        String url = "https://vdo.ninja/?push=" + roomName + "&webcam&autostart&videobitrate=15000&scale=100";
        webView.loadUrl(url);
        Toast.makeText(this, "Streaming Canon Camera to OBS Studio (Room: " + roomName + ")...", Toast.LENGTH_LONG).show();
    }

    private void loadVdoNinjaMonitor() {
        String url = "https://vdo.ninja/?view=" + roomName + "&cleanoutput&scale=100";
        webView.loadUrl(url);
        Toast.makeText(this, "Connecting to OBS Monitor...", Toast.LENGTH_SHORT).show();
    }

    private void showSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Canon Wi-Fi & VDO.Ninja Settings");

        android.widget.LinearLayout layout = new android.widget.LinearLayout(this);
        layout.setOrientation(android.widget.LinearLayout.VERTICAL);
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
            loadLocalStudio();
        });
        builder.setNegativeButton("Cancel", (dialog, which) -> dialog.cancel());
        builder.show();
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

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
