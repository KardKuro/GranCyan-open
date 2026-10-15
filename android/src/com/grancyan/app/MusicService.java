package com.grancyan.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 点歌在手机系统里的那一份：下拉栏/锁屏的播放卡片 + 桌面歌词悬浮条。
 * 需求：手机的下拉通知栏能显示出 Grancyan 在播放，最好跟随主题色。
 *
 * 为什么要原生做：WebView 不像 Chrome 那样替 navigator.mediaSession 建系统媒体会话，
 * 页面里设了元数据，系统那边什么都看不到。所以页面把「放的是什么、在第几秒、在不在放」经
 * MusicBridge 推过来，这里建 MediaSession + MediaStyle 通知；卡片上的按钮再经 MusicBridge 调回页面。
 *
 * 跟随主题色：Android 13+ 的播放卡片不认 setColor/setColorized，它的配色是**从封面图里取色**的。
 * 所以封面不直接给原图，而是合成一张：主题色压暗做底、主题色描一圈环、原封面裁圆放中间。
 * 系统从这张图里取出来的主色就是主题色（老系统上 setColorized 也照样生效）。
 *
 * 前台服务（mediaPlayback）：有歌就挂着，停掉（页面推来空标题）才收。顺带让切到后台时进程不容易被杀。
 */
public class MusicService extends Service implements LyricOverlay.Host {
    private static final String CH = "music";
    private static final int NID = 7301;
    static final Handler H = new Handler(Looper.getMainLooper());

    // 页面推来的最新一份（服务还没起来时先存着，起来后按它画）
    static JSONObject st = new JSONObject();
    static JSONObject ly = new JSONObject();
    static boolean appVisible = true;
    static MusicService inst;

    private MediaSession ms;
    private NotificationManager nm;
    private LyricOverlay ov;
    private Bitmap art;
    private String artKey = "", artWant = "";
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    // 锁屏后 CPU 一睡，两首之间取下一首地址、缓冲都停住（症状：后台放歌放一会就自己断）。
    // 放着的时候拿住 CPU 和 Wi-Fi；停了再宽限一会儿才放手（自动下一首中间有一段 playing=false）。
    // 带超时：页面每 15 秒推一次状态会续上，页面没了也最多拿 10 分钟。
    private android.os.PowerManager.WakeLock cpu;
    private android.net.wifi.WifiManager.WifiLock wifi;
    private final Runnable dropLocks = this::releaseLocks;

    // ───── 页面那边（MusicBridge）调这几个，都在主线程上跑 ─────
    static void pushState(Context c, JSONObject s) {
        st = s;
        boolean has = !s.optString("title").isEmpty();
        if (!has) { if (inst != null) inst.shutdown(); return; }
        if (inst != null) { inst.refresh(); return; }
        try {
            Intent i = new Intent(c, MusicService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception e) {
            // Android 12+ 在后台起前台服务会被拒（ForegroundServiceStartNotAllowedException）：
            // 这一下没起来不要紧，她回到 App 里再按播放/换歌时会再推一次
            android.util.Log.w("GrancyanMusic", "前台服务没起来", e);
        }
    }

    static void pushLyric(JSONObject l) {
        ly = l;
        if (inst != null) { inst.ov.setLyric(l); inst.syncOverlay(); inst.refresh(); }
    }

    static void setAppVisible(boolean v) {
        appVisible = v;
        if (inst != null) inst.syncOverlay();
    }

    static void stopAll() { if (inst != null) inst.shutdown(); }

    // ───── 服务本体 ─────
    @Override public void onCreate() {
        super.onCreate();
        inst = this;
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "正在播放", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setDescription("点歌在下拉栏和锁屏上的播放卡片");
            nm.createNotificationChannel(ch);
        }
        try {
            cpu = ((android.os.PowerManager) getSystemService(POWER_SERVICE))
                .newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Grancyan:music");
            cpu.setReferenceCounted(false);
            android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                wifi = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Grancyan:music");
                wifi.setReferenceCounted(false);
            }
        } catch (Exception e) { android.util.Log.w("GrancyanMusic", "唤醒锁没拿到", e); }
        ms = new MediaSession(this, "GrancyanMusic");
        ms.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MusicBridge.toJs("play", ""); }
            @Override public void onPause() { MusicBridge.toJs("pause", ""); }
            @Override public void onStop() { MusicBridge.toJs("pause", ""); }
            @Override public void onSkipToNext() { MusicBridge.toJs("next", ""); }
            @Override public void onSkipToPrevious() { MusicBridge.toJs("prev", ""); }
            @Override public void onSeekTo(long pos) {
                // 先把本地时钟挪过去，卡片上的进度条不用等页面回推就停在新位置
                try { st.put("pos", pos / 1000.0); } catch (Exception ignored) {}
                refresh();
                MusicBridge.toJs("seek", String.valueOf(pos / 1000.0));
            }
            @Override public void onCustomAction(String action, Bundle extras) {
                if (!"lyric".equals(action)) return;
                if (ov.locked()) ov.setLocked(false);   // 锁着时这颗按钮就是解锁
                else MusicBridge.toJs("lyric", "");
            }
        });
        ms.setSessionActivity(openApp());
        ms.setActive(true);
        ov = new LyricOverlay(this, this);
        ov.setLyric(ly);
        refresh();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent != null ? intent.getAction() : null;
        if (a != null) MusicBridge.toJs(a, "");   // 老系统通知栏上的按钮（prev / toggle / next）
        refresh();
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onTaskRemoved(Intent rootIntent) { shutdown(); }

    @Override public void onDestroy() {
        ov.show(false);
        try { ms.setActive(false); ms.release(); } catch (Exception ignored) {}
        io.shutdownNow();
        H.removeCallbacks(dropLocks);
        releaseLocks();
        if (inst == this) inst = null;
        super.onDestroy();
    }

    void shutdown() {
        ov.show(false);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    // LyricOverlay.Host
    @Override public void cmd(String c) { MusicBridge.toJs(c, ""); }
    @Override public void lockChanged() { refresh(); }

    void syncOverlay() {
        boolean want = !appVisible && ly.optBoolean("on") && ov.hasLines() && LyricOverlay.permitted(this);
        ov.show(want);
    }

    private PendingIntent openApp() {
        // 和桌面图标一样的 Intent：把已有的那个任务拉到前面，不会新开一份 MainActivity（新开 = 再起一个 WebView，歌会断）
        Intent i = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent act(String a, int code) {
        Intent i = new Intent(this, MusicService.class).setAction(a);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private int res(String name) { return getResources().getIdentifier(name, "drawable", getPackageName()); }

    /** 按 st 把会话状态、元数据、通知、悬浮条的时钟全刷一遍 */
    void refresh() {
        JSONObject s = st;
        String title = s.optString("title"), artist = s.optString("artist");
        boolean playing = s.optBoolean("playing");
        double dur = s.optDouble("dur", 0), pos = s.optDouble("pos", 0);
        float rate = (float) s.optDouble("rate", 1);
        int accent = parseColor(s.optString("accent"), 0xFFC6FF3A);
        ov.setClock(pos, playing, rate);
        syncOverlay();
        holdLocks(playing);

        // 封面换了 / 主题色换了才重新合成
        String key = s.optString("cover") + "|" + accent;
        if (!key.equals(artKey) && !key.equals(artWant)) loadArt(s.optString("cover"), accent, key);

        boolean lyOn = ly.optBoolean("on");
        PlaybackState.Builder pb = new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                (long) (pos * 1000), playing ? rate : 0f, SystemClock.elapsedRealtime());
        if (ly.optInt("n") > 0) {
            String lab = ov.locked() ? "解锁桌面歌词" : lyOn ? "关掉桌面歌词" : "桌面歌词";
            pb.addCustomAction(new PlaybackState.CustomAction.Builder("lyric", lab, res("ic_act_lyric")).build());
        }
        ms.setPlaybackState(pb.build());

        MediaMetadata.Builder mb = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "GranCyan 点歌");
        if (dur > 0) mb.putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (dur * 1000));
        if (art != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        ms.setMetadata(mb.build());

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setSmallIcon(res("ic_stat_music"))
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(openApp())
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(false)
            .setOngoing(playing)
            .setColor(accent)
            .setColorized(true)
            .addAction(new Notification.Action.Builder(Icon.createWithResource(this, res("ic_act_prev")), "上一首", act("prev", 1)).build())
            .addAction(new Notification.Action.Builder(Icon.createWithResource(this, res(playing ? "ic_act_pause" : "ic_act_play")), playing ? "暂停" : "播放", act("toggle", 2)).build())
            .addAction(new Notification.Action.Builder(Icon.createWithResource(this, res("ic_act_next")), "下一首", act("next", 3)).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(ms.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        if (art != null) b.setLargeIcon(art);
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NID, n);
        } catch (Exception e) {
            android.util.Log.w("GrancyanMusic", "startForeground 失败，退回普通通知", e);
            nm.notify(NID, n);
        }
    }

    private void holdLocks(boolean playing) {
        H.removeCallbacks(dropLocks);
        if (!playing) { H.postDelayed(dropLocks, 90_000); return; }
        try {
            if (cpu != null) cpu.acquire(10 * 60_000L);
            if (wifi != null && !wifi.isHeld()) wifi.acquire();
        } catch (Exception e) { android.util.Log.w("GrancyanMusic", "唤醒锁拿不住", e); }
    }

    private void releaseLocks() {
        try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) {}
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) {}
    }

    private void loadArt(String url, int accent, String key) {
        artWant = key;
        io.execute(() -> {
            Bitmap cover = null;
            if (url.startsWith("http")) {
                try {
                    // 网易云的图床认 ?param=WxH，原图动辄上千像素，要个 300 的就够
                    String u = url.contains("music.126.net") && !url.contains("param=") ? url + (url.contains("?") ? "&" : "?") + "param=300y300" : url;
                    HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
                    c.setConnectTimeout(6000); c.setReadTimeout(8000);
                    try (InputStream in = c.getInputStream()) { cover = BitmapFactory.decodeStream(in); }
                } catch (Exception e) { android.util.Log.w("GrancyanMusic", "封面没拿到: " + e); }
            }
            Bitmap out = compose(cover, accent);
            H.post(() -> {
                if (!key.equals(artWant)) return;   // 已经又换了一首
                art = out; artKey = key; artWant = "";
                if (inst == this) refresh();
            });
        });
    }

    /** 主题色压暗做底 + 主题色光晕和描边 + 圆形封面。系统从这张图取色，取到的就是主题色 */
    static Bitmap compose(Bitmap cover, int accent) {
        int S = 512;
        Bitmap b = Bitmap.createBitmap(S, S, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        int r = Color.red(accent), g = Color.green(accent), bl = Color.blue(accent);
        int bg = Color.rgb((int) (r * .16 + 8), (int) (g * .16 + 9), (int) (bl * .16 + 8));
        c.drawColor(bg);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setShader(new RadialGradient(S / 2f, S / 2f, S * .5f, Color.argb(110, r, g, bl), Color.argb(0, r, g, bl), Shader.TileMode.CLAMP));
        c.drawCircle(S / 2f, S / 2f, S * .5f, p);
        p.setShader(null);
        float rad = S * .30f;
        if (cover != null) {
            BitmapShader sh = new BitmapShader(cover, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
            float k = 2 * rad / Math.min(cover.getWidth(), cover.getHeight());
            Matrix m = new Matrix();
            m.setScale(k, k);
            m.postTranslate(S / 2f - cover.getWidth() * k / 2, S / 2f - cover.getHeight() * k / 2);
            sh.setLocalMatrix(m);
            p.setShader(sh);
            c.drawCircle(S / 2f, S / 2f, rad, p);
            p.setShader(null);
        } else {
            p.setColor(Color.argb(70, r, g, bl));
            c.drawCircle(S / 2f, S / 2f, rad, p);
        }
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(S * .028f);
        p.setColor(accent);
        c.drawCircle(S / 2f, S / 2f, rad + S * .03f, p);
        return b;
    }

    /** 页面的 --accent：#rgb / #rrggbb / #rrggbbaa / rgb(a)(…)；认不出就用 def */
    static int parseColor(String s, int def) {
        if (s == null) return def;
        s = s.trim();
        try {
            if (s.startsWith("#")) {
                String h = s.substring(1);
                if (h.length() == 3) h = "" + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
                if (h.length() == 8) h = h.substring(0, 6);
                if (h.length() == 6) return 0xFF000000 | Integer.parseInt(h, 16);
            } else if (s.startsWith("rgb")) {
                String[] a = s.substring(s.indexOf('(') + 1, s.indexOf(')')).split("[,\\s/]+");
                return Color.rgb(Math.round(Float.parseFloat(a[0])), Math.round(Float.parseFloat(a[1])), Math.round(Float.parseFloat(a[2])));
            }
        } catch (Exception ignored) {}
        return def;
    }
}
