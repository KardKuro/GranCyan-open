package com.grancyan.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/**
 * 手环数据本地桥 —— 让 .apk 自己拉 Gadgetbridge 数据，不再依赖电脑。
 *
 * 电脑那条路（server.js 的 /api/band-data）是：adb 唤醒 GB → adb 发广播触发导出
 * → adb pull 拿 .db → sql.js 解析。手机上这三步 adb 全都不需要：
 *   - 广播：自己 sendBroadcast 就行，本来就是同一台机器
 *   - 取文件：导出目标 /storage/emulated/0/手环数据/ 是共享存储，有权限就能读
 *   - 解析：Android 自带 SQLite
 * 所以整条链路可以完全本地化，出门在外也能看手环。
 *
 * 权限：导出目录不是本应用的私有目录，Android 11+ 的分区存储下普通
 * READ_EXTERNAL_STORAGE 读不到，必须要「所有文件访问权限」(MANAGE_EXTERNAL_STORAGE)，
 * 且只能由用户去系统设置里手动打开 —— requestAccess() 负责把他送到那个页面。
 *
 * 查询语句跟 server.js pullBandData() 保持一致，前端拿到的 JSON 结构两边完全相同，
 * 所以 renderBandPanel() 不用改。改这边记得同步改那边。
 */
public class BandBridge {

    private static final String GB_PKG = "nodomain.freeyourgadget.gadgetbridge";
    private static final String DB_REMOTE =
            "/storage/emulated/0/手环数据/Gadgetbridge.db";
    private static final long PULL_COOLDOWN_MS = 60_000L;

    private final Activity activity;
    private final WebView webView;

    private String cachedJson = null;
    private long cachedAt = 0L;
    private long cachedDbMtime = 0L;

    public BandBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /** 前端探测：这个版本的 App 有没有本地手环桥。 */
    @JavascriptInterface
    public boolean available() {
        return true;
    }

    /** 有没有「所有文件访问权限」。没有的话读不到导出目录。 */
    @JavascriptInterface
    public boolean hasAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return new File(DB_REMOTE).canRead();
    }

    /** 把用户送到系统的「所有文件访问权限」设置页，只能他自己点开。 */
    @JavascriptInterface
    public void requestAccess() {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + activity.getPackageName()));
            } else {
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Exception e) {
            android.util.Log.e("Grancyan", "打开权限设置失败", e);
        }
    }

    /** 导出文件在不在、多大、什么时候写的 —— 面板上报错时用得着。 */
    @JavascriptInterface
    public String status() {
        File f = new File(DB_REMOTE);
        try {
            JSONObject o = new JSONObject();
            o.put("path", DB_REMOTE);
            o.put("exists", f.exists());
            o.put("canRead", f.canRead());
            o.put("size", f.exists() ? f.length() : 0);
            o.put("mtime", f.exists() ? f.lastModified() : 0);
            o.put("hasAccess", hasAccess());
            o.put("gbInstalled", isGbInstalled());
            return o.toString();
        } catch (Exception e) {
            return "{\"exists\":false}";
        }
    }

    private boolean isGbInstalled() {
        try {
            activity.getPackageManager().getPackageInfo(GB_PKG, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 异步取数据。整个流程要十几秒（等 GB 把库导出来），不能卡在 JS 线程上，
     * 所以走后台线程 + 回调：结果通过 window._bandBridgeResult(cbId, json) 送回前端。
     */
    @JavascriptInterface
    public void fetch(final String cbId, final boolean force) {
        new Thread(() -> {
            String json;
            try {
                json = doFetch(force);
            } catch (Throwable t) {
                android.util.Log.e("Grancyan", "手环本地读取失败", t);
                json = errJson("读取失败: " + t.getMessage());
            }
            final String payload = json;
            webView.post(() -> webView.evaluateJavascript(
                    "window._bandBridgeResult && window._bandBridgeResult("
                            + JSONObject.quote(cbId) + "," + payload + ")", null));
        }, "band-bridge").start();
    }

    private String errJson(String msg) {
        try {
            return new JSONObject().put("ok", false).put("msg", msg).toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"msg\":\"读取失败\"}";
        }
    }

    private String doFetch(boolean force) throws Exception {
        if (!hasAccess()) {
            return errJson("需要「所有文件访问权限」才能读 Gadgetbridge 的导出文件");
        }
        long now = System.currentTimeMillis();
        if (!force && cachedJson != null && now - cachedAt < PULL_COOLDOWN_MS) {
            return cachedJson;
        }

        File remote = new File(DB_REMOTE);
        long mtimeBefore = remote.exists() ? remote.lastModified() : 0L;

        // 触发 GB 同步手环 + 导出数据库。动作名和电脑端一致，
        // 同样需要在 GB 设置 → 开发者选项 → 意图接口 里放行这两项。
        sendGbCommand("command.ACTIVITY_SYNC");
        sendGbCommand("command.TRIGGER_EXPORT");

        // 等导出真的落盘（mtime 变了），最多 12 秒；超时就用现有的旧文件
        boolean exported = false;
        for (int i = 0; i < 6; i++) {
            Thread.sleep(2000);
            if (remote.exists() && remote.lastModified() > mtimeBefore) { exported = true; break; }
        }
        if (!remote.exists()) {
            return errJson("找不到导出文件：" + DB_REMOTE
                    + "\n先在 Gadgetbridge 里把自动导出目录设成「手环数据」文件夹");
        }
        if (!exported) {
            android.util.Log.w("Grancyan", "[手环] 触发导出后文件未更新，使用现有文件");
        }

        // 拷进应用私有目录再打开：直接对共享存储上的库开 SQLite，
        // 某些 ROM 会因为要建 -journal 临时文件而失败。拷一份最省事。
        File local = new File(activity.getCacheDir(), "Gadgetbridge.db");
        copy(remote, local);

        SQLiteDatabase db = SQLiteDatabase.openDatabase(
                local.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
        try {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("ageMins", Math.round((now - remote.lastModified()) / 60000.0));
            out.put("source", "phone");
            out.put("daily", rows(db, "SELECT TIMESTAMP,STEPS,HR_RESTING,HR_MAX,HR_MIN,HR_AVG,STRESS_AVG,CALORIES,SPO2_AVG FROM XIAOMI_DAILY_SUMMARY_SAMPLE ORDER BY TIMESTAMP DESC LIMIT 1"));
            out.put("latestHR", rows(db, "SELECT TIMESTAMP,HEART_RATE,STEPS,STRESS,SPO2 FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE>0 ORDER BY TIMESTAMP DESC LIMIT 1"));
            out.put("recentActivity", rows(db, "SELECT TIMESTAMP,STEPS,HEART_RATE,STRESS,SPO2 FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE>0 OR STEPS>0 ORDER BY TIMESTAMP DESC LIMIT 10"));
            out.put("sleepSummary", rows(db, "SELECT TIMESTAMP,WAKEUP_TIME,TOTAL_DURATION,DEEP_SLEEP_DURATION,LIGHT_SLEEP_DURATION,REM_SLEEP_DURATION,AWAKE_DURATION FROM XIAOMI_SLEEP_TIME_SAMPLE ORDER BY TIMESTAMP DESC LIMIT 1"));
            out.put("hrSeries", rows(db, "SELECT TIMESTAMP,HEART_RATE FROM XIAOMI_ACTIVITY_SAMPLE WHERE HEART_RATE>0 AND TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE)-86400 ORDER BY TIMESTAMP ASC LIMIT 2000"));
            out.put("stressSeries", rows(db, "SELECT TIMESTAMP,STRESS FROM XIAOMI_ACTIVITY_SAMPLE WHERE STRESS>0 AND TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE)-86400 ORDER BY TIMESTAMP ASC LIMIT 2000"));
            out.put("stepsSeries", rows(db, "SELECT TIMESTAMP,STEPS FROM XIAOMI_ACTIVITY_SAMPLE WHERE STEPS>0 AND TIMESTAMP > (SELECT MAX(TIMESTAMP) FROM XIAOMI_ACTIVITY_SAMPLE)-86400 ORDER BY TIMESTAMP ASC LIMIT 2000"));
            out.put("daily7", rows(db, "SELECT TIMESTAMP,STEPS,HR_RESTING,HR_MAX,HR_MIN,HR_AVG,STRESS_AVG,CALORIES,SPO2_AVG FROM XIAOMI_DAILY_SUMMARY_SAMPLE ORDER BY TIMESTAMP DESC LIMIT 7"));
            out.put("sleep7", rows(db, "SELECT TIMESTAMP,WAKEUP_TIME,TOTAL_DURATION,DEEP_SLEEP_DURATION,LIGHT_SLEEP_DURATION,REM_SLEEP_DURATION,AWAKE_DURATION FROM XIAOMI_SLEEP_TIME_SAMPLE WHERE TOTAL_DURATION>60 ORDER BY TIMESTAMP DESC LIMIT 7"));

            cachedJson = out.toString();
            cachedAt = now;
            cachedDbMtime = remote.lastModified();
            return cachedJson;
        } finally {
            db.close();
        }
    }

    /** 广播必须显式指定包名，否则 Android 8+ 的隐式广播限制会让它谁也收不到。 */
    private void sendGbCommand(String suffix) {
        try {
            Intent i = new Intent(GB_PKG + "." + suffix);
            i.setPackage(GB_PKG);
            activity.sendBroadcast(i);
        } catch (Exception e) {
            android.util.Log.w("Grancyan", "广播失败 " + suffix + ": " + e.getMessage());
        }
    }

    private static void copy(File from, File to) throws Exception {
        try (FileInputStream in = new FileInputStream(from);
             FileOutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /** 查询结果转成 [{列名:值}]，跟 server.js 的 sqlRows() 同形。 */
    private static JSONArray rows(SQLiteDatabase db, String sql) {
        JSONArray arr = new JSONArray();
        Cursor c = null;
        try {
            c = db.rawQuery(sql, null);
            String[] cols = c.getColumnNames();
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                for (int i = 0; i < cols.length; i++) {
                    if (c.isNull(i)) o.put(cols[i], JSONObject.NULL);
                    else o.put(cols[i], c.getLong(i));
                }
                arr.put(o);
            }
        } catch (Exception e) {
            // 表不存在（换了别的手环品牌）不该让整个请求失败，返回空数组即可
            android.util.Log.w("Grancyan", "查询失败: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        return arr;
    }
}
