package com.gaviru.camstudio;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
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
import android.widget.FrameLayout;
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
 * Supports two dual-stream workflows:
 * 1. Phone Camera Mode: Captures phone's built-in 4K/1080p 60FPS camera (Back/Front) and streams directly to VDO.Ninja / OBS.
 * 2. Canon DSLR Mode: Connects to Canon EOS Camera Wi-Fi (PTP/IP), 0-latency live view, tap-to-focus, and streams to OBS.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "GaviruCamMain";
    private static final int PERMISSION_REQ_CODE = 1001;
    private static final String PREFS_NAME = "GaviruCamPrefs";
    private static final String KEY_CAMERA_IP = "camera_ip";
    private static final String KEY_ROOM_NAME = "vdo_room_name";
    private static final String KEY_MODE = "app_mode";

    public enum AppMode {
        PHONE_CAM,
        CANON_DSLR
    }

    private AppMode currentMode = AppMode.CANON_DSLR;
    private boolean isPhoneBroadcasting = false;
    private boolean isFrontCamera = false;
    private String selectedResolution = "1080p";
    private int selectedFps = 60;

    private ImageView imgLiveView;
    private View focusBox;
    private LinearLayout waitingOverlay;
    private TextView txtWaitingMessage;
    private TextView txtStatusBadge;
    private TextView txtDiagInfo;
    private WebView vdoWebView;

    private LinearLayout phoneControls;
    private LinearLayout canonControls;
    private Button btnModePhone;
    private Button btnModeCanon;

    private SharedPreferences prefs;
    private String cameraIp = "192.168.1.1";
    private String roomName = "gaviru-cam-pro";

    private CanonPtpIpEngine canonEngine;
    private LocalHttpServer localServer;
    private ConnectivityManager.NetworkCallback wifiNetworkCallback;
    private Network currentWifiNetwork = null;

    private boolean isBroadcastingToObs = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        cameraIp = prefs.getString(KEY_CAMERA_IP, "192.168.1.1");
        roomName = prefs.getString(KEY_ROOM_NAME, "gaviru-cam-pro");
        String savedMode = prefs.getString(KEY_MODE, AppMode.CANON_DSLR.name());
        try {
            currentMode = AppMode.valueOf(savedMode);
        } catch (Exception e) {
            currentMode = AppMode.CANON_DSLR;
        }

        imgLiveView = findViewById(R.id.imgLiveView);
        focusBox = findViewById(R.id.focusBox);
        waitingOverlay = findViewById(R.id.waitingOverlay);
        txtWaitingMessage = findViewById(R.id.txtWaitingMessage);
        txtStatusBadge = findViewById(R.id.txtStatusBadge);
        txtDiagInfo = findViewById(R.id.txtDiagInfo);
        vdoWebView = findViewById(R.id.vdoWebView);

        phoneControls = findViewById(R.id.phoneControls);
        canonControls = findViewById(R.id.canonControls);
        btnModePhone = findViewById(R.id.btnModePhone);
        btnModeCanon = findViewById(R.id.btnModeCanon);

        setupControls();
        setupVdoNinjaBackgroundBroadcaster();
        checkAndRequestPermissions();

        // Initialize to saved or default mode
        if (currentMode == AppMode.PHONE_CAM) {
            switchToPhoneCameraMode();
        } else {
            switchToCanonMode();
        }
    }

    private void switchToPhoneCameraMode() {
        currentMode = AppMode.PHONE_CAM;
        prefs.edit().putString(KEY_MODE, AppMode.PHONE_CAM.name()).apply();

        btnModePhone.setBackgroundTintList(ColorStateList.valueOf(0xFF2563EB));
        btnModePhone.setTextColor(0xFFFFFFFF);
        btnModeCanon.setBackgroundTintList(ColorStateList.valueOf(0xFF1E293B));
        btnModeCanon.setTextColor(0xFF94A3B8);

        phoneControls.setVisibility(View.VISIBLE);
        canonControls.setVisibility(View.GONE);

        imgLiveView.setVisibility(View.GONE);
        focusBox.setVisibility(View.GONE);
        waitingOverlay.setVisibility(View.GONE);
        vdoWebView.setVisibility(View.VISIBLE);

        // Stop Canon services while in Phone Mode
        if (canonEngine != null) {
            canonEngine.stop();
            canonEngine = null;
        }
        if (localServer != null) {
            localServer.stop();
            localServer = null;
        }

        txtStatusBadge.setText("Standby");
        txtStatusBadge.setBackgroundColor(0xFF251010);
        txtStatusBadge.setTextColor(0xFFFCA5A5);
        txtDiagInfo.setText("Mode: 📱 Phone Camera | Room: " + roomName + " | Ready to Stream (Back Cam)");
    }

    private void switchToCanonMode() {
        currentMode = AppMode.CANON_DSLR;
        prefs.edit().putString(KEY_MODE, AppMode.CANON_DSLR.name()).apply();

        btnModeCanon.setBackgroundTintList(ColorStateList.valueOf(0xFF2563EB));
        btnModeCanon.setTextColor(0xFFFFFFFF);
        btnModePhone.setBackgroundTintList(ColorStateList.valueOf(0xFF1E293B));
        btnModePhone.setTextColor(0xFF94A3B8);

        canonControls.setVisibility(View.VISIBLE);
        phoneControls.setVisibility(View.GONE);

        imgLiveView.setVisibility(View.VISIBLE);
        waitingOverlay.setVisibility(View.VISIBLE);
        vdoWebView.setVisibility(View.VISIBLE); // Kept VISIBLE behind imgLiveView so WebRTC never sleeps

        // If phone was streaming, reset url
        if (isPhoneBroadcasting) {
            isPhoneBroadcasting = false;
            Button btnStream = findViewById(R.id.btnStreamPhoneObs);
            if (btnStream != null) {
                btnStream.setText("🚀 Start Phone Cam Stream");
                btnStream.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
            }
        }
        vdoWebView.loadUrl("about:blank");

        // Proactively detect Wi-Fi network and start Canon services
        detectAndBindWifi();
        registerWifiNetworkCallback();
        startLocalServices();
    }

    private void togglePhoneStreaming() {
        isPhoneBroadcasting = !isPhoneBroadcasting;
        Button btnStreamPhoneObs = findViewById(R.id.btnStreamPhoneObs);
        if (isPhoneBroadcasting) {
            btnStreamPhoneObs.setText("⏹ Stop Phone Stream");
            btnStreamPhoneObs.setBackgroundTintList(ColorStateList.valueOf(0xFFEF4444));

            int bitrate = selectedResolution.equals("4k") ? 18000 : selectedResolution.equals("1080p") ? 9000 : 4500;
            String facing = isFrontCamera ? "user" : "back";

            // Complete WebRTC Push URL for Phone Camera
            String vdoPhonePushUrl = "https://vdo.ninja/?push=" + roomName +
                    "&webcam&autostart&videobitrate=" + bitrate +
                    "&audiobitrate=192&scale=100&quality=0&fps=" + selectedFps +
                    "&facing=" + facing;

            vdoWebView.loadUrl(vdoPhonePushUrl);

            txtStatusBadge.setText("🟢 LIVE " + selectedResolution.toUpperCase() + " " + selectedFps + "FPS");
            txtStatusBadge.setBackgroundColor(0xFF102219);
            txtStatusBadge.setTextColor(0xFF6EE7B7);

            String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
            txtDiagInfo.setText("Broadcasting Live! OBS Link: " + obsLink);

            showObsLinkDialog(obsLink);
        } else {
            btnStreamPhoneObs.setText("🚀 Start Phone Cam Stream");
            btnStreamPhoneObs.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
            vdoWebView.loadUrl("about:blank");

            txtStatusBadge.setText("Standby");
            txtStatusBadge.setBackgroundColor(0xFF251010);
            txtStatusBadge.setTextColor(0xFFFCA5A5);
            txtDiagInfo.setText("Mode: 📱 Phone Camera | Room: " + roomName + " | Standby");
            Toast.makeText(this, "Stream Stopped", Toast.LENGTH_SHORT).show();
        }
    }

    private void flipPhoneCamera() {
        isFrontCamera = !isFrontCamera;
        Toast.makeText(this, isFrontCamera ? "Switched to Front (Selfie) Cam" : "Switched to Back Camera", Toast.LENGTH_SHORT).show();
        if (isPhoneBroadcasting) {
            togglePhoneStreaming(); // Stop
            vdoWebView.postDelayed(this::togglePhoneStreaming, 600); // Restart with new camera
        }
    }

    private String getDeviceIpAddress() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int ip = wm.getConnectionInfo().getIpAddress();
                if (ip != 0) {
                    return String.format("%d.%d.%d.%d",
                            (ip & 0xFF),
                            ((ip >> 8) & 0xFF),
                            ((ip >> 16) & 0xFF),
                            ((ip >> 24) & 0xFF));
                }
            }
        } catch (Exception ignored) {}
        return "192.168.1.X";
    }

    private void showObsLinkDialog(String obsLink) {
        String directLocalStream = "http://" + getDeviceIpAddress() + ":8787/stream";
        new AlertDialog.Builder(this)
                .setTitle("🚀 Streaming to OBS Studio!")
                .setMessage("Canon 4000D කැමරාව OBS Studio එකට stream කිරීමට පහත Link එක OBS Browser Source එකට ලබා දෙන්න:\n\n"
                        + "🌐 VDO.Ninja Link (Cloud / Internet):\n" + obsLink + "\n\n"
                        + "⚡ Local Wi-Fi Direct Link (0-Latency / No Internet):\n" + directLocalStream)
                .setPositiveButton("📋 Copy VDO.Ninja Link", (dialog, which) -> {
                    copyObsLinkToClipboard();
                })
                .setNeutralButton("📋 Copy Local Link", (dialog, which) -> {
                    ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    ClipData clip = ClipData.newPlainText("OBS Local Stream", directLocalStream);
                    if (clipboard != null) {
                        clipboard.setPrimaryClip(clip);
                        Toast.makeText(this, "Local OBS Link Copied!", Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("OK", null)
                .show();
    }

    private void copyObsLinkToClipboard() {
        String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = ClipData.newPlainText("OBS Link", obsLink);
        if (clipboard != null) {
            clipboard.setPrimaryClip(clip);
            Toast.makeText(this, "OBS Link Copied!", Toast.LENGTH_SHORT).show();
        }
    }

    private void showQualityDialog() {
        String[] options = {
                "1080p 60FPS (Full HD - Highly Recommended)",
                "4K Ultra HD 60FPS (High Bitrate)",
                "720p 60FPS (Smooth / Low Latency)"
        };
        new AlertDialog.Builder(this)
                .setTitle("⚡ Select Video Quality")
                .setItems(options, (dialog, which) -> {
                    if (which == 0) selectedResolution = "1080p";
                    else if (which == 1) selectedResolution = "4k";
                    else if (which == 2) selectedResolution = "720p";

                    Button btnQuality = findViewById(R.id.btnPhoneQuality);
                    if (btnQuality != null) {
                        btnQuality.setText("⚡ " + selectedResolution.toUpperCase() + " 60FPS");
                    }
                    if (isPhoneBroadcasting) {
                        togglePhoneStreaming();
                        vdoWebView.postDelayed(this::togglePhoneStreaming, 600);
                    }
                })
                .show();
    }

    private void detectAndBindWifi() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                Network[] networks = cm.getAllNetworks();
                for (Network n : networks) {
                    NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                    if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                        currentWifiNetwork = n;
                        Log.i(TAG, "Found active Wi-Fi interface: " + n);
                        break;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Error finding active Wi-Fi: " + e.getMessage());
        }
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
                    currentWifiNetwork = network;
                    if (canonEngine != null) {
                        canonEngine.setWifiNetwork(network);
                    }
                    detectGatewayIp();
                }

                @Override
                public void onLost(@NonNull Network network) {
                    Log.w(TAG, "Wi-Fi Network lost");
                    if (currentWifiNetwork == network) {
                        currentWifiNetwork = null;
                    }
                    if (canonEngine != null) {
                        canonEngine.setWifiNetwork(null);
                    }
                }
            };

            if (cm != null) {
                cm.registerNetworkCallback(request, wifiNetworkCallback);
            }
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
                    int gw = dhcp.gateway;
                    String detectedIp = String.format("%d.%d.%d.%d",
                            (gw & 0xFF),
                            ((gw >> 8) & 0xFF),
                            ((gw >> 16) & 0xFF),
                            ((gw >> 24) & 0xFF));
                    if (!detectedIp.equals("0.0.0.0") && !detectedIp.equals(cameraIp)) {
                        cameraIp = detectedIp;
                        prefs.edit().putString(KEY_CAMERA_IP, cameraIp).apply();
                        runOnUiThread(() -> {
                            Toast.makeText(this, "Camera Gateway: " + cameraIp, Toast.LENGTH_SHORT).show();
                            if (currentMode == AppMode.CANON_DSLR) {
                                startLocalServices();
                            }
                        });
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void startLocalServices() {
        if (currentMode != AppMode.CANON_DSLR) return;
        try {
            if (canonEngine != null) {
                canonEngine.stop();
            }
            if (localServer != null) {
                localServer.stop();
            }

            detectAndBindWifi();

            canonEngine = new CanonPtpIpEngine(this, cameraIp, 15740);
            if (currentWifiNetwork != null) {
                canonEngine.setWifiNetwork(currentWifiNetwork);
            }

            canonEngine.setLogListener(line -> runOnUiThread(() -> {
                txtDiagInfo.setText(line);
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
                                    " | Shutter: OPEN | Frames: " + canonEngine.getTotalFramesReceived() +
                                    String.format(" (%.1f FPS)", canonEngine.getCurrentFps()));
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
        btnModePhone.setOnClickListener(v -> switchToPhoneCameraMode());
        btnModeCanon.setOnClickListener(v -> switchToCanonMode());

        // Phone Mode Controls
        Button btnStreamPhoneObs = findViewById(R.id.btnStreamPhoneObs);
        Button btnFlipPhoneCam = findViewById(R.id.btnFlipPhoneCam);
        Button btnCopyPhoneObsLink = findViewById(R.id.btnCopyPhoneObsLink);
        Button btnPhoneQuality = findViewById(R.id.btnPhoneQuality);

        btnStreamPhoneObs.setOnClickListener(v -> togglePhoneStreaming());
        btnFlipPhoneCam.setOnClickListener(v -> flipPhoneCamera());
        btnCopyPhoneObsLink.setOnClickListener(v -> copyObsLinkToClipboard());
        btnPhoneQuality.setOnClickListener(v -> showQualityDialog());

        // Canon Mode Controls
        Button btnShutter = findViewById(R.id.btnShutter);
        Button btnStreamObs = findViewById(R.id.btnStreamObs);
        Button btnToggleVdoView = findViewById(R.id.btnToggleVdoView);
        Button btnCopyCanonObsLink = findViewById(R.id.btnCopyCanonObsLink);
        Button btnSettings = findViewById(R.id.btnSettings);
        Button btnGuide = findViewById(R.id.btnGuide);

        if (btnToggleVdoView != null) {
            btnToggleVdoView.setOnClickListener(v -> toggleVdoScreenView(btnToggleVdoView));
        }

        if (btnCopyCanonObsLink != null) {
            btnCopyCanonObsLink.setOnClickListener(v -> {
                String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
                showObsLinkDialog(obsLink);
            });
        }

        Button btnFar3 = findViewById(R.id.btnFar3);
        Button btnFar1 = findViewById(R.id.btnFar1);
        Button btnNear1 = findViewById(R.id.btnNear1);
        Button btnNear3 = findViewById(R.id.btnNear3);

        if (btnGuide != null) {
            btnGuide.setOnClickListener(v -> showGuideDialog());
        }

        btnShutter.setOnClickListener(v -> {
            Toast.makeText(this, "📸 Firing Shutter...", Toast.LENGTH_SHORT).show();
            playCanonBeep();
            new Thread(() -> {
                if (canonEngine != null) {
                    canonEngine.triggerShutterRelease();
                }
            }).start();
        });

        btnFar3.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(1, 3); }).start());
        btnFar1.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(1, 1); }).start());
        btnNear1.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(2, 1); }).start());
        btnNear3.setOnClickListener(v -> new Thread(() -> { if (canonEngine != null) canonEngine.driveLensFocus(2, 3); }).start());

        imgLiveView.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                float x = event.getX();
                float y = event.getY();
                showFocusBox(x, y);
                playCanonBeep();
                new Thread(() -> {
                    if (canonEngine != null) {
                        boolean afOk = canonEngine.triggerAutoFocus();
                        if (!afOk) {
                            canonEngine.driveLensFocus(2, 1);
                        }
                    }
                }).start();
            }
            return true;
        });

        btnStreamObs.setOnClickListener(v -> toggleCanonObsStreaming(btnStreamObs));
        btnSettings.setOnClickListener(v -> showSettingsDialog());
    }

    private void showGuideDialog() {
        new AlertDialog.Builder(this)
                .setTitle("📷 Gaviru Cam Studio Help")
                .setMessage("📱 1. Phone Camera Mode:\n" +
                        "Phone එකේ කැමරාව (Back හෝ Front) භාවිතා කර VDO.Ninja හරහා OBS Studio වෙත 4K/1080p 60FPS සජීවීව Push කරයි.\n\n" +
                        "📷 2. Canon DSLR Wi-Fi Mode:\n" +
                        "Canon කැමරාවේ Wi-Fi Menu වෙත ගොස් 'Remote control (EOS Utility)' (💻 පරිගණක අයිකනය) තෝරා Phone එකෙන් connect වන්න. Camera dial එක 'M' හෝ 'P' මත තබන්න.")
                .setPositiveButton("තේරුණා (OK)", null)
                .show();
    }

    private void showFocusBox(float x, float y) {
        focusBox.setX(x - (focusBox.getWidth() / 2f));
        focusBox.setY(y - (focusBox.getHeight() / 2f));
        focusBox.setVisibility(View.VISIBLE);
        focusBox.postDelayed(() -> focusBox.setVisibility(View.GONE), 1600);
    }

    private boolean isViewingVdoScreen = false;

    private void toggleVdoScreenView(Button btn) {
        isViewingVdoScreen = !isViewingVdoScreen;
        if (isViewingVdoScreen) {
            imgLiveView.setVisibility(View.GONE);
            btn.setText("📷 Show Canon View");
            btn.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
            Toast.makeText(this, "Showing VDO.Ninja Screen", Toast.LENGTH_SHORT).show();
        } else {
            imgLiveView.setVisibility(View.VISIBLE);
            btn.setText("🌐 Show VDO.Ninja Screen");
            btn.setBackgroundTintList(ColorStateList.valueOf(0xFF2563EB));
            Toast.makeText(this, "Showing Canon Viewfinder", Toast.LENGTH_SHORT).show();
        }
    }

    private void toggleCanonObsStreaming(Button btnStreamObs) {
        isBroadcastingToObs = !isBroadcastingToObs;
        if (isBroadcastingToObs) {
            btnStreamObs.setText("⏹ Stop Canon OBS");
            btnStreamObs.setBackgroundTintList(ColorStateList.valueOf(0xFFF59E0B));
            String vdoPushUrl = "https://vdo.ninja/?push=" + roomName + "&webcam&autostart&noaudio&videobitrate=8000&fps=30&cleanoutput";
            vdoWebView.loadUrl(vdoPushUrl);

            // Automatically switch to VDO screen so user can confirm connection and click start if needed
            isViewingVdoScreen = true;
            imgLiveView.setVisibility(View.GONE);
            Button btnToggle = findViewById(R.id.btnToggleVdoView);
            if (btnToggle != null) {
                btnToggle.setText("📷 Show Canon View");
                btnToggle.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
            }

            String obsLink = "https://vdo.ninja/?view=" + roomName + "&cleanoutput";
            showObsLinkDialog(obsLink);
        } else {
            btnStreamObs.setText("🚀 Stream Canon ➔ OBS");
            btnStreamObs.setBackgroundTintList(ColorStateList.valueOf(0xFF10B981));
            vdoWebView.loadUrl("about:blank");
            isViewingVdoScreen = false;
            imgLiveView.setVisibility(View.VISIBLE);
            Button btnToggle = findViewById(R.id.btnToggleVdoView);
            if (btnToggle != null) {
                btnToggle.setText("🌐 Show VDO.Ninja Screen");
                btnToggle.setBackgroundTintList(ColorStateList.valueOf(0xFF2563EB));
            }
            Toast.makeText(this, "OBS Broadcast Stopped", Toast.LENGTH_SHORT).show();
        }
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
                if (canonEngine != null) {
                    byte[] frame = canonEngine.getLatestJpegFrame();
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
                if (currentMode == AppMode.CANON_DSLR && url != null && !url.equals("about:blank")) {
                    injectCanonWebcamShim(view);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (currentMode == AppMode.CANON_DSLR && url != null && !url.equals("about:blank")) {
                    injectCanonWebcamShim(view);
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e("VDO-Error", "Error " + errorCode + ": " + description);
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "⚠️ VDO.Ninja Error: " + description + "\n(Mobile Data On කර ඇත්දැයි බලන්න)", Toast.LENGTH_LONG).show();
                });
            }
        });

        vdoWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
                Log.d("VDO-JS", consoleMessage.message() + " [" + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + "]");
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress > 30 && currentMode == AppMode.CANON_DSLR) {
                    injectCanonWebcamShim(view);
                }
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
            "    let audioTracks = [];" +
            "    try {" +
            "      const AC = window.AudioContext || window.webkitAudioContext;" +
            "      if (AC) {" +
            "        const actx = new AC();" +
            "        const osc = actx.createOscillator();" +
            "        const dst = actx.createMediaStreamDestination();" +
            "        const gain = actx.createGain();" +
            "        gain.gain.value = 0;" +
            "        osc.connect(gain); gain.connect(dst); osc.start();" +
            "        audioTracks = dst.stream.getAudioTracks();" +
            "      }" +
            "    } catch(e) {}" +
            "    return new MediaStream([...vs.getVideoTracks(), ...audioTracks]);" +
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
            "    return Promise.resolve(createStream());" +
            "  };" +
            "  navigator.mediaDevices.getDisplayMedia = function(constraints) {" +
            "    return Promise.resolve(createStream());" +
            "  };" +
            "  navigator.getUserMedia = function(c, s, e) { if (s) s(createStream()); };" +
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
            "  console.log('✓ Canon Virtual Webcam Shim successfully armed');" +
            "})();";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            view.evaluateJavascript(js, null);
        } else {
            view.loadUrl("javascript:" + js);
        }
    }

    private void showSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("⚙️ Configuration Settings");

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(40, 20, 40, 10);

        final EditText inputRoom = new EditText(this);
        inputRoom.setHint("VDO.Ninja Room Name (default: gaviru-cam-pro)");
        inputRoom.setText(roomName);
        layout.addView(inputRoom);

        final EditText inputIp = new EditText(this);
        inputIp.setHint("Canon Camera Wi-Fi IP (default: 192.168.1.1)");
        inputIp.setText(cameraIp);
        layout.addView(inputIp);

        builder.setView(layout);
        builder.setPositiveButton("Save Settings", (dialog, which) -> {
            roomName = inputRoom.getText().toString().trim();
            cameraIp = inputIp.getText().toString().trim();
            if (roomName.isEmpty()) roomName = "gaviru-cam-pro";
            if (cameraIp.isEmpty()) cameraIp = "192.168.1.1";

            prefs.edit()
                    .putString(KEY_ROOM_NAME, roomName)
                    .putString(KEY_CAMERA_IP, cameraIp)
                    .apply();

            if (currentMode == AppMode.CANON_DSLR) {
                startLocalServices();
            } else {
                txtDiagInfo.setText("Mode: 📱 Phone Camera | Room: " + roomName + " | Ready to Stream");
            }
        });
        builder.setNegativeButton("Cancel", (dialog, which) -> dialog.cancel());
        builder.show();
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
            Toast.makeText(this, "Camera & Audio Permissions Granted!", Toast.LENGTH_SHORT).show();
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
