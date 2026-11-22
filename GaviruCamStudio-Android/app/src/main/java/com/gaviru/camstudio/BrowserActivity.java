package com.gaviru.camstudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
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
 * Full desktop WebView browser — go to any site: VDO.Ninja, Facebook Live,
 * YouTube Live, OBS Websocket, etc.
 * Camera + Mic permissions auto-granted so WebRTC works without popup.
 */
public class BrowserActivity extends AppCompatActivity {

    private static final int FILE_CHOOSER_REQ = 2001;
    private static final int PERMISSION_REQ   = 2002;

    private WebView  webView;
    private EditText editUrl;
    private ProgressBar progressBar;
    private ImageButton btnBack, btnForward, btnRefresh, btnHome, btnClose;

    // For file upload (<input type="file">)
    private ValueCallback<Uri[]> filePathCallback;

    // Default home URL — VDO.Ninja push (can be changed by user)
    private String homeUrl = "https://vdo.ninja/";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_browser);

        webView     = findViewById(R.id.browserWebView);
        editUrl     = findViewById(R.id.editUrl);
        progressBar = findViewById(R.id.browserProgress);
        btnBack     = findViewById(R.id.btnBrowserBack);
        btnForward  = findViewById(R.id.btnBrowserForward);
        btnRefresh  = findViewById(R.id.btnBrowserRefresh);
        btnHome     = findViewById(R.id.btnBrowserHome);
        btnClose    = findViewById(R.id.btnBrowserClose);

        // Pick up URL from intent (if launched from main screen with a URL)
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
        // Desktop user-agent (Chrome 120 desktop)
        ws.setUserAgentString(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Safari/537.36"
        );

        // ── Media / WebRTC ─────────────────────────────────────────────────
        ws.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // ── WebViewClient — handle navigation ─────────────────────────────
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                editUrl.setText(url);
                updateNavButtons();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                editUrl.setText(url);
                updateNavButtons();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Keep everything inside our WebView
                String url = req.getUrl().toString();
                if (url.startsWith("http") || url.startsWith("https")) {
                    view.loadUrl(url);
                    return true;
                }
                // Let the system handle mailto:, intent: etc.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) {}
                return true;
            }
        });

        // ── WebChromeClient — camera / mic / file / fullscreen ────────────
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Auto-grant camera + mic for WebRTC (Facebook Live, VDO.Ninja, etc.)
                request.grant(request.getResources());
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

            // Allow pop-up windows (some live sites open new tabs)
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
                return true; // suppress console spam
            }
        });

        // Allow multiple windows
        ws.setSupportMultipleWindows(true);
        ws.setJavaScriptCanOpenWindowsAutomatically(true);
    }

    private void setupControls() {
        // URL bar: Go on keyboard Enter / Done
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

        // ── Quick link buttons ─────────────────────────────────────────────
        setupQuickLinks();
    }

    private void setupQuickLinks() {
        android.widget.Button btnVdo = findViewById(R.id.btnQuickVdo);
        android.widget.Button btnFb  = findViewById(R.id.btnQuickFb);
        android.widget.Button btnYt  = findViewById(R.id.btnQuickYt);
        android.widget.Button btnCam = findViewById(R.id.btnQuickCam);

        if (btnVdo != null) btnVdo.setOnClickListener(v ->
            webView.loadUrl("https://vdo.ninja/"));

        if (btnFb != null) btnFb.setOnClickListener(v ->
            webView.loadUrl("https://www.facebook.com/live/producer"));

        if (btnYt != null) btnYt.setOnClickListener(v ->
            webView.loadUrl("https://studio.youtube.com/"));

        if (btnCam != null) {
            // Push Canon camera to VDO.Ninja with the room from main prefs
            android.content.SharedPreferences p =
                getSharedPreferences("GaviruCamPrefs", MODE_PRIVATE);
            String room = p.getString("vdo_room_name", "gaviru_cam_pro");
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
            // Looks like a domain
            url = "https://" + input;
        } else {
            // Search query — use Google
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
        webView.destroy();
        super.onDestroy();
    }
}
