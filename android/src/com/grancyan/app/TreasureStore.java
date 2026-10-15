package com.grancyan.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 藏宝纸条的原生一侧：存列表、挂/撤接近提醒、进围栏发通知。
 * TreasureBridge（页面调）、TreasureAlertReceiver（系统喊进围栏了）、TreasureBootReceiver（开机/升级后重挂）
 * 三处都走这里，全部 synchronized 在同一把锁上 —— JS 桥在 binder 线程、receiver 在主线程，会撞。
 *
 * SharedPreferences「treasure」里三样：
 *   letters    最近一次 setLetters 的列表（不含正文，页面压根不传）
 *   registered 实际挂到系统里的：id → 围栏签名。挂失败（没权限）的不记，等权限到了 resync 再挂
 *   notified   通知过的：id → 时刻。只增不减（封顶 MAX_NOTIFIED），保证同一张只响一次
 *
 * 系统那边的接近提醒在重启、强行停止、（大概率）覆盖安装后都会被清掉，但 registered 还记着。
 * 所以这几种时候走 force：把 registered 当作空的，全量重挂。每个进程第一次 sync 也 force，
 * 强行停止之后的下一次启动就是新进程，靠这个兜住。
 */
final class TreasureStore {
    static final String TAG = "GrancyanTreasure";
    static final String CHANNEL = "treasure";
    static final String EXTRA_ID = "treasure_id";
    static final String EXTRA_TOKEN = "treasure_tok";
    private static final String PREFS = "treasure";
    private static final int MAX_NOTIFIED = 300;
    private static final Object LOCK = new Object();
    private static boolean syncedThisProcess = false;

    private TreasureStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean hasFine(Context c) {
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasBackground(Context c) {
        if (Build.VERSION.SDK_INT < 29) return hasFine(c);   // 10 以下没有单独的后台定位，前台给了就是全给了
        return c.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean canNotify(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = nm.getNotificationChannel(CHANNEL);
            if (ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }

    static boolean locationOn(Context c) {
        try {
            LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
            return Build.VERSION.SDK_INT >= 28 ? lm.isLocationEnabled()
                    : lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    static String statusJson(Context c) {
        try {
            return new JSONObject()
                    .put("fine", hasFine(c))
                    .put("background", hasBackground(c))
                    .put("notify", canNotify(c))
                    .put("locationOn", locationOn(c))
                    .toString();
        } catch (Exception e) {
            return "{\"fine\":false,\"background\":false,\"notify\":false,\"locationOn\":false}";
        }
    }

    // ── 列表 ────────────────────────────────────────────────

    /** 页面传来的 JSON → Letter。字段缺了/类型不对的条目由 TreasurePlan.normalize 丢掉。 */
    static List<TreasurePlan.Letter> parseLetters(String json) throws Exception {
        List<TreasurePlan.Letter> out = new ArrayList<>();
        if (json == null || json.trim().isEmpty()) return out;
        JSONArray a = new JSONArray(json);
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            out.add(new TreasurePlan.Letter(
                    o.optString("id", ""),
                    o.optDouble("lat", Double.NaN),
                    o.optDouble("lng", Double.NaN),
                    o.optInt("radius_m", 0),
                    o.optString("title", ""),
                    o.optString("place", "")));
        }
        return TreasurePlan.normalize(out);
    }

    /** 存回去的只有这几个字段 —— 就算页面哪天手滑多传了 body，也不落盘。 */
    private static String lettersToJson(List<TreasurePlan.Letter> list) throws Exception {
        JSONArray a = new JSONArray();
        for (TreasurePlan.Letter l : list) {
            a.put(new JSONObject().put("id", l.id).put("lat", l.lat).put("lng", l.lng)
                    .put("radius_m", l.radius).put("title", l.title).put("place", l.place));
        }
        return a.toString();
    }

    private static Map<String, String> readMap(SharedPreferences p, String key) {
        Map<String, String> m = new HashMap<>();
        try {
            JSONObject o = new JSONObject(p.getString(key, "{}"));
            Iterator<String> it = o.keys();
            while (it.hasNext()) { String k = it.next(); m.put(k, o.optString(k, "")); }
        } catch (Exception ignored) {}
        return m;
    }

    private static String mapToJson(Map<String, String> m) {
        try {
            JSONObject o = new JSONObject();
            for (Map.Entry<String, String> e : m.entrySet()) o.put(e.getKey(), e.getValue());
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    // ── 对齐 ────────────────────────────────────────────────

    /** 页面调：存下新列表并对齐系统里的提醒。返回实际挂着的个数（没权限时是 0）。 */
    static int setLetters(Context c, String json) throws Exception {
        List<TreasurePlan.Letter> list = parseLetters(json);
        synchronized (LOCK) {
            prefs(c).edit().putString("letters", lettersToJson(list)).commit();
            boolean force = !syncedThisProcess;
            syncedThisProcess = true;
            return syncLocked(c, list, force);
        }
    }

    /**
     * App 一启动（TreasureBridge 构造时）就调：这个进程还没对齐过的话全量重挂一次。
     * 强行停止会把系统里的提醒连 PendingIntent 一起清掉，registered 却还记着；
     * 不在这兜，就得指望页面启动时一定调 setLetters。
     */
    static void resyncOnProcessStart(Context c) {
        synchronized (LOCK) {
            if (syncedThisProcess) return;
            syncedThisProcess = true;
        }
        resync(c, true);
    }

    /**
     * 用存着的列表重挂。force=true：开机、覆盖安装、进程刚起来 —— 系统那边可能已经什么都没了。
     * 刚拿到权限时用 false 就够：没权限时挂不上的本来就没记进 registered，增量会补上。
     */
    static int resync(Context c, boolean force) {
        synchronized (LOCK) {
            try {
                List<TreasurePlan.Letter> list = parseLetters(prefs(c).getString("letters", "[]"));
                return syncLocked(c, list, force);
            } catch (Exception e) {
                android.util.Log.e(TAG, "重挂提醒失败", e);
                return -1;
            }
        }
    }

    private static int syncLocked(Context c, List<TreasurePlan.Letter> list, boolean force) {
        SharedPreferences p = prefs(c);
        Map<String, String> registered = readMap(p, "registered");
        Set<String> notified = readMap(p, "notified").keySet();
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);

        if (force) {
            // 系统里可能还挂着（也可能早没了），先按 id 全撤一遍再当空的算，免得叠两个围栏
            for (String id : registered.keySet()) removeAlert(c, lm, id);
            registered.clear();
        }
        TreasurePlan.Result plan = TreasurePlan.plan(registered, list, notified);
        for (String id : plan.remove) {
            removeAlert(c, lm, id);
            registered.remove(id);
        }
        boolean fine = hasFine(c);
        for (TreasurePlan.Letter l : plan.add) {
            if (!fine) break;   // 没精确定位权限 addProximityAlert 必抛；等 resync
            try {
                lm.addProximityAlert(l.lat, l.lng, l.radius, -1, alertIntent(c, l.id));
                registered.put(l.id, l.sig());
            } catch (SecurityException se) {
                android.util.Log.w(TAG, "挂提醒被拒（权限）: " + l.id);
                break;
            } catch (Exception e) {
                android.util.Log.e(TAG, "挂提醒失败: " + l.id, e);
            }
        }
        p.edit().putString("registered", mapToJson(registered)).commit();
        android.util.Log.i(TAG, "对齐完成: 列表 " + list.size() + " 张，挂着 " + registered.size()
                + "，撤 " + plan.remove.size() + "，新挂 " + plan.add.size() + (force ? "（全量）" : ""));
        return registered.size();
    }

    private static void removeAlert(Context c, LocationManager lm, String id) {
        try {
            PendingIntent pi = alertIntent(c, id);
            lm.removeProximityAlert(pi);
            pi.cancel();
        } catch (Exception e) {
            android.util.Log.w(TAG, "撤提醒失败: " + id, e);
        }
    }

    /**
     * 每张纸条一个 PendingIntent：靠 data 里的 id 区分（PendingIntent 判等看 action/data/class，不看 extras）。
     * 必须 MUTABLE —— 系统要往里塞 LocationManager.KEY_PROXIMITY_ENTERING。显式指向自家 receiver，
     * 所以 targetSdk 34 那条「可变 PendingIntent 不许是隐式 Intent」不会撞上。
     */
    static PendingIntent alertIntent(Context c, String id) {
        Intent i = new Intent(c, TreasureAlertReceiver.class)
                .setAction("com.grancyan.app.TREASURE_NEAR")
                .setData(new Uri.Builder().scheme("grancyan-treasure").authority("letter").appendPath(id).build());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(c.getApplicationContext(), id.hashCode(), i, flags);
    }

    // ── 进围栏 ──────────────────────────────────────────────

    /** receiver 调：进了某张纸条的围栏。没通知过就发通知、记下、把这张的提醒撤了（不用再耗 GPS）。 */
    static void onEnter(Context c, String id) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(c);
            Map<String, String> notified = readMap(p, "notified");
            Map<String, String> registered = readMap(p, "registered");
            LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);

            TreasurePlan.Letter letter = null;
            try {
                for (TreasurePlan.Letter l : parseLetters(p.getString("letters", "[]"))) {
                    if (l.id.equals(id)) { letter = l; break; }
                }
            } catch (Exception ignored) {}

            if (letter == null || notified.containsKey(id)) {
                // 已经不在列表里（被找到 / 删了，但页面还没来得及 setLetters），或者响过了：撤掉，别再来
                removeAlert(c, lm, id);
                if (registered.remove(id) != null) p.edit().putString("registered", mapToJson(registered)).commit();
                return;
            }

            if (!canNotify(c)) {
                // 通知被关着：这次发了也看不见。不记「响过」、提醒也留着，等她开了通知、下次走进来再响
                android.util.Log.w(TAG, "进了围栏但通知是关的，先不算数: " + id);
                return;
            }
            if (!notify(c, letter)) return;   // 没发出去就不算响过，提醒留着
            notified.put(id, String.valueOf(System.currentTimeMillis()));
            trimNotified(notified);
            removeAlert(c, lm, id);
            registered.remove(id);
            p.edit().putString("notified", mapToJson(notified))
                    .putString("registered", mapToJson(registered)).commit();
        }
    }

    // 只留最近 MAX_NOTIFIED 条。被挤掉的是很早以前的纸条，早就不在列表里了，不会再响。
    private static void trimNotified(Map<String, String> m) {
        if (m.size() <= MAX_NOTIFIED) return;
        List<Map.Entry<String, String>> rows = new ArrayList<>(m.entrySet());
        rows.sort((a, b) -> Long.compare(parseLong(a.getValue()), parseLong(b.getValue())));
        for (int i = 0; i < rows.size() - MAX_NOTIFIED; i++) m.remove(rows.get(i).getKey());
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s); } catch (Exception e) { return 0; }
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "克克埋的纸条", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("走到克克埋了纸条的地方附近时提醒你");
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    private static boolean notify(Context c, TreasurePlan.Letter l) {
        try {
            ensureChannel(c);
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            // 正文永远不进通知：这里压根拿不到正文，只有地点和标题
            String where = l.place.isEmpty() ? "这附近" : l.place;
            String text = l.title.isEmpty() ? where : where + "：" + l.title;
            int icon = c.getResources().getIdentifier("ic_stat_treasure", "drawable", c.getPackageName());
            if (icon == 0) icon = c.getApplicationInfo().icon;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
            b.setSmallIcon(icon)
                    .setContentTitle("克克在这里埋了东西")
                    .setContentText(text)
                    .setContentIntent(openIntent(c, l.id))
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setColor(0xFFE8B04B)
                    .setShowWhen(true);
            if (Build.VERSION.SDK_INT < 26) {
                b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            }
            nm.notify(CHANNEL, l.id.hashCode(), b.build());
            android.util.Log.i(TAG, "已通知: " + l.id);
            return true;
        } catch (SecurityException se) {
            android.util.Log.w(TAG, "没有通知权限，发不出去: " + l.id);
        } catch (Exception e) {
            android.util.Log.e(TAG, "发通知失败", e);
        }
        return false;
    }

    /**
     * 点通知 → 回到已有的 App（不新开 WebView）。
     * 跟桌面图标同一个 MAIN/LAUNCHER intent（MusicService.openApp 那种），再加 SINGLE_TOP|CLEAR_TOP：
     * 光是 MAIN/LAUNCHER+NEW_TASK 的话，任务已经在的时候系统只把它挪到前台，**新 intent 根本不送达**，
     * treasure_id 就丢了；SINGLE_TOP 让已有的 MainActivity 走 onNewIntent，CLEAR_TOP 把压在它上面的
     * （比如从 App 里点开的系统设置页）清掉，否则顶上不是 MainActivity，SINGLE_TOP 不生效。
     * 每张纸条的 PendingIntent 靠 requestCode（id.hashCode）区分，互不覆盖；
     * 不往 intent 上挂 data，免得它跟桌面图标的 intent 不再是「同一个」。
     */
    static PendingIntent openIntent(Context c, String id) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_TOKEN, token(c));
        return PendingIntent.getActivity(c, id.hashCode(), i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * 本机一份随机口令，只放进自家通知的 PendingIntent 里。MainActivity 是 exported 的，
     * 别的 App 也能带着 treasure_id 把它拉起来；口令对不上的一律不认。
     */
    static String token(Context c) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(c);
            String t = p.getString("token", "");
            if (t.isEmpty()) {
                t = java.util.UUID.randomUUID().toString();
                p.edit().putString("token", t).commit();
            }
            return t;
        }
    }

    static boolean tokenOk(Context c, String t) {
        return t != null && !t.isEmpty() && t.equals(token(c));
    }
}
