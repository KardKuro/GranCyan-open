const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', '24-music.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'android', 'assets', 'js', '24-music.js'));
const helpers = source.slice(source.indexOf('function musicSearchNorm('), source.indexOf('async function musicPick('));
let failed = 0;
function check(name, yes) {
  console.log(`  ${yes ? '✓' : '✗'} ${name}`);
  if (!yes) failed++;
}

(async () => {
  let requested = '';
  const fetch = async url => {
    requested = url;
    return { ok: true, json: async () => ({ results: [
      { kind: 'song', trackName: '和你一起的旅行', artistName: '艾索', trackViewUrl: 'https://music.apple.com/song/1', previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a' },
      { kind: 'song', trackName: '和你一起的旅行', artistName: '别人', trackViewUrl: 'https://music.apple.com/song/2' },
    ] }) };
  };
  const api = new Function('fetch', helpers + '\nreturn { musicSearchHasMatch, musicSearchApple };')(fetch);
  const q = '艾索 和你一起的旅行';
  check('网易云无匹配时识别缺曲', !api.musicSearchHasMatch(q, [{ name: '一起的旅行', artist: 'Zean' }]));
  const songs = await api.musicSearchApple(q);
  check('Apple Music 用歌名搜索并过滤歌手', requested.includes('term=%E5%92%8C%E4%BD%A0%E4%B8%80%E8%B5%B7%E7%9A%84%E6%97%85%E8%A1%8C') && songs.length === 1 && songs[0].artist === '艾索');
  check('网易云没有艾索的目标曲时会查询外部目录', source.includes('if (!musicSearchHasMatch(q, _mResults))'));
  check('外部条目明确标注试听和完整曲入口', source.includes('Apple Music · 官方试听') && source.includes('在 Apple Music 打开完整版'));
  check('音乐脚本与安卓副本一致', fs.readFileSync(path.join(root, 'js', '24-music.js')).equals(android));
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
