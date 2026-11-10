package com.gaviru.camstudio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Foreground Service for Gaviru Cam Studio.
 * Keeps Canon PTP/IP engine, LocalHttpServer (port 8787), Wi-Fi connection,
 * and background streaming alive 24/7 even when Chrome or other apps are active.
 */
public class GaviruCamForegroundService extends Service {

    private static final String TAG = "GaviruCamService";
    private static final String CHANNEL_ID = "gaviru_cam_service_channel";
    private static final int NOTIFICATION_ID = 4000;

    private static final String PREFS_NAME = "GaviruCamPrefs";
    private static final String KEY_CAMERA_IP = "camera_ip";
    private static final String KEY_ROOM_NAME = "vdo_room_name";

    private final IBinder binder = new LocalBinder();

    private CanonPtpIpEngine canonEngine;
    private LocalHttpServer localServer;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private Network currentWifiNetwork = null;

    private String cameraIp = "192.168.1.1";
    private String roomName = "gaviru_cam_pro";
    private boolean isRunning = false;

    public class LocalBinder extends Binder {
        public GaviruCamForegroundService getService() {
            return GaviruCamForegroundService.this;
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireLocks();

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        cameraIp = prefs.getString(KEY_CAMERA_IP, "192.168.1.1");
        roomName = prefs.getString(KEY_ROOM_NAME, "gaviru_cam_pro");

        startForeground(NOTIFICATION_ID, buildNotification("Initializing background service..."));
        registerWifiCallback();
        startEngines();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("camera_ip")) {
            String newIp = intent.getStringExtra("camera_ip");
            if (newIp != null && !newIp.equals(cameraIp)) {
                cameraIp = newIp;
                restartEngines();
            }
        }
        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Gaviru Cam Background Streaming",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Keeps Canon 4000D Wi-Fi connection and Port 8787 active in background");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String text) {
        Intent notifIntent = new Intent(this, MainActivity.class);
        notifIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, notifIntent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                        : PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("📷 Gaviru Cam Studio (Background Active)")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, buildNotification(text));
            }
        } catch (Exception ignored) {}
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GaviruCam::ServiceWakeLock");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(24 * 60 * 60 * 1000L); // 24 hours
            }

            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int wifiMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.HONEYCOMB_MR1
                        ? WifiManager.WIFI_MODE_FULL_HIGH_PERF
                        : WifiManager.WIFI_MODE_FULL;
                wifiLock = wm.createWifiLock(wifiMode, "GaviruCam::WifiLock");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "Error acquiring locks: " + e.getMessage());
        }
    }

    private void registerWifiCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                NetworkRequest req = new NetworkRequest.Builder()
                        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                        .build();

                wifiCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(@NonNull Network network) {
                        currentWifiNetwork = network;
                        if (canonEngine != null) {
                            canonEngine.setWifiNetwork(network);
                        }
                        detectGatewayIp();
                    }

                    @Override
                    public void onLost(@NonNull Network network) {
                        if (currentWifiNetwork == network) {
                            currentWifiNetwork = null;
                        }
                        if (canonEngine != null) {
                            canonEngine.setWifiNetwork(null);
                        }
                    }
                };
                cm.registerNetworkCallback(req, wifiCallback);
            }
        } catch (Exception e) {
            Log.w(TAG, "registerWifiCallback error: " + e.getMessage());
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
                        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                                .edit().putString(KEY_CAMERA_IP, cameraIp).apply();
                        restartEngines();
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    public synchronized void startEngines() {
        if (isRunning) return;
        isRunning = true;

        try {
            canonEngine = new CanonPtpIpEngine(this, cameraIp, 15740);
            if (currentWifiNetwork != null) {
                canonEngine.setWifiNetwork(currentWifiNetwork);
            }

            canonEngine.setLogListener(line -> {
                if (line.contains("LIVE") || line.contains("Live View Active")) {
                    updateNotification("🟢 Live View Streaming (" + String.format("%.1f", canonEngine.getCurrentFps()) + " FPS) | Port 8787");
                } else if (line.contains("Error") || line.contains("❌")) {
                    updateNotification("🔴 Camera Disconnected | " + cameraIp);
                }
            });

            canonEngine.start();

            localServer = new LocalHttpServer(this, canonEngine);
            localServer.setRoomName(roomName);
            localServer.start();

            updateNotification("Connecting to Canon " + cameraIp + ":15740 | Port 8787 Active");
        } catch (Exception e) {
            Log.e(TAG, "Error starting engines: " + e.getMessage());
        }
    }

    public synchronized void stopEngines() {
        isRunning = false;
        if (canonEngine != null) {
            canonEngine.stop();
            canonEngine = null;
        }
        if (localServer != null) {
            localServer.stop();
            localServer = null;
        }
    }

    public synchronized void restartEngines() {
        stopEngines();
        startEngines();
    }

    public CanonPtpIpEngine getCanonEngine() {
        return canonEngine;
    }

    public LocalHttpServer getLocalServer() {
        return localServer;
    }

    public String getCameraIp() {
        return cameraIp;
    }

    public void setCameraIp(String ip) {
        if (ip != null && !ip.equals(cameraIp)) {
            this.cameraIp = ip;
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit().putString(KEY_CAMERA_IP, cameraIp).apply();
            restartEngines();
        }
    }

    public String getRoomName() {
        return roomName;
    }

    public void setRoomName(String room) {
        this.roomName = room;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit().putString(KEY_ROOM_NAME, roomName).apply();
        if (localServer != null) {
            localServer.setRoomName(roomName);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopEngines();

        try {
            if (wifiCallback != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(wifiCallback);
            }
        } catch (Exception ignored) {}

        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
    }
}
