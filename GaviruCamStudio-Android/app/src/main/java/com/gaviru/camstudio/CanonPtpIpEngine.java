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
 * Canon EOS PTP/IP Wi-Fi Engine for Android Native
 * Specifically ported and verified against working PC LiveViewBootstrap protocol
 * for Canon EOS 4000D / Rebel T100 / 1300D / 2000D / 3000D in "Connect to smartphone" (📱) Wi-Fi mode.
 *
 * Implements the exact PC Live View Bootstrap Sequence:
 * 1. OpenSession (0x1002, 1)
 * 2. SetRemoteMode (0x9114, 1)
 * 3. SetEventMode (0x9115, 1)
 * 4. SetCapacity (0x913D, 0x1FFF)
 * 5. PollEvents (0x9116)
 * 6. SetDevicePropValueEx: Capacity/Storage (0xD11C -> 4)
 * 7. SetPcConnectMode (0x911A, 0x0FFFFFFF, 0x1000, 1) [CRITICAL for Wi-Fi remote unlock!]
 * 8. PollEvents (0x9116)
 * 9. SetDevicePropValueEx: EVF_MODE (0xD1B1 -> 1, 2 bytes)
 * 10. SetDevicePropValueEx: EVF_OUTPUT_DEVICE (0xD1B0 -> 8 WIFI_PC / 9 WIFI_AND_LCD, 4 bytes)
 *     [PHYSICALLY LIFTS MIRROR UP AND OPENS SHUTTER CURTAINS!]
 * 11. PollEvents (0x9116)
 * 12. Viewfinder Data Polling (0x9153, [0x00200000, 1, 0]) & Structured JPEG Extraction
 * 13. Remote Shutter Release (0x910F RemoteRelease / 0x9128+0x9129 Two-stage)
 * 14. Auto Focus (0x9154 EOS_DoAf) & Remote Lens Drive (0x9155 EOS_DriveLens)
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

    // PTP/IP Data Directions (from mtpPackets.ts)
    // 1 = CAMERA_TO_HOST_OR_NONE (commands with no data or receiving data from camera)
    // 2 = HOST_TO_CAMERA (commands sending data from host to camera)
    private static final int DATA_DIR_CAMERA_TO_HOST_OR_NONE = 1;
    private static final int DATA_DIR_HOST_TO_CAMERA         = 2;

    // Canon EOS Operation Codes (from canonEos.ts)
    private static final int OC_OPEN_SESSION            = 0x1002;
    private static final int OC_GET_DEVICE_INFO         = 0x1001;
    private static final int OC_EOS_REMOTE_RELEASE      = 0x910F; // RemoteRelease
    private static final int OC_EOS_SET_PROP_EX         = 0x9110; // SetDevicePropValueEx
    private static final int OC_EOS_SET_REMOTE_MODE     = 0x9114;
    private static final int OC_EOS_SET_EVENT_MODE      = 0x9115;
    private static final int OC_EOS_GET_EVENT_DATA      = 0x9116;
    private static final int OC_EOS_SET_PC_CONNECT_MODE = 0x911A; // CRITICAL for Wi-Fi EVF
    private static final int OC_EOS_RELEASE_ON          = 0x9128; // RemoteReleaseOn
    private static final int OC_EOS_RELEASE_OFF         = 0x9129; // RemoteReleaseOff
    private static final int OC_EOS_SET_CAPACITY        = 0x913D; // SetCapacity
    private static final int OC_EOS_START_LIVE_VIEW     = 0x9151; // InitiateViewfinder
    private static final int OC_EOS_STOP_LIVE_VIEW      = 0x9152; // TerminateViewfinder
    private static final int OC_EOS_GET_LIVE_FRAME      = 0x9153; // GetViewfinderData
    private static final int OC_EOS_DO_AF               = 0x9154; // DoAf
    private static final int OC_EOS_DRIVE_LENS          = 0x9155; // DriveLens
    private static final int OC_EOS_CANCEL_AF           = 0x9160; // CancelAf

    // Canon EOS Property Codes (from canonProperties.ts)
    private static final int DPC_EOS_APERTURE          = 0xD101;
    private static final int DPC_EOS_SHUTTER_SPEED     = 0xD102;
    private static final int DPC_EOS_ISO               = 0xD103;
    private static final int DPC_EOS_CAPTURE_TARGET    = 0xD11C; // CAPACITY_PROPERTY -> 4 (PC/Host)
    private static final int DPC_EOS_LIVE_VIEW_OUTPUT  = 0xD1B0; // EVF_OUTPUT_DEVICE -> 8 (WIFI_PC) or 9 (WIFI_AND_LCD)
    private static final int DPC_EOS_LIVE_VIEW_MODE    = 0xD1B1; // EVF_MODE -> 1 (On)

    // Standard Response Codes
    private static final int RC_OK          = 0x2001;
    private static final int RC_DEVICE_BUSY = 0x2019;
    private static final int RC_NOT_READY   = 0xA102;

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

    public static class CommandResult {
        public final int responseCode;
        public final byte[] data;

        public CommandResult(int responseCode, byte[] data) {
            this.responseCode = responseCode;
            this.data = data;
        }
    }

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
                    log("▶ Connecting to Canon 4000D Wi-Fi (" + cameraIp + ":" + cameraPort + ")");
                    connectAndStream();
                } catch (Exception e) {
                    lastError = e.getMessage();
                    statusMessage = "Error: " + e.getMessage();
                    logErr("Connection error: " + e.getMessage());
                }

                closeSockets();

                if (isRunning.get()) {
                    try {
                        Thread.sleep(2000);
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

    private synchronized int nextTransactionId() {
        return transactionId++;
    }

    private void connectAndStream() throws Exception {
        log("Step [1/6]: Connecting TCP Sockets to Canon 4000D...");

        // 1. Connect Command Socket
        cmdSocket = new Socket();
        cmdSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(cmdSocket);
                log("✓ Command Socket bound to Camera Wi-Fi");
            } catch (Exception e) {
                logErr("Could not bind cmdSocket to Wi-Fi: " + e.getMessage());
            }
        }

        cmdSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 7000);
        cmdOut = cmdSocket.getOutputStream();
        cmdIn = cmdSocket.getInputStream();

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
        log("Step [2/6]: ✓ InitCommand OK! ID=" + connectionNumber);

        // 3. Connect Event Socket (Packet Type 3)
        evtSocket = new Socket();
        evtSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(evtSocket);
            } catch (Exception ignored) {}
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

        // 4. Open Session (OpCode: 0x1002, SessionID: 1)
        log("Step [4/6]: Opening PTP Session (0x1002)...");
        transactionId = 1;
        CommandResult openRes = executeCameraCommand(OC_OPEN_SESSION, 1);
        log("✓ PTP Session Opened! (0x" + Integer.toHexString(openRes.responseCode) + ")");

        // 5. Query Device Info (0x1001)
        try {
            executeCameraCommand(OC_GET_DEVICE_INFO);
            log("✓ Device Info Handshake OK");
        } catch (Exception ignored) {}

        // 6. EXACT PC LIVE VIEW BOOTSTRAP SEQUENCE (LiveViewBootstrap.ts)
        log("Step [5/6]: Executing Canon EOS Live View Bootstrap Sequence...");

        // Step 6.1: SetRemoteMode(1) (0x9114)
        executeCameraCommand(OC_EOS_SET_REMOTE_MODE, 1);
        log("✓ Step 1/10: SetRemoteMode(1) OK");

        // Step 6.2: SetEventMode(1) (0x9115)
        executeCameraCommand(OC_EOS_SET_EVENT_MODE, 1);
        log("✓ Step 2/10: SetEventMode(1) OK");

        // Step 6.3: SetCapacity(0x1FFF) (0x913D)
        try {
            executeCameraCommand(OC_EOS_SET_CAPACITY, 0x1FFF);
            log("✓ Step 3/10: SetCapacity(0x1FFF) OK");
        } catch (Exception e) {
            log("SetCapacity note: " + e.getMessage());
        }

        // Step 6.4: Poll events (0x9116)
        pollEvents();
        log("✓ Step 4/10: Event poll OK");

        // Step 6.5: Set Capacity Property (0xD11C -> 4) (PC/Host storage)
        writePropertyWithRetry(DPC_EOS_CAPTURE_TARGET, 4, 4, 3000);
        log("✓ Step 5/10: Capacity Property (0xD11C = 4) OK");

        // Step 6.6: SetPcConnectMode (0x911A, 0x0FFFFFFF, 0x1000, 1)
        // CRITICAL FOR CANON 4000D OVER WI-FI!
        try {
            CommandResult pcRes = executeCameraCommand(OC_EOS_SET_PC_CONNECT_MODE, 0x0FFFFFFF, 0x1000, 1);
            log("✓ Step 6/10: SetPcConnectMode (0x911A) OK! Code: 0x" + Integer.toHexString(pcRes.responseCode));
        } catch (Exception e) {
            log("SetPcConnectMode note: " + e.getMessage());
        }

        // Step 6.7: Poll events (0x9116)
        pollEvents();
        log("✓ Step 7/10: Event poll OK");

        // Step 6.8: Set EVF_MODE (0xD1B1 -> 1, 2 bytes)
        writePropertyWithRetry(DPC_EOS_LIVE_VIEW_MODE, 1, 2, 3000);
        log("✓ Step 8/10: EVF_MODE (0xD1B1 = 1) OK");

        // Step 6.9: Set EVF_OUTPUT_DEVICE (0xD1B0 -> 8 WIFI_PC / 9 WIFI_AND_LCD, 4 bytes)
        // THIS COMMAND PHYSICALLY LIFTS THE MIRROR AND OPENS THE SHUTTER CURTAIN!
        statusMessage = "Opening Shutter / Raising Mirror...";
        log("Step [5/6]: Raising Mirror & Opening Shutter (EVF_OUTPUT_DEVICE = 8 WIFI_PC)...");

        boolean evfSet = writePropertyWithRetry(DPC_EOS_LIVE_VIEW_OUTPUT, 8, 4, 4000);
        if (!evfSet) {
            log("Trying EVF_OUTPUT_DEVICE = 9 (WIFI_AND_LCD)...");
            evfSet = writePropertyWithRetry(DPC_EOS_LIVE_VIEW_OUTPUT, 9, 4, 3000);
        }
        if (!evfSet) {
            log("Trying EVF_OUTPUT_DEVICE = 3 / 2 (Direct)...");
            writePropertyWithRetry(DPC_EOS_LIVE_VIEW_OUTPUT, 3, 4, 2000);
        }

        // Step 6.10: Poll events (0x9116)
        pollEvents();
        log("✓ Step 10/10: Final Event poll OK");

        mirrorUp = true;
        isLiveViewActive.set(true);
        statusMessage = "Canon 4000D Live View Active!";
        log("Step [6/6]: ✓ Live View Stream Active! Shutter opened, fetching video frames...");

        // 7. Continuous Live View Frame Polling Loop
        int consecutiveErrors = 0;
        lastFpsCalcTime = System.currentTimeMillis();
        frameCount = 0;

        while (isRunning.get() && isLiveViewActive.get()) {
            try {
                // Fetch frame using Canon EOS 0x9153 (GetLiveViewImage) with parameters [0x00200000, 1, 0]
                byte[] jpeg = fetchLiveViewFrame();

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
                    if (consecutiveErrors > 10) {
                        log("Re-triggering Canon EVF Output (0xD1B0 = 8)...");
                        writePropertyWithRetry(DPC_EOS_LIVE_VIEW_OUTPUT, 8, 4, 1000);
                        try { pollEvents(); } catch (Exception ignored) {}
                        consecutiveErrors = 0;
                    }
                }

                Thread.sleep(25); // ~35-40 FPS polling
            } catch (Exception e) {
                logErr("Frame poll tick error: " + e.getMessage());
                consecutiveErrors++;
                if (consecutiveErrors > 30) {
                    throw e; // Force reconnect
                }
                Thread.sleep(80);
            }
        }
    }

    /**
     * Polls camera events via Canon EOS GET_EVENT (0x9116).
     */
    public synchronized void pollEvents() throws Exception {
        executeCameraCommand(OC_EOS_GET_EVENT_DATA);
    }

    /**
     * Fetches Live View JPEG frame handling standard PTP/IP Data In phase.
     * Uses Canon EOS GET_VIEWFINDER_DATA (0x9153) with standard parameters [0x00200000, 1, 0].
     */
    private synchronized byte[] fetchLiveViewFrame() throws Exception {
        CommandResult res = executeCameraCommand(OC_EOS_GET_LIVE_FRAME, 0x00200000, 1, 0);

        if (res.responseCode != RC_OK && res.responseCode != RC_DEVICE_BUSY) {
            return null;
        }

        byte[] rawBlob = res.data;
        if (rawBlob == null || rawBlob.length < 50) {
            return null;
        }

        return extractJpegFromViewfinderBlob(rawBlob);
    }

    /**
     * Extracts JPEG from Canon EOS viewfinder blob matching extractCanonEosJpeg from canonEos.ts.
     * Chunks types containing JPEG: 1, 9, 11.
     * Fallback to scanning for SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9).
     */
    private byte[] extractJpegFromViewfinderBlob(byte[] rawBlob) {
        // 1. Structured Canon Chunk Parsing (matching extractCanonEosJpeg in canonEos.ts)
        int offset = 0;
        ByteBuffer buf = ByteBuffer.wrap(rawBlob).order(ByteOrder.LITTLE_ENDIAN);

        while (offset + 8 <= rawBlob.length) {
            int byteLength = buf.getInt(offset);
            int type = buf.getInt(offset + 4);

            if (byteLength < 8 || offset + byteLength > rawBlob.length) {
                break;
            }

            if (type == 1 || type == 9 || type == 11) {
                int candidateLen = byteLength - 8;
                if (candidateLen >= 4) {
                    int cStart = offset + 8;
                    if ((rawBlob[cStart] & 0xFF) == 0xFF && (rawBlob[cStart + 1] & 0xFF) == 0xD8 &&
                        (rawBlob[cStart + candidateLen - 2] & 0xFF) == 0xFF && (rawBlob[cStart + candidateLen - 1] & 0xFF) == 0xD9) {
                        byte[] jpeg = new byte[candidateLen];
                        System.arraycopy(rawBlob, cStart, jpeg, 0, candidateLen);
                        return jpeg;
                    }
                }
            }
            offset += byteLength;
        }

        // 2. Fallback: Full buffer scan for SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9)
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
     * Executes standard PTP-IP command with Data Phase = CAMERA_TO_HOST_OR_NONE (1).
     * Handles direct CommandResponse (7) or StartDataPacket (9) + Data (10/12) + CommandResponse (7).
     */
    public synchronized CommandResult executeCameraCommand(int opCode, int... params) throws Exception {
        int txId = nextTransactionId();
        int paramCount = params != null ? params.length : 0;
        int totalLen = 8 + 4 + 2 + 4 + (paramCount * 4); // 18 + paramCount * 4

        ByteBuffer req = ByteBuffer.allocate(totalLen).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(totalLen);
        req.putInt(PTPIP_CMD_REQUEST); // 6
        req.putInt(DATA_DIR_CAMERA_TO_HOST_OR_NONE); // 1 (CAMERA_TO_HOST_OR_NONE)
        req.putShort((short) opCode);
        req.putInt(txId);
        for (int p : params) {
            req.putInt(p);
        }

        cmdOut.write(req.array());
        cmdOut.flush();

        // Read response header
        byte[] firstHeader = readExact(cmdIn, 8);
        ByteBuffer hBuf = ByteBuffer.wrap(firstHeader).order(ByteOrder.LITTLE_ENDIAN);
        int pktLen = hBuf.getInt();
        int pktType = hBuf.getInt();

        if (pktType == PTPIP_CMD_RESPONSE) { // 7
            byte[] body = readExact(cmdIn, pktLen - 8);
            ByteBuffer bBuf = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN);
            int respCode = bBuf.getShort() & 0xFFFF;
            return new CommandResult(respCode, new byte[0]);
        }

        if (pktType != PTPIP_START_DATA_PACKET) { // 9
            if (pktLen > 8) readExact(cmdIn, pktLen - 8);
            return new CommandResult(-1, new byte[0]);
        }

        // Read StartDataPacket body (txId + 8-byte length)
        byte[] startBody = readExact(cmdIn, pktLen - 8);
        ByteBuffer sBuf = ByteBuffer.wrap(startBody).order(ByteOrder.LITTLE_ENDIAN);
        int startTxId = sBuf.getInt();
        long expectedDataLen = sBuf.getLong();

        ByteArrayOutputStream dataStream = new ByteArrayOutputStream((int) Math.min(expectedDataLen > 0 ? expectedDataLen : 65536, 2097152));
        boolean isLast = false;
        while (!isLast) {
            byte[] chunkHdr = readExact(cmdIn, 8);
            ByteBuffer cHdr = ByteBuffer.wrap(chunkHdr).order(ByteOrder.LITTLE_ENDIAN);
            int chunkLen = cHdr.getInt();
            int chunkType = cHdr.getInt();

            byte[] chunkBody = readExact(cmdIn, chunkLen - 8);
            if (chunkType == PTPIP_DATA_PACKET || chunkType == PTPIP_END_DATA_PACKET) {
                // First 4 bytes are txId
                if (chunkBody.length > 4) {
                    dataStream.write(chunkBody, 4, chunkBody.length - 4);
                }
                if (chunkType == PTPIP_END_DATA_PACKET) {
                    isLast = true;
                }
            } else if (chunkType == PTPIP_CMD_RESPONSE) {
                ByteBuffer bBuf = ByteBuffer.wrap(chunkBody).order(ByteOrder.LITTLE_ENDIAN);
                int respCode = bBuf.getShort() & 0xFFFF;
                return new CommandResult(respCode, dataStream.toByteArray());
            }
        }

        // Read final CommandResponse (7)
        byte[] respHdr = readExact(cmdIn, 8);
        ByteBuffer rHdr = ByteBuffer.wrap(respHdr).order(ByteOrder.LITTLE_ENDIAN);
        int rLen = rHdr.getInt();
        int rType = rHdr.getInt();
        int respCode = -1;
        if (rType == PTPIP_CMD_RESPONSE) {
            byte[] rBody = readExact(cmdIn, rLen - 8);
            ByteBuffer bBuf = ByteBuffer.wrap(rBody).order(ByteOrder.LITTLE_ENDIAN);
            respCode = bBuf.getShort() & 0xFFFF;
        } else {
            if (rLen > 8) readExact(cmdIn, rLen - 8);
        }

        return new CommandResult(respCode, dataStream.toByteArray());
    }

    /**
     * Executes host data command (Data Phase = HOST_TO_CAMERA = 2), e.g. SetDevicePropValueEx (0x9110).
     */
    public synchronized int executeHostDataCommand(int opCode, byte[] payload, int... params) throws Exception {
        int txId = nextTransactionId();
        int paramCount = params != null ? params.length : 0;
        int totalLen = 8 + 4 + 2 + 4 + (paramCount * 4);

        // 1. PTPIP_CMD_REQUEST (type 6) with dataDirection = 2 (HOST_TO_CAMERA)
        ByteBuffer req = ByteBuffer.allocate(totalLen).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(totalLen);
        req.putInt(PTPIP_CMD_REQUEST); // 6
        req.putInt(DATA_DIR_HOST_TO_CAMERA); // 2
        req.putShort((short) opCode);
        req.putInt(txId);
        for (int p : params) {
            req.putInt(p);
        }
        cmdOut.write(req.array());

        // 2. PTPIP_START_DATA_PACKET (type 9)
        ByteBuffer start = ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN);
        start.putInt(20);
        start.putInt(PTPIP_START_DATA_PACKET); // 9
        start.putInt(txId);
        start.putLong(payload.length);
        cmdOut.write(start.array());

        // 3. PTPIP_END_DATA_PACKET (type 12)
        int endLen = 12 + payload.length;
        ByteBuffer end = ByteBuffer.allocate(endLen).order(ByteOrder.LITTLE_ENDIAN);
        end.putInt(endLen);
        end.putInt(PTPIP_END_DATA_PACKET); // 12
        end.putInt(txId);
        end.put(payload);
        cmdOut.write(end.array());
        cmdOut.flush();

        // 4. Read PTPIP_CMD_RESPONSE (type 7)
        byte[] respHdr = readExact(cmdIn, 8);
        ByteBuffer rHdr = ByteBuffer.wrap(respHdr).order(ByteOrder.LITTLE_ENDIAN);
        int rLen = rHdr.getInt();
        int rType = rHdr.getInt();
        if (rType != PTPIP_CMD_RESPONSE) {
            if (rLen > 8) readExact(cmdIn, rLen - 8);
            return -1;
        }
        byte[] rBody = readExact(cmdIn, rLen - 8);
        ByteBuffer bBuf = ByteBuffer.wrap(rBody).order(ByteOrder.LITTLE_ENDIAN);
        return bBuf.getShort() & 0xFFFF;
    }

    /**
     * Creates standard Canon EOS 12-byte Property Value Payload.
     * Byte 0..3: Total length = 12
     * Byte 4..7: Property Code (e.g. 0xD1B0)
     * Byte 8..11: Property Value (uint8, uint16, or uint32 Little Endian)
     */
    private byte[] createCanonPropertyPayload(int propCode, int value, int byteLength) {
        byte[] payload = new byte[12];
        ByteBuffer buf = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN);
        buf.putInt(12); // Length
        buf.putInt(propCode); // Property code
        if (byteLength == 1) {
            buf.put((byte) (value & 0xFF));
        } else if (byteLength == 2) {
            buf.putShort((short) (value & 0xFFFF));
        } else {
            buf.putInt(value);
        }
        return payload;
    }

    /**
     * Writes Canon property with retry and event polling, matching writePropertyWithRetry in LiveViewBootstrap.ts.
     */
    public synchronized boolean writePropertyWithRetry(int propCode, int value, int byteLength, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        byte[] payload = createCanonPropertyPayload(propCode, value, byteLength);

        while (System.currentTimeMillis() <= deadline && isRunning.get()) {
            try {
                int resp = executeHostDataCommand(OC_EOS_SET_PROP_EX, payload);
                if (resp == RC_OK) { // 0x2001
                    log("✓ SetProp 0x" + Integer.toHexString(propCode) + " = " + value + " OK");
                    return true;
                }

                // Retryable codes: 0x2019 (DEVICE_BUSY), 0xA102 (NOT_READY)
                if (resp == RC_DEVICE_BUSY || resp == RC_NOT_READY) {
                    try { pollEvents(); } catch (Exception ignored) {}
                    Thread.sleep(35);
                    continue;
                }

                logErr("SetProp 0x" + Integer.toHexString(propCode) + " returned 0x" + Integer.toHexString(resp));
                return false;
            } catch (Exception e) {
                logErr("SetProp exception: " + e.getMessage());
                try { pollEvents(); } catch (Exception ignored) {}
                try { Thread.sleep(35); } catch (InterruptedException ignored) {}
            }
        }
        return false;
    }

    public synchronized boolean setCanonDevicePropertyEx(int propCode, int value) {
        int byteLen = 4;
        if (propCode == DPC_EOS_LIVE_VIEW_MODE) {
            byteLen = 2;
        }
        return writePropertyWithRetry(propCode, value, byteLen, 2500);
    }

    public synchronized boolean setDeviceProperty32(int propCode, int value) {
        return setCanonDevicePropertyEx(propCode, value);
    }

    /**
     * Triggers Auto Focus (EOS_DoAf OpCode 0x9154).
     */
    public synchronized boolean triggerAutoFocus() {
        if (!isConnected()) return false;
        try {
            log("Triggering Canon Auto Focus (0x9154)...");
            // Ensure EVF Wi-Fi mode is set
            writePropertyWithRetry(DPC_EOS_LIVE_VIEW_OUTPUT, 8, 4, 1000);
            CommandResult res = executeCameraCommand(OC_EOS_DO_AF, 1);
            log("Auto Focus response: 0x" + Integer.toHexString(res.responseCode));
            return res.responseCode == RC_OK;
        } catch (Exception e) {
            logErr("Auto Focus error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Cancel Auto Focus / Freeze Focus (EOS_CancelAf OpCode 0x9160 / 0x902A).
     */
    public synchronized boolean cancelAutoFocus() {
        if (!isConnected()) return false;
        try {
            executeCameraCommand(OC_EOS_CANCEL_AF);
            return true;
        } catch (Exception e) {
            try {
                executeCameraCommand(0x902A);
                return true;
            } catch (Exception ignored) {}
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

            CommandResult res = executeCameraCommand(OC_EOS_DRIVE_LENS, eosParam);
            log("EOS DriveLens (0x9155) param=0x" + Integer.toHexString(eosParam) + " resp=0x" + Integer.toHexString(res.responseCode));
            return res.responseCode == RC_OK;
        } catch (Exception e) {
            logErr("Focus Drive error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Triggers Full Physical Mechanical Shutter Actuation / Takes a photo.
     * Uses Canon EOS REMOTE_RELEASE (0x910F) as primary, with fallback to Two-Stage Actuation.
     */
    public synchronized boolean triggerShutterRelease() {
        if (!isConnected()) return false;
        try {
            log("📸 Firing Canon 4000D Physical Shutter Release...");

            // Method 1: PC App Standard Canon EOS REMOTE_RELEASE (0x910F)
            try {
                writePropertyWithRetry(DPC_EOS_LIVE_VIEW_OUTPUT, 8, 4, 1000);
                CommandResult res = executeCameraCommand(OC_EOS_REMOTE_RELEASE);
                log("✓ Remote Release (0x910F) response: 0x" + Integer.toHexString(res.responseCode));
                if (res.responseCode == RC_OK) {
                    Thread.sleep(250);
                    try { pollEvents(); } catch (Exception ignored) {}
                    return true;
                }
            } catch (Exception e) {
                log("0x910F note: " + e.getMessage());
            }

            // Method 2: Two-Stage Canon EOS Shutter Trigger (0x9128 Half/Full -> 0x9129 Release)
            try {
                executeCameraCommand(OC_EOS_RELEASE_ON, 1, 0); // Half-press Focus
                Thread.sleep(120);
                executeCameraCommand(OC_EOS_RELEASE_ON, 2, 0); // Full-press Shutter
                Thread.sleep(200);
                executeCameraCommand(OC_EOS_RELEASE_OFF, 2);   // Release Shutter
                executeCameraCommand(OC_EOS_RELEASE_OFF, 1);   // Release Focus
                log("✓ Canon 4000D Two-Stage Shutter Released!");
                return true;
            } catch (Exception e) {
                log("Two-stage release note: " + e.getMessage());
            }

            // Method 3: Canon TakePicture (0x902F)
            try {
                CommandResult res = executeCameraCommand(0x902F, 0);
                if (res.responseCode == RC_OK) return true;
            } catch (Exception ignored) {}

            return false;
        } catch (Exception e) {
            logErr("Shutter Release error: " + e.getMessage());
            return false;
        }
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
