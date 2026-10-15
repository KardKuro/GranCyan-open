package com.grancyan.app;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * TreasurePlan（setLetters ⇄ 已挂接近提醒的对齐）的纯 Java 单测，不依赖安卓。
 * 不在 android/src 里，build.ps1 不会把它编进 APK。跑法（仓库根目录，JDK 17+）：
 *
 *   javac -d android/build/plan-test android/src/com/grancyan/app/TreasurePlan.java android/test/TreasurePlanTest.java
 *   java -cp android/build/plan-test com.grancyan.app.TreasurePlanTest
 *
 * 全过打印「TreasurePlanTest: N 条全部通过」，退出码 0；有一条不过退出码 1。
 */
public class TreasurePlanTest {
    private static int pass = 0, fail = 0;

    private static void check(String name, boolean ok) {
        if (ok) pass++;
        else { fail++; System.out.println("  ✗ " + name); }
    }

    private static TreasurePlan.Letter L(String id, double lat, double lng, int r) {
        return new TreasurePlan.Letter(id, lat, lng, r, "标题" + id, "地点" + id);
    }

    private static Set<String> set(String... s) { return new HashSet<>(Arrays.asList(s)); }

    private static Set<String> ids(List<TreasurePlan.Letter> l) {
        Set<String> s = new HashSet<>();
        for (TreasurePlan.Letter x : l) s.add(x.id);
        return s;
    }

    public static void main(String[] args) {
        // ── 从空开始：全挂 ──
        {
            List<TreasurePlan.Letter> want = TreasurePlan.normalize(Arrays.asList(L("a", 31.2, 121.5, 150), L("b", 31.3, 121.6, 0)));
            TreasurePlan.Result r = TreasurePlan.plan(new HashMap<>(), want, set());
            check("空 → 全挂", ids(r.add).equals(set("a", "b")) && r.remove.isEmpty());
            check("半径 0 → 默认 150", want.get(1).radius == 150);
        }
        // ── 没变化：什么都不做 ──
        {
            List<TreasurePlan.Letter> want = TreasurePlan.normalize(Arrays.asList(L("a", 31.2, 121.5, 150)));
            Map<String, String> reg = new HashMap<>();
            reg.put("a", want.get(0).sig());
            TreasurePlan.Result r = TreasurePlan.plan(reg, want, set());
            check("没变化 → 不撤不挂", r.add.isEmpty() && r.remove.isEmpty());
        }
        // ── 传 [] → 全撤 ──
        {
            Map<String, String> reg = new HashMap<>();
            reg.put("a", "x"); reg.put("b", "y");
            TreasurePlan.Result r = TreasurePlan.plan(reg, TreasurePlan.normalize(Arrays.asList()), set());
            check("[] → 全撤", new HashSet<>(r.remove).equals(set("a", "b")) && r.add.isEmpty());
        }
        // ── 增删混合 ──
        {
            List<TreasurePlan.Letter> want = TreasurePlan.normalize(Arrays.asList(L("b", 1.5, 2.5, 150), L("c", 3.5, 4.5, 150)));
            Map<String, String> reg = new HashMap<>();
            reg.put("a", L("a", 9, 9, 150).sig());
            reg.put("b", want.get(0).sig());
            TreasurePlan.Result r = TreasurePlan.plan(reg, want, set());
            check("混合：撤 a", r.remove.equals(Arrays.asList("a")));
            check("混合：只挂 c（b 已挂着）", ids(r.add).equals(set("c")));
        }
        // ── 坐标/半径变了：先撤再挂 ──
        {
            Map<String, String> reg = new HashMap<>();
            reg.put("a", L("a", 31.2, 121.5, 150).sig());
            List<TreasurePlan.Letter> moved = TreasurePlan.normalize(Arrays.asList(L("a", 31.2001, 121.5, 150)));
            TreasurePlan.Result r = TreasurePlan.plan(reg, moved, set());
            check("挪了位置 → 撤 a 再挂 a", r.remove.equals(Arrays.asList("a")) && ids(r.add).equals(set("a")));
            List<TreasurePlan.Letter> wider = TreasurePlan.normalize(Arrays.asList(L("a", 31.2, 121.5, 300)));
            TreasurePlan.Result r2 = TreasurePlan.plan(reg, wider, set());
            check("改了半径 → 撤 a 再挂 a", r2.remove.equals(Arrays.asList("a")) && ids(r2.add).equals(set("a")));
        }
        // ── 通知过的：不挂；挂着的要撤 ──
        {
            List<TreasurePlan.Letter> want = TreasurePlan.normalize(Arrays.asList(L("a", 1.5, 2.5, 150), L("b", 3.5, 4.5, 150)));
            TreasurePlan.Result r = TreasurePlan.plan(new HashMap<>(), want, set("a"));
            check("通知过的 a 不再挂", ids(r.add).equals(set("b")));
            Map<String, String> reg = new HashMap<>();
            reg.put("a", want.get(0).sig());
            TreasurePlan.Result r2 = TreasurePlan.plan(reg, want, set("a"));
            check("通知过还挂着的 a → 撤", r2.remove.equals(Arrays.asList("a")) && ids(r2.add).equals(set("b")));
        }
        // ── normalize：脏数据 ──
        {
            List<TreasurePlan.Letter> n = TreasurePlan.normalize(Arrays.asList(
                    L("", 1.5, 2.5, 150),            // 空 id
                    null,
                    L("nan", Double.NaN, 2, 150),
                    L("far", 95, 2, 150),            // 纬度越界
                    L("zero", 0, 0, 150),            // 前端没取到坐标
                    L("dup", 1.5, 2.5, 150),
                    L("dup", 7.5, 8.5, 150),         // 重复 id 留第一条
                    L("tiny", 1.5, 2.5, 5),          // 半径太小
                    L("huge", 1.5, 2.5, 999999)));   // 半径太大
            check("normalize 只留 dup/tiny/huge", ids(n).equals(set("dup", "tiny", "huge")) && n.size() == 3);
            check("重复 id 留第一条", n.get(0).lat == 1.5);
            check("半径下限 30", n.get(1).radius == TreasurePlan.MIN_RADIUS);
            check("半径上限 5000", n.get(2).radius == TreasurePlan.MAX_RADIUS);
            check("normalize(null) = 空", TreasurePlan.normalize(null).isEmpty());
        }
        // ── 签名跟 Locale 无关 ──
        {
            java.util.Locale old = java.util.Locale.getDefault();
            java.util.Locale.setDefault(java.util.Locale.GERMANY);   // 德语小数点是逗号
            String s = L("a", 31.5, 121.25, 150).sig();
            java.util.Locale.setDefault(old);
            check("sig 不受 Locale 影响", s.equals("31.5,121.25,150"));
        }

        System.out.println(fail == 0
                ? "TreasurePlanTest: " + pass + " 条全部通过"
                : "TreasurePlanTest: " + fail + " 条失败 / " + (pass + fail));
        System.exit(fail == 0 ? 0 : 1);
    }
}
