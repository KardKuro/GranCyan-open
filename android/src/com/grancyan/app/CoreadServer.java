package com.grancyan.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.Uri;
import fi.iki.elonen.NanoHTTPD;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Coread 阅读功能的内置服务器
 * 在 localhost:8080 提供书架、章节、批注等功能
 */
public class CoreadServer extends NanoHTTPD {

    private final Context context;
    private final DBHelper dbHelper;

    public CoreadServer(Context context) {
        super(8080);
        this.context = context;
        this.dbHelper = new DBHelper(context);
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Method method = session.getMethod();

        try {
            // 路由：书架页面
            if ("/reading".equals(uri)) {
                return serveBookshelf();
            }

            // 路由：书籍目录
            if (uri.matches("/reading/book/[^/]+")) {
                String bookId = uri.substring("/reading/book/".length());
                return serveBookToc(bookId);
            }

            // 路由：章节内容
            if (uri.matches("/reading/book/[^/]+/chapter/\\d+")) {
                String[] parts = uri.split("/");
                String bookId = parts[3];
                int chapterNum = Integer.parseInt(parts[5]);
                return serveChapter(bookId, chapterNum);
            }

            // API：手动批注
            if ("/api/annotate".equals(uri) && Method.POST.equals(method)) {
                return handleAnnotate(session);
            }

            // Android 独立点歌：页面在 App 里时走这个本机代理，不再要求电脑开着 server.js。
            if ("/api/music/search".equals(uri)) return musicSearch(session);
            if ("/api/music/url".equals(uri)) return musicUrl(session);
            if ("/api/music/pick".equals(uri)) return musicPick(session);
            if ("/api/music/lyric".equals(uri)) return musicLyric(session);

            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404 Not Found");

        } catch (Exception e) {
            e.printStackTrace();
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain",
                "500 Internal Server Error: " + e.getMessage());
        }
    }

    // 书架页面
    private Response serveBookshelf() {
        StringBuilder html = new StringBuilder();
        html.append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">");
        html.append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
        html.append("<title>书架</title>");
        html.append("<style>");
        html.append(getCSS());
        html.append("</style></head><body>");
        // 右上角 ✕：MainActivity 把根路径接回 App 主界面并带上 #widgets，回到小组件
        html.append("<a class=\"x\" href=\"/#widgets\" title=\"关闭\" aria-label=\"关闭\">✕</a>");
        html.append("<div class=\"wrap\">");
        html.append("<h1>📚 书架</h1>");
        html.append("<p class=\"sub\">falling in love on the same page</p>");

        // 查询所有书籍
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        Cursor cursor = db.rawQuery(
            "SELECT id, title, author, last_chapter, last_read_at FROM books ORDER BY last_read_at DESC",
            null
        );

        if (cursor.getCount() == 0) {
            html.append("<p style=\"color:var(--faint);margin-top:40px;text-align:center;line-height:2\">");
            html.append("这里是离线书架，还没有书<br>");
            html.append("<small style=\"font-size:12px\">导入方式：用文件管理器打开 .epub 文件，选择用 Grancyan 打开<br>");
            html.append("或在设置里填电脑的服务器地址，即可使用电脑端完整书架（可直接上传 epub）</small></p>");
        } else {
            html.append("<ul class=\"plain\">");
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String title = cursor.getString(1);
                String author = cursor.getString(2);
                int lastChapter = cursor.getInt(3);

                html.append("<li><a href=\"/reading/book/").append(esc(id)).append("\" class=\"row\">");
                html.append(esc(title));
                if (author != null && !author.isEmpty()) {
                    html.append(" <small>").append(esc(author)).append("</small>");
                }
                if (lastChapter > 0) {
                    html.append(" <small>读到第 ").append(lastChapter).append(" 章</small>");
                }
                html.append("</a></li>");
            }
            html.append("</ul>");
        }
        cursor.close();

        html.append("</div>").append(accentSync()).append("</body></html>");

        return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", html.toString());
    }

    // 书籍目录
    private Response serveBookToc(String bookId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();

        // 查询书籍信息
        Cursor bookCursor = db.rawQuery("SELECT title, author FROM books WHERE id=?", new String[]{bookId});
        if (!bookCursor.moveToFirst()) {
            bookCursor.close();
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "书籍不存在");
        }
        String title = bookCursor.getString(0);
        String author = bookCursor.getString(1);
        bookCursor.close();

        StringBuilder html = new StringBuilder();
        html.append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">");
        html.append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
        html.append("<title>").append(esc(title)).append("</title>");
        html.append("<style>").append(getCSS()).append("</style></head><body>");
        html.append("<div class=\"wrap\">");
        html.append("<a href=\"/reading\" class=\"back\">← 返回书架</a>");
        html.append("<h1>").append(esc(title)).append("</h1>");
        if (author != null && !author.isEmpty()) {
            html.append("<p class=\"sub\">").append(esc(author)).append("</p>");
        }

        // 查询章节列表
        Cursor chapterCursor = db.rawQuery(
            "SELECT chapter_num, title FROM chapters WHERE book_id=? ORDER BY chapter_num",
            new String[]{bookId}
        );

        if (chapterCursor.getCount() == 0) {
            html.append("<p style=\"color:var(--faint);margin-top:20px\">暂无章节</p>");
        } else {
            html.append("<ul class=\"plain\">");
            while (chapterCursor.moveToNext()) {
                int chapterNum = chapterCursor.getInt(0);
                String chapterTitle = chapterCursor.getString(1);
                html.append("<li><a href=\"/reading/book/").append(esc(bookId))
                    .append("/chapter/").append(chapterNum).append("\" class=\"row\">");
                html.append("第 ").append(chapterNum).append(" 章");
                if (chapterTitle != null && !chapterTitle.isEmpty()) {
                    html.append(" · ").append(esc(chapterTitle));
                }
                html.append("</a></li>");
            }
            html.append("</ul>");
        }
        chapterCursor.close();

        html.append("</div>").append(accentSync()).append("</body></html>");

        return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", html.toString());
    }

    // 章节内容（简化版，暂不支持批注嵌入）
    private Response serveChapter(String bookId, int chapterNum) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();

        // 查询书籍信息
        Cursor bookCursor = db.rawQuery("SELECT title FROM books WHERE id=?", new String[]{bookId});
        if (!bookCursor.moveToFirst()) {
            bookCursor.close();
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "书籍不存在");
        }
        String bookTitle = bookCursor.getString(0);
        bookCursor.close();

        // 查询章节内容
        Cursor chapterCursor = db.rawQuery(
            "SELECT title, content FROM chapters WHERE book_id=? AND chapter_num=?",
            new String[]{bookId, String.valueOf(chapterNum)}
        );

        if (!chapterCursor.moveToFirst()) {
            chapterCursor.close();
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "章节不存在");
        }

        String chapterTitle = chapterCursor.getString(0);
        String content = chapterCursor.getString(1);
        chapterCursor.close();

        StringBuilder html = new StringBuilder();
        html.append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">");
        html.append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
        html.append("<title>").append(esc(chapterTitle)).append("</title>");
        html.append("<style>").append(getCSS()).append("</style></head><body>");
        html.append("<div class=\"wrap\">");
        html.append("<a href=\"/reading/book/").append(esc(bookId)).append("\" class=\"back\">← 目录</a>");
        html.append("<h1>").append(esc(chapterTitle != null ? chapterTitle : "第 " + chapterNum + " 章")).append("</h1>");
        html.append("<p class=\"sub\">").append(esc(bookTitle)).append("</p>");

        // 章节正文
        html.append("<div class=\"content\">");
        html.append(esc(content != null ? content : "（内容为空）"));
        html.append("</div>");

        // 上一章/下一章导航
        html.append("<div class=\"nav\">");
        if (chapterNum > 1) {
            html.append("<a href=\"/reading/book/").append(esc(bookId))
                .append("/chapter/").append(chapterNum - 1).append("\">← 上一章</a>");
        } else {
            html.append("<span></span>");
        }
        html.append("<a href=\"/reading/book/").append(esc(bookId))
            .append("/chapter/").append(chapterNum + 1).append("\">下一章 →</a>");
        html.append("</div>");

        html.append("</div>").append(accentSync()).append("</body></html>");

        return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", html.toString());
    }

    // 处理批注 API（简化版）
    private Response handleAnnotate(IHTTPSession session) {
        // TODO: 解析 POST body 并保存批注
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"success\":true}");
    }

    private String param(IHTTPSession session, String name) {
        Map<String, List<String>> ps = session.getParameters();
        List<String> values = ps.get(name);
        return values == null || values.isEmpty() ? "" : values.get(0).trim();
    }

    private Response musicJson(JSONObject body) {
        Response r = newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", body.toString());
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Cache-Control", "no-store");
        return r;
    }

    private String musicGet(String rawUrl, boolean followRedirects) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try { return musicGetOnce(rawUrl, followRedirects); }
            catch (IOException e) {
                last = e;
                if (attempt == 0) try { Thread.sleep(250); } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        throw last;
    }

    private String musicGetOnce(String rawUrl, boolean followRedirects) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(rawUrl).openConnection();
        c.setInstanceFollowRedirects(followRedirects);
        c.setConnectTimeout(12000);
        c.setReadTimeout(12000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36");
        c.setRequestProperty("Referer", "https://music.163.com/");
        c.setRequestProperty("Accept-Encoding", "identity");
        int code = c.getResponseCode();
        if (!followRedirects && code >= 300 && code < 400) return c.getHeaderField("Location");
        InputStream in = code >= 200 && code < 400 ? c.getInputStream() : c.getErrorStream();
        String out = in == null ? "" : readStream(in);
        if (in != null) in.close();
        c.disconnect();
        if (code < 200 || code >= 400) throw new IOException("HTTP " + code);
        return out;
    }

    private JSONArray neteaseSearch(String q, int limit) throws Exception {
        String u = "https://music.163.com/api/cloudsearch/pc?s=" + URLEncoder.encode(q, "UTF-8")
            + "&type=1&offset=0&limit=" + Math.max(1, Math.min(limit, 30));
        JSONObject root = new JSONObject(musicGet(u, true));
        JSONArray src = root.optJSONObject("result") == null ? new JSONArray()
            : root.optJSONObject("result").optJSONArray("songs");
        JSONArray songs = new JSONArray();
        if (src == null) return songs;
        for (int i = 0; i < src.length(); i++) {
            JSONObject s = src.optJSONObject(i); if (s == null) continue;
            JSONArray ar = s.optJSONArray("ar");
            StringBuilder artist = new StringBuilder();
            if (ar != null) for (int k = 0; k < ar.length(); k++) {
                String name = ar.optJSONObject(k) == null ? "" : ar.optJSONObject(k).optString("name");
                if (!name.isEmpty()) { if (artist.length() > 0) artist.append('/'); artist.append(name); }
            }
            JSONObject al = s.optJSONObject("al");
            String cover = al == null ? "" : al.optString("picUrl", "");
            if (cover.startsWith("http:")) cover = "https:" + cover.substring(5);
            if (!cover.isEmpty()) cover += "?param=200y200";
            songs.put(new JSONObject().put("id", s.optLong("id")).put("name", s.optString("name"))
                .put("artist", artist.length() == 0 ? "未知" : artist.toString())
                .put("album", al == null ? "" : al.optString("name", ""))
                .put("cover", cover).put("duration", s.optLong("dt")));
        }
        return songs;
    }

    private String neteaseUrl(String id) {
        try {
            String loc = musicGet("https://music.163.com/song/media/outer/url?id="
                + URLEncoder.encode(id, "UTF-8") + ".mp3", false);
            if (loc == null || loc.contains("/404") || !loc.toLowerCase().contains(".mp3")) return "";
            return loc.replaceFirst("^http://", "https://");
        } catch (Exception e) { return ""; }
    }

    private Response musicSearch(IHTTPSession session) throws Exception {
        String q = param(session, "q");
        int limit = 12; try { limit = Integer.parseInt(param(session, "limit")); } catch (Exception ignored) {}
        return musicJson(new JSONObject().put("songs", neteaseSearch(q, limit)));
    }

    private Response musicUrl(IHTTPSession session) throws Exception {
        String url = neteaseUrl(param(session, "id"));
        return musicJson(new JSONObject().put("url", url).put("playable", !url.isEmpty()));
    }

    private Response musicPick(IHTTPSession session) throws Exception {
        JSONArray songs = neteaseSearch(param(session, "q"), 10);
        JSONObject chosen = null; String url = "";
        for (int i = 0; i < Math.min(6, songs.length()); i++) {
            JSONObject song = songs.getJSONObject(i);
            String candidate = neteaseUrl(String.valueOf(song.optLong("id")));
            if (!candidate.isEmpty()) { chosen = song; url = candidate; break; }
        }
        if (chosen == null && songs.length() > 0) chosen = songs.getJSONObject(0);
        return musicJson(new JSONObject().put("song", chosen == null ? JSONObject.NULL : chosen).put("url", url));
    }

    // ⚠️ 这个接口和 server.js 的 /api/music/lyric 必须给出同一份字段：
    //    手机独立跑的时候走这里，连着电脑的时候走 server.js。少给一个字段，
    //    表现就是"电脑上有逐字歌词、手机上没有"，而且两边都不报错。
    //    yv=逐字 YRC，ytv/yrv=逐字版的翻译和罗马音，tv/rv=行级那份。
    private Response musicLyric(IHTTPSession session) throws Exception {
        String id = URLEncoder.encode(param(session, "id"), "UTF-8");
        JSONObject src = new JSONObject(musicGet(
                "https://music.163.com/api/song/lyric?id=" + id + "&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1", true));
        return musicJson(new JSONObject()
                .put("lyric",     lyricField(src, "lrc"))
                .put("tlyric",    lyricField(src, "tlyric"))
                .put("romalrc",   lyricField(src, "romalrc"))
                .put("yrc",       lyricField(src, "yrc"))
                .put("ytlrc",     lyricField(src, "ytlrc"))
                .put("yromalrc",  lyricField(src, "yromalrc"))
                .put("pureMusic", src.optBoolean("pureMusic", false)
                        || (src.optJSONObject("lrc") != null && src.optJSONObject("lrc").optBoolean("pureMusic", false))
                        || (src.optJSONObject("yrc") != null && src.optJSONObject("yrc").optBoolean("pureMusic", false))));
    }

    private String lyricField(JSONObject src, String key) {
        JSONObject o = src.optJSONObject(key);
        return o == null ? "" : o.optString("lyric", "");
    }

    // HTML 转义
    private String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    // 重点色同步（与电脑端 coread/routes/reader.js 的 ACCENT_SYNC 同一套）：
    // 主程序在 grancyan.app、这台内置书架在 localhost:8080，两个源、localStorage 不互通，
    // 所以颜色由主程序挂在 ?acc= 上带进来（MainActivity 转发 /reading 时会保留 query），
    // 落进本源 localStorage，之后翻目录/章节都还在。
    private String accentSync() {
        return "<script>(function(){"
             + "var OK=/^#[0-9a-fA-F]{6}$/;"
             + "function paint(c){if(!c||!OK.test(c))return false;"
             + "var R=parseInt(c.slice(1,3),16),G=parseInt(c.slice(3,5),16),B=parseInt(c.slice(5,7),16),"
             + "s=document.documentElement.style;s.setProperty('--acc',c);"
             + "s.setProperty('--hl','rgba('+R+','+G+','+B+',.2)');return true}"
             + "var u=null;try{u=new URLSearchParams(location.search).get('acc')}catch(x){}"
             + "if(u&&OK.test(u)){paint(u);try{localStorage.setItem('coread_acc',u)}catch(x){}return}"
             + "try{paint(localStorage.getItem('coread_acc'))}catch(x){}"
             + "})()</script>";
    }

    // CSS 样式（与电脑端 coread/routes/reader.js 保持一致：固定深色；强调色由 accentSync() 覆盖）
    private String getCSS() {
        return "*{margin:0;padding:0;box-sizing:border-box}" +
               ":root{--bg:#0f0f18;--tx:#e4e4f0;--soft:rgba(228,228,240,.66);--faint:rgba(228,228,240,.4);" +
               "--line:rgba(255,255,255,.07);--card:rgba(255,255,255,.06);--acc:#6366f1;--hl:rgba(99,102,241,.22)}" +
               ":root{color-scheme:dark}" +
               "body{font-family:'Cormorant Garamond',SimSun,STSong,'Noto Serif SC',serif;" +
               "background:var(--bg);color:var(--tx);min-height:100vh;padding-bottom:70px}" +
               ".wrap{max-width:660px;margin:0 auto;padding:28px 20px}" +
               "a{color:inherit;text-decoration:none}" +
               "h1{font-size:22px;font-weight:400;letter-spacing:1px;margin-bottom:4px}" +
               ".sub{font-size:13px;color:var(--faint);font-style:italic;margin-bottom:24px}" +
               ".back{display:inline-block;font-size:13px;color:var(--faint);margin-bottom:16px}" +
               ".x{position:fixed;top:12px;right:14px;z-index:10;width:34px;height:34px;display:grid;place-items:center;" +
               "border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--faint);font-family:sans-serif;font-size:15px}" +
               "ul.plain{list-style:none}" +
               ".row{display:block;padding:12px 4px;border-bottom:1px solid var(--line);font-size:15px}" +
               ".row small{color:var(--faint);margin-left:8px;font-size:12px}" +
               ".content{font-size:16.5px;line-height:1.9;white-space:pre-wrap;margin:20px 0}" +
               ".hl-user{background:var(--hl);border-radius:6px;padding:.06em 2px;cursor:pointer;" +
               "-webkit-box-decoration-break:clone;box-decoration-break:clone}" +
               ".hl-ai{border-bottom:1.5px solid var(--acc);padding-bottom:1px;cursor:pointer;" +
               "-webkit-box-decoration-break:clone;box-decoration-break:clone}" +
               ".nav{display:flex;justify-content:space-between;margin-top:32px;padding-top:16px;" +
               "border-top:1px solid var(--line);font-size:13px;color:var(--soft)}" +
               ".nav a{padding:8px 16px;border:1px solid var(--line);border-radius:8px;transition:all 0.2s}" +
               ".nav a:hover{background:var(--card);border-color:var(--soft)}";
    }

    // 导入 EPUB 文件（简化版：只提取标题和章节文本）
    public void importEpub(Uri uri) {
        try {
            InputStream inputStream = context.getContentResolver().openInputStream(uri);
            if (inputStream == null) {
                android.util.Log.e("CoreadServer", "无法打开文件: " + uri);
                return;
            }

            String bookId = UUID.randomUUID().toString();
            String bookTitle = "未命名书籍";
            String author = "";
            int chapterNum = 0;

            // 解析 EPUB（ZIP 格式）
            ZipInputStream zipIn = new ZipInputStream(inputStream);
            ZipEntry entry;

            while ((entry = zipIn.getNextEntry()) != null) {
                String name = entry.getName();

                // 提取 .html/.xhtml 文件作为章节
                if ((name.endsWith(".html") || name.endsWith(".xhtml")) && !name.contains("nav.")) {
                    chapterNum++;
                    String content = readStream(zipIn);
                    // 简单提取纯文本（移除 HTML 标签）
                    String plainText = content.replaceAll("<[^>]+>", "").trim();

                    if (plainText.length() > 50) { // 过滤太短的内容
                        SQLiteDatabase db = dbHelper.getWritableDatabase();
                        db.execSQL("INSERT INTO chapters(id, book_id, chapter_num, title, content) VALUES(?,?,?,?,?)",
                            new Object[]{UUID.randomUUID().toString(), bookId, chapterNum,
                            "第 " + chapterNum + " 章", plainText.substring(0, Math.min(50000, plainText.length()))});
                    }
                }
            }

            zipIn.close();
            inputStream.close();

            // 如果成功导入章节，创建书籍记录
            if (chapterNum > 0) {
                SQLiteDatabase db = dbHelper.getWritableDatabase();
                bookTitle = uri.getLastPathSegment();
                if (bookTitle != null && bookTitle.endsWith(".epub")) {
                    bookTitle = bookTitle.substring(0, bookTitle.length() - 5);
                }
                db.execSQL("INSERT INTO books(id, title, author, last_chapter) VALUES(?,?,?,?)",
                    new Object[]{bookId, bookTitle, author, 0});
                android.util.Log.i("CoreadServer", "成功导入: " + bookTitle + " (" + chapterNum + " 章)");
            }

        } catch (Exception e) {
            android.util.Log.e("CoreadServer", "导入 EPUB 失败", e);
        }
    }

    // 读取输入流为字符串
    private String readStream(InputStream in) throws IOException {
        byte[] buffer = new byte[8192];
        StringBuilder sb = new StringBuilder();
        int len;
        while ((len = in.read(buffer)) > 0) {
            sb.append(new String(buffer, 0, len, "UTF-8"));
        }
        return sb.toString();
    }

    // SQLite 数据库帮助类
    private static class DBHelper extends SQLiteOpenHelper {
        private static final String DB_NAME = "coread.db";
        private static final int DB_VERSION = 2; // v2: 去掉示例书籍假数据

        public DBHelper(Context context) {
            super(context, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            // 创建书籍表
            db.execSQL("CREATE TABLE IF NOT EXISTS books(" +
                "id TEXT PRIMARY KEY, " +
                "title TEXT NOT NULL, " +
                "author TEXT DEFAULT '', " +
                "last_chapter INTEGER DEFAULT 0, " +
                "last_read_at TEXT DEFAULT '', " +
                "created_at TEXT DEFAULT (datetime('now','localtime')))");

            // 创建章节表
            db.execSQL("CREATE TABLE IF NOT EXISTS chapters(" +
                "id TEXT PRIMARY KEY, " +
                "book_id TEXT NOT NULL, " +
                "chapter_num INTEGER NOT NULL, " +
                "title TEXT DEFAULT '', " +
                "content TEXT DEFAULT '', " +
                "digest TEXT DEFAULT '')");

            // 创建批注表
            db.execSQL("CREATE TABLE IF NOT EXISTS annotations(" +
                "id TEXT PRIMARY KEY, " +
                "book_id TEXT NOT NULL, " +
                "chapter_num INTEGER NOT NULL, " +
                "original_text TEXT DEFAULT '', " +
                "annotation TEXT NOT NULL, " +
                "annotator TEXT NOT NULL, " +
                "created_at TEXT DEFAULT (datetime('now','localtime')))");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            // 简单处理：删除旧表重建
            db.execSQL("DROP TABLE IF EXISTS books");
            db.execSQL("DROP TABLE IF EXISTS chapters");
            db.execSQL("DROP TABLE IF EXISTS annotations");
            onCreate(db);
        }
    }
}
