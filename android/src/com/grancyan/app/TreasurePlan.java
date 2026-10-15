package com.grancyan.app;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 藏宝纸条：setLetters 传进来的列表 ⇄ 系统里已经挂着的接近提醒，怎么对齐。
 *
 * 纯 Java，不碰任何 android.*，这样能脱离安卓单独测（android/test/TreasurePlanTest.java）。
 * 真正去调 LocationManager 的是 TreasureStore，它只照这里算出来的单子执行。
 *
 * 规则：
 *   · 已经通知过的纸条不再挂提醒（同一张只通知一次；她划掉通知没点开也不会再响）
 *   · 挂着、但新列表里没了的 → 撤
 *   · 坐标或半径变了的 → 先撤再挂（同一个 PendingIntent 换了围栏，系统不会替换，会叠两个）
 *   · 新列表里有、还没挂的 → 挂
 *   · 坐标不合法的条目直接丢掉（NaN、越界、id 为空）；id 重复的留第一条
 */
final class TreasurePlan {

    static final int DEFAULT_RADIUS = 150;
    static final int MIN_RADIUS = 30;      // 再小 GPS 漂一下就进不去
    static final int MAX_RADIUS = 5000;

    static final class Letter {
        final String id;
        final double lat, lng;
        final int radius;
        final String title, place;

        Letter(String id, double lat, double lng, int radius, String title, String place) {
            this.id = id;
            this.lat = lat;
            this.lng = lng;
            this.radius = radius;
            this.title = title == null ? "" : title;
            this.place = place == null ? "" : place;
        }

        /** 围栏签名：已挂的提醒按这个判断「变没变」。Double.toString 不看 Locale，不会出现「31,5」这种。 */
        String sig() { return lat + "," + lng + "," + radius; }
    }

    static final class Result {
        final List<String> remove = new ArrayList<>();   // 先撤
        final List<Letter> add = new ArrayList<>();       // 再挂
    }

    private TreasurePlan() {}

    /** 半径收进合法范围；没给（<=0）就用默认 150m。 */
    static int clampRadius(int r) {
        if (r <= 0) return DEFAULT_RADIUS;
        return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, r));
    }

    static boolean validCoord(double lat, double lng) {
        return !Double.isNaN(lat) && !Double.isNaN(lng) && !Double.isInfinite(lat) && !Double.isInfinite(lng)
            && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
            && !(lat == 0 && lng == 0);   // (0,0) 基本只会是前端没取到坐标的默认值
    }

    /** 去掉不合法的、去重（留第一条），半径归一。保持原顺序。 */
    static List<Letter> normalize(Collection<Letter> in) {
        Map<String, Letter> seen = new LinkedHashMap<>();
        if (in == null) return new ArrayList<>();
        for (Letter l : in) {
            if (l == null || l.id == null || l.id.trim().isEmpty()) continue;
            if (!validCoord(l.lat, l.lng)) continue;
            if (seen.containsKey(l.id)) continue;
            seen.put(l.id, new Letter(l.id, l.lat, l.lng, clampRadius(l.radius), l.title, l.place));
        }
        return new ArrayList<>(seen.values());
    }

    /**
     * @param registered 现在系统里挂着的：id → sig
     * @param desired    新列表（已 normalize）
     * @param notified   通知过的 id
     */
    static Result plan(Map<String, String> registered, List<Letter> desired, Set<String> notified) {
        Result r = new Result();
        Map<String, Letter> want = new LinkedHashMap<>();
        for (Letter l : desired) {
            if (notified != null && notified.contains(l.id)) continue;
            want.put(l.id, l);
        }
        for (Map.Entry<String, String> e : registered.entrySet()) {
            Letter l = want.get(e.getKey());
            if (l == null || !l.sig().equals(e.getValue())) r.remove.add(e.getKey());
        }
        for (Letter l : want.values()) {
            String cur = registered.get(l.id);
            if (cur == null || !cur.equals(l.sig())) r.add.add(l);
        }
        return r;
    }
}
