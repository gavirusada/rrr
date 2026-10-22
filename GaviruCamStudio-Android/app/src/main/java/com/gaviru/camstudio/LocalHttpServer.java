package com.gaviru.camstudio;

import android.content.Context;
import android.util.Log;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Embedded Lightweight HTTP Server for Android (Port 8787)
 * Serves the Studio Web UI, MJPEG Live Stream (/stream), and Remote Control API (/api/command).
 */
public class LocalHttpServer {

    private static final String TAG = "LocalHttpServer";
    private final int port = 8787;
    private final Context context;
    private final CanonPtpIpEngine canonEngine;
    private final AtomicBoolean isRunning = new AtomicBoolean(false);
    private ServerSocket serverSocket;

    public LocalHttpServer(Context context, CanonPtpIpEngine canonEngine) {
        this.context = context;
        this.canonEngine = canonEngine;
    }

    public void start() {
        if (isRunning.get()) return;
        isRunning.set(true);

        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"));
                Log.i(TAG, "Local Android Server started on http://127.0.0.1:" + port);

                while (isRunning.get()) {
                    Socket client = serverSocket.accept();
                    new Thread(() -> handleClient(client), "Http-Client").start();
                }
            } catch (Exception e) {
                if (isRunning.get()) {
                    Log.e(TAG, "Server error: " + e.getMessage());
                }
            }
        }, "Local-Http-Server").start();
    }

    public void stop() {
        isRunning.set(false);
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) {}
    }

    private void handleClient(Socket client) {
        try {
            client.setSoTimeout(10000);
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();

            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String reqLine = reader.readLine();
            if (reqLine == null) {
                client.close();
                return;
            }

            String[] parts = reqLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";

            int contentLength = 0;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(line.substring(15).trim());
                }
            }

            if (path.equals("/") || path.startsWith("/control")) {
                serveControlPage(out);
            } else if (path.startsWith("/stream") || path.startsWith("/live.mjpg")) {
                client.setSoTimeout(0); // Infinite timeout for video streaming
                serveMjpegStream(out);
            } else if (path.startsWith("/snapshot.jpg")) {
                serveSnapshot(out);
            } else if (path.startsWith("/api/state")) {
                serveApiState(out);
            } else if (path.startsWith("/api/command") && method.equalsIgnoreCase("POST")) {
                handleApiCommand(reader, contentLength, out);
            } else {
                out.write("HTTP/1.1 404 Not Found\r\n\r\nNot Found".getBytes(StandardCharsets.UTF_8));
                out.flush();
            }

            if (!path.startsWith("/stream") && !path.startsWith("/live.mjpg")) {
                client.close();
            }
        } catch (Exception ignored) {
            try { client.close(); } catch (Exception ignored2) {}
        }
    }

    private void serveControlPage(OutputStream out) throws Exception {
        String html = getStudioHtml();
        byte[] bytes = html.getBytes(StandardCharsets.UTF_8);

        String headers = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/html; charset=utf-8\r\n" +
                "Content-Length: " + bytes.length + "\r\n" +
                "Connection: close\r\n\r\n";

        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }

    private void serveMjpegStream(OutputStream out) throws Exception {
        String boundary = "gaviru_mjpeg_boundary";
        String initHeaders = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: multipart/x-mixed-replace; boundary=" + boundary + "\r\n" +
                "Cache-Control: no-cache, no-store, must-revalidate\r\n" +
                "Connection: keep-alive\r\n\r\n";

        out.write(initHeaders.getBytes(StandardCharsets.UTF_8));
        out.flush();

        byte[] lastSent = null;

        while (isRunning.get()) {
            byte[] frame = canonEngine.getLatestJpegFrame();
            if (frame != null && frame != lastSent) {
                lastSent = frame;
                String partHeader = "--" + boundary + "\r\n" +
                        "Content-Type: image/jpeg\r\n" +
                        "Content-Length: " + frame.length + "\r\n\r\n";

                out.write(partHeader.getBytes(StandardCharsets.UTF_8));
                out.write(frame);
                out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
            Thread.sleep(25);
        }
    }

    private void serveSnapshot(OutputStream out) throws Exception {
        byte[] frame = canonEngine.getLatestJpegFrame();
        if (frame == null) {
            out.write("HTTP/1.1 503 Service Unavailable\r\n\r\nNo Frame".getBytes(StandardCharsets.UTF_8));
            return;
        }

        String headers = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: image/jpeg\r\n" +
                "Content-Length: " + frame.length + "\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(frame);
        out.flush();
    }

    private void serveApiState(OutputStream out) throws Exception {
        JSONObject state = new JSONObject();
        state.put("ok", true);
        state.put("connected", canonEngine.isConnected());

        JSONObject cam = new JSONObject();
        cam.put("cameraName", "Canon EOS DSLR (Wi-Fi)");
        cam.put("iso", 100);
        cam.put("shutterSpeed", "1/125");
        cam.put("aperture", "f/4.0");
        cam.put("evfActive", true);
        state.put("camera", cam);

        byte[] bytes = state.toString().getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: " + bytes.length + "\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }

    private void handleApiCommand(BufferedReader reader, int length, OutputStream out) throws Exception {
        char[] bodyChars = new char[length];
        int read = 0;
        while (read < length) {
            int r = reader.read(bodyChars, read, length - read);
            if (r == -1) break;
            read += r;
        }
        String body = new String(bodyChars);
        JSONObject json = new JSONObject(body);
        String action = json.optString("action", "");

        boolean success = false;

        switch (action) {
            case "focus_step": {
                int step = json.optInt("step", 1);
                int dir = step >= 0 ? 1 : 2; // 1 = Far, 2 = Near
                success = canonEngine.driveLensFocus(dir, Math.abs(step));
                break;
            }
            case "cancel_af": {
                success = canonEngine.cancelAutoFocus();
                break;
            }
            case "shutter_release": {
                success = canonEngine.triggerShutterRelease();
                break;
            }
            case "set_iso": {
                int val = json.optInt("value", 100);
                success = canonEngine.setDeviceProperty32(0xD103, val);
                break;
            }
            case "set_shutter": {
                int val = json.optInt("value", 0x60);
                success = canonEngine.setDeviceProperty32(0xD104, val);
                break;
            }
            case "set_aperture": {
                int val = json.optInt("value", 0x28);
                success = canonEngine.setDeviceProperty32(0xD105, val);
                break;
            }
            default:
                success = true;
                break;
        }

        JSONObject resp = new JSONObject();
        resp.put("ok", success);
        byte[] bytes = resp.toString().getBytes(StandardCharsets.UTF_8);

        String headers = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: " + bytes.length + "\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }

    private String getStudioHtml() {
        return "<!doctype html>\n" +
                "<html lang=\"en\">\n" +
                "<head>\n" +
                "  <meta charset=\"utf-8\">\n" +
                "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover\">\n" +
                "  <title>Gaviru Cam Pro — Mobile Studio</title>\n" +
                "  <style>\n" +
                "    :root { color-scheme: dark; --bg:#080a0f; --card:#111520; --border:#232a3d; --red:#ef4444; --gold:#f59e0b; --cyan:#06b6d4; --green:#10b981; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; }\n" +
                "    * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }\n" +
                "    body { background:var(--bg); color:#f8fafc; min-height:100vh; display:flex; flex-direction:column; padding-bottom:20px; }\n" +
                "    header { background:#11151e; padding:12px 16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border); position:sticky; top:0; z-index:50; }\n" +
                "    .brand { font-size:16px; font-weight:800; background:linear-gradient(90deg,#fff,#fbbf24); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }\n" +
                "    .badge { font-size:11px; font-weight:700; padding:4px 8px; border-radius:6px; background:#102219; color:#6ee7b7; border:1px solid #10b981; }\n" +
                "    .viewport-box { position:relative; width:100%; aspect-ratio:3/2; background:#000; overflow:hidden; display:flex; align-items:center; justify-content:center; border-bottom:1px solid var(--border); }\n" +
                "    canvas { width:100%; height:100%; object-fit:contain; display:block; cursor:crosshair; }\n" +
                "    .af-box { position:absolute; width:64px; height:64px; border:2px solid #ef4444; border-radius:8px; pointer-events:none; transform:translate(-50%,-50%); transition:all 0.15s ease; opacity:0; box-shadow:0 0 14px rgba(239,68,68,0.7); }\n" +
                "    .af-box.active { opacity:1; }\n" +
                "    .af-box.locked { border-color:#10b981; box-shadow:0 0 14px rgba(16,185,129,0.8); }\n" +
                "    .controls { padding:14px; display:flex; flex-direction:column; gap:12px; }\n" +
                "    .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:10px; }\n" +
                "    .btn-row { display:flex; gap:8px; }\n" +
                "    button { font:inherit; font-weight:700; font-size:12.5px; border-radius:8px; border:1px solid var(--border); background:#171c2b; color:#fff; padding:10px 12px; cursor:pointer; transition:0.15s; flex:1; display:flex; align-items:center; justify-content:center; gap:6px; }\n" +
                "    button:active { transform:scale(0.97); }\n" +
                "    button.primary { background:linear-gradient(135deg,#ef4444,#dc2626); border-color:#ef4444; box-shadow:0 4px 12px rgba(239,68,68,0.35); }\n" +
                "    button.accent { background:linear-gradient(135deg,#10b981,#059669); border-color:#10b981; }\n" +
                "    button.gold { background:linear-gradient(135deg,#d97706,#b45309); border-color:#f59e0b; }\n" +
                "    .slider-row { display:flex; flex-direction:column; gap:4px; font-size:12px; color:#94a3b8; }\n" +
                "    input[type=range] { width:100%; accent-color:var(--red); }\n" +
                "  </style>\n" +
                "</head>\n" +
                "<body>\n" +
                "  <header>\n" +
                "    <div class=\"brand\">🎥 Gaviru Cam Pro Mobile</div>\n" +
                "    <div id=\"wifiBadge\" class=\"badge\">📡 Wi-Fi: CONNECTED</div>\n" +
                "  </header>\n" +
                "\n" +
                "  <div class=\"viewport-box\" onclick=\"onCanvasTap(event)\">\n" +
                "    <canvas id=\"monitorCanvas\" width=\"1280\" height=\"854\"></canvas>\n" +
                "    <div id=\"afBox\" class=\"af-box\"></div>\n" +
                "    <img id=\"rawStreamImg\" src=\"/stream\" style=\"display:none;\" crossorigin=\"anonymous\">\n" +
                "  </div>\n" +
                "\n" +
                "  <div class=\"controls\">\n" +
                "    <!-- VDO.Ninja 1-Click Broadcast Button -->\n" +
                "    <div class=\"btn-row\">\n" +
                "      <button id=\"btnVdoBroadcast\" class=\"primary\" style=\"padding:14px; font-size:14px;\" onclick=\"toggleVdoBroadcast()\">\n" +
                "        🚀 Start VDO.Ninja 4K Broadcast to OBS\n" +
                "      </button>\n" +
                "    </div>\n" +
                "    <div id=\"vdoStatusBox\" style=\"display:none; background:#120c15; border:1px solid #ef4444; border-radius:8px; padding:10px; font-size:11.5px; color:#fca5a5;\">\n" +
                "      📡 <strong>VDO.Ninja Live Streaming Active!</strong> OBS Studio එකට මෙම Link එක ලබා දෙන්න:<br>\n" +
                "      <code id=\"obsLinkCode\" style=\"color:#fde68a; font-family:monospace; word-break:break-all;\">https://vdo.ninja/?view=gaviru-cam-pro&cleanoutput</code>\n" +
                "      <button class=\"gold\" style=\"margin-top:6px; padding:6px; font-size:11px;\" onclick=\"copyObsLink()\">📋 Copy OBS Link</button>\n" +
                "    </div>\n" +
                "\n" +
                "    <!-- Focus Controls -->\n" +
                "    <div class=\"card\">\n" +
                "      <div style=\"font-size:13px; font-weight:800; color:#fff; display:flex; justify-content:space-between;\">\n" +
                "        <span>🔍 Lens Auto & Manual Focus Drive</span>\n" +
                "        <span id=\"lblFocusStatus\" style=\"color:#38bdf8; font-size:11px;\">Tap Viewport to Focus</span>\n" +
                "      </div>\n" +
                "      <div class=\"btn-row\">\n" +
                "        <button onclick=\"sendFocus(-3)\">⏪ Far 3</button>\n" +
                "        <button onclick=\"sendFocus(-1)\">◀ Far 1</button>\n" +
                "        <button onclick=\"sendFocus(1)\">Near 1 ▶</button>\n" +
                "        <button onclick=\"sendFocus(3)\">Near 3 ⏩</button>\n" +
                "      </div>\n" +
                "      <div class=\"btn-row\">\n" +
                "        <button class=\"accent\" onclick=\"freezeFocusNow()\">🔒 Freeze Focus & Light (Sweet Spot)</button>\n" +
                "        <button class=\"gold\" onclick=\"triggerShutter()\">📸 Take Photo</button>\n" +
                "      </div>\n" +
                "    </div>\n" +
                "\n" +
                "    <!-- Focus Light Sweet Spot Dimming -->\n" +
                "    <div class=\"card\">\n" +
                "      <div style=\"font-size:13px; font-weight:800; color:#fff;\">💡 Focus Light Dimming & Brightening</div>\n" +
                "      <div class=\"slider-row\">\n" +
                "        <div style=\"display:flex; justify-content:space-between;\"><span>Focus Dim Level:</span><span id=\"lblDimVal\">82%</span></div>\n" +
                "        <input type=\"range\" id=\"sliderDim\" min=\"35\" max=\"150\" value=\"82\" oninput=\"lblDimVal.textContent=this.value+'%'\">\n" +
                "      </div>\n" +
                "      <div class=\"slider-row\">\n" +
                "        <div style=\"display:flex; justify-content:space-between;\"><span>Lock Brightness:</span><span id=\"lblBrightVal\">100%</span></div>\n" +
                "        <input type=\"range\" id=\"sliderBright\" min=\"50\" max=\"160\" value=\"100\" oninput=\"lblBrightVal.textContent=this.value+'%'\">\n" +
                "      </div>\n" +
                "    </div>\n" +
                "  </div>\n" +
                "\n" +
                "  <script>\n" +
                "    const canvas = document.getElementById('monitorCanvas');\n" +
                "    const ctx = canvas.getContext('2d');\n" +
                "    const rawImg = document.getElementById('rawStreamImg');\n" +
                "    const afBox = document.getElementById('afBox');\n" +
                "    let audioCtx = null;\n" +
                "    let isBroadcasting = false;\n" +
                "    let broadcastStream = null;\n" +
                "    let roomName = 'gaviru-cam-pro';\n" +
                "\n" +
                "    // Render MJPEG onto Canvas at 30 FPS\n" +
                "    function renderLoop() {\n" +
                "      if (rawImg.complete && rawImg.naturalWidth > 0) {\n" +
                "        ctx.drawImage(rawImg, 0, 0, canvas.width, canvas.height);\n" +
                "      }\n" +
                "      requestAnimationFrame(renderLoop);\n" +
                "    }\n" +
                "    requestAnimationFrame(renderLoop);\n" +
                "\n" +
                "    // Authentic Canon Pip-Pip Double Beep\n" +
                "    function playCanonBeep() {\n" +
                "      try {\n" +
                "        const AudioClass = window.AudioContext || window.webkitAudioContext;\n" +
                "        if (!audioCtx && AudioClass) audioCtx = new AudioClass();\n" +
                "        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();\n" +
                "        if (!audioCtx) return;\n" +
                "        const now = audioCtx.currentTime;\n" +
                "        const pip = (t, dur) => {\n" +
                "          const osc = audioCtx.createOscillator();\n" +
                "          const gain = audioCtx.createGain();\n" +
                "          osc.type = 'sine';\n" +
                "          osc.frequency.setValueAtTime(2880, t);\n" +
                "          gain.gain.setValueAtTime(0.001, t);\n" +
                "          gain.gain.exponentialRampToValueAtTime(0.25, t + 0.008);\n" +
                "          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);\n" +
                "          osc.connect(gain); gain.connect(audioCtx.destination);\n" +
                "          osc.start(t); osc.stop(t + dur + 0.01);\n" +
                "        };\n" +
                "        pip(now, 0.055);\n" +
                "        pip(now + 0.075, 0.065);\n" +
                "      } catch(e) {}\n" +
                "    }\n" +
                "\n" +
                "    // Tap Viewport to Trigger Auto-Focus + Light Dimming Effect\n" +
                "    async function onCanvasTap(e) {\n" +
                "      const rect = e.currentTarget.getBoundingClientRect();\n" +
                "      const x = ((e.clientX - rect.left) / rect.width) * 100;\n" +
                "      const y = ((e.clientY - rect.top) / rect.height) * 100;\n" +
                "      afBox.style.left = x + '%';\n" +
                "      afBox.style.top = y + '%';\n" +
                "      afBox.className = 'af-box active';\n" +
                "      document.getElementById('lblFocusStatus').textContent = 'Focusing...';\n" +
                "\n" +
                "      // Drive lens near/far\n" +
                "      await sendFocus(1);\n" +
                "      setTimeout(() => {\n" +
                "        afBox.className = 'af-box active locked';\n" +
                "        playCanonBeep();\n" +
                "        document.getElementById('lblFocusStatus').textContent = '🔔 Focus Locked!';\n" +
                "        setTimeout(() => { afBox.className = 'af-box'; }, 1800);\n" +
                "      }, 400);\n" +
                "    }\n" +
                "\n" +
                "    async function sendFocus(step) {\n" +
                "      try {\n" +
                "        await fetch('/api/command', {\n" +
                "          method: 'POST',\n" +
                "          headers: { 'Content-Type': 'application/json' },\n" +
                "          body: JSON.stringify({ action: 'focus_step', step })\n" +
                "        });\n" +
                "      } catch(e) {}\n" +
                "    }\n" +
                "\n" +
                "    async function freezeFocusNow() {\n" +
                "      playCanonBeep();\n" +
                "      document.getElementById('lblFocusStatus').textContent = '🔒 Sweet Spot Locked!';\n" +
                "      try {\n" +
                "        await fetch('/api/command', {\n" +
                "          method: 'POST',\n" +
                "          headers: { 'Content-Type': 'application/json' },\n" +
                "          body: JSON.stringify({ action: 'cancel_af' })\n" +
                "        });\n" +
                "      } catch(e) {}\n" +
                "    }\n" +
                "\n" +
                "    async function triggerShutter() {\n" +
                "      playCanonBeep();\n" +
                "      await fetch('/api/command', {\n" +
                "        method: 'POST',\n" +
                "        headers: { 'Content-Type': 'application/json' },\n" +
                "        body: JSON.stringify({ action: 'shutter_release' })\n" +
                "      });\n" +
                "    }\n" +
                "\n" +
                "    // VDO.Ninja 4K Live Broadcast to OBS Studio\n" +
                "    function toggleVdoBroadcast() {\n" +
                "      const btn = document.getElementById('btnVdoBroadcast');\n" +
                "      const box = document.getElementById('vdoStatusBox');\n" +
                "      isBroadcasting = !isBroadcasting;\n" +
                "      if (isBroadcasting) {\n" +
                "        btn.textContent = '⏹ Stop VDO.Ninja Broadcast';\n" +
                "        btn.className = 'gold';\n" +
                "        box.style.display = 'block';\n" +
                "        // Open VDO.Ninja push window or background frame\n" +
                "        const pushUrl = 'https://vdo.ninja/?push=' + encodeURIComponent(roomName) + '&webcam&autostart&videobitrate=15000&scale=100';\n" +
                "        window.open(pushUrl, '_blank');\n" +
                "      } else {\n" +
                "        btn.textContent = '🚀 Start VDO.Ninja 4K Broadcast to OBS';\n" +
                "        btn.className = 'primary';\n" +
                "        box.style.display = 'none';\n" +
                "      }\n" +
                "    }\n" +
                "\n" +
                "    function copyObsLink() {\n" +
                "      const link = 'https://vdo.ninja/?view=' + encodeURIComponent(roomName) + '&cleanoutput';\n" +
                "      navigator.clipboard.writeText(link);\n" +
                "      alert('📋 OBS Browser Source Link Copied:\\n' + link);\n" +
                "    }\n" +
                "  </script>\n" +
                "</body>\n" +
                "</html>";
    }
}
