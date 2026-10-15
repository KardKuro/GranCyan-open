package com.grancyan.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/**
 * 手机上的桌面歌词悬浮条（桌面端那条外显示歌词的手机版）。
 *
 * 浮在别的 App 上面，所以只在 GranCyan 退到后台时出现；回到 App 里由页面自己那层（#mzDeskLy）显示。
 * 要「在其他应用上层显示」权限（SYSTEM_ALERT_WINDOW），只能她自己在系统设置里点开。
 *
 * 和电脑悬浮窗不一样的地方：电脑那边每帧由页面算好推过去；手机退到后台后 WebView 的 rAF 停了、
 * 定时器也会被节流，所以这里拿到的是**整首歌的时间轴**（每句起点、扫色时长、逐字的字级时间），
 * 加上「某一刻在第几秒、在不在放」，自己按系统时钟往前推，自己算当前句和扫色进度。
 * 页面只在换歌、播放/暂停、拖进度、改开关时推一次。
 *
 * 排版照抄 deskly.js：普通两行一页（2k 靠左、2k+1 靠右）；开了「音」「译」变成当前这句 + 副行，居中。
 * 太长的句子先缩（最多到 0.6 倍），再长就跟着唱到的位置往左滚。
 *
 * 点一下歌词出工具条（音 / 译 / 字小 / 字大 / 锁 / ✕），上下拖挪位置。锁上后整条穿透触摸，
 * 解锁在下拉栏播放卡片的「词」按钮上（锁着时它就是解锁）。
 */
final class LyricOverlay {
    interface Host { void cmd(String c); void lockChanged(); }

    private final Context ctx;
    private final Host host;
    private final WindowManager wm;
    private final SharedPreferences sp;
    private final LinearLayout root;
    private final LyricView lv;
    private final LinearLayout bar;
    private final TextView bRo, bTr, bLock;
    private final WindowManager.LayoutParams lp;
    private boolean attached;
    private boolean locked;
    private final float dp;
    private final Runnable hideBar = this::hideBar;

    LyricOverlay(Context c, Host h) {
        ctx = c; host = h;
        wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
        sp = c.getSharedPreferences("lyric_overlay", Context.MODE_PRIVATE);
        dp = c.getResources().getDisplayMetrics().density;
        locked = sp.getBoolean("locked", false);

        root = new LinearLayout(c);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (8 * dp);
        root.setPadding(pad, (int) (4 * dp), pad, (int) (4 * dp));
        lv = new LyricView(c);
        lv.setTextSizeSp(sp.getFloat("size", 19f));
        root.addView(lv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        bar = new LinearLayout(c);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        bar.setVisibility(View.GONE);
        bRo = btn("音", v -> { host.cmd("ro"); kickBar(); });
        bTr = btn("译", v -> { host.cmd("tr"); kickBar(); });
        btn("A−", v -> { size(-1.5f); kickBar(); });
        btn("A+", v -> { size(1.5f); kickBar(); });
        bLock = btn("锁", v -> setLocked(true));
        btn("✕", v -> { hideBar(); host.cmd("lyoff"); });
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        blp.topMargin = (int) (4 * dp);
        root.addView(bar, blp);

        lp = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        int sh = c.getResources().getDisplayMetrics().heightPixels;
        lp.y = sp.getInt("y", (int) (sh * 0.62f));
        applyTouchable();

        // 上下拖挪位置；没拖动就是点了一下 → 出/收工具条
        final int slop = ViewConfiguration.get(c).getScaledTouchSlop();
        root.setOnTouchListener(new View.OnTouchListener() {
            float sy; int y0; boolean moved;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: sy = e.getRawY(); y0 = lp.y; moved = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        float dy = e.getRawY() - sy;
                        if (!moved && Math.abs(dy) > slop) moved = true;
                        if (moved) { lp.y = clampY(Math.round(y0 + dy)); if (attached) wm.updateViewLayout(root, lp); }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (moved) sp.edit().putInt("y", lp.y).apply();
                        else if (bar.getVisibility() == View.VISIBLE) hideBar(); else showBar();
                        return true;
                }
                return false;
            }
        });
    }

    private TextView btn(String label, View.OnClickListener l) {
        TextView t = new TextView(ctx);
        t.setText(label);
        t.setTextColor(Color.WHITE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setGravity(Gravity.CENTER);
        int ph = (int) (12 * dp), pv = (int) (6 * dp);
        t.setPadding(ph, pv, ph, pv);
        t.setOnClickListener(l);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.leftMargin = p.rightMargin = (int) (3 * dp);
        bar.addView(t, p);
        return t;
    }

    private int clampY(int y) {
        int sh = ctx.getResources().getDisplayMetrics().heightPixels;
        return Math.max(0, Math.min(sh - (int) (60 * dp), y));
    }

    private void size(float d) {
        float s = Math.max(13f, Math.min(34f, lv.sizeSp + d));
        lv.setTextSizeSp(s);
        sp.edit().putFloat("size", s).apply();
    }

    private void kickBar() { root.removeCallbacks(hideBar); root.postDelayed(hideBar, 4000); }

    private void showBar() {
        paintBar();
        bar.setVisibility(View.VISIBLE);
        GradientDrawable g = new GradientDrawable();
        g.setColor(0x99000000);
        g.setCornerRadius(14 * dp);
        root.setBackground(g);
        kickBar();
    }

    private void hideBar() {
        root.removeCallbacks(hideBar);
        bar.setVisibility(View.GONE);
        root.setBackground(null);
    }

    private void paintBar() {
        bRo.setVisibility(lv.hasRo ? View.VISIBLE : View.GONE);
        bTr.setVisibility(lv.hasTr ? View.VISIBLE : View.GONE);
        pill(bRo, lv.optRo);
        pill(bTr, lv.optTr);
        pill(bLock, false);
    }

    private void pill(TextView t, boolean on) {
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(8 * dp);
        g.setStroke((int) Math.max(1, dp), on ? lv.accent : 0x66FFFFFF);
        g.setColor(on ? (lv.accent & 0x00FFFFFF) | 0x40000000 : 0x00000000);
        t.setBackground(g);
        t.setTextColor(on ? lv.accent : Color.WHITE);
    }

    boolean locked() { return locked; }

    void setLocked(boolean v) {
        locked = v;
        sp.edit().putBoolean("locked", v).apply();
        hideBar();
        applyTouchable();
        if (attached) wm.updateViewLayout(root, lp);
        host.lockChanged();
    }

    private void applyTouchable() {
        if (locked) lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
    }

    static boolean permitted(Context c) {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
    }

    void setLyric(JSONObject l) {
        lv.setLyric(l);
        if (bar.getVisibility() == View.VISIBLE) paintBar();
    }

    void setClock(double posSec, boolean playing, float rate) { lv.setClock(posSec, playing, rate); }

    boolean hasLines() { return lv.lines.size() > 0; }

    /** 该不该露出来由 MusicService 判断（词开着、有词、App 在后台、有权限），这里只管挂上/拿下 */
    void show(boolean want) {
        if (want && !attached) {
            if (!permitted(ctx)) return;
            try { wm.addView(root, lp); attached = true; lv.kick(); }
            catch (Exception e) { android.util.Log.w("GrancyanLyric", "addView 失败", e); }
        } else if (!want && attached) {
            hideBar();
            try { wm.removeView(root); } catch (Exception ignored) {}
            attached = false;
        }
        lv.visible = attached;
    }

    // ───────────────────────── 画歌词的那块 ─────────────────────────
    static final class LyricView extends View {
        static final class Line { double s, d; String t, ro, tr; double[] w; }   // w: [起, 止, 字数] × n
        final List<Line> lines = new ArrayList<>();
        boolean wbw, optRo, optTr, hasRo, hasTr, visible;
        int accent = 0xFFC6FF3A;
        float sizeSp = 19f;
        private double basePos; private long baseAt; private boolean playing; private float rate = 1f;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float dpx;
        private int lastRows = -1;

        LyricView(Context c) {
            super(c);
            dpx = c.getResources().getDisplayMetrics().density;
            // 和 App 里一样用宋体：FONT_PRESETS 三档最后都落到 serif，系统里中文 serif＝思源宋体（NotoSerifCJK）
            paint.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD));
        }

        void setTextSizeSp(float s) { sizeSp = s; requestLayout(); invalidate(); }

        void setLyric(JSONObject l) {
            lines.clear();
            JSONArray a = l.optJSONArray("lines");
            if (a != null) for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                Line n = new Line();
                n.s = o.optDouble("s", 0); n.d = Math.max(0.3, o.optDouble("d", 3));
                n.t = o.optString("t", ""); n.ro = o.optString("ro", ""); n.tr = o.optString("tr", "");
                JSONArray w = o.optJSONArray("w");
                if (w != null && w.length() > 0) {
                    n.w = new double[w.length() * 3];
                    for (int k = 0; k < w.length(); k++) {
                        JSONArray x = w.optJSONArray(k);
                        if (x == null) continue;
                        n.w[k * 3] = x.optDouble(0); n.w[k * 3 + 1] = x.optDouble(1); n.w[k * 3 + 2] = Math.max(1, x.optDouble(2, 1));
                    }
                }
                lines.add(n);
            }
            wbw = l.optBoolean("wbw");
            hasRo = l.optBoolean("hasRo"); hasTr = l.optBoolean("hasTr");
            optRo = hasRo && l.optBoolean("ro"); optTr = hasTr && l.optBoolean("tr");
            accent = MusicService.parseColor(l.optString("accent"), accent);
            requestLayout();
            invalidate();
        }

        void setClock(double posSec, boolean pl, float r) {
            basePos = posSec; baseAt = SystemClock.elapsedRealtime(); playing = pl; rate = r > 0 ? r : 1f;
            kick();
        }

        void kick() { invalidate(); }

        double now() {
            return basePos + (playing ? (SystemClock.elapsedRealtime() - baseAt) / 1000.0 * rate : 0);
        }

        int idxAt(double t) {
            int lo = 0, hi = lines.size() - 1, r = -1;
            while (lo <= hi) { int m = (lo + hi) >>> 1; if (lines.get(m).s <= t) { r = m; lo = m + 1; } else hi = m - 1; }
            return r;
        }

        // 和 _mDeskProg 一个算法：逐字按字数加权，行级按页面算好的扫色时长
        double prog(Line ln, double t) {
            if (wbw && ln.w != null) {
                double tot = 0, done = 0;
                for (int k = 0; k < ln.w.length; k += 3) {
                    double s = ln.w[k], e = ln.w[k + 1], n = ln.w[k + 2];
                    tot += n;
                    if (t >= e) done += n; else if (t > s) done += n * (t - s) / Math.max(.001, e - s);
                }
                return tot > 0 ? Math.min(1, done / tot) : 0;
            }
            return Math.max(0, Math.min(1, (t - ln.s) / ln.d));
        }

        private boolean sub() { return optRo || optTr; }
        private float mainPx() { return sizeSp * getResources().getDisplayMetrics().scaledDensity; }
        private int rowCount() { return sub() ? 1 + (optRo ? 1 : 0) + (optTr ? 1 : 0) : 2; }

        @Override protected void onMeasure(int wSpec, int hSpec) {
            float m = mainPx(), h = m * 1.35f * 2;
            if (sub()) h = m * 1.35f + (optRo ? m * .62f * 1.45f : 0) + (optTr ? m * .62f * 1.45f : 0);
            setMeasuredDimension(MeasureSpec.getSize(wSpec), (int) Math.ceil(h + 6 * dpx));
        }

        @Override protected void onDraw(Canvas c) {
            if (lines.isEmpty()) return;
            if (rowCount() != lastRows) { lastRows = rowCount(); requestLayout(); }
            double t = now();
            int i = idxAt(t), n = lines.size();
            float W = getWidth(), m = mainPx(), y = 3 * dpx;
            if (sub()) {
                int k = Math.max(0, i);
                Line ln = lines.get(k);
                double p = i < 0 ? 0 : prog(ln, t);
                y = row(c, ln.t, m, y, W, 2, i < 0 ? -1 : p, i >= 0);
                if (optRo) y = row(c, ln.ro, m * .62f, y, W, 2, i < 0 ? -1 : p, i >= 0);
                if (optTr) row(c, ln.tr, m * .62f, y, W, 2, -1, false);
            } else {
                int pg = i < 0 ? 0 : i - (i % 2);
                for (int r = 0; r < 2; r++) {
                    int k = pg + r;
                    String s = k < n ? lines.get(k).t : "";
                    double p = k == i ? prog(lines.get(k), t) : k < i ? 1 : -1;
                    y = row(c, s, m, y, W, r, p, k == i);
                }
            }
            if (playing && visible) postInvalidateDelayed(33);   // 30 帧够顺，省电
        }

        /** 画一行。align 0 左 1 右 2 居中；p<0 不扫色（未唱到/翻译），cur=当前句（亮一些） */
        private float row(Canvas c, String s, float size, float y, float W, int align, double p, boolean cur) {
            float lh = size * (size < mainPx() ? 1.45f : 1.35f);
            if (s == null || s.isEmpty()) return y + lh;
            float avail = W - 8 * dpx;
            paint.setTextSize(size);
            float tw = paint.measureText(s);
            if (tw > avail) { paint.setTextSize(Math.max(size * .6f, size * avail / tw)); tw = paint.measureText(s); }
            float over = Math.max(0, tw - avail);
            float x = align == 0 ? 4 * dpx : align == 1 ? W - 4 * dpx - Math.min(tw, avail) : (W - Math.min(tw, avail)) / 2;
            if (over > 0) {
                double q = p < 0 ? 0 : p;
                x -= (float) Math.max(0, Math.min(over, q * (over + avail) - avail * .55));
            }
            float base = y + lh / 2 - (paint.descent() + paint.ascent()) / 2;
            c.save();
            c.clipRect(4 * dpx, y, W - 4 * dpx, y + lh);
            paint.setShadowLayer(4 * dpx, 0, 0, 0xCC000000);
            int idle = cur || p < 0 ? 0xF2FFFFFF : 0xCCFFFFFF;
            if (p > 0) {
                float cut = x + (float) (tw * p);
                c.save(); c.clipRect(x - 2, y, cut, y + lh);
                paint.setColor(accent); c.drawText(s, x, base, paint);
                c.restore();
                c.save(); c.clipRect(cut, y, x + tw + 2, y + lh);
                paint.setColor(idle); c.drawText(s, x, base, paint);
                c.restore();
            } else {
                paint.setColor(idle);
                c.drawText(s, x, base, paint);
            }
            c.restore();
            return y + lh;
        }
    }
}
