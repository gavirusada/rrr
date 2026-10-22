package com.gaviru.camstudio;

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
 * Handles PTP/IP handshakes, EOS remote live view streaming (OpCode 0x9153 / 0x9027),
 * and lens focus drive (OpCode 0x9155 / 0x9029).
 */
public class CanonPtpIpEngine {

    private static final String TAG = "CanonPtpIpEngine";

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

    private int activeLiveViewOpCode = 0x9153; // Default to EOS GetLiveViewPicture

    public interface FrameListener {
        void onNewFrame(byte[] jpegBytes);
    }

    private FrameListener frameListener;

    public CanonPtpIpEngine(String cameraIp, int cameraPort) {
        if (cameraIp != null && !cameraIp.trim().isEmpty()) {
            this.cameraIp = cameraIp.trim();
        }
        if (cameraPort > 0) {
            this.cameraPort = cameraPort;
        }
    }

    public void setWifiNetwork(Network network) {
        this.wifiNetwork = network;
        Log.i(TAG, "Assigned Wi-Fi Network: " + network);
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
                    Log.e(TAG, "Connection cycle error: " + e.getMessage(), e);
                }

                closeSockets();

                if (isRunning.get()) {
                    try {
                        Thread.sleep(3000); // Retry interval
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
        try { if (cmdSocket != null) cmdSocket.close(); } catch (Exception ignored) {}
        try { if (evtSocket != null) evtSocket.close(); } catch (Exception ignored) {}
        cmdSocket = null;
        evtSocket = null;
    }

    private void connectAndStream() throws Exception {
        Log.i(TAG, "Attempting connection to Canon Camera at " + cameraIp + ":" + cameraPort + "...");

        // 1. Connect Command Socket
        cmdSocket = new Socket();
        cmdSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(cmdSocket);
                Log.i(TAG, "cmdSocket bound to Wi-Fi network interface");
            } catch (Exception e) {
                Log.w(TAG, "Could not bind cmdSocket to Wi-Fi: " + e.getMessage());
            }
        }
        cmdSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 7000);
        cmdOut = cmdSocket.getOutputStream();
        cmdIn = cmdSocket.getInputStream();

        statusMessage = "Sending PTP/IP Init...";

        // 2. InitCommandRequest
        byte[] guid = new byte[16];
        ByteBuffer.wrap(guid).putLong(UUID.randomUUID().getMostSignificantBits()).putLong(UUID.randomUUID().getLeastSignificantBits());
        byte[] clientNameBytes = "Gaviru-Cam-Pro\0".getBytes(StandardCharsets.UTF_16LE);

        ByteBuffer initCmd = ByteBuffer.allocate(8 + 16 + clientNameBytes.length + 4).order(ByteOrder.LITTLE_ENDIAN);
        initCmd.putInt(initCmd.capacity());
        initCmd.putInt(1); // Packet Type: InitCommandRequest
        initCmd.put(guid);
        initCmd.put(clientNameBytes);
        initCmd.putInt(0x00010000); // Version 1.0

        cmdOut.write(initCmd.array());
        cmdOut.flush();

        // Read InitCommandAck
        byte[] ackHeader = readExact(cmdIn, 8);
        ByteBuffer ackBuf = ByteBuffer.wrap(ackHeader).order(ByteOrder.LITTLE_ENDIAN);
        int ackLen = ackBuf.getInt();
        int ackType = ackBuf.getInt();
        if (ackType != 2) throw new Exception("Expected InitCommandAck (Type 2), got: " + ackType);

        byte[] ackBody = readExact(cmdIn, ackLen - 8);
        ByteBuffer ackBodyBuf = ByteBuffer.wrap(ackBody).order(ByteOrder.LITTLE_ENDIAN);
        connectionNumber = ackBodyBuf.getInt();
        Log.i(TAG, "InitCommand OK! ConnectionNumber: " + connectionNumber);

        // 3. Connect Event Socket
        evtSocket = new Socket();
        evtSocket.setTcpNoDelay(true);
        if (wifiNetwork != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                wifiNetwork.bindSocket(evtSocket);
                Log.i(TAG, "evtSocket bound to Wi-Fi network interface");
            } catch (Exception e) {
                Log.w(TAG, "Could not bind evtSocket to Wi-Fi: " + e.getMessage());
            }
        }
        evtSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 7000);
        evtOut = evtSocket.getOutputStream();
        evtIn = evtSocket.getInputStream();

        ByteBuffer initEvt = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        initEvt.putInt(12);
        initEvt.putInt(3); // Packet Type: InitEventRequest
        initEvt.putInt(connectionNumber);

        evtOut.write(initEvt.array());
        evtOut.flush();

        byte[] evtAckHeader = readExact(evtIn, 8);
        ByteBuffer evtAckBuf = ByteBuffer.wrap(evtAckHeader).order(ByteOrder.LITTLE_ENDIAN);
        int evtAckLen = evtAckBuf.getInt();
        int evtAckType = evtAckBuf.getInt();
        if (evtAckType != 4) throw new Exception("Expected InitEventAck (Type 4), got: " + evtAckType);
        if (evtAckLen > 8) readExact(evtIn, evtAckLen - 8);

        Log.i(TAG, "PTP/IP Event Socket Connected!");

        // Start Event Drainer Thread
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

        statusMessage = "Opening PTP Session...";

        // 4. Open Session (OpCode: 0x1002)
        sendOperationRequest(0x1002, 1);
        readOperationResponse();

        // 5. Canon EOS Specific Handshakes
        // SetRemoteMode (OpCode: 0x9114, Param: 1)
        try {
            sendOperationRequest(0x9114, 1);
            readOperationResponse();
            Log.i(TAG, "Canon SetRemoteMode(1) OK");
        } catch (Exception e) {
            Log.w(TAG, "SetRemoteMode not supported or skipped: " + e.getMessage());
        }

        // SetEventMode (OpCode: 0x9115, Param: 1)
        try {
            sendOperationRequest(0x9115, 1);
            readOperationResponse();
            Log.i(TAG, "Canon SetEventMode(1) OK");
        } catch (Exception e) {
            Log.w(TAG, "SetEventMode not supported or skipped: " + e.getMessage());
        }

        // Set EvfOutputDevice (Property 0xD102): Try PC+LCD (3), LCD (2), PC (1), 9, 8
        int[] evfModes = {3, 2, 9, 8, 1};
        for (int mode : evfModes) {
            if (setDeviceProperty32(0xD102, mode)) {
                Log.i(TAG, "Canon EvfOutputDevice set to: " + mode);
                break;
            }
        }

        // Set EvfMode (Property 0xD10B) -> 1 (Enable EVF)
        setDeviceProperty32(0xD10B, 1);

        isLiveViewActive.set(true);
        statusMessage = "Canon EVF Live View Streaming Active!";
        Log.i(TAG, "EVF Live View Active! Starting frame polling loop...");

        // 6. Frame Polling Loop
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
                        statusMessage = String.format("Streaming: %.1f FPS (%d KB)", currentFps, jpeg.length / 1024);
                    }

                    if (frameListener != null) {
                        frameListener.onNewFrame(jpeg);
                    }
                } else {
                    consecutiveErrors++;
                    if (consecutiveErrors > 15) {
                        // Attempt re-enabling EVF
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
     * Fetches Live View image data handling PTP/IP StartData (9), DataPacket (12), and EndData (10).
     */
    private synchronized byte[] fetchLiveViewFrame(int opCode) throws Exception {
        int txId = transactionId++;

        // OperationRequest
        ByteBuffer req = ByteBuffer.allocate(8 + 4 + 2 + 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(req.capacity());
        req.putInt(6); // OperationRequest
        req.putInt(1); // DataPhase: In
        req.putShort((short) opCode);
        req.putInt(txId);
        req.putInt(0x00200000); // 2MB Max buffer

        cmdOut.write(req.array());
        cmdOut.flush();

        ByteArrayOutputStream frameStream = new ByteArrayOutputStream();

        while (true) {
            byte[] hdr = readExact(cmdIn, 8);
            ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
            int pktLen = hBuf.getInt();
            int pktType = hBuf.getInt();

            if (pktType == 9) { // StartData
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
            } else if (pktType == 12) { // DataPacket (Intermediate chunk)
                byte[] data = readExact(cmdIn, pktLen - 8);
                // First 4 bytes are transactionId, remainder is payload
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
            } else if (pktType == 10) { // EndData (Final chunk)
                byte[] data = readExact(cmdIn, pktLen - 8);
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
                // Read subsequent OperationResponse packet
                readOperationResponse();
                break;
            } else if (pktType == 7) { // OperationResponse (without data)
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
                break;
            } else {
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
            }
        }

        byte[] rawBlob = frameStream.toByteArray();
        if (rawBlob.length < 50) return null;

        // Scan for JPEG SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9)
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
     * Supports EOS OpCode 0x9155 and PTP OpCode 0x9029.
     * @param direction 1 = Far / Infinity, 2 = Near / Macro
     * @param step 1 = Small, 2 = Medium, 3 = Large
     */
    public synchronized boolean driveLensFocus(int direction, int step) {
        if (!isConnected()) return false;
        try {
            int stepClamped = Math.max(1, Math.min(3, step));

            // Try EOS OpCode 0x9155:
            // Near: 0x00000001, 0x00000002, 0x00000003
            // Far:  0x00008001, 0x00008002, 0x00008003
            int eosParam = direction == 1 ? (0x00008000 | stepClamped) : stepClamped;
            try {
                sendOperationRequest(0x9155, eosParam);
                readOperationResponse();
                Log.i(TAG, "EOS DriveFocus (0x9155) succeeded! Param=" + Integer.toHexString(eosParam));
                return true;
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
     * Trigger Shutter Release (OpCode: 0x902F or 0x9128)
     */
    public synchronized boolean triggerShutterRelease() {
        if (!isConnected()) return false;
        try {
            try {
                sendOperationRequest(0x902F);
                readOperationResponse();
                return true;
            } catch (Exception e) {
                sendOperationRequest(0x9128); // EOS remote release
                readOperationResponse();
                return true;
            }
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
     * Set Canon 32-bit Device Property (OpCode: 0x9014 - SetDevicePropValueEx)
     */
    public synchronized boolean setDeviceProperty32(int propCode, int value) {
        if (cmdOut == null) return false;
        try {
            int txId = transactionId++;

            // Data payload: PropCode (2B), DataType 0x0004 UINT32 (2B), Value (4B)
            byte[] dataPayload = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
                    .putShort((short) propCode)
                    .putShort((short) 0x0004)
                    .putInt(value)
                    .array();

            // OpRequest
            ByteBuffer req = ByteBuffer.allocate(8 + 4 + 2 + 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
            req.putInt(req.capacity());
            req.putInt(6); // OpRequest
            req.putInt(2); // Data Out
            req.putShort((short) 0x9014); // SetDevicePropValueEx
            req.putInt(txId);
            req.putInt(propCode);

            cmdOut.write(req.array());

            // StartData
            ByteBuffer start = ByteBuffer.allocate(8 + 4 + 8).order(ByteOrder.LITTLE_ENDIAN);
            start.putInt(start.capacity());
            start.putInt(9); // StartData
            start.putInt(txId);
            start.putLong(dataPayload.length);
            cmdOut.write(start.array());

            // EndData
            ByteBuffer end = ByteBuffer.allocate(8 + 4 + dataPayload.length).order(ByteOrder.LITTLE_ENDIAN);
            end.putInt(end.capacity());
            end.putInt(10); // EndData
            end.putInt(txId);
            end.put(dataPayload);
            cmdOut.write(end.array());
            cmdOut.flush();

            readOperationResponse();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "SetProp (0x" + Integer.toHexString(propCode) + ") error: " + e.getMessage());
            return false;
        }
    }

    private void sendOperationRequest(int opCode, int... params) throws Exception {
        int txId = transactionId++;
        int paramCount = params != null ? params.length : 0;
        int totalLen = 8 + 4 + 2 + 4 + (paramCount * 4);

        ByteBuffer req = ByteBuffer.allocate(totalLen).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(totalLen);
        req.putInt(6); // OperationRequest
        req.putInt(1); // DataPhase: In or No data
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
            if (read == -1) throw new Exception("Unexpected EOF while reading socket");
            offset += read;
        }
        return buf;
    }
}
