package com.gaviru.camstudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Message;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * Gaviru Cam Studio — Built-in Desktop Browser
 * Full desktop WebView browser with Canon 4000D Virtual Webcam Injection.
 * When any website (Facebook Live, YouTube, StreamYard, VDO.Ninja, etc.)
 * calls getUserMedia/getDisplayMedia, it directly receives the Canon 4000D
 * DSLR Live View feed + real microphone audio (Earphone Jack Mic / built-in mic)!
 */
public class BrowserActivity extends AppCompatActivity {

    private static final int FILE_CHOOSER_REQ = 2001;
    private static final int PERMISSION_REQ   = 2002;

    private WebView  webView;
    private EditText editUrl;
    private ProgressBar progressBar;
    private ImageButton btnBack, btnForward, btnRefresh, btnHome, btnClose;

    private ValueCallback<Uri[]> filePathCallback;
    private String homeUrl = "https://www.facebook.com/live/producer";

    private GaviruCamForegroundService serviceInstance = null;
    private boolean isBound = false;

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            GaviruCamForegroundService.LocalBinder localBinder =
                (GaviruCamForegroundService.LocalBinder) binder;
            serviceInstance = localBinder.getService();
            isBound = true;
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            serviceInstance = null;
            isBound = false;
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_browser);

        // Bind to background ForegroundService to access live Canon MJPEG frames
        serviceInstance = GaviruCamForegroundService.getInstance();
        bindService(new Intent(this, GaviruCamForegroundService.class), serviceConnection, Context.BIND_AUTO_CREATE);

        webView     = findViewById(R.id.browserWebView);
        editUrl     = findViewById(R.id.editUrl);
        progressBar = findViewById(R.id.browserProgress);
        btnBack     = findViewById(R.id.btnBrowserBack);
        btnForward  = findViewById(R.id.btnBrowserForward);
        btnRefresh  = findViewById(R.id.btnBrowserRefresh);
        btnHome     = findViewById(R.id.btnBrowserHome);
        btnClose    = findViewById(R.id.btnBrowserClose);

        if (getIntent() != null && getIntent().getStringExtra("url") != null) {
            homeUrl = getIntent().getStringExtra("url");
        }

        setupWebView();
        setupControls();
        requestPermissionsIfNeeded();

        webView.loadUrl(homeUrl);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings ws = webView.getSettings();

        // ── Core JS + Storage ──────────────────────────────────────────────
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);

        // ── Desktop mode ───────────────────────────────────────────────────
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setSupportZoom(true);
        ws.setBuiltInZoomControls(true);
        ws.setDisplayZoomControls(false);

        // Desktop Chrome user-agent so Facebook, YouTube, StreamYard render full desktop live studios
        ws.setUserAgentString(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/124.0.0.0 Safari/537.36"
        );

        // ── Media / WebRTC ─────────────────────────────────────────────────
        ws.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Bridge providing Canon 4000D Live View frames to website JavaScript
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String getLatestFrameBase64() {
                GaviruCamForegroundService s = serviceInstance != null ?
                    serviceInstance : GaviruCamForegroundService.getInstance();
                if (s != null && s.getCanonEngine() != null) {
                    byte[] frame = s.getCanonEngine().getLatestJpegFrame();
                    if (frame != null && frame.length > 50) {
                        return Base64.encodeToString(frame, Base64.NO_WRAP);
                    }
                }
                return "";
            }
        }, "CanonBridge");

        // ── WebViewClient ─────────────────────────────────────────────────
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                editUrl.setText(url);
                updateNavButtons();
                injectCanonWebcamShim(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                editUrl.setText(url);
                updateNavButtons();
                injectCanonWebcamShim(view);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    view.loadUrl(url);
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) {}
                return true;
            }
        });

        // ── WebChromeClient ───────────────────────────────────────────────
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Auto-grant Camera + Mic permissions to websites so live stream works instantly!
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }

            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setProgress(progress);
                if (progress == 100) progressBar.setVisibility(View.GONE);
                else progressBar.setVisibility(View.VISIBLE);
                if (progress > 30) {
                    injectCanonWebcamShim(view);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                    ValueCallback<Uri[]> filePath,
                    FileChooserParams params) {
                filePathCallback = filePath;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQ);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                    boolean isUserGesture, Message resultMsg) {
                WebView newView = new WebView(BrowserActivity.this);
                newView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView v, String url) {
                        webView.loadUrl(url);
                    }
                });
                WebView.WebViewTransport transport =
                    (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(newView);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                return true;
            }
        });

        ws.setSupportMultipleWindows(true);
        ws.setJavaScriptCanOpenWindowsAutomatically(true);
    }

    /**
     * Injects the WebRTC virtual webcam shim into the website.
     * Hooks navigator.mediaDevices.getUserMedia & navigator.mediaDevices.enumerateDevices
     * so that the site automatically receives Canon 4000D DSLR live video feed
     * combined with the real microphone audio (earphone jack / built-in mic).
     */
    private void injectCanonWebcamShim(WebView view) {
        String js =
            "(function() {" +
            "  if (window.__canonShimArmed) return;" +
            "  window.__canonShimArmed = true;" +
            "  if (!window.__origGUM && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {" +
            "    window.__origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);" +
            "  }" +
            "  if (!window.__origEnumerate && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {" +
            "    window.__origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);" +
            "  }" +
            "  const canvas = document.createElement('canvas');" +
            "  canvas.width = 1280; canvas.height = 720;" +
            "  const ctx = canvas.getContext('2d');" +
            "  ctx.fillStyle = '#080a0f';" +
            "  ctx.fillRect(0, 0, canvas.width, canvas.height);" +
            "  ctx.fillStyle = '#10b981';" +
            "  ctx.font = 'bold 36px sans-serif';" +
            "  ctx.fillText('📷 Gaviru Cam — Canon EOS 4000D Live', 60, 120);" +
            "  const img = new Image();" +
            "  let busy = false;" +
            "  img.onload = function() {" +
            "    try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch(e) {}" +
            "    busy = false;" +
            "  };" +
            "  img.onerror = function() { busy = false; };" +
            "  function updateFrame() {" +
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
            "  setInterval(updateFrame, 25);" +
            "  function buildCanonStream(constraints) {" +
            "    const videoStream = canvas.captureStream(30);" +
            "    const wantAudio = (!constraints || constraints.audio !== false);" +
            "    if (!wantAudio) {" +
            "      return Promise.resolve(new MediaStream([...videoStream.getVideoTracks()]));" +
            "    }" +
            "    if (window.__origGUM) {" +
            "      let aOpt = true;" +
            "      if (constraints && typeof constraints.audio === 'object') {" +
            "        aOpt = Object.assign({}, constraints.audio);" +
            "        if (aOpt.deviceId && (aOpt.deviceId === 'canon-camera-id' || aOpt.deviceId === 'default')) {" +
            "          delete aOpt.deviceId;" +
            "        }" +
            "      }" +
            "      return window.__origGUM({ audio: aOpt, video: false })" +
            "        .then(function(micStream) {" +
            "          return new MediaStream([...videoStream.getVideoTracks(), ...micStream.getAudioTracks()]);" +
            "        })" +
            "        .catch(function() {" +
            "          return window.__origGUM({ audio: true, video: false })" +
            "            .then(function(fb) {" +
            "              return new MediaStream([...videoStream.getVideoTracks(), ...fb.getAudioTracks()]);" +
            "            })" +
            "            .catch(function() {" +
            "              return new MediaStream([...videoStream.getVideoTracks()]);" +
            "            });" +
            "        });" +
            "    }" +
            "    return Promise.resolve(new MediaStream([...videoStream.getVideoTracks()]));" +
            "  }" +
            "  if (!navigator.mediaDevices) navigator.mediaDevices = {};" +
            "  navigator.mediaDevices.enumerateDevices = async function() {" +
            "    let realList = [];" +
            "    try {" +
            "      if (window.__origEnumerate) realList = await window.__origEnumerate();" +
            "    } catch(e) {}" +
            "    const devices = [];" +
            "    devices.push({" +
            "      deviceId: 'canon-camera-id'," +
            "      kind: 'videoinput'," +
            "      label: '📷 Canon EOS 4000D DSLR (Gaviru Cam Live)'," +
            "      groupId: 'canon-video-group'," +
            "      toJSON: function() { return this; }" +
            "    });" +
            "    if (realList && realList.length > 0) {" +
            "      for (let i = 0; i < realList.length; i++) {" +
            "        const d = realList[i];" +
            "        if (d.kind === 'audioinput') {" +
            "          devices.push({" +
            "            deviceId: d.deviceId || ('audio_' + i)," +
            "            kind: 'audioinput'," +
            "            label: d.label || ('🎙️ Microphone ' + (i + 1))," +
            "            groupId: d.groupId || 'audio-group'," +
            "            toJSON: function() { return this; }" +
            "          });" +
            "        } else if (d.kind === 'audiooutput') {" +
            "          devices.push(d);" +
            "        }" +
            "      }" +
            "    }" +
            "    devices.push({" +
            "      deviceId: 'headset_mic'," +
            "      kind: 'audioinput'," +
            "      label: '🎧 Earphone Jack Mic (3.5mm Headset)'," +
            "      groupId: 'earphone-group'," +
            "      toJSON: function() { return this; }" +
            "    });" +
            "    devices.push({" +
            "      deviceId: 'builtin_mic'," +
            "      kind: 'audioinput'," +
            "      label: '📱 Phone Built-in Microphone'," +
            "      groupId: 'phone-group'," +
            "      toJSON: function() { return this; }" +
            "    });" +
            "    return devices;" +
            "  };" +
            "  navigator.mediaDevices.getUserMedia = function(c) { return buildCanonStream(c); };" +
            "  navigator.mediaDevices.getDisplayMedia = function(c) { return buildCanonStream(c); };" +
            "  navigator.getUserMedia = function(c, s, e) {" +
            "    buildCanonStream(c).then(function(st) { if (s) s(st); }).catch(function(err) { if (e) e(err); });" +
            "  };" +
            "  navigator.webkitGetUserMedia = navigator.getUserMedia;" +
            "  console.log('✓ Canon 4000D DSLR Live Webcam injected into browser!');" +
            "})();";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            view.evaluateJavascript(js, null);
        } else {
            view.loadUrl("javascript:" + js);
        }
    }

    private void setupControls() {
        editUrl.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO
                    || actionId == EditorInfo.IME_ACTION_SEARCH
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                        && event.getAction() == KeyEvent.ACTION_DOWN)) {
                navigateTo(editUrl.getText().toString().trim());
                return true;
            }
            return false;
        });

        btnBack.setOnClickListener(v -> {
            if (webView.canGoBack()) webView.goBack();
        });

        btnForward.setOnClickListener(v -> {
            if (webView.canGoForward()) webView.goForward();
        });

        btnRefresh.setOnClickListener(v -> webView.reload());

        btnHome.setOnClickListener(v -> {
            webView.loadUrl(homeUrl);
            Toast.makeText(this, "🏠 Home", Toast.LENGTH_SHORT).show();
        });

        btnClose.setOnClickListener(v -> finish());

        setupQuickLinks();
    }

    private void setupQuickLinks() {
        Button btnVdo = findViewById(R.id.btnQuickVdo);
        Button btnFb  = findViewById(R.id.btnQuickFb);
        Button btnYt  = findViewById(R.id.btnQuickYt);
        Button btnCam = findViewById(R.id.btnQuickCam);

        if (btnVdo != null) btnVdo.setOnClickListener(v ->
            webView.loadUrl("https://vdo.ninja/"));

        if (btnFb != null) btnFb.setOnClickListener(v ->
            webView.loadUrl("https://www.facebook.com/live/producer"));

        if (btnYt != null) btnYt.setOnClickListener(v ->
            webView.loadUrl("https://studio.youtube.com/"));

        if (btnCam != null) {
            String room = getSharedPreferences("GaviruCamPrefs", MODE_PRIVATE)
                .getString("vdo_room_name", "gaviru_cam_pro");
            String pushUrl = "https://vdo.ninja/?push=" + room +
                "&webcam&autostart&videobitrate=6000&audiobitrate=128&fps=30";
            btnCam.setOnClickListener(v -> webView.loadUrl(pushUrl));
        }
    }

    private void navigateTo(String input) {
        if (input.isEmpty()) return;
        String url;
        if (input.startsWith("http://") || input.startsWith("https://")) {
            url = input;
        } else if (input.contains(".") && !input.contains(" ")) {
            url = "https://" + input;
        } else {
            url = "https://www.google.com/search?q=" + Uri.encode(input);
        }
        webView.loadUrl(url);
    }

    private void updateNavButtons() {
        btnBack.setEnabled(webView.canGoBack());
        btnForward.setEnabled(webView.canGoForward());
        btnBack.setAlpha(webView.canGoBack() ? 1f : 0.4f);
        btnForward.setAlpha(webView.canGoForward() ? 1f : 0.4f);
    }

    private void requestPermissionsIfNeeded() {
        String[] perms = {
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.MODIFY_AUDIO_SETTINGS
        };
        boolean needRequest = false;
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p)
                    != PackageManager.PERMISSION_GRANTED) {
                needRequest = true;
                break;
            }
        }
        if (needRequest) {
            ActivityCompat.requestPermissions(this, perms, PERMISSION_REQ);
        }
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQ) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataStr = data.getDataString();
                if (dataStr != null) results = new Uri[]{Uri.parse(dataStr)};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (isBound) {
            unbindService(serviceConnection);
            isBound = false;
        }
        webView.destroy();
        super.onDestroy();
    }
}
