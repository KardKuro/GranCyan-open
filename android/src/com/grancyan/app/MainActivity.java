package com.grancyan.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.InputStream;

/**
 * Grancyan 壳应用：
 * 把打包在 assets 里的前端页面伪装到 https://grancyan.app 这个虚拟安全源上加载，
 * 这样 localStorage / IndexedDB 都有稳定的 origin 可用。
 * 主聊天直连各家 AI API；本地 Claude、表情包等功能通过设置里的「服务器地址」
 * 连接电脑上的 server.js（同一局域网）。
 */
public class MainActivity extends Activity {

    private static final String APP_HOST = "grancyan.app";
    private static final int FILE_CHOOSER_REQUEST = 1;
    private static final int MEDIA_PERMISSION_REQUEST = 2;   // 摄像头 / 麦克风共用

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingPermRequest;   // 等系统摄像头/麦克风权限结果的那个网页请求
    private CoreadServer coreadServer;
    private GestureDetector gestureDetector;
    private FocusBridge focusBridge;
    private PhoneBridge phoneBridge;
    private TreasureBridge treasureBridge;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 启动内置 Coread 服务器
        try {
            coreadServer = new CoreadServer(this);
            coreadServer.start();
            android.util.Log.i("Grancyan", "Coread 服务器已启动: http://localhost:8080");
        } catch (Exception e) {
            android.util.Log.e("Grancyan", "Coread 服务器启动失败", e);
        }

        // 处理从 MT 管理器等文件管理器打开 EPUB 文件
        // 进程被杀后从最近任务/桌面恢复时，系统给的还是当初点通知冷启动的那个 intent（removeExtra 只改了
        // 进程里那份），不挡的话同一张纸条会再开一次
        if (savedInstanceState != null
                || (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            getIntent().removeExtra(TreasureStore.EXTRA_ID);
        }
        handleIncomingIntent(getIntent());

        // 初始化手势检测器（右滑返回聊天界面）
        gestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            private static final int SWIPE_THRESHOLD = 100;
            private static final int SWIPE_VELOCITY_THRESHOLD = 100;

            @Override
            public boolean onFling(MotionEvent e1, MotionEvent e2, float velocityX, float velocityY) {
                if (e1 == null || e2 == null) return false;
                float diffX = e2.getX() - e1.getX();
                float diffY = e2.getY() - e1.getY();

                // 检测右滑手势（从左向右）
                if (Math.abs(diffX) > Math.abs(diffY) &&
                    Math.abs(diffX) > SWIPE_THRESHOLD &&
                    Math.abs(velocityX) > SWIPE_VELOCITY_THRESHOLD &&
                    diffX > 0) {

                    // 如果当前在阅读页面（内置书架或电脑端书架），返回主界面
                    String url = webView.getUrl();
                    if (url != null && !url.startsWith("https://" + APP_HOST)) {
                        webView.loadUrl("https://grancyan.app/");
                        return true;
                    }
                }
                return false;
            }
        });

        // 允许电脑上用 chrome://inspect（USB 连接）远程调试页面
        WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);

        // 在 WebView 上设置触摸监听
        webView.setOnTouchListener((v, event) -> {
            gestureDetector.onTouchEvent(event);
            return false; // 返回 false 让 WebView 继续处理触摸事件
        });

        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 页面源是 https，而局域网 server.js 是 http，必须放行混合内容
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);

        // 手环本地桥：让 App 自己读 Gadgetbridge 的导出库，不用再连电脑跑 adb。
        // 页面是从 assets 里出来的自家内容（shouldInterceptRequest 只放行 grancyan.app），
        // 不是任意网页，所以挂 JS 接口是安全的。
        webView.addJavascriptInterface(new BandBridge(this, webView), "GrancyanBand");

        // 番茄钟屏幕固定：开始时由系统确认把手机锁在 Grancyan，结束时自动解除。
        focusBridge = new FocusBridge(this);
        webView.addJavascriptInterface(focusBridge, "GrancyanFocus");

        // 点歌：下拉栏播放卡片 + 后台时的桌面歌词悬浮条（MusicService / LyricOverlay）
        webView.addJavascriptInterface(new MusicBridge(this, webView), "GrancyanMusic");

        // 手机近况：今天各 App 用了多久、回来之前在刷什么、大概在哪个区（js/60-phone.js，默认关）
        phoneBridge = new PhoneBridge(this, webView);
        webView.addJavascriptInterface(phoneBridge, "GrancyanPhone");

        // 藏宝地图：AI 在用户标过的地点埋纸条，走近了系统通知（js/68-treasure.js）。
        // 要的是精确位置 + 后台定位，跟上面只要粗略位置的手机近况分开两个桥。
        treasureBridge = new TreasureBridge(this, webView);
        webView.addJavascriptInterface(treasureBridge, "GrancyanTreasure");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!"https".equals(url.getScheme()) || !APP_HOST.equals(url.getHost())) return null;
                String path = url.getPath();
                if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
                try {
                    InputStream is = getAssets().open(path.substring(1));
                    return new WebResourceResponse(guessMime(path), "utf-8", is);
                } catch (Exception e) {
                    return null;
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();

                // App 壳内的 /reading（前端没配电脑服务器地址时的兜底）→ 内置离线书架
                if (APP_HOST.equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith("/reading")) {
                    String targetUrl = "http://localhost:8080" + url.getPath() +
                        (url.getQuery() != null ? "?" + url.getQuery() : "");
                    webView.loadUrl(targetUrl);
                    return true;
                }

                if (APP_HOST.equals(url.getHost())) return false;

                // 局域网/本机地址（电脑 server.js 的完整书架、内置书架）留在 WebView 里；
                // 其中书架页的「← 返回」指向根路径，跳回 App 主界面而不是电脑端网页版
                if (isLanHost(url.getHost())) {
                    String p = url.getPath();
                    if (p == null || p.isEmpty() || "/".equals(p)) {
                        // #widgets 要带过去：书架的 ✕ / 返回靠它回到小组件，而不是掉在聊天里
                        String frag = url.getFragment();
                        webView.loadUrl("https://" + APP_HOST + "/index.html" + (frag != null && !frag.isEmpty() ? "#" + frag : ""));
                        return true;
                    }
                    return false;
                }

                // 外部链接交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {}
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }

            // 页面里的「拍照」取摄像头、「语音消息 / 语音通话」取麦克风，都走 getUserMedia。
            // WebView 默认一律拒绝，得在这儿显式放行；而且光 grant 给网页还不够——系统那层的
            // CAMERA / RECORD_AUDIO 也得先要到，否则网页拿到许可、设备照样打不开。
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        java.util.List<String> need = new java.util.ArrayList<>();
                        for (String r : request.getResources()) {
                            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)
                                    && checkSelfPermission(Manifest.permission.CAMERA)
                                       != PackageManager.PERMISSION_GRANTED) {
                                need.add(Manifest.permission.CAMERA);
                            }
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)
                                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                                       != PackageManager.PERMISSION_GRANTED) {
                                need.add(Manifest.permission.RECORD_AUDIO);
                            }
                        }
                        if (need.isEmpty()) {
                            request.grant(request.getResources());
                        } else {
                            pendingPermRequest = request;
                            requestPermissions(need.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
                        }
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingPermRequest == request) pendingPermRequest = null;
            }
        });

        webView.loadUrl("https://" + APP_HOST + "/index.html");
    }

    // 判断是否局域网/本机地址（这些页面留在 WebView 内打开，不丢给系统浏览器）
    private static boolean isLanHost(String host) {
        if (host == null) return false;
        return "localhost".equals(host) || host.startsWith("127.")
            || host.startsWith("192.168.") || host.startsWith("10.")
            || host.matches("172\\.(1[6-9]|2\\d|3[01])\\..*");
    }

    private static String guessMime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".woff") || p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // 系统摄像头/麦克风权限的结果回来了 → 把它转给还在等的那个网页 getUserMedia 请求。
    // 要的权限里只要有一个被拒，网页那边就没法用（比如语音通话缺麦克风），直接 deny。
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == MEDIA_PERMISSION_REQUEST && pendingPermRequest != null) {
            boolean granted = results.length > 0;
            for (int r : results) {
                if (r != PackageManager.PERMISSION_GRANTED) granted = false;
            }
            if (granted) pendingPermRequest.grant(pendingPermRequest.getResources());
            else pendingPermRequest.deny();
            pendingPermRequest = null;
        } else if (treasureBridge != null && treasureBridge.onPermissionResult(requestCode)) {
            // 藏宝地图的三步权限链，结果已经转给页面
        } else if (requestCode == PhoneBridge.LOCATION_PERMISSION_REQUEST && phoneBridge != null) {
            boolean granted = false;
            for (int r : results) if (r == PackageManager.PERMISSION_GRANTED) granted = true;
            phoneBridge.onPermissionResult(granted);
        } else {
            super.onRequestPermissionsResult(requestCode, permissions, results);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            filePathCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (focusBridge != null && focusBridge.locked()) {
            webView.loadUrl("javascript:openPomodoro()");
            return;
        }
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        return gestureDetector.onTouchEvent(event) || super.onTouchEvent(event);
    }

    // 桌面歌词悬浮条只在 App 退到后台时出现；在 App 里由页面自己那层显示，两份叠着就重影了
    @Override
    protected void onStart() {
        super.onStart();
        MusicService.setAppVisible(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (treasureBridge != null) treasureBridge.onResume();
    }

    @Override
    protected void onStop() {
        MusicService.setAppVisible(false);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        // WebView 一没，歌就停了：系统卡片和悬浮条跟着收，不留一张点不动的卡
        MusicBridge.detach();
        MusicService.stopAll();
        if (webView != null) webView.destroy();
        if (coreadServer != null) coreadServer.stop();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncomingIntent(intent);
    }

    // 处理从文件管理器打开 EPUB；点「这里埋了东西」的通知进来（带 treasure_id）
    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String treasureId = intent.getStringExtra(TreasureStore.EXTRA_ID);
        if (treasureId != null && !treasureId.isEmpty()) {
            String tok = intent.getStringExtra(TreasureStore.EXTRA_TOKEN);
            intent.removeExtra(TreasureStore.EXTRA_ID);   // 转屏/重建时 getIntent() 还是它，别再开一次
            intent.removeExtra(TreasureStore.EXTRA_TOKEN);
            // 只认自家通知：MainActivity 是 exported 的，别的 App 也能塞个 treasure_id 进来
            if (!TreasureStore.tokenOk(this, tok)) return;
            // onCreate 里调进来时 WebView 和桥都还没建，页面也没加载：存起来等页面 takePending()
            if (treasureBridge == null) TreasureBridge.setPending(treasureId);
            else treasureBridge.deliver(treasureId);
            return;
        }
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            android.net.Uri uri = intent.getData();
            if (uri != null && coreadServer != null) {
                android.util.Log.i("Grancyan", "收到 EPUB 文件: " + uri.toString());
                coreadServer.importEpub(uri);
                // 导入后跳转到书架
                if (webView != null) {
                    webView.post(() -> webView.loadUrl("http://localhost:8080/reading"));
                }
            }
        }
    }
}
