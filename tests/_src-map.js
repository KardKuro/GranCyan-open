// tests/_src-map.js
// 断言源码映射表：拆分（见 docs/server-split-plan.md）用的基础设施之一。
//
// 问题：26 个正则断言测试现在全都直接 `fs.readFileSync(server.js)` 硬编码路径。
// 业务代码一旦真的搬进 server/xxx.js，这些测试的"读哪个文件"要跟着改，
// 而且**一个逻辑区可能落在不止一个文件里**（比如调用点留在 server.js、
// 定义搬进新模块）——这正是 Codex 建议 #10 点名要支持的形状。
//
// 用法：
//   const { srcOf, readSrc } = require('./_src-map');
//   srcOf('doctor')   // -> ['<root>/server.js', '<root>/server/doctor-registry.js', '<root>/server/band.js']（绝对路径数组）
//   readSrc('doctor') // -> [{file:'server.js', text:'...'}, {file:'server/doctor-registry.js', text:'...'}, {file:'server/band.js', text:'...'}]
//
// readSrc 不做拼接——每个文件各自一条 {file, text}。要在多个文件上跑正则，
// 分别对每条 text 跑，或者按逻辑（求和/任一命中）显式组合结果，**不要
// `parts.map(p=>p.text).join('')` 再跑一条正则**：拼接会制造运行时不存在的
// 相邻关系，测试变绿但保障变弱（docs/server-split-plan.md Phase 0 第 3 步原话）。
// 跨"定义—调用"两端的断言，正确做法是拆成两条，分别查各自的逻辑名
// （例子见 docs/assertion-migration-map.md「跨边界断言清单」）。
//
// 约定：搬一块业务代码，就在下面的 MAP 里改一行对应的路径数组。
// 现有 14 个正则断言测试暂时不改用 srcOf——迁去用它是每次搬块时顺手做的事，
// 不是这次基础设施改造的范围。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 逻辑名 -> 文件路径数组（相对 ROOT）。
// doctor 是多文件条目——server/doctor-registry.js 是取状态的注册器（Phase 0.5
// 第 1 步落地）；各分区的 registerDoctorCheck 调用点原来都在 server.js，
// 分区搬家时调用点跟着搬走，就得把新文件也加进 doctor 的数组——band 是第一个
// （server/band.js，Phase 1 第 3 块）：band 检查的定义现在只在那个文件里，
// doctor 断言要能看到它就必须看那个文件，不能只看 server.js。
// claude/nursery/engawa 三个检查点还留在 server.js，之后各自的分区
// 搬家时依样把对应文件加进这个数组。
const MAP = {
  music:      ['server/music.js'],
  ipa:        ['server/ipa.js'],
  band:       ['server/band.js'],
  video:      ['server/media.js'],
  cloud:      ['server/cloud.js'],
  stickers:   ['server.js'],
  'local-ai': ['server.js'],
  engawa:     ['server.js'],
  social:     ['server.js'],
  doctor:     ['server.js', 'server/doctor-registry.js', 'server/band.js'],
};

// 传逻辑区名，返回它当前映射到的文件绝对路径数组。
function srcOf(name) {
  const files = MAP[name];
  if (!files) {
    throw new Error(`_src-map: 没有 "${name}" 这个逻辑名 —— 先在 tests/_src-map.js 的 MAP 里登记`);
  }
  return files.map(f => path.join(ROOT, f));
}

// 传逻辑区名，把映射到的每个文件各自读出，返回 [{file, text}]（不拼接）。
function readSrc(name) {
  return srcOf(name).map(abs => ({
    file: path.relative(ROOT, abs).split(path.sep).join('/'),
    text: fs.readFileSync(abs, 'utf8'),
  }));
}

// 单文件断言的正道：映射不是恰好一个文件就当场炸，防止有人抄 readSrc(name)[0]
// ——那种写法在条目将来变多文件时会静默忽略其余文件（Codex 二轮建议 #5）。
function readSingleSrc(name) {
  const parts = readSrc(name);
  if (parts.length !== 1) {
    throw new Error(`_src-map: "${name}" 映射了 ${parts.length} 个文件，readSingleSrc 只服务单文件条目 —— ` +
      `多文件请用 readSrc 并对每个文件分别断言（别取 [0]，也别拼接）`);
  }
  return parts[0];
}

module.exports = { srcOf, readSrc, readSingleSrc };
