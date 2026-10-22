package com.gaviru.camstudio;

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
 * Native Canon PTP/IP Wi-Fi Client for Android
 * Connects directly to Canon EOS DSLR/Mirrorless cameras over Wi-Fi (IP: 192.168.1.1:15740).
 * Handles EVF Live View streaming and real-time Lens Focus & Camera Controls.
 */
public class CanonPtpIpEngine {

    private static final String TAG = "CanonPtpIp";

    private String cameraIp = "192.168.1.1";
    private int cameraPort = 15740;

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
    private String lastError = null;

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

    public void setFrameListener(FrameListener listener) {
        this.frameListener = listener;
    }

    public synchronized boolean isConnected() {
        return isRunning.get() && cmdSocket != null && cmdSocket.isConnected();
    }

    public byte[] getLatestJpegFrame() {
        return latestJpegFrame;
    }

    public String getLastError() {
        return lastError;
    }

    public void start() {
        if (isRunning.get()) return;
        isRunning.set(true);

        new Thread(() -> {
            while (isRunning.get()) {
                try {
                    connectAndStream();
                } catch (Exception e) {
                    lastError = e.getMessage();
                    Log.e(TAG, "Connection error: " + e.getMessage(), e);
                }

                closeSockets();

                if (isRunning.get()) {
                    try {
                        Thread.sleep(2500); // Retry delay
                    } catch (InterruptedException ignored) {}
                }
            }
        }, "Canon-PTP-Streamer").start();
    }

    public void stop() {
        isRunning.set(false);
        closeSockets();
    }

    private void closeSockets() {
        isLiveViewActive.set(false);
        try { if (cmdSocket != null) cmdSocket.close(); } catch (Exception ignored) {}
        try { if (evtSocket != null) evtSocket.close(); } catch (Exception ignored) {}
        cmdSocket = null;
        evtSocket = null;
    }

    private void connectAndStream() throws Exception {
        Log.i(TAG, "Connecting to Canon Camera at " + cameraIp + ":" + cameraPort + "...");

        // 1. Connect Command Socket
        cmdSocket = new Socket();
        cmdSocket.setTcpNoDelay(true);
        cmdSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 5000);
        cmdOut = cmdSocket.getOutputStream();
        cmdIn = cmdSocket.getInputStream();

        // 2. InitCommandRequest
        byte[] guid = new byte[16];
        ByteBuffer.wrap(guid).putLong(UUID.randomUUID().getMostSignificantBits()).putLong(UUID.randomUUID().getLeastSignificantBits());
        byte[] clientNameBytes = "Gaviru-Cam-Android\0".getBytes(StandardCharsets.UTF_16LE);

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
        Log.i(TAG, "PTP/IP Command Connected! ConnectionNumber: " + connectionNumber);

        // 3. Connect Event Socket
        evtSocket = new Socket();
        evtSocket.setTcpNoDelay(true);
        evtSocket.connect(new InetSocketAddress(cameraIp, cameraPort), 5000);
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

        // 4. Open Session (OpCode: 0x1002)
        sendOperationRequest(0x1002, 1);
        readOperationResponse();

        // 5. Start EVF Live View
        // Set EvfOutputDevice (0xD102) -> 0x00000008 (Wi-Fi PC) or 0x00000009 (Wi-Fi PC + LCD)
        setDeviceProperty32(0xD102, 0x00000009);
        // Set EvfMode (0xD10B) -> 1 (Enable EVF)
        setDeviceProperty32(0xD10B, 1);

        isLiveViewActive.set(true);
        Log.i(TAG, "Canon EVF Live View Started successfully! Streaming frames...");

        // 6. Frame Polling Loop
        while (isRunning.get() && isLiveViewActive.get()) {
            try {
                byte[] jpeg = fetchViewFinderFrame();
                if (jpeg != null && jpeg.length > 100) {
                    latestJpegFrame = jpeg;
                    lastFrameTime = System.currentTimeMillis();
                    if (frameListener != null) {
                        frameListener.onNewFrame(jpeg);
                    }
                }
                Thread.sleep(25); // ~35 FPS
            } catch (Exception e) {
                Log.w(TAG, "ViewFinder poll tick error: " + e.getMessage());
                Thread.sleep(80);
            }
        }
    }

    /**
     * Sends Canon GetViewFinderData (OpCode: 0x9027) and extracts the JPEG frame
     */
    private synchronized byte[] fetchViewFinderFrame() throws Exception {
        int txId = transactionId++;

        // OperationRequest: GetViewFinderData (0x9027), Param1 = 0x00200000 (Max buffer 2MB)
        ByteBuffer req = ByteBuffer.allocate(8 + 4 + 2 + 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
        req.putInt(req.capacity());
        req.putInt(6); // OperationRequest
        req.putInt(1); // DataPhase: In
        req.putShort((short) 0x9027); // OpCode
        req.putInt(txId);
        req.putInt(0x00200000); // 2MB length request

        cmdOut.write(req.array());
        cmdOut.flush();

        // Read Data / Response Packets
        ByteArrayOutputStream frameStream = new ByteArrayOutputStream();
        boolean receivedData = false;

        while (true) {
            byte[] hdr = readExact(cmdIn, 8);
            ByteBuffer hBuf = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
            int pktLen = hBuf.getInt();
            int pktType = hBuf.getInt();

            if (pktType == 9) { // StartData
                readExact(cmdIn, pktLen - 8);
                receivedData = true;
            } else if (pktType == 10) { // EndData
                byte[] data = readExact(cmdIn, pktLen - 8);
                // First 4 bytes are transactionId, remaining is payload
                if (data.length > 4) {
                    frameStream.write(data, 4, data.length - 4);
                }
            } else if (pktType == 7) { // OperationResponse
                byte[] resp = readExact(cmdIn, pktLen - 8);
                break;
            } else {
                if (pktLen > 8) readExact(cmdIn, pktLen - 8);
            }
        }

        byte[] rawBlob = frameStream.toByteArray();
        if (rawBlob.length < 10) return null;

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
     * Canon Lens Drive Focus (OpCode: 0x9029 - DoAutoFocus / DriveLens)
     * @param direction 0x0001 = Far / Infinity, 0x0002 = Near / Macro
     * @param step 1 = Small, 2 = Medium, 3 = Large
     */
    public synchronized boolean driveLensFocus(int direction, int step) {
        if (!isConnected()) return false;
        try {
            int stepParam = Math.max(1, Math.min(3, step));
            int dirParam = direction == 1 ? 0x0001 : 0x0002;
            int param = (dirParam << 16) | stepParam;

            sendOperationRequest(0x9029, param);
            readOperationResponse();
            Log.i(TAG, "Focus Drive sent! Direction=" + direction + " Step=" + step);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Focus Drive error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Trigger Shutter Release (OpCode: 0x902F)
     */
    public synchronized boolean triggerShutterRelease() {
        if (!isConnected()) return false;
        try {
            sendOperationRequest(0x902F);
            readOperationResponse();
            Log.i(TAG, "Shutter Released!");
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
            Log.e(TAG, "SetProp error: " + e.getMessage());
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
        req.putInt(1); // DataPhase: No data / In
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
            int read = in.read(buf, offset, length - 1);
            if (read == -1) throw new Exception("Unexpected EOF while reading socket");
            offset += read;
        }
        return buf;
    }
}
