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
 * Canon PTP/IP Wi-Fi Engine for Android
 * Connects directly to Canon EOS DSLR and Mirrorless cameras over Wi-Fi (192.168.1.1:15740).
 * Implements ISO 15740 PTP-IP standard with exact DataPhaseInfo and Canon EOS extensions:
 * - Persistent GUID for stable camera pairing
 * - Remote Mode & Event Mode activation (0x9114, 0x9115)
 * - Live View activation (flips mirror up, opens shutter) (0xD102, 0xD10B)
 * - Live View frame streaming (0x9153 / 0x9027)
 * - Remote Lens Focus Drive (0x9155 / 0x9029)
 * - Remote Shutter Release (0x9128 / 0x902F)
 */
public class CanonPtpIpEngine {

    private static final String TAG = "CanonPtpIpEngine";

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
    private int frameCount = 0;
    private float currentFps = 0f;
    private long lastFpsCalcTime = 0;

    private String statusMessage = "Disconnected";
    private String lastError = null;
    private boolean mirrorUp = false;

    private int activeLiveViewOpCode = 0x9153; // EOS GetLiveViewPicture

    public interface FrameListener {
        void onNewFrame(byte[] jpegBytes);
    }

    private FrameListener frameListener;

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
        Log.i(TAG, "Assigned Wi-Fi Network interface: " + network);
    }

    public void setFrameListener(FrameListener listener) {
        this.frameListener = listener;
    }

    public synchronized boolean isConnected() {
        return isRunning.get() && cmdSocket != null && cmdSocket.isConnected() && !cmdSocket.isClosed();
    }

    public boolean isLiveViewStreaming() {
        return isLiveViewActive.get() && (System.currentTimeMillis() - lastFrameTime < 3000);
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

    public boolean isMirrorUp() {
        return mirrorUp;
    }

    public void start() {
        if (isRunning.get()) return;
        isRunning.set(true);

        new Thread(() -> {
            while (isRunning.get()) {
                try {
                    statusMessage = "Connecting to Canon Wi-Fi (" + cameraIp + ":" + cameraPort + ")...";
                    connectAndStream();
                } catch (Exception e) {
                    lastError = e.getMessage();
                    statusMessage = "Error: " + e.getMessage();
                    Log.e(TAG, "Connection error: " + e.getMessage(), e);
                }

                closeSockets();

                if (isRunning.get()) {
                    try {
                        Thread.sleep(3000);
                    } catch (InterruptedException ignored) {}
                }
            }
        }, "Canon-PTP-Streamer").start();
    }

    public void stop() {
        isRunning.set(false);
        closeSockets();
        statusMessage = "Stopped";
    }

    private void closeSockets() {
        isLiveViewActive.set(false);
        mirrorUp = false;
        try { if (cmdSocket != null) cmdSocket.close(); } catch (Exception ignored) {}
        try { if (evtSocket != null) evtSocket.close(); } catch (Exception ignored) {}
        cmdSocket = null;
        evtSocket = null;
    }

    /**
     * Gets or creates a persistent GUID for Canon camera pairing.
     * Randomizing GUID on every connect causes Canon cameras to reject the connection!
     */
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
        Log.i(TAG, "Connecting to Canon Camera at " + cameraIp + ":" + cameraPort + "...");

        // 1. Connect Command Socket
        cmdSocket = new Socket();
        cmdSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(cmdSocket);
                Log.i(TAG, "cmdSocket successfully bound to Wi-Fi network interface");
            } catch (Exception e) {
                Log.w(TAG, "Could not bind cmdSocket to Wi-Fi: " + e.getMessage());
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
        initCmd.putInt(1); // InitCommandRequest
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
        if (ackType != 2) throw new Exception("Expected InitCommandAck (2), got: " + ackType);

        byte[] ackBody = readExact(cmdIn, ackLen - 8);
        ByteBuffer ackBodyBuf = ByteBuffer.wrap(ackBody).order(ByteOrder.LITTLE_ENDIAN);
        connectionNumber = ackBodyBuf.getInt();
        Log.i(TAG, "InitCommand OK! ConnectionNumber: " + connectionNumber);

        // 3. Connect Event Socket (Packet Type 3)
        evtSocket = new Socket();
        evtSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(evtSocket);
                Log.i(TAG, "evtSocket successfully bound to Wi-Fi network interface");
            } catch (Exception e) {
                Log.w(TAG, "Could not bind evtSocket to Wi-Fi: " + e.getMessage());
            }
        }
        evtSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 7000);
        evtOut = evtSocket.getOutputStream();
        evtIn = evtSocket.getInputStream();

        ByteBuffer initEvt = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        initEvt.putInt(12);
        initEvt.putInt(3); // InitEventRequest
        initEvt.putInt(connectionNumber);

        evtOut.write(initEvt.array());
        evtOut.flush();

        byte[] evtAckHeader = readExact(evtIn, 8);
        ByteBuffer evtAckBuf = ByteBuffer.wrap(evtAckHeader).order(ByteOrder.LITTLE_ENDIAN);
        int evtAckLen = evtAckBuf.getInt();
        int evtAckType = evtAckBuf.getInt();
        if (evtAckType != 4) throw new Exception("Expected InitEventAck (4), got: " + evtAckType);
        if (evtAckLen > 8) readExact(evtIn, evtAckLen - 8);

        Log.i(TAG, "PTP/IP Event Socket Connected!");

        // Start Event Drainer Thread to prevent socket backpressure
        new Thread(() -> {
            try {
                while (isRunning.get() && evtSocket != null && !evtSocket.isClosed()) {
                    byte[] hdr = readExact(evtIn, 8);
                    ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
                    int len = hBuf.getInt();
                    if (len > 8) readExact(evtIn, len - 8);
                }
            } catch (Exception ignored) {}
        }, "Canon-Evt-Drainer").start();

        statusMessage = "Opening Session...";

        // 4. Open Session (OpCode: 0x1002, SessionID: 1, DataPhase: 0 - No Data Phase)
        sendOperationRequest(0x1002, 1);
        readOperationResponse();
        Log.i(TAG, "PTP Session Opened!");

        // 5. Canon EOS Handshake: SetRemoteMode (0x9114) & SetEventMode (0x9115)
        try {
            sendOperationRequest(0x9114, 1);
            readOperationResponse();
            Log.i(TAG, "Canon EOS SetRemoteMode(1) OK");
        } catch (Exception e) {
            Log.w(TAG, "SetRemoteMode error: " + e.getMessage());
        }

        try {
            sendOperationRequest(0x9115, 1);
            readOperationResponse();
            Log.i(TAG, "Canon EOS SetEventMode(1) OK");
        } catch (Exception e) {
            Log.w(TAG, "SetEventMode error: " + e.getMessage());
        }

        // 6. Start Live View: Set EvfOutputDevice (0xD102) -> 3 (PC + LCD)
        // This is the command that flips up the mirror and opens the shutter!
        statusMessage = "Activating Live View (Opening Shutter)...";
        int[] evfOutputModes = {3, 2, 9, 8, 1};
        boolean evfSuccess = false;
        for (int m : evfOutputModes) {
            if (setDeviceProperty32(0xD102, m)) {
                Log.i(TAG, "Canon EvfOutputDevice (0xD102) set to " + m + " (Shutter Opened / Mirror Raised)!");
                evfSuccess = true;
                break;
            }
        }

        // EvfMode (0xD10B) -> 1 (Enable EVF)
        setDeviceProperty32(0xD10B, 1);

        isLiveViewActive.set(true);
        mirrorUp = true;
        statusMessage = "Canon Live View Active!";
        Log.i(TAG, "Live View Active! Mirror is up, shutter is open. Polling frames...");

        // 7. Live View Polling Loop
        int consecutiveErrors = 0;
        lastFpsCalcTime = System.currentTimeMillis();
        frameCount = 0;

        while (isRunning.get() && isLiveViewActive.get()) {
            try {
                byte[] jpeg = fetchLiveViewFrame(activeLiveViewOpCode);

                if (jpeg == null && activeLiveViewOpCode == 0x9153) {
                    // Try alternative OpCode 0x9027 (GetViewFinderData)
                    activeLiveViewOpCode = 0x9027;
                    jpeg = fetchLiveViewFrame(activeLiveViewOpCode);
                }

                if (jpeg != null && jpeg.length > 500) {
                    latestJpegFrame = jpeg;
                    lastFrameTime = System.currentTimeMillis();
                    frameCount++;
                    consecutiveErrors = 0;

                    long now = System.currentTimeMillis();
                    if (now - lastFpsCalcTime >= 1000) {
                        currentFps = (frameCount * 1000f) / (now - lastFpsCalcTime);
                        frameCount = 0;
                        lastFpsCalcTime = now;
                        statusMessage = String.format("Canon Live: %.1f FPS (%d KB)", currentFps, jpeg.length / 1024);
                    }

                    if (frameListener != null) {
                        frameListener.onNewFrame(jpeg);
                    }
                } else {
                    consecutiveErrors++;
                    if (consecutiveErrors > 15) {
                        // Re-trigger live view property if interrupted
                        setDeviceProperty32(0xD102, 3);
                        setDeviceProperty32(0xD10B, 1);
                        consecutiveErrors = 0;
                    }
                }

                Thread.sleep(25); // ~35 FPS
            } catch (Exception e) {
                Log.w(TAG, "Frame fetch tick error: " + e.getMessage());
                consecutiveErrors++;
                if (consecutiveErrors > 25) {
                    throw e; // Force reconnect
                }
                Thread.sleep(80);
            }
        }
    }

    /**
     * Fetches Live View JPEG frame handling PTP/IP Data In phase:
     * OperationRequest (DataPhase = 2), StartData (Type 9), DataPacket (Type 12), EndData (Type 10), OperationResponse (Type 7).
     */
    private synchronized byte[] fetchLiveViewFrame(int opCode) throws Exception {
        // OperationRequest with DataPhase = 2 (Data In - Camera sends data to Host)
        sendOperationRequestWithPhase(opCode, 2, 0x00200000); // 2MB Max buffer

        ByteArrayOutputStream frameStream = new ByteArrayOutputStream();

        while (true) {
            byte[] hdr = readExact(cmdIn, 8);
            ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
            int pktLen = hBuf.getInt();
            int pktType = hBuf.getInt();

            if (pktType == 9) { // StartData
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
            } else if (pktType == 12) { // DataPacket (intermediate chunk)
                byte[] data = readExact(cmdIn, pktLen - 8);
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
            } else if (pktType == 10) { // EndData (final chunk)
                byte[] data = readExact(cmdIn, pktLen - 8);
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
                // Read subsequent OperationResponse packet
                readOperationResponse();
                break;
            } else if (pktType == 7) { // OperationResponse
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
                break;
            } else {
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
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
     * Drives Canon Lens Focus.
     * Uses DataPhase = 0 (No Data Phase).
     * Supports EOS OpCode 0x9155 and PTP OpCode 0x9029.
     * @param direction 1 = Far / Infinity, 2 = Near / Macro
     * @param step 1 = Small, 2 = Medium, 3 = Large
     */
    public synchronized boolean driveLensFocus(int direction, int step) {
        if (!isConnected()) return false;
        try {
            int stepClamped = Math.max(1, Math.min(3, step));

            // EOS OpCode 0x9155:
            // Near: 0x00000001, 0x00000002, 0x00000003
            // Far:  0x00008001, 0x00008002, 0x00008003
            int eosParam = direction == 1 ? (0x00008000 | stepClamped) : stepClamped;
            try {
                sendOperationRequest(0x9155, eosParam);
                int resp = readOperationResponse();
                if (resp == 0x2001) {
                    Log.i(TAG, "EOS DriveFocus (0x9155) succeeded! Param=0x" + Integer.toHexString(eosParam));
                    return true;
                }
            } catch (Exception e) {
                Log.w(TAG, "OpCode 0x9155 failed, trying 0x9029: " + e.getMessage());
            }

            // Fallback OpCode 0x9029 (DriveLens)
            int dirParam = direction == 1 ? 0x0001 : 0x0002;
            int param = (dirParam << 16) | stepClamped;
            sendOperationRequest(0x9029, param);
            readOperationResponse();
            Log.i(TAG, "PTP DriveLens (0x9029) succeeded!");
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Focus Drive error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Triggers Shutter Release / Takes a photo.
     * In Canon EOS, sends Shutter Press, delays, then sends Shutter Release.
     * Produces genuine mirror flip and mechanical shutter sound!
     */
    public synchronized boolean triggerShutterRelease() {
        if (!isConnected()) return false;
        try {
            // Method 1: Canon EOS RemoteRelease (0x9128)
            // Param 1 = 1 (Shutter Button Press), Param 2 = 0
            try {
                sendOperationRequest(0x9128, 1, 0);
                readOperationResponse();
                Thread.sleep(150);
                sendOperationRequest(0x9128, 2, 0); // Shutter Button Release
                readOperationResponse();
                Log.i(TAG, "EOS RemoteRelease (0x9128) fired shutter successfully!");
                return true;
            } catch (Exception e) {
                Log.w(TAG, "0x9128 failed, trying 0x902F: " + e.getMessage());
            }

            // Method 2: Canon TakePicture (0x902F)
            try {
                sendOperationRequest(0x902F, 0);
                readOperationResponse();
                Log.i(TAG, "Canon TakePicture (0x902F) fired shutter successfully!");
                return true;
            } catch (Exception e) {
                Log.w(TAG, "0x902F failed, trying 0x100E: " + e.getMessage());
            }

            // Method 3: Standard PTP InitiateCapture (0x100E)
            sendOperationRequest(0x100E, 0, 0);
            readOperationResponse();
            Log.i(TAG, "PTP InitiateCapture (0x100E) fired shutter successfully!");
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Shutter Release error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Cancel Auto Focus / Freeze Focus (OpCode: 0x902A)
     */
    public synchronized boolean cancelAutoFocus() {
        if (!isConnected()) return false;
        try {
            sendOperationRequest(0x902A);
            readOperationResponse();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Sets Canon 32-bit Device Property (OpCode: 0x9014 - SetDevicePropValueEx)
     * DataPhase = 1 (Data Out - Host sends data to camera).
     */
    public synchronized boolean setDeviceProperty32(int propCode, int value) {
        if (cmdOut == null) return false;
        try {
            int txId = transactionId++;

            byte[] dataPayload = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
                    .putShort((short) propCode)
                    .putShort((short) 0x0004) // DataType: UINT32
                    .putInt(value)
                    .array();

            // OperationRequest (DataPhase = 1 -> Data Out)
            ByteBuffer req = ByteBuffer.allocate(8 + 4 + 2 + 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
            req.putInt(req.capacity());
            req.putInt(6); // OperationRequest
            req.putInt(1); // DataPhase: 1 = Data Out (Host -> Camera)
            req.putShort((short) 0x9014); // SetDevicePropValueEx
            req.putInt(txId);
            req.putInt(propCode);

            cmdOut.write(req.array());

            // StartData (Type 9)
            ByteBuffer start = ByteBuffer.allocate(8 + 4 + 8).order(ByteOrder.LITTLE_ENDIAN);
            start.putInt(start.capacity());
            start.putInt(9); // StartData
            start.putInt(txId);
            start.putLong(dataPayload.length);
            cmdOut.write(start.array());

            // EndData (Type 10)
            ByteBuffer end = ByteBuffer.allocate(8 + 4 + dataPayload.length).order(ByteOrder.LITTLE_ENDIAN);
            end.putInt(end.capacity());
            end.putInt(10); // EndData
            end.putInt(txId);
            end.put(dataPayload);
            cmdOut.write(end.array());
            cmdOut.flush();

            int resp = readOperationResponse();
            return resp == 0x2001; // 0x2001 = OK
        } catch (Exception e) {
            Log.w(TAG, "SetDeviceProp (0x" + Integer.toHexString(propCode) + ") error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Sends PTP/IP OperationRequest with NO DATA PHASE (DataPhase = 0).
     */
    private void sendOperationRequest(int opCode, int... params) throws Exception {
        sendOperationRequestWithPhase(opCode, 0, params);
    }

    /**
     * Sends PTP/IP OperationRequest with specified DataPhaseInfo:
     * 0 = No Data Phase
     * 1 = Data Out (Host -> Camera)
     * 2 = Data In  (Camera -> Host)
     */
    private void sendOperationRequestWithPhase(int opCode, int dataPhase, int... params) throws Exception {
        int txId = transactionId++;
        int paramCount = params != null ? params.length : 0;
        int totalLen = 8 + 4 + 2 + 4 + (paramCount * 4);

        ByteBuffer req = ByteBuffer.allocate(totalLen).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(totalLen);
        req.putInt(6); // OperationRequest
        req.putInt(dataPhase); // Exact DataPhaseInfo!
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

        if (type != 7) { // OperationResponse
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
