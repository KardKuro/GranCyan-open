// models.js — 书架用哪个模型。
//
// 为什么要在服务端存一份：书架的聊天/批注/摘要都是服务端发起的（SSE 全链路见 chat.js），
// 服务端得自己有能力调模型；而手机上主程序在 grancyan.app、书架在电脑 server 的 IP，
// 两个源，书架页读不到主程序 IndexedDB 里的 state.configs。所以主程序把配置推过来存下。
// 表里带 api_key —— 用户自己的机器，且这些 key 本来就已经跟着 settings 同步到 Supabase 了。
//
// 也可以不靠主程序推：直接往 reading_models 表里手填一行，effect 一样。

// 本地 Claude 的模型号（与主程序 index.html 的下拉框保持一致）
const LOCAL_MODELS = [
  ['', '默认 (Sonnet)'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-sonnet-4-5', 'Sonnet 4.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
];

const SEL_KEY = 'selected_model';

function kvGet(db, k) {
  try { const r = db.prepare('SELECT v FROM reading_kv WHERE k=?').get(k); return r ? r.v : ''; }
  catch (e) { return ''; }
}
function kvSet(db, k, v) {
  db.prepare('INSERT INTO reading_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v || ''));
}

// 主程序推来的 state.configs → 整表替换。key 为空的配置也存（本地 Claude 本来就不需要 key）。
function replaceModels(db, configs) {
  const rows = (configs || []).filter((c) => c && c.id != null);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM reading_models').run();
    rows.forEach((c, i) => {
      db.prepare(`INSERT INTO reading_models
        (id,nickname,model_name,api_base,api_key,local_model,is_local,temp,max_tokens,sort)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        String(c.id), String(c.nickname || ''), String(c.modelName || ''),
        String(c.apiBase || ''), String(c.apiKey || ''), String(c.localModel || ''),
        c.isLocalClaude ? 1 : 0, Number(c.temp) || 0.7, Number(c.maxReplyTokens) || 0, i
      );
    });
  });
  tx();
  return rows.length;
}

// 下拉框选项。本地 Claude 那条展开成各个模型号；其余一条一个。绝不带 api_key 出门。
function listOptions(db) {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM reading_models ORDER BY sort').all(); } catch (e) {}
  const opts = [];
  for (const r of rows) {
    if (r.is_local) {
      for (const [v, label] of LOCAL_MODELS) {
        opts.push({ key: r.id + '|' + v, label: (r.nickname || '订阅 Claude') + ' · ' + label });
      }
    } else {
      opts.push({ key: r.id + '|', label: r.nickname + (r.model_name ? '（' + r.model_name + '）' : '') + (r.api_key ? '' : ' ⚠未填key') });
    }
  }
  // 主程序还没推过配置：至少给一个能用的本地 Claude
  if (!opts.length) opts.push({ key: '|', label: '订阅 Claude · 默认 (Sonnet)' });
  return opts;
}

// key → 真正能拿去调的配置。key 形如 "<configId>|<localModel>"。
// 解析不出来就退回本地 Claude 默认——书架永远有得聊，不会因为选了个坏配置就哑掉。
function resolve(db, key) {
  const fallback = { isLocal: true, localModel: '', label: '订阅 Claude · 默认' };
  const k = String(key || '');
  const i = k.indexOf('|');
  if (i < 0) return fallback;
  const id = k.slice(0, i), localModel = k.slice(i + 1);
  if (!id) return { ...fallback, localModel };

  let r = null;
  try { r = db.prepare('SELECT * FROM reading_models WHERE id=?').get(id); } catch (e) {}
  if (!r) return fallback;
  if (r.is_local) return { isLocal: true, localModel, label: (r.nickname || '订阅 Claude') };
  if (!r.api_key) return fallback; // 没 key 调不动，别让书架报错，退本地
  return {
    isLocal: false,
    label: r.nickname || r.model_name,
    modelName: r.model_name,
    apiBase: r.api_base,
    apiKey: r.api_key,
    temp: r.temp,
    maxTokens: r.max_tokens,
  };
}

function getSelectedKey(db) { return kvGet(db, SEL_KEY); }
function setSelectedKey(db, key) { kvSet(db, SEL_KEY, key); }

// 书架当前该用的模型配置
function current(db) { return resolve(db, getSelectedKey(db)); }

module.exports = { LOCAL_MODELS, replaceModels, listOptions, resolve, getSelectedKey, setSelectedKey, current };
