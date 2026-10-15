package com.grancyan.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.LocationManager;
import android.net.Uri;
import java.util.List;

/**
 * 接近提醒（LocationManager.addProximityAlert）打过来的广播。exported=false：只有系统经由我们自己的
 * PendingIntent 能送进来。App 进程没在跑也会被拉起来执行这里。
 * 进 → TreasureStore.onEnter 发通知；出 → 不管（只通知一次，出去了也没什么可说的）。
 */
public class TreasureAlertReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        String id = null;
        if (data != null) {
            List<String> seg = data.getPathSegments();
            if (seg != null && !seg.isEmpty()) id = seg.get(0);
        }
        if (id == null || id.isEmpty()) return;
        boolean entering = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false);
        android.util.Log.i(TreasureStore.TAG, (entering ? "进入" : "离开") + "围栏: " + id);
        if (!entering) return;
        // 读写 SharedPreferences + 一次 notify，主线程上几毫秒的事，用不着 goAsync
        TreasureStore.onEnter(context, id);
    }
}
