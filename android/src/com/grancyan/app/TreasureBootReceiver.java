package com.grancyan.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机 / 覆盖安装之后，系统里挂着的接近提醒都没了 —— 从 SharedPreferences 读回列表全量重挂。
 * 不用等她打开 App：纸条埋在公园门口，她早上开机直接出门也得能响。
 * BOOT_COMPLETED 和 MY_PACKAGE_REPLACED 都是受保护广播，别的 App 发不出来，所以 exported=true 无妨。
 */
public class TreasureBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        int n = TreasureStore.resync(context, true);
        android.util.Log.i(TreasureStore.TAG, a + " → 重挂 " + n + " 个提醒");
    }
}
