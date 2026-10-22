package com.gaviru.camstudio;

import android.Manifest;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
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
 * Connects directly to Canon Camera Wi-Fi, provides Lens Focus & Camera Controls,
 * and broadcasts 4K Live Stream to VDO.Ninja / OBS Studio without needing any PC!
 */
public class MainActivity extends AppCompatActivity {

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

        // Start Canon Wi-Fi PTP/IP Engine and Local HTTP Server
        startLocalServices();

        // Load the Studio Control & Focus Interface
        loadLocalStudio();
    }

    private void startLocalServices() {
        try {
            canonEngine = new CanonPtpIpEngine(cameraIp, 15740);
            canonEngine.start();

            localServer = new LocalHttpServer(this, canonEngine);
            localServer.start();

            Toast.makeText(this, "Connecting to Canon Wi-Fi (" + cameraIp + ":15740)...", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Service start error: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void setupButtons() {
        Button btnVdoLive = findViewById(R.id.btnVdoLive);
        Button btnRemoteControl = findViewById(R.id.btnRemoteControl);
        Button btnPhoneCamPush = findViewById(R.id.btnPhoneCamPush);
        Button btnSettings = findViewById(R.id.btnSettings);

        btnVdoLive.setOnClickListener(v -> loadVdoNinjaMonitor());
        btnRemoteControl.setOnClickListener(v -> loadLocalStudio());
        btnPhoneCamPush.setOnClickListener(v -> loadPhoneCameraPush());
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
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
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

    private void loadLocalStudio() {
        webView.loadUrl("http://127.0.0.1:8787/control");
        Toast.makeText(this, "Camera Live View & Focus Controls Ready!", Toast.LENGTH_SHORT).show();
    }

    private void loadVdoNinjaMonitor() {
        String url = "https://vdo.ninja/?view=" + roomName + "&cleanoutput&scale=100";
        webView.loadUrl(url);
        Toast.makeText(this, "Connecting to VDO.Ninja Monitor: " + roomName, Toast.LENGTH_SHORT).show();
    }

    private void loadPhoneCameraPush() {
        String url = "https://vdo.ninja/?push=" + roomName + "&webcam&autostart&videobitrate=15000&scale=100";
        webView.loadUrl(url);
        Toast.makeText(this, "Streaming Camera to OBS Studio via VDO.Ninja...", Toast.LENGTH_LONG).show();
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

            if (canonEngine != null) {
                canonEngine.stop();
            }
            if (localServer != null) {
                localServer.stop();
            }

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
                Manifest.permission.MODIFY_AUDIO_SETTINGS
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
