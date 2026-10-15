package com.grancyan.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/**
 * 藏宝地图的原生桥（页面里 window.GrancyanTreasure，前端在 js/68-treasure.js）。契约见 briefs/treasure.md。
 *
 *   available()            → true
 *   status()               → {"fine","background","notify","locationOn"}
 *   requestPermissions()   依次 FINE(+COARSE) → POST_NOTIFICATIONS → BACKGROUND，每步回调 _treasureNative('perm', status)
 *   locate(cbId)           一次**精确**位置 → _treasureNative('loc', {cbId,lat,lng,acc} | {cbId,error})
 *   setLetters(json)       还埋着的纸条（不含正文）→ 对齐接近提醒
 *   takePending()          点通知冷启动进来的那张纸条 id，取一次就清
 *   openSettings()         （契约外的小补充）权限被永久拒了之后送她去 App 详情页
 *
 * 跟 PhoneBridge 刻意分开：那边只要粗略位置、坐标四舍五入到 0.1° 才给页面；
 * 这边是她自己点开的藏宝功能，要的就是精确点（150m 的圈，11km 的模糊点没法用）。
 */
public final class TreasureBridge {
    static final int PERM_FINE = 41;
    static final int PERM_NOTIFY = 42;
    static final int PERM_BACKGROUND = 43;

    private static final long FRESH_FIX_MS = 2 * 60 * 1000;   // 「我在这」要的是现在的位置，系统缓存 2 分钟内才直接用
    private static final float GOOD_ACC_M = 100f;
    private static final long STALE_LIMIT_MS = 10 * 60 * 1000;
    private static final long FIX_TIMEOUT_S = 20;
    private static final long GPS_TIMEOUT_S = 40;

    // 冷启动（或页面还没准备好）时点通知进来的那张纸条，等页面 takePending() 来拿
    private static volatile String pending = "";

    private final Activity activity;
    private final WebView webView;
    private volatile boolean inFlow = false;   // requestPermissions 链走到一半（去设置页了）

    TreasureBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        TreasureStore.ensureChannel(activity);
        new Thread(() -> TreasureStore.resyncOnProcessStart(activity), "treasure-boot-sync").start();
    }

    @JavascriptInterface
    public boolean available() { return true; }

    @JavascriptInterface
    public String status() { return TreasureStore.statusJson(activity); }

    // ── 权限 ────────────────────────────────────────────────

    /**
     * 一条链：缺哪步从哪步开始，前一步回来接着下一步。
     *   1. FINE —— targetSdk 31+ 上必须和 COARSE 一起要，单要 FINE 系统直接无视（不弹框、直接判拒）。
     *      12+ 的弹框里她可以只给「大致位置」，那样 fine 仍是 false，接近提醒挂不上。
     *   2. POST_NOTIFICATIONS（13+）—— 被拒了也接着往下走，status 里 notify=false 页面看得见。
     *   3. BACKGROUND（10+）—— 前台定位没给就不要（系统也不让）。11+ 上这一步系统不弹框，直接跳到
     *      「位置信息权限」那一页让她选「始终允许」；页面应该在调 requestPermissions 之前先跟她解释。
     */
    @JavascriptInterface
    public void requestPermissions() {
        activity.runOnUiThread(() -> {
            inFlow = true;
            nextStep();
        });
    }

    private void nextStep() {
        try {
            if (!TreasureStore.hasFine(activity)) {
                activity.requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION }, PERM_FINE);
                return;
            }
            if (Build.VERSION.SDK_INT >= 33 && !granted("android.permission.POST_NOTIFICATIONS")
                    && !askedNotify) {
                askedNotify = true;
                activity.requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" }, PERM_NOTIFY);
                return;
            }
            if (Build.VERSION.SDK_INT >= 29 && !TreasureStore.hasBackground(activity)) {
                activity.requestPermissions(new String[]{
                        Manifest.permission.ACCESS_BACKGROUND_LOCATION }, PERM_BACKGROUND);
                return;
            }
        } catch (Exception e) {
            android.util.Log.e(TreasureStore.TAG, "申请权限失败", e);
        }
        finishFlow();
    }
    private boolean askedNotify = false;   // 一条链里通知只问一次：拒了就过，不在这儿死循环

    private boolean granted(String perm) {
        return activity.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** MainActivity.onRequestPermissionsResult 转过来。返回 false = 不是这边的请求码。 */
    boolean onPermissionResult(int requestCode) {
        if (requestCode != PERM_FINE && requestCode != PERM_NOTIFY && requestCode != PERM_BACKGROUND) return false;
        emit("perm", status());           // 每一步的结果都报一次
        if (requestCode == PERM_FINE && !TreasureStore.hasFine(activity)) {
            finishFlow(false);            // 前台精确定位都没给，后面两步没意义
        } else if (requestCode == PERM_BACKGROUND) {
            finishFlow(false);            // 最后一步，给没给都到此为止
        } else {
            nextStep();
        }
        return true;
    }

    private void finishFlow() { finishFlow(true); }

    private void finishFlow(boolean report) {
        inFlow = false;
        askedNotify = false;
        // 权限可能刚到手：之前 setLetters 时没权限挂不上的，现在补挂
        new Thread(() -> TreasureStore.resync(activity, false), "treasure-resync").start();
        if (report) emit("perm", status());   // 什么都不用要（早就全给了）的时候，页面也得收到一次回调
    }

    /** 从设置页回来（onResume）：权限可能在那边被改了，告诉页面一声，顺便补挂。 */
    void onResume() {
        if (inFlow) return;   // 链还在走，结果由 onPermissionResult 报
        if (!settingsOpened) return;
        settingsOpened = false;
        new Thread(() -> TreasureStore.resync(activity, false), "treasure-resync").start();
        emit("perm", status());
    }
    private volatile boolean settingsOpened = false;

    @JavascriptInterface
    public void openSettings() {
        activity.runOnUiThread(() -> {
            try {
                settingsOpened = true;
                activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName())));
            } catch (Exception e) {
                settingsOpened = false;
                android.util.Log.e(TreasureStore.TAG, "打不开应用详情", e);
            }
        });
    }

    // ── 定位 ────────────────────────────────────────────────

    @JavascriptInterface
    public void locate(String cbId) {
        final String id = cbId == null ? "" : cbId;
        new Thread(() -> {
            String json;
            try {
                json = doLocate(id);
            } catch (Throwable t) {
                android.util.Log.e(TreasureStore.TAG, "定位失败", t);
                json = err(id, "error");
            }
            emit("loc", json);
        }, "treasure-locate").start();
    }

    private String doLocate(String cbId) throws Exception {
        if (!TreasureStore.hasFine(activity)) return err(cbId, "no-permission");
        if (!TreasureStore.locationOn(activity)) return err(cbId, "service-off");
        LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);

        Location best = null;
        for (String p : lm.getProviders(true)) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (SecurityException ignored) {}
        }
        boolean fresh = best != null && System.currentTimeMillis() - best.getTime() <= FRESH_FIX_MS
                && best.hasAccuracy() && best.getAccuracy() <= GOOD_ACC_M;
        boolean stale = false;
        if (!fresh) {
            Location f = freshFix(lm);
            if (f != null) best = f;
            else if (best != null && System.currentTimeMillis() - best.getTime() <= STALE_LIMIT_MS) stale = true;
            else best = null;   // 现拿拿不到、缓存又是好久以前的：别拿旧位置冒充「现在」，埋错地方更糟
        }
        if (best == null) return err(cbId, "no-fix");
        JSONObject o = new JSONObject().put("cbId", cbId)
                .put("lat", best.getLatitude())
                .put("lng", best.getLongitude())
                .put("acc", best.hasAccuracy() ? (double) best.getAccuracy() : -1)
                .put("at", best.getTime());
        if (stale) o.put("stale", true);   // 现拿失败，退回 10 分钟内的缓存（可能不准），页面可以提示一句
        return o.toString();
    }

    // 精确定位：fused 有就用（Pixel 上「Google 定位精确度」关着时它也会退回 GPS），再 GPS，最后 network
    private Location freshFix(LocationManager lm) {
        List<String> order = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) order.add(LocationManager.FUSED_PROVIDER);
        order.add(LocationManager.GPS_PROVIDER);
        order.add(LocationManager.NETWORK_PROVIDER);
        List<String> enabled = lm.getProviders(true);
        for (String p : order) {
            if (!enabled.contains(p)) continue;
            AtomicReference<Location> got = new AtomicReference<>();
            CountDownLatch latch = new CountDownLatch(1);
            CancellationSignal cancel = new CancellationSignal();
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    lm.getCurrentLocation(p, cancel, activity.getMainExecutor(), l -> { got.set(l); latch.countDown(); });
                } else {
                    lm.requestSingleUpdate(p, new android.location.LocationListener() {
                        @Override public void onLocationChanged(Location l) { got.set(l); latch.countDown(); }
                        @Override public void onStatusChanged(String s, int i, android.os.Bundle b) {}
                        @Override public void onProviderEnabled(String s) {}
                        @Override public void onProviderDisabled(String s) {}
                    }, Looper.getMainLooper());
                }
                long wait = LocationManager.GPS_PROVIDER.equals(p) ? GPS_TIMEOUT_S : FIX_TIMEOUT_S;
                if (!latch.await(wait, TimeUnit.SECONDS)) cancel.cancel();
            } catch (SecurityException se) {
                continue;
            } catch (InterruptedException ie) {
                return null;
            }
            if (got.get() != null) return got.get();
        }
        return null;
    }

    private static String err(String cbId, String why) {
        try { return new JSONObject().put("cbId", cbId).put("error", why).toString(); }
        catch (Exception e) { return "{\"cbId\":" + JSONObject.quote(cbId) + ",\"error\":\"error\"}"; }
    }

    // ── 纸条 ────────────────────────────────────────────────

    /** 返回实际挂着的个数（没权限 = 0，列表照样存下，权限到手后补挂）；JSON 坏了返回 -1。 */
    @JavascriptInterface
    public int setLetters(String json) {
        try {
            return TreasureStore.setLetters(activity, json);
        } catch (Exception e) {
            android.util.Log.e(TreasureStore.TAG, "setLetters 解析失败", e);
            return -1;
        }
    }

    @JavascriptInterface
    public String takePending() {
        String p = pending;
        pending = "";
        return p == null ? "" : p;
    }

    // ── 点通知进来 ───────────────────────────────────────────

    /** 冷启动：页面还没加载，先存着等 takePending()。 */
    static void setPending(String id) {
        if (id != null && !id.isEmpty()) pending = id;
    }

    /**
     * 热启动（onNewIntent）：页面多半在，直接叫 _treasureOpen。
     * 页面要是正在重载、_treasureOpen 还没定义，就存成 pending，等它启动时 takePending() 拿走。
     * 先存后叫、叫成了再清 —— 反过来的话，页面恰好在这几毫秒里 takePending 会拿个空。
     */
    void deliver(String id) {
        if (id == null || id.isEmpty()) return;
        pending = id;
        webView.post(() -> {
            try {
                // WebView 停在书架（localhost:8080/reading）之类的页上时没有 _treasureOpen：
                // 先回主页面，页面起来后 takePending() 会拿到这张
                String url = webView.getUrl();
                if (url == null || !url.startsWith("https://grancyan.app/")) {
                    webView.loadUrl("https://grancyan.app/index.html");
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){if(typeof window._treasureOpen!=='function')return 0;"
                                + "window._treasureOpen(" + JSONObject.quote(id) + ");return 1;})()",
                        v -> { if ("1".equals(v) && id.equals(pending)) pending = ""; });
            } catch (Exception ignored) {}
        });
    }

    private void emit(String kind, String payload) {
        webView.post(() -> {
            try {
                webView.evaluateJavascript("window._treasureNative && window._treasureNative("
                        + JSONObject.quote(kind) + "," + payload + ")", null);
            } catch (Exception ignored) {}
        });
    }
}
