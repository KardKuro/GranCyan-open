// ============================================================
// 部署配置 —— 自己部署时只需要改这一个文件
// ============================================================
// 全部留空 = 纯本机模式：不弹登录墙，云同步、云端表情收藏、分享链接、藏宝地图上云这些功能安静地不出现，
// 其余功能照常。想要多设备同步就建一个自己的 Supabase 项目，把下面两项填上
// （建表脚本在 docs/*.sql；anon key 本来就是给前端公开用的，不是密钥）。
//
// 电脑端 server（server.js）那侧另外从环境变量 / 项目根目录的 .env 读同名配置：
//   SUPABASE_URL=https://<你的项目>.supabase.co
//   SUPABASE_ANON_KEY=eyJ...
// 两边填同一个项目。
var GRANCYAN_CONFIG = {
    // Supabase 项目地址，形如 https://abcdefghijklmnop.supabase.co
    supabaseUrl: '',
    // Supabase 项目的 anon（public）key
    supabaseAnonKey: '',
    // 分享对话的查看页地址（以 / 结尾），链接会拼成 <sharePageUrl>#<id>。
    // 查看页是一个只调 get_share(id) 的静态页（见 docs/shares.sql）。留空 = 点分享时只提示未配置。
    sharePageUrl: '',
    // 施工单（js/64-build.js）让 Claude Code 去哪个目录改代码（电脑上的绝对路径）。留空 = 电脑端 server 自己的项目目录。
    buildCwd: '',
};
