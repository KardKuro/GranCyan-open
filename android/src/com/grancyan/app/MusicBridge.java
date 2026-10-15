package com.grancyan.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;

/**
 * 点歌 ↔ 系统的桥（页面里是 window.GrancyanMusic，js/24-music.js 的 _mNative* 那几个函数在用）。
 *
 * 页面 → 这里：state（放的是什么、第几秒、在不在放、主题色）、lyric（整首的时间轴和「词/音/译」开关）。
 * 这里 → 页面：卡片按钮、耳机键、悬浮条上的按钮，统一调 window._mNativeCmd(cmd, arg)。
 *
 * JS 接口的方法跑在 WebView 自己的后台线程上，一律转到主线程再碰服务和窗口。
 */
public final class MusicBridge {
    private static WebView web;
    private final Activity act;

    MusicBridge(Activity a, WebView w) { act = a; web = w; }

    @JavascriptInterface
    public void state(String json) {
        final JSONObject o = parse(json);
        if (o != null) MusicService.H.post(() -> MusicService.pushState(act.getApplicationContext(), o));
    }

    @JavascriptInterface
    public void lyric(String json) {
        final JSONObject o = parse(json);
        if (o != null) MusicService.H.post(() -> MusicService.pushLyric(o));
    }

    /** 有没有「在其他应用上层显示」权限 */
    @JavascriptInterface
    public boolean canOverlay() { return LyricOverlay.permitted(act); }

    /** 送她去系统设置里打开那个权限（只能她自己点） */
    @JavascriptInterface
    public void askOverlay() {
        act.runOnUiThread(() -> {
            try {
                act.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + act.getPackageName())));
            } catch (Exception e) {
                android.util.Log.w("GrancyanMusic", "打不开悬浮窗权限页", e);
            }
        });
    }

    static void toJs(String cmd, String arg) {
        final WebView w = web;
        if (w == null) return;
        final String js = "window._mNativeCmd&&window._mNativeCmd(" + JSONObject.quote(cmd) + "," + JSONObject.quote(arg == null ? "" : arg) + ")";
        w.post(() -> { try { w.evaluateJavascript(js, null); } catch (Exception ignored) {} });
    }

    static void detach() { web = null; }

    private static JSONObject parse(String s) {
        try { return new JSONObject(s); } catch (Exception e) { return null; }
    }
}
