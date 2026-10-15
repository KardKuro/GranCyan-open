package com.grancyan.app;

import android.Manifest;
import android.app.Activity;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.location.Address;
import android.location.Geocoder;
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
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 手机近况桥（页面里 window.GrancyanPhone，前端在 js/60-phone.js）：
 *   · 今天各 App 的前台时长 + 回到 Grancyan 之前在用哪个 App —— UsageStats，
 *     要她在系统设置「使用情况访问」里手动打开，App 自己弹不出授权框。
 *   · 大概在哪个城市 / 区 —— 只要粗略定位（ACCESS_COARSE_LOCATION，系统给的本来就是 ~2km 的模糊点）。
 * 两样都默认关，前端开关打开了才会来调这里。
 *
 * 坐标不出这个类：反查地名在这里做完，交给页面的只有地名和四舍五入到 0.1°（约 11km）的坐标，
 * 后者只拿去查天气。精确到哪条街的东西页面根本拿不到，也就不可能被塞进提示词。
 */
public final class PhoneBridge {
    static final int LOCATION_PERMISSION_REQUEST = 3;
    private static final long FRESH_FIX_MS = 10 * 60 * 1000;   // 系统缓存的位置 10 分钟内就直接用
    // fused / network 有就快，没有等也白等；GPS 冷启动在室内动辄半分钟以上，单独给长一点。
    // 实测过一台「Google 定位精确度」关着的手机（network provider enabled=false），
    // 全机所有 provider 的 last location 都是 null——那种手机上只能指望 GPS。
    private static final long LOCATE_TIMEOUT_S = 15;
    private static final long GPS_TIMEOUT_S = 45;

    private final Activity activity;
    private final WebView webView;

    PhoneBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public boolean available() { return true; }

    // ── 使用情况 ─────────────────────────────────────────────

    @JavascriptInterface
    public boolean usageGranted() {
        try {
            AppOpsManager ops = (AppOpsManager) activity.getSystemService(Context.APP_OPS_SERVICE);
            int uid = android.os.Process.myUid();
            String pkg = activity.getPackageName();
            int mode = Build.VERSION.SDK_INT >= 29
                    ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, uid, pkg)
                    : ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, uid, pkg);
            if (mode == AppOpsManager.MODE_DEFAULT) {
                return activity.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS)
                        == PackageManager.PERMISSION_GRANTED;
            }
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    /** 送她去「使用情况访问」。带 package: 的话新系统直接落在 Grancyan 那一页，老系统不认就退回总列表。 */
    @JavascriptInterface
    public void openUsageSettings() {
        activity.runOnUiThread(() -> {
            try {
                Intent i = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivity(i);
            } catch (Exception e) {
                try { activity.startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)); }
                catch (Exception e2) { android.util.Log.e("GrancyanPhone", "打不开使用情况访问设置", e2); }
            }
        });
    }

    /**
     * 今天（本地零点到现在）的前台时长，按 App 汇总；外加「最近一段不是 Grancyan 的前台 App」。
     * 不用 queryUsageStats(INTERVAL_DAILY)：它按系统的桶切，桶的边界不在零点，会把昨晚的算进来。
     * 自己从事件流里配对 RESUMED/PAUSED，零点前就开着的那个从零点算起。
     */
    @JavascriptInterface
    public String usageToday() {
        try {
            if (!usageGranted()) return "{\"ok\":false,\"why\":\"no-permission\"}";
            UsageStatsManager usm = (UsageStatsManager) activity.getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            Calendar c = Calendar.getInstance();
            c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0);
            c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
            long start = c.getTimeInMillis();

            String self = activity.getPackageName();
            Set<String> chrome = chromePackages();      // 桌面、系统界面这些不算「在用某个 App」

            Map<String, Long> open = new HashMap<>();    // pkg/class → 这次 RESUMED 的时刻
            Set<String> seen = new HashSet<>();
            Map<String, Long> total = new HashMap<>();
            // 「最近一段」：同一个 App 连着用，中间回过桌面不算断；回到 Grancyan 或熄屏就断。
            // runFg 只累计真在前台的时间——2026-10-03 真机上逮到：手环同步在后台把 Gadgetbridge
            // 闪了一下，熄屏几分钟后解锁它又在最上面露了 3 秒，按首尾相减算成了「在那边待了 7 分钟」。
            String runPkg = null; long runStart = 0, runEnd = 0, runFg = 0; boolean runBroken = true;

            UsageEvents ev = usm.queryEvents(start, now);
            UsageEvents.Event e = new UsageEvents.Event();
            while (ev.hasNextEvent()) {
                ev.getNextEvent(e);
                int t = e.getEventType();
                String pkg = e.getPackageName();
                if (pkg == null) continue;
                String key = pkg + "/" + e.getClassName();
                long ts = e.getTimeStamp();
                if (t == UsageEvents.Event.ACTIVITY_RESUMED) {
                    if (!open.containsKey(key)) open.put(key, ts);
                    seen.add(key);
                    if (pkg.equals(self)) {
                        runBroken = true;                 // 回到 Grancyan：上一段算是结束了
                    } else if (!chrome.contains(pkg)) {
                        if (runBroken || !pkg.equals(runPkg)) { runPkg = pkg; runStart = ts; runFg = 0; }
                        runEnd = 0;
                        runBroken = false;
                    }
                } else if (t == UsageEvents.Event.ACTIVITY_PAUSED || t == 23 /* ACTIVITY_STOPPED */) {
                    Long s = open.remove(key);
                    // 零点前就在前台、今天第一次露面就是 PAUSED：从零点算。STOPPED 不算——
                    // 它可能是零点前早就退到后台、零点后才被系统停掉的那种。
                    if (s == null && t == UsageEvents.Event.ACTIVITY_PAUSED && !seen.contains(key)) s = start;
                    seen.add(key);
                    if (s != null) {
                        total.merge(pkg, Math.max(0, ts - s), Long::sum);
                        if (pkg.equals(runPkg) && s >= runStart) runFg += Math.max(0, ts - s);
                    }
                    if (pkg.equals(runPkg) && runEnd == 0) runEnd = ts;
                } else if (t == 16 /* SCREEN_NON_INTERACTIVE */) {
                    runBroken = true;                     // 熄屏：这一段到此为止，亮屏后再打开算新的一段
                }
            }
            String fgPkg = null; long fgSince = 0;
            for (Map.Entry<String, Long> en : open.entrySet()) {
                String pkg = en.getKey().substring(0, en.getKey().indexOf('/'));
                total.merge(pkg, Math.max(0, now - en.getValue()), Long::sum);
                if (en.getValue() >= fgSince) { fgSince = en.getValue(); fgPkg = pkg; }
            }

            PackageManager pm = activity.getPackageManager();
            List<Map.Entry<String, Long>> rows = new ArrayList<>(total.entrySet());
            rows.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
            JSONArray apps = new JSONArray();
            long sum = 0;
            for (Map.Entry<String, Long> r : rows) {
                if (chrome.contains(r.getKey())) continue;
                if (r.getValue() < 60_000) continue;     // 不到一分钟的不列（点开就关的、系统闪一下的）
                sum += r.getValue();
                if (apps.length() < 15) {
                    apps.put(new JSONObject().put("pkg", r.getKey()).put("label", label(pm, r.getKey()))
                            .put("ms", r.getValue()).put("self", r.getKey().equals(self)));
                }
            }
            JSONObject o = new JSONObject().put("ok", true).put("now", now).put("start", start)
                    .put("totalMs", sum).put("apps", apps);
            if (runPkg != null) {
                o.put("prev", new JSONObject().put("pkg", runPkg).put("label", label(pm, runPkg))
                        .put("start", runStart).put("end", runEnd).put("fgMs", runFg));
            }
            if (fgPkg != null) {
                o.put("fg", new JSONObject().put("pkg", fgPkg).put("label", label(pm, fgPkg))
                        .put("since", fgSince).put("self", fgPkg.equals(self)));
            }
            return o.toString();
        } catch (Throwable t) {
            android.util.Log.e("GrancyanPhone", "读使用情况失败", t);
            return "{\"ok\":false,\"why\":\"error\"}";
        }
    }

    // 桌面（可能不止一个）+ 系统界面 + 权限弹窗：它们在前台不代表她在「用」什么
    private Set<String> chromePackages() {
        Set<String> s = new HashSet<>();
        s.add("android");
        s.add("com.android.systemui");
        s.add("com.google.android.permissioncontroller");
        s.add("com.android.permissioncontroller");
        try {
            Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
            for (ResolveInfo ri : activity.getPackageManager().queryIntentActivities(home, 0)) {
                if (ri.activityInfo != null) s.add(ri.activityInfo.packageName);
            }
        } catch (Exception ignored) {}
        return s;
    }

    // 包名 → 桌面上那个名字。拿不到（包可见性挡住了、已卸载）就退回包名，前端会再兜一层。
    private static String label(PackageManager pm, String pkg) {
        try {
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence l = pm.getApplicationLabel(ai);
            return l == null ? pkg : l.toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    // ── 位置 ────────────────────────────────────────────────

    @JavascriptInterface
    public boolean locationGranted() {
        return activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** 系统定位总开关（下拉栏那个「位置信息」）。关着的话有权限也拿不到东西。 */
    @JavascriptInterface
    public boolean locationServiceOn() {
        try {
            LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
            return Build.VERSION.SDK_INT >= 28 ? lm.isLocationEnabled()
                    : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) || lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    /** 弹系统的定位授权框。结果经 MainActivity.onRequestPermissionsResult → onPermissionResult 回到页面。 */
    @JavascriptInterface
    public void requestLocation() {
        activity.runOnUiThread(() -> activity.requestPermissions(
                new String[]{ Manifest.permission.ACCESS_COARSE_LOCATION }, LOCATION_PERMISSION_REQUEST));
    }

    /** 已经被拒过（系统不再弹框）的时候，送她去 App 详情页自己开。 */
    @JavascriptInterface
    public void openAppSettings() {
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName())));
            } catch (Exception e) {
                android.util.Log.e("GrancyanPhone", "打不开应用详情", e);
            }
        });
    }

    void onPermissionResult(boolean granted) {
        emit("perm", granted ? "true" : "false");
    }

    /** 异步定位 + 反查地名，结果经 window._phoneNative('loc', json) 送回。可能要十几秒。 */
    @JavascriptInterface
    public void locate() {
        new Thread(() -> {
            String json;
            try {
                json = doLocate();
            } catch (Throwable t) {
                android.util.Log.e("GrancyanPhone", "定位失败", t);
                json = "{\"ok\":false,\"why\":\"error\"}";
            }
            emit("loc", json);
        }, "phone-locate").start();
    }

    private String doLocate() throws Exception {
        if (!locationGranted()) return "{\"ok\":false,\"why\":\"no-permission\"}";
        if (!locationServiceOn()) return "{\"ok\":false,\"why\":\"service-off\"}";
        LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);

        Location best = null;
        for (String p : lm.getProviders(true)) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (SecurityException ignored) {}
        }
        if (best == null || System.currentTimeMillis() - best.getTime() > FRESH_FIX_MS) {
            Location fresh = freshFix(lm);
            if (fresh != null) best = fresh;
        }
        if (best == null) return "{\"ok\":false,\"why\":\"no-fix\"}";

        JSONObject o = new JSONObject().put("ok", true)
                .put("lat1", Math.round(best.getLatitude() * 10) / 10.0)
                .put("lon1", Math.round(best.getLongitude() * 10) / 10.0)
                .put("at", best.getTime());
        try {
            if (Geocoder.isPresent()) {
                @SuppressWarnings("deprecation")
                List<Address> list = new Geocoder(activity, Locale.SIMPLIFIED_CHINESE)
                        .getFromLocation(best.getLatitude(), best.getLongitude(), 1);
                if (list != null && !list.isEmpty()) {
                    Address a = list.get(0);
                    o.put("country", nz(a.getCountryName())).put("province", nz(a.getAdminArea()))
                     .put("city", nz(a.getLocality())).put("subAdmin", nz(a.getSubAdminArea()))
                     .put("district", nz(a.getSubLocality()));
                }
            } else {
                o.put("geocoder", "absent");
            }
        } catch (Exception ge) {
            o.put("geocoder", "failed");                  // 国内没梯子时 Google 的反查会超时，前端走兜底
        }
        return o.toString();
    }

    // 系统缓存的位置太旧时现要一个。粗略权限下各家 provider 给的都是模糊点，够判断在哪个区。
    private Location freshFix(LocationManager lm) {
        List<String> order = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) order.add(LocationManager.FUSED_PROVIDER);
        order.add(LocationManager.NETWORK_PROVIDER);
        order.add(LocationManager.GPS_PROVIDER);
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
                long wait = LocationManager.GPS_PROVIDER.equals(p) ? GPS_TIMEOUT_S : LOCATE_TIMEOUT_S;
                if (!latch.await(wait, TimeUnit.SECONDS)) cancel.cancel();
            } catch (SecurityException se) {
                continue;                                  // 只有粗略权限时老系统的 gps 会拒，换下一个
            } catch (InterruptedException ie) {
                return null;
            }
            if (got.get() != null) return got.get();
        }
        return null;
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private void emit(String kind, String payload) {
        webView.post(() -> {
            try {
                webView.evaluateJavascript("window._phoneNative && window._phoneNative("
                        + JSONObject.quote(kind) + "," + payload + ")", null);
            } catch (Exception ignored) {}
        });
    }
}
