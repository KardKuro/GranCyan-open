package com.grancyan.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.webkit.JavascriptInterface;
import android.view.WindowManager;

/** Android 屏幕固定桥。非 Device Owner 时系统会显示一次确认，由用户亲自同意。 */
public final class FocusBridge {
    private final Activity activity;

    FocusBridge(Activity activity) { this.activity = activity; }

    @JavascriptInterface
    public boolean available() { return android.os.Build.VERSION.SDK_INT >= 21; }

    @JavascriptInterface
    public void lock() {
        activity.runOnUiThread(() -> {
            try {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                activity.startLockTask();
            } catch (Exception e) {
                android.util.Log.e("GrancyanFocus", "startLockTask failed", e);
            }
        });
    }

    @JavascriptInterface
    public void unlock() {
        activity.runOnUiThread(() -> {
            try { activity.stopLockTask(); } catch (Exception ignored) {}
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @JavascriptInterface
    public boolean locked() {
        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
        return am != null && am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }
}
