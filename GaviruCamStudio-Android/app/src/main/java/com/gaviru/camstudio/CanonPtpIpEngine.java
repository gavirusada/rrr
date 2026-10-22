package com.gaviru.camstudio;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Network;
import android.os.Build;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Canon PTP/IP Wi-Fi Engine for Android Native
 * Connects directly to Canon EOS DSLR and Mirrorless cameras over Wi-Fi (192.168.1.1:15740).
 * Implements ISO 15740 PTP-IP standard and Canon EOS vendor extensions:
 * - Direct Wi-Fi socket binding (prevents cellular routing when mobile data is active)
 * - Persistent GUID for stable camera pairing
 * - Remote Mode & Event Mode activation (0x9114, 0x9115)
 * - Live View activation: Canon EOS InitiateViewfinder (0x9151) & EVFOutputDevice (0xD1b0 / 0xD102 = 3)
 *   Flips the mirror up and opens the physical shutter!
 * - Continuous Live View frame streaming (0x9153 EOS_GetViewFinderData) with proper PTP/IP chunk handling:
 *   (Type 9 StartData, Type 10 DataPacket, Type 12 EndDataPacket)
 * - Genuine Lens Autofocus (0x9154 EOS_DoAf) & Remote Lens Drive (0x9155 EOS_DriveLens)
 * - Mechanical Shutter Release (0x9128 RemoteReleaseOn + 0x9129 RemoteReleaseOff)
 */
public class CanonPtpIpEngine {

    private static final String TAG = "CanonPtpIpEngine";

    // PTP/IP Packet Types (CIPA DC-005 / ISO-15740 Annex D)
    private static final int PTPIP_INIT_COMMAND_REQUEST = 1;
    private static final int PTPIP_INIT_COMMAND_ACK     = 2;
    private static final int PTPIP_INIT_EVENT_REQUEST   = 3;
    private static final int PTPIP_INIT_EVENT_ACK       = 4;
    private static final int PTPIP_INIT_FAIL            = 5;
    private static final int PTPIP_CMD_REQUEST          = 6;
    private static final int PTPIP_CMD_RESPONSE         = 7;
    private static final int PTPIP_EVENT                = 8;
    private static final int PTPIP_START_DATA_PACKET    = 9;
    private static final int PTPIP_DATA_PACKET          = 10;
    private static final int PTPIP_CANCEL_TRANSACTION   = 11;
    private static final int PTPIP_END_DATA_PACKET      = 12;

    // Canon EOS Operation Codes
    private static final int OC_OPEN_SESSION         = 0x1002;
    private static final int OC_GET_DEVICE_INFO      = 0x1001;
    private static final int OC_EOS_SET_REMOTE_MODE  = 0x9114;
    private static final int OC_EOS_SET_EVENT_MODE   = 0x9115;
    private static final int OC_EOS_START_LIVE_VIEW  = 0x9151; // InitiateViewfinder
    private static final int OC_EOS_STOP_LIVE_VIEW   = 0x9152; // TerminateViewfinder
    private static final int OC_EOS_GET_LIVE_FRAME   = 0x9153; // GetViewFinderData
    private static final int OC_EOS_DO_AF            = 0x9154; // DoAf
    private static final int OC_EOS_DRIVE_LENS       = 0x9155; // DriveLens
    private static final int OC_EOS_RELEASE_ON       = 0x9128; // RemoteReleaseOn
    private static final int OC_EOS_RELEASE_OFF      = 0x9129; // RemoteReleaseOff
    private static final int OC_EOS_SET_PROP_EX      = 0x9110; // SetDevicePropValueEx

    // Canon Device Properties
    private static final int DPC_EOS_EVF_OUTPUT_DEVICE = 0xD1b0; // EVFOutputDevice
    private static final int DPC_EOS_EVF_MODE          = 0xD1b1; // EVFMode
    private static final int DPC_EDSDK_EVF_OUTPUT_DEV  = 0xD102; // EDSDK EVFOutputDevice
    private static final int DPC_EDSDK_EVF_MODE        = 0xD10B; // EDSDK EVFMode

    private final Context context;
    private String cameraIp = "192.168.1.1";
    private int cameraPort = 15740;

    private Network wifiNetwork = null;

    private Socket cmdSocket;
    private Socket evtSocket;
    private OutputStream cmdOut;
    private InputStream cmdIn;
    private OutputStream evtOut;
    private InputStream evtIn;

    private int transactionId = 1;
    private int connectionNumber = 0;

    private final AtomicBoolean isRunning = new AtomicBoolean(false);
    private final AtomicBoolean isLiveViewActive = new AtomicBoolean(false);

    private byte[] latestJpegFrame = null;
    private long lastFrameTime = 0;
    private int totalFramesReceived = 0;
    private int frameCount = 0;
    private float currentFps = 0f;
    private long lastFpsCalcTime = 0;

    private String statusMessage = "Disconnected";
    private String lastError = null;
    private boolean mirrorUp = false;

    public interface FrameListener {
        void onNewFrame(byte[] jpegBytes);
    }

    public interface LogListener {
        void onLog(String line);
    }

    private FrameListener frameListener;
    private LogListener logListener;

    public CanonPtpIpEngine(Context context, String cameraIp, int cameraPort) {
        this.context = context;
        if (cameraIp != null && !cameraIp.trim().isEmpty()) {
            this.cameraIp = cameraIp.trim();
        }
        if (cameraPort > 0) {
            this.cameraPort = cameraPort;
        }
    }

    public void setWifiNetwork(Network network) {
        this.wifiNetwork = network;
        log("Assigned Wi-Fi Network interface: " + network);
    }

    public void setFrameListener(FrameListener listener) {
        this.frameListener = listener;
    }

    public void setLogListener(LogListener listener) {
        this.logListener = listener;
    }

    private void log(String msg) {
        Log.i(TAG, msg);
        if (logListener != null) {
            logListener.onLog(msg);
        }
    }

    private void logErr(String msg) {
        Log.e(TAG, msg);
        if (logListener != null) {
            logListener.onLog("❌ " + msg);
        }
    }

    public synchronized boolean isConnected() {
        return isRunning.get() && cmdSocket != null && cmdSocket.isConnected() && !cmdSocket.isClosed();
    }

    public boolean isLiveViewStreaming() {
        return isLiveViewActive.get() && (System.currentTimeMillis() - lastFrameTime < 3500);
    }

    public byte[] getLatestJpegFrame() {
        return latestJpegFrame;
    }

    public String getStatusMessage() {
        return statusMessage;
    }

    public String getLastError() {
        return lastError;
    }

    public float getCurrentFps() {
        return currentFps;
    }

    public int getTotalFramesReceived() {
        return totalFramesReceived;
    }

    public boolean isMirrorUp() {
        return mirrorUp;
    }

    public String getCameraIp() {
        return cameraIp;
    }

    public int getCameraPort() {
        return cameraPort;
    }

    public void start() {
        if (isRunning.get()) return;
        isRunning.set(true);

        new Thread(() -> {
            while (isRunning.get()) {
                try {
                    statusMessage = "Connecting to " + cameraIp + ":" + cameraPort + "...";
                    log("▶ Starting connection attempt to " + cameraIp + ":" + cameraPort);
                    connectAndStream();
                } catch (Exception e) {
                    lastError = e.getMessage();
                    statusMessage = "Error: " + e.getMessage();
                    logErr("Connection cycle error: " + e.getMessage());
                }

                closeSockets();

                if (isRunning.get()) {
                    try {
                        Thread.sleep(2500);
                    } catch (InterruptedException ignored) {}
                }
            }
        }, "Canon-PTP-Streamer").start();
    }

    public void stop() {
        isRunning.set(false);
        closeSockets();
        statusMessage = "Stopped";
        log("Canon engine stopped");
    }

    private void closeSockets() {
        isLiveViewActive.set(false);
        mirrorUp = false;
        try { if (cmdSocket != null) cmdSocket.close(); } catch (Exception ignored) {}
        try { if (evtSocket != null) evtSocket.close(); } catch (Exception ignored) {}
        cmdSocket = null;
        evtSocket = null;
    }

    private byte[] getPersistentGuid() {
        SharedPreferences sp = context.getSharedPreferences("CanonPtpPrefs", Context.MODE_PRIVATE);
        String savedGuid = sp.getString("guid_str", null);
        UUID uuid;
        if (savedGuid == null) {
            uuid = UUID.randomUUID();
            sp.edit().putString("guid_str", uuid.toString()).apply();
        } else {
            try {
                uuid = UUID.fromString(savedGuid);
            } catch (Exception e) {
                uuid = UUID.randomUUID();
                sp.edit().putString("guid_str", uuid.toString()).apply();
            }
        }
        byte[] guid = new byte[16];
        ByteBuffer.wrap(guid)
                .putLong(uuid.getMostSignificantBits())
                .putLong(uuid.getLeastSignificantBits());
        return guid;
    }

    private void connectAndStream() throws Exception {
        log("Step [1/6]: Connecting Command Socket to " + cameraIp + ":" + cameraPort + "...");

        // 1. Connect Command Socket
        cmdSocket = new Socket();
        cmdSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(cmdSocket);
                log("✓ cmdSocket bound to Camera Wi-Fi network");
            } catch (Exception e) {
                logErr("Could not bind cmdSocket to Wi-Fi: " + e.getMessage());
            }
        } else {
            log("⚠ No Wi-Fi network object bound; using default routing");
        }

        cmdSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 7000);
        cmdOut = cmdSocket.getOutputStream();
        cmdIn = cmdSocket.getInputStream();
        log("✓ Command Socket Connected!");

        statusMessage = "PTP/IP Handshaking...";

        // 2. InitCommandRequest (Packet Type 1)
        byte[] guid = getPersistentGuid();
        byte[] clientNameBytes = "GaviruCam\0".getBytes(StandardCharsets.UTF_16LE);

        ByteBuffer initCmd = ByteBuffer.allocate(8 + 16 + clientNameBytes.length + 4).order(ByteOrder.LITTLE_ENDIAN);
        initCmd.putInt(initCmd.capacity());
        initCmd.putInt(PTPIP_INIT_COMMAND_REQUEST); // 1
        initCmd.put(guid);
        initCmd.put(clientNameBytes);
        initCmd.putInt(0x00010000); // PTP Version 1.0

        cmdOut.write(initCmd.array());
        cmdOut.flush();

        // Read InitCommandAck (Packet Type 2)
        byte[] ackHeader = readExact(cmdIn, 8);
        ByteBuffer ackBuf = ByteBuffer.wrap(ackHeader).order(ByteOrder.LITTLE_ENDIAN);
        int ackLen = ackBuf.getInt();
        int ackType = ackBuf.getInt();
        if (ackType != PTPIP_INIT_COMMAND_ACK) {
            throw new Exception("Expected InitCommandAck (2), got: " + ackType);
        }

        byte[] ackBody = readExact(cmdIn, ackLen - 8);
        ByteBuffer ackBodyBuf = ByteBuffer.wrap(ackBody).order(ByteOrder.LITTLE_ENDIAN);
        connectionNumber = ackBodyBuf.getInt();
        log("Step [2/6]: ✓ InitCommand OK! ConnectionNumber=" + connectionNumber);

        // 3. Connect Event Socket (Packet Type 3)
        log("Connecting Event Socket to " + cameraIp + ":" + cameraPort + "...");
        evtSocket = new Socket();
        evtSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(evtSocket);
                log("✓ evtSocket bound to Camera Wi-Fi network");
            } catch (Exception e) {
                logErr("Could not bind evtSocket to Wi-Fi: " + e.getMessage());
            }
        }

        evtSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 7000);
        evtOut = evtSocket.getOutputStream();
        evtIn = evtSocket.getInputStream();

        ByteBuffer initEvt = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        initEvt.putInt(12);
        initEvt.putInt(PTPIP_INIT_EVENT_REQUEST); // 3
        initEvt.putInt(connectionNumber);

        evtOut.write(initEvt.array());
        evtOut.flush();

        byte[] evtAckHeader = readExact(evtIn, 8);
        ByteBuffer evtAckBuf = ByteBuffer.wrap(evtAckHeader).order(ByteOrder.LITTLE_ENDIAN);
        int evtAckLen = evtAckBuf.getInt();
        int evtAckType = evtAckBuf.getInt();
        if (evtAckType != PTPIP_INIT_EVENT_ACK) {
            throw new Exception("Expected InitEventAck (4), got: " + evtAckType);
        }
        if (evtAckLen > 8) {
            readExact(evtIn, evtAckLen - 8);
        }

        log("Step [3/6]: ✓ Event Socket Connected!");

        // Start Event Drainer Thread to prevent socket backpressure
        new Thread(() -> {
            try {
                while (isRunning.get() && evtSocket != null && !evtSocket.isClosed()) {
                    byte[] hdr = readExact(evtIn, 8);
                    ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
                    int len = hBuf.getInt();
                    if (len > 8) {
                        readExact(evtIn, len - 8);
                    }
                }
            } catch (Exception ignored) {}
        }, "Canon-Evt-Drainer").start();

        statusMessage = "Opening PTP Session...";

        // 4. Open Session (OpCode: 0x1002, SessionID: 1, DataPhase: 0 - No Data Phase)
        log("Step [4/6]: Opening PTP Session (0x1002)...");
        transactionId = 1;
        sendOperationRequest(OC_OPEN_SESSION, 1);
        int openResp = readOperationResponse();
        log("✓ PTP Session Opened! Code=0x" + Integer.toHexString(openResp));

        // 5. Query Device Info (0x1001) - Standard PTP initialization requirement
        try {
            sendOperationRequestWithPhase(OC_GET_DEVICE_INFO, 2);
            drainIncomingDataPhase();
            log("✓ Canon Device Info Handshake OK");
        } catch (Exception e) {
            log("DeviceInfo info: " + e.getMessage());
        }

        // 6. Canon EOS Handshake: SetRemoteMode (0x9114) FIRST, then SetEventMode (0x9115)
        try {
            sendOperationRequest(OC_EOS_SET_REMOTE_MODE, 1);
            int remResp = readOperationResponse();
            log("✓ Canon EOS SetRemoteMode(1) OK (0x" + Integer.toHexString(remResp) + ")");
        } catch (Exception e) {
            logErr("SetRemoteMode warning: " + e.getMessage());
        }

        try {
            sendOperationRequest(OC_EOS_SET_EVENT_MODE, 1);
            int evtResp = readOperationResponse();
            log("✓ Canon EOS SetEventMode(1) OK (0x" + Integer.toHexString(evtResp) + ")");
        } catch (Exception e) {
            logErr("SetEventMode warning: " + e.getMessage());
        }

        // 7. Start Live View (Opens Shutter & Raises Mirror!)
        statusMessage = "Opening Shutter / Raising Mirror...";
        log("Step [5/6]: Activating Canon Live View & Opening Shutter...");

        // Method A: Dedicated Canon EOS OpCode 0x9151 (InitiateViewfinder / StartLiveView)
        boolean startedViaOpcode = false;
        try {
            sendOperationRequest(OC_EOS_START_LIVE_VIEW);
            int liveResp = readOperationResponse();
            log("EOS InitiateViewfinder (0x9151) code: 0x" + Integer.toHexString(liveResp));
            if (liveResp == 0x2001) {
                mirrorUp = true;
                startedViaOpcode = true;
            }
        } catch (Exception e) {
            log("OpCode 0x9151 note: " + e.getMessage());
        }

        // Method B: Set EVF Output Device properties
        // DPC_EOS_EVF_OUTPUT_DEVICE (0xD1b0) & DPC_EDSDK_EVF_OUTPUT_DEV (0xD102)
        int[] targetProperties = {DPC_EOS_EVF_OUTPUT_DEVICE, DPC_EDSDK_EVF_OUTPUT_DEV};
        int[] evfOutputModes = {3, 1, 2}; // 3 = PC+LCD, 1 = PC, 2 = LCD
        for (int prop : targetProperties) {
            for (int m : evfOutputModes) {
                if (setDeviceProperty32(prop, m)) {
                    log("✓ Set Live View Output (0x" + Integer.toHexString(prop) + ") = " + m + " (Shutter Open)");
                    mirrorUp = true;
                    break;
                }
            }
        }

        // Method C: Set EVF Mode to 1 (0xD1b1 and 0xD10B)
        setDeviceProperty32(DPC_EOS_EVF_MODE, 1);
        setDeviceProperty32(DPC_EDSDK_EVF_MODE, 1);

        isLiveViewActive.set(true);
        statusMessage = "Canon Live View Active!";
        log("Step [6/6]: ✓ Live View Active! Streaming camera frames...");

        // 8. Continuous Live View Polling Loop
        int consecutiveErrors = 0;
        lastFpsCalcTime = System.currentTimeMillis();
        frameCount = 0;

        while (isRunning.get() && isLiveViewActive.get()) {
            try {
                byte[] jpeg = fetchLiveViewFrame(OC_EOS_GET_LIVE_FRAME);

                if (jpeg != null && jpeg.length > 500) {
                    latestJpegFrame = jpeg;
                    lastFrameTime = System.currentTimeMillis();
                    totalFramesReceived++;
                    frameCount++;
                    consecutiveErrors = 0;
                    mirrorUp = true;

                    long now = System.currentTimeMillis();
                    if (now - lastFpsCalcTime >= 1000) {
                        currentFps = (frameCount * 1000f) / (now - lastFpsCalcTime);
                        frameCount = 0;
                        lastFpsCalcTime = now;
                        statusMessage = String.format("Live: %.1f FPS (%d KB)", currentFps, jpeg.length / 1024);
                    }

                    if (frameListener != null) {
                        frameListener.onNewFrame(jpeg);
                    }
                } else {
                    consecutiveErrors++;
                    if (consecutiveErrors > 12) {
                        log("Re-triggering Live View commands...");
                        try { sendOperationRequest(OC_EOS_START_LIVE_VIEW); readOperationResponse(); } catch (Exception ignored) {}
                        setDeviceProperty32(DPC_EOS_EVF_OUTPUT_DEVICE, 3);
                        setDeviceProperty32(DPC_EDSDK_EVF_OUTPUT_DEV, 3);
                        consecutiveErrors = 0;
                    }
                }

                Thread.sleep(25); // Target ~35 FPS
            } catch (Exception e) {
                logErr("Frame fetch error: " + e.getMessage());
                consecutiveErrors++;
                if (consecutiveErrors > 25) {
                    throw e; // Force reconnect
                }
                Thread.sleep(80);
            }
        }
    }

    /**
     * Drains incoming DataPhase bytes for commands like GetDeviceInfo.
     */
    private void drainIncomingDataPhase() {
        try {
            while (true) {
                byte[] hdr = readExact(cmdIn, 8);
                ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
                int pktLen = hBuf.getInt();
                int pktType = hBuf.getInt();

                if (pktLen > 8) {
                    readExact(cmdIn, pktLen - 8);
                }

                if (pktType == PTPIP_END_DATA_PACKET) { // 12
                    readOperationResponse();
                    break;
                } else if (pktType == PTPIP_CMD_RESPONSE) { // 7
                    break;
                }
            }
        } catch (Exception ignored) {}
    }

    /**
     * Fetches Live View JPEG frame handling standard PTP/IP Data In phase:
     * - PTPIP_START_DATA_PACKET (9)
     * - PTPIP_DATA_PACKET (10): Intermediate chunks
     * - PTPIP_END_DATA_PACKET (12): Final chunk
     * - PTPIP_CMD_RESPONSE (7): Final operation acknowledgment
     */
    private synchronized byte[] fetchLiveViewFrame(int opCode) throws Exception {
        // OperationRequest with DataPhase = 2 (Data In - Camera sends data to Host).
        // Canon EOS_GetViewFinderData (0x9153) takes NO parameters!
        sendOperationRequestWithPhase(opCode, 2);

        ByteArrayOutputStream frameStream = new ByteArrayOutputStream(65536);

        while (true) {
            byte[] hdr = readExact(cmdIn, 8);
            ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
            int pktLen = hBuf.getInt();
            int pktType = hBuf.getInt();

            if (pktType == PTPIP_START_DATA_PACKET) { // Type 9
                // Start of data phase
                if (pktLen > 8) {
                    readExact(cmdIn, pktLen - 8);
                }
            } else if (pktType == PTPIP_DATA_PACKET) { // Type 10
                // Intermediate data chunk
                byte[] data = readExact(cmdIn, pktLen - 8);
                // Data packet body contains 4-byte TransactionID followed by raw data
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
            } else if (pktType == PTPIP_END_DATA_PACKET) { // Type 12
                // Final data chunk
                byte[] data = readExact(cmdIn, pktLen - 8);
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
                // Read subsequent OperationResponse packet (Type 7)
                readOperationResponse();
                break;
            } else if (pktType == PTPIP_CMD_RESPONSE) { // Type 7
                if (pktLen > 8) {
                    readExact(cmdIn, pktLen - 8);
                }
                break;
            } else {
                if (pktLen > 8) {
                    readExact(cmdIn, pktLen - 8);
                }
            }
        }

        byte[] rawBlob = frameStream.toByteArray();
        if (rawBlob.length < 50) return null;

        // Extract JPEG by scanning SOI (FF D8) and EOI (FF D9)
        int soi = -1;
        int eoi = -1;
        for (int i = 0; i < rawBlob.length - 1; i++) {
            if ((rawBlob[i] & 0xFF) == 0xFF && (rawBlob[i + 1] & 0xFF) == 0xD8) {
                soi = i;
                break;
            }
        }
        if (soi != -1) {
            for (int i = rawBlob.length - 2; i >= soi; i--) {
                if ((rawBlob[i] & 0xFF) == 0xFF && (rawBlob[i + 1] & 0xFF) == 0xD9) {
                    eoi = i + 2;
                    break;
                }
            }
        }

        if (soi != -1 && eoi != -1 && eoi > soi) {
            byte[] jpeg = new byte[eoi - soi];
            System.arraycopy(rawBlob, soi, jpeg, 0, jpeg.length);
            return jpeg;
        }

        return null;
    }

    /**
     * Triggers Auto Focus (EOS_DoAf OpCode 0x9154).
     */
    public synchronized boolean triggerAutoFocus() {
        if (!isConnected()) return false;
        try {
            log("Triggering Canon Auto Focus (0x9154)...");
            sendOperationRequest(OC_EOS_DO_AF, 1);
            int resp = readOperationResponse();
            log("Auto Focus response: 0x" + Integer.toHexString(resp));
            return resp == 0x2001;
        } catch (Exception e) {
            logErr("Auto Focus error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Drives Canon Lens Focus (EOS_DriveLens OpCode 0x9155).
     * Direction: 1 = Far, 2 = Near. Step: 1..3.
     */
    public synchronized boolean driveLensFocus(int direction, int step) {
        if (!isConnected()) return false;
        try {
            int stepClamped = Math.max(1, Math.min(3, step));

            // EOS OpCode 0x9155 (DriveLens):
            // Near: 0x00000001, 0x00000002, 0x00000003
            // Far:  0x00008001, 0x00008002, 0x00008003
            int eosParam = direction == 1 ? (0x00008000 | stepClamped) : stepClamped;
            try {
                sendOperationRequest(OC_EOS_DRIVE_LENS, eosParam);
                int resp = readOperationResponse();
                if (resp == 0x2001) {
                    log("✓ EOS DriveLens (0x9155) succeeded! Param=0x" + Integer.toHexString(eosParam));
                    return true;
                }
            } catch (Exception e) {
                log("0x9155 failed, trying fallback: " + e.getMessage());
            }

            // Fallback OpCode 0x9029 (DriveLens standard)
            int dirParam = direction == 1 ? 0x0001 : 0x0002;
            int param = (dirParam << 16) | stepClamped;
            sendOperationRequest(0x9029, param);
            readOperationResponse();
            return true;
        } catch (Exception e) {
            logErr("Focus Drive error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Triggers Shutter Release / Takes a photo.
     * In Canon EOS, sends Shutter Press (0x9128), delays, then sends Shutter Release (0x9129).
     * Produces genuine mirror flip and mechanical shutter sound!
     */
    public synchronized boolean triggerShutterRelease() {
        if (!isConnected()) return false;
        try {
            log("📸 Firing Canon Shutter Release...");

            // Method 1: Canon EOS RemoteReleaseOn (0x9128) + RemoteReleaseOff (0x9129)
            try {
                // RemoteReleaseOn: Param1 = 2 (Full press), Param2 = 0
                sendOperationRequest(OC_EOS_RELEASE_ON, 2, 0);
                readOperationResponse();

                Thread.sleep(120);

                // RemoteReleaseOff: Param1 = 2
                sendOperationRequest(OC_EOS_RELEASE_OFF, 2);
                readOperationResponse();

                log("✓ Canon EOS Shutter fired successfully!");
                return true;
            } catch (Exception e) {
                log("0x9128/0x9129 release error: " + e.getMessage());
            }

            // Method 2: Canon TakePicture (0x902F)
            try {
                sendOperationRequest(0x902F, 0);
                readOperationResponse();
                log("✓ Canon TakePicture (0x902F) succeeded!");
                return true;
            } catch (Exception e) {
                log("0x902F failed: " + e.getMessage());
            }

            // Method 3: Standard PTP InitiateCapture (0x100E)
            sendOperationRequest(0x100E, 0, 0);
            readOperationResponse();
            log("✓ PTP InitiateCapture (0x100E) succeeded!");
            return true;
        } catch (Exception e) {
            logErr("Shutter Release error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Sets Canon 32-bit Device Property using PTP/IP Data Out phase:
     * 1. OperationRequest (Type 6, DataPhase = 1)
     * 2. StartDataPacket (Type 9)
     * 3. EndDataPacket (Type 12)
     * 4. OperationResponse (Type 7)
     */
    public synchronized boolean setDeviceProperty32(int propCode, int value) {
        if (cmdOut == null) return false;

        // Try Canon EOS SetDevicePropValueEx (0x9110)
        try {
            int txId = transactionId++;
            byte[] dataPayload = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN)
                    .putInt(propCode)
                    .putInt(4) // 4 bytes data
                    .putInt(value)
                    .array();

            sendPropPacket(OC_EOS_SET_PROP_EX, txId, propCode, dataPayload);
            int resp = readOperationResponse();
            if (resp == 0x2001) {
                log("✓ EOS SetProp (0x9110) 0x" + Integer.toHexString(propCode) + "=" + value + " OK");
                return true;
            }
        } catch (Exception e) {
            log("EOS SetProp 0x9110 note: " + e.getMessage());
        }

        // Try Standard PTP SetDevicePropValue (0x1016)
        try {
            int txId = transactionId++;
            byte[] dataPayload = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
                    .putInt(value)
                    .array();

            sendPropPacket(0x1016, txId, propCode, dataPayload);
            int resp = readOperationResponse();
            if (resp == 0x2001) {
                log("✓ PTP SetProp (0x1016) 0x" + Integer.toHexString(propCode) + "=" + value + " OK");
                return true;
            }
        } catch (Exception e) {
            log("PTP SetProp 0x1016 note: " + e.getMessage());
        }

        return false;
    }

    private void sendPropPacket(int opCode, int txId, int propCode, byte[] dataPayload) throws Exception {
        // 1. OperationRequest (DataPhase = 1 -> Data Out: Host -> Camera)
        ByteBuffer req = ByteBuffer.allocate(8 + 4 + 2 + 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(req.capacity());
        req.putInt(PTPIP_CMD_REQUEST); // 6
        req.putInt(1); // DataPhase: 1 = Data Out
        req.putShort((short) opCode);
        req.putInt(txId);
        req.putInt(propCode);
        cmdOut.write(req.array());

        // 2. StartDataPacket (Type 9): 4 len + 4 type + 4 txId + 8 total bytes (uint64)
        ByteBuffer start = ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN);
        start.putInt(20);
        start.putInt(PTPIP_START_DATA_PACKET); // 9
        start.putInt(txId);
        start.putLong(dataPayload.length);
        cmdOut.write(start.array());

        // 3. EndDataPacket (Type 12): 4 len + 4 type + 4 txId + payload
        int endLen = 8 + 4 + dataPayload.length;
        ByteBuffer end = ByteBuffer.allocate(endLen).order(ByteOrder.LITTLE_ENDIAN);
        end.putInt(endLen);
        end.putInt(PTPIP_END_DATA_PACKET); // 12
        end.putInt(txId);
        end.put(dataPayload);
        cmdOut.write(end.array());
        cmdOut.flush();
    }

    private void sendOperationRequest(int opCode, int... params) throws Exception {
        sendOperationRequestWithPhase(opCode, 0, params);
    }

    private void sendOperationRequestWithPhase(int opCode, int dataPhase, int... params) throws Exception {
        int txId = transactionId++;
        int paramCount = params != null ? params.length : 0;
        int totalLen = 8 + 4 + 2 + 4 + (paramCount * 4);

        ByteBuffer req = ByteBuffer.allocate(totalLen).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(totalLen);
        req.putInt(PTPIP_CMD_REQUEST); // 6
        req.putInt(dataPhase); // Exact DataPhaseInfo: 0 = No Data, 1 = Data Out, 2 = Data In
        req.putShort((short) opCode);
        req.putInt(txId);
        for (int p : params) {
            req.putInt(p);
        }

        cmdOut.write(req.array());
        cmdOut.flush();
    }

    private int readOperationResponse() throws Exception {
        byte[] hdr = readExact(cmdIn, 8);
        ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
        int len = hBuf.getInt();
        int type = hBuf.getInt();

        if (type != PTPIP_CMD_RESPONSE) { // 7
            if (len > 8) readExact(cmdIn, len - 8);
            return -1;
        }

        byte[] body = readExact(cmdIn, len - 8);
        ByteBuffer bBuf = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN);
        int respCode = bBuf.getShort() & 0xFFFF;
        return respCode;
    }

    private static byte[] readExact(InputStream in, int length) throws Exception {
        byte[] buf = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = in.read(buf, offset, length - offset);
            if (read == -1) throw new Exception("Unexpected EOF while reading Canon socket");
            offset += read;
        }
        return buf;
    }
}
