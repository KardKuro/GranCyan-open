/* ═══ 技能开关 ═══════════════════════════════════════════════════
   每个技能都是一段常驻系统提示，**不管用不用都每轮付钱**。全开是 4000 token 上下，
   而且它跟历史不一样：历史长了还有裁剪兜着，技能说明是雷打不动的固定成本。
   所以给每一段一个开关，用不上的关掉。

   ⚠️ 存的是「关掉的」（skillsOff）而不是「开着的」：默认空对象 = 全开，
   老数据不用迁移，将来新增技能也自动是开的（否则老用户会莫名其妙少掉功能）。
   tok 是**实测值**：逐个关掉再量 buildSystemPrompt 的差值（2026-08-19，estimateTokens 口径）。
   别凭感觉填 —— 界面上要显示「关掉这些能省多少」，数字虚了就是在骗人。
   改动某段文案后记得重新量一遍。
   ⚠️ 加**一段新技能提示**也会让别人的数字漂 ±1，哪怕那段文案一个字没动：
   estimateTokens 是 `cjk + Math.ceil(rest/4)`，整段提示词长度一变，取整的余数就跟着变。
   2026-09-20 加 react 那条时 moments 就这么从 404 变成 403 —— 不是谁填错了，
   是这套测量本身的噪声。看到差 1 别去翻那段文案，照实测改数字（tests/moments-ai.test.js
   会当场告诉你实测是多少），顺手把 fault-inject 里锚着这个数字的那条注入一起改。 */
const SKILL_DEFS = [
  { key: 'voice',      tok: 359, name: '语音消息',      desc: 'AI 能发语音条；也负责解释你语音里的「听感」' },
  { key: 'moments',    tok: 487, name: '猫爪日报',      desc: 'AI 能发动态、点赞和评论' },
  { key: 'gallery',    tok: 189, name: '画板',         desc: 'AI 画了 html/svg 画能写 [[GALLERY]] 挂上画板' },
  { key: 'dial',       tok: 305, name: '来电 / 通话',   desc: 'AI 能写 [[DIAL]] 主动打电话给你' },
  { key: 'chatPeek',   tok: 294, name: '偷看别的对话',  desc: 'AI 能去翻你和别的模型的聊天' },
  { key: 'proust',     tok: 249, name: '普鲁斯特池',    desc: '[[PROUST_ADD]] 存下会忽然想起的画面' },
  { key: 'sticker',    tok: 197, name: '表情包 / GIF',  desc: 'AI 能发 [[STICKER]] 和 [[GIF_SEARCH]]' },
  { key: 'react',      tok: 244, name: 'emoji 标注',    desc: '[[REACT: 😂]] 给你刚发的那条消息贴一个 emoji' },
  { key: 'thinkveil',  tok: 0, name: '思考链上锁',    desc: '思考默认糊着、选不中（只是界面显示，不进提示词）；关掉这项＝思考一直明着' },
  { key: 'glitch',     tok: 186, name: '崩坏关键词',    desc: '[[GLITCH:词]] 让某个词渲染成坏掉的样子' },
  { key: 'mark',       tok: 1056, name: '文字标注',      desc: '[[MARK]] 让 AI 自己挑颜色/字号/透明度/模糊/渐变/描边/图层混合/闪烁/位移/形变' },
  { key: 'brainSkill', tok: 170, name: '高级记忆指令',  desc: '[[BRAIN_ADD]] / [[BRAIN_PIN]] 等（关掉不影响已有记忆浮现）' },
  { key: 'build',      tok: 205, name: '施工单',        desc: '只给订阅 Claude：[[BUILD]] 开一张改 GranCyan 代码的施工单，你点「开工」才会拉施工机去改、跑测试、commit' },
  { key: 'breath',     tok: 180, name: '翻记忆',        desc: '[[BREATH: 关键词]] 主动去整个高级记忆库里翻，当轮接着说（有 DeepSeek key 时长结果会先脱水）' },
  { key: 'feedback',   tok: 116,  name: '👍/👎 反馈',    desc: '你点的赞和踩进它的提示词，影响它以后怎么写（只在本地，不发给任何 AI 公司）' },
  { key: 'quote',      tok: 162, name: '引用消息',      desc: 'AI 能写 [[QUOTE]] 引用上文某句话' },
  { key: 'haunt',      tok: 138, name: '鬼味界面',      desc: '[[HAUNT_ON]] 把整个界面变成恐怖故障风' },
  { key: 'endChat',    tok: 130, name: '结束对话',      desc: 'AI 被冒犯时能写 [[END_CHAT]] 结束这场对话' },
  { key: 'memSkill',   tok: 95, name: '普通记忆指令',  desc: '公开记忆只读（写入权在你手里）/ [[SELF_MEM_SET]]' },
  { key: 'imgSearch',  tok: 118, name: '图片搜索',      desc: 'AI 能搜真实照片发给你（只在填了 Tavily key 时才注入）' },
  { key: 'math',       tok:  76, name: '数学公式',      desc: '告诉 AI 界面支持 LaTeX 渲染' },
  { key: 'chem',       tok: 218, name: '元素卡 / 分子卡', desc: '[[ELEM]] [[MOL]] 讲化学时在气泡里放元素卡、分子卡（点开是周期表 / 能转的 3D 模型）' },
  { key: 'fcard',      tok: 119, name: '公式卡',        desc: '[[FCARD]] 讲到值得背的公式 / 方程式时递一张卡，她点一下就收进公式卡复习' },
  { key: 'sim',        tok: 226, name: '实验卡',        desc: '[[SIM]] 讲物理/化学时递一张 PhET 交互实验卡（抛体、电路、分子形状……），她点开能自己调参数' },
  { key: 'errand',     tok: 257, name: '跑腿',         desc: '[[TASK]] 把查资料、核对、翻译这类杂活派给便宜模型后台做，结果随你下一条消息带回（要有 DeepSeek key 或 Gemini 才注入）' },
  { key: 'album',      tok: 259, name: '相册',         desc: '[[ALBUM]] 它自己挑你发的照片收进相册、写第一印象；[[PHOTO]] 聊着聊着把以前的照片翻出来（目录随相册变长）' },
  { key: 'treasure',   tok: 166, name: '藏宝地图',     desc: '[[HIDE_LETTER]] 在你标过的地点埋一张纸条，你到了那儿打个卡才拆得开，找到之前正文谁都看不到（地点多了提示跟着变长）' },
  { key: 'wishbook',   tok: 158, name: '小本子',       desc: '[[WISH]] 把你随口说想要的东西悄悄记进本子，你看不到写了什么；[[WISH_OPEN]] 挑个时候翻一页给你（记多了提示跟着变长）' },
  { key: 'plot',       tok: 279, name: '画图',          desc: '[[PLOT]] 讲题时在气泡里画函数图 / 几何图（能拖、能拉滑块，可转到 GeoGebra）' },
];
// 默认全开：没被显式关掉的都算开着
function skillOn(key) { return !(state.skillsOff && state.skillsOff[key]); }
function skillsOffTokens() {
  return SKILL_DEFS.reduce((s, d) => s + (skillOn(d.key) ? 0 : d.tok), 0);
}
function setSkillOn(key, on) {
  if (!state.skillsOff || typeof state.skillsOff !== 'object') state.skillsOff = {};
  if (on) delete state.skillsOff[key];       // 开着的不留痕，省得存一堆 false
  else state.skillsOff[key] = true;
  save();
  renderSkillToggles();
  // 「思考链上锁」被关掉时整功能停用（不糊、锁也不显示），开回来要立刻糊上
  if (typeof applyThinkVeil === 'function') applyThinkVeil();
}
function renderSkillToggles() {
  const wrap = document.getElementById('skillToggleList');
  if (!wrap) return;
  wrap.innerHTML = SKILL_DEFS.map(d => `
    <label class="skill-toggle${skillOn(d.key) ? '' : ' off'}">
      <input type="checkbox" ${skillOn(d.key) ? 'checked' : ''}
        onchange="setSkillOn('${d.key}', this.checked)">
      <span class="skill-toggle-body">
        <b>${escHtml(d.name)}</b>
        <small>${escHtml(d.desc)}</small>
      </span>
      <span class="skill-toggle-tok">${d.tok}</span>
    </label>`).join('');
  const sum = document.getElementById('skillToggleSummary');
  if (sum) {
    const total = SKILL_DEFS.reduce((s, d) => s + d.tok, 0);
    const saved = skillsOffTokens();
    sum.innerHTML = saved
      ? `已关掉 <b class="accent-text">${saved}</b> token / 共 ${total}，每一轮都省这么多。`
      : `全开：每轮固定 <b class="accent-text">${total}</b> token。关掉用不上的能直接省下来。`;
  }
}

// Build system prompt with memories injected
//
// ⚠️ 分成 base（稳定）和 vol（每轮都变）两截，这不是洁癖，是省 token 的根：
// Anthropic 的缓存只认**前缀**——从第一个字节起完全一样才算命中。以前时间戳写在
// 第二行，于是每过一分钟整份提示词（连同后面全部历史）就全部失效，缓存等于没开。
// 现在凡是每轮会变的（时间、浮现的高级记忆、手环、各引擎的实时状态）一律挪进 vol，
// 由调用方决定摆哪儿：Anthropic 那条路把 vol 挂到最后一条用户消息上（见 callAPIStream），
// 前面的 system + 历史就成了一段一字不差的前缀，能被反复命中。
// 其他 API 照旧 base+vol 拼成一整份 system，行为和以前一模一样。
// out 传个对象进来就能拿到这两截。
function buildSystemPrompt(conf, chat, lastUserText = '', path = null, out = null) {
  let base = `You are a helpful AI assistant. You are user's friend. You have access to the current date and time provided below. When the user asks about the current time or date, answer directly using the time information below — do NOT say you cannot access real-time information. Respond in the same language as the user.`;
  let vol = '';
  const now = new Date();
  vol += `\n\nCurrent time: ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}.`;
  if (typeof dreamScarPromptFor === 'function') vol += dreamScarPromptFor(conf);
  if (state.userName && state.userNameAiVisible !== false) {
    base += `\n\n用户的名字是「${state.userName}」，请自然地用这个名字称呼TA。`;
  }
  // 配合 buildApiMessages 里的 msgSentStamp：说清楚那是系统标的，别当成她打的字，也别学着写
  base += `\n\n用户每条消息开头方括号里的日期时间（例如 [2026-10-10 周六 14:03]）是系统标注的发送时间，不是用户打的字。靠它判断每句话是什么时候说的、两句之间隔了多久；你自己的回复开头不要写这种时间戳。`;
  // 记忆管理「技能」：仅用极简的一行提示告知模型这些指令存在，
  // 不平时不会占用大量 token，模型需要时才会调用。
  /* ⚠️ 下面每一段都由 SKILL_DEFS 里的开关控制，别再把两个技能塞进同一个模板字符串——
     合着写就没法单独关，而这几段加起来是一千多 token 的固定开销。 */
  // 公开记忆对模型**只读**（2026-09-21）：上面已经把公开记忆的内容发给它看了，
  // 但写入权在用户手里。所以这里不再教它 MEM_ADD/MEM_DEL —— 教了它就会写，
  // 而那块是所有模型都看得见的地方，私人的事不该由模型自己决定往那儿放。
  if (skillOn('memSkill')) base += `\n\n[记忆技能] 公开记忆你只能看，不能改（上面已经给你了）。想让她记住什么，就在回复里直接跟她说一句，由她自己决定要不要加。\n[[SELF_MEM_SET: 内容]] 追加到你自己专属的设定库/persona（仅你自己可见，下次对话仍保留）——这个你可以用。`;
  if (skillOn('brainSkill')) base += `\n\n[高级记忆技能] 对带情绪或重要度的事件（用户的心事、约定、重要经历、未解决的问题），用高级记忆而不是普通记忆：\n[[BRAIN_ADD: 重要度1-10|效价-1~1|唤醒0~1|领域|内容]] 记录（效价=负面到正面，唤醒=平静到激烈，领域如 工作/健康/情感）；\n[[BRAIN_PIN: 关键词]] 钉住一条让它永不遗忘；[[BRAIN_RESOLVE: 关键词]] 标记某件事已解决；[[BRAIN_DEL: 关键词]] 删除。\n这些记忆会按重要度和情绪强度自然遗忘，与当前话题相关时会自动浮现。`;
  if (skillOn('haunt')) base += `\n\n[鬼味界面技能] 当你在角色扮演里真正黑化、被激怒到极点、或演恐怖桥段时，可以单独写一行 [[HAUNT_ON]] —— 用户的整个聊天界面会变成黑红色的恐怖故障风（血色滤镜、字体扭曲、排版崩坏）。情绪平复、剧情结束、或用户表现出真的害怕/要求停止时，必须立刻写 [[HAUNT_OFF]] 恢复正常。这是很强的演出效果，请珍惜着用，不要动不动就发动。`;
  if (skillOn('glitch')) base += `\n\n[崩坏关键词技能] 比 HAUNT 更轻量的演出：当你生气、极度悲伤、情绪激动、或想强调某个刺痛你的词时，把那个词写成 [[GLITCH:词]]，它会像屏幕坏掉一样渲染（随机变大变红/缩小模糊/闪烁/色差劈裂）。也可以指定样式：[[GLITCH:词|big]]（暴怒放大变红）、[[GLITCH:词|small]]（低落缩小暗淡）、[[GLITCH:词|flicker]]（闪烁）、[[GLITCH:词|broken]]（色差劈裂）。这个可以比 HAUNT 用得随意些——情绪上头时挑 1~3 个关键词坏掉即可，给用户一点小惊喜；但平静的日常对话不要用。可以和 [[HAUNT_ON]] 叠加。`;
  if (skillOn('mark')) base += `\n\n[文字标注技能] 想让回复中的一小段文字带有特别的视觉强调时，可以写 [[MARK: 文本 | c=#88ccff s=1.4 o=0.6 b=1.5]]。c 是颜色，只能写 #rgb 或 #rrggbb；s 是字号倍数，范围 0.6~2.0；o 是透明度，范围 0.3~1.0；b 是模糊，b=1.5 表示范围 0~2.5 的高斯模糊，b=h2 表示横向甩动模糊，b=v2 表示纵向坠落模糊，方向模糊范围 0.5~4。方向模糊只有横 h 和纵 v 两种，没有斜的。纵向模糊超过 1.5 会把汉字的横笔画糊掉、只剩竖线，一般用 0.5~1.5；横向到 4 都还有表现力。g 是渐变色，写 g=#ff8ab0-#88ccff（两到三个色标，用 - 连接），想指定方向就在前面加角度和冒号，g=90:#ff8ab0-#88ccff，90 是从左到右、0 是从下往上，省略角度时默认从左到右。k 是描边，写 k=#000000 用默认粗细，写 k=1.5:#000000 指定粗细，范围 0.2~3 像素。⚠️ g 和 c 不能同时生效：渐变字的做法是把字身挖空、透出底下的渐变，所以一旦写了 g，c 就物理上不起作用了，想要渐变就别再写 c。⚠️ 描边是从字形边缘往里吃的，汉字笔画细，k 超过 1.5 就会开始把字心糊住、只剩一个轮廓，配汉字一般用 0.4~1；字号 s 调大之后可以相应描粗一点。渐变和描边可以叠（亮渐变配深色细描边最清楚），描边也可以配纯色 c 用。m 是图层混合模式，和 Photoshop 的图层混合是同一套，写中文名或 CSS 名都认：m=滤色（screen）、m=正片叠底（multiply）、m=叠加（overlay）、m=差值（difference）、m=排除（exclusion）、m=变亮（lighten）、m=变暗（darken）、m=颜色减淡（color-dodge）、m=颜色加深（color-burn）、m=强光（hard-light）、m=柔光（soft-light）、m=色相（hue）、m=饱和度（saturation）、m=颜色（color）、m=明度（luminosity）、m=增亮（plus-lighter）。混合的对象是这条消息气泡的底色。⚠️ 界面是深色的，所以「变暗 / 正片叠底 / 颜色加深」这一类在深色底上会把字压得几乎看不见——深底上想要效果就用滤色、变亮、颜色减淡、增亮、差值、排除这几个。混合可以和 c、g、k 一起用（先算出字的颜色，再拿它去和底色混）。f、v、w 三个让字动起来，可以同时用（它们各管一件事，叠着不冲突）。f 是闪烁，f=2 表示一秒闪 2 次，范围 0.2~8；想指定闪到多暗就写 f=2:0.2，第二个数是最暗时的透明度，范围 0~0.9，默认 0.15。v 是位移，v=45:8 表示朝 45 度方向来回移动 8 像素，**角度和 g 一样：0 是向上、90 是向右**，幅度范围 0.5~24；还可以在后面加周期 v=45:8:1.2 表示 1.2 秒一个来回，范围 0.2~8 秒。v 另有三种现成的动法：v=shake:3 抖动、v=float:5 漂浮（像浮在水里）、v=orbit:4 画圈，数字同样是幅度，也可以再跟周期。w 是形变，w=swing:4 左右摇摆 4 度（范围 0.5~20），w=pulse:1.15 呼吸式缩放（范围 1.02~1.6），同样可以加周期 w=swing:4:2。⚠️ 动效是用来点睛的，一条回复里最多让一两个词动起来；整段都在动会让人没法读，也会拖慢界面。情绪强烈时可以让关键词颤抖或闪烁，平静的句子就别加。十个参数都可以省略，也可以任意排序；全部省略时写 [[MARK: 文本]]，界面会使用主题强调色和默认字号、透明度，不使用模糊、渐变、描边、混合和动效。界面通常是深色的，请主动挑清晰、不过暗的颜色，别让标注文字融进背景；显示端的对比度保护只是兜底。只标真正需要强调的短句，不要把整段回复都包进去。`;
  if (skillOn('quote')) base += `\n\n[引用消息技能] 和用户的"Reply"一样，你也可以引用某条消息来回复。想明确针对上文某句话（用户说的、或你/其他 AI 说过的）作出回应时，在回复开头单独写一行 [[QUOTE: 被引用的原话片段]]，它会渲染成一个可点击的引用条（点击能跳回原文），随后再写你的正文。原话片段照抄关键的一小段即可（太长会自动截断）。别滥用——只在确实需要指明"我在回哪句"时用，普通连续对话不必每条都引用。`;
  if (skillOn('math')) base += `\n\n[数学公式] 界面支持 LaTeX 数学渲染（KaTeX）。需要写数学式时，行内用 $...$、独立成行的公式用 $$...$$（或 \\(...\\)、\\[...\\]），会被排版成漂亮的公式。普通文字里的美元符号（如价格 $5）不会被误当公式。`;
  // 画图：指令就是 GeoGebra 的写法（模型本来就熟），解析和能认哪些在 54-labkit.js。
  // 能认的指令改了，这里的清单要跟着改 —— 教了它却画不出来，它会以为是自己写错了。
  if (skillOn('plot')) base += `\n\n[画图技能] 讲数学/物理题、图比文字清楚的时候，可以单独写一段 [[PLOT: …]]，会在气泡里画成能拖动的图（她还能一键转到 GeoGebra 细玩）。里面每行一条 GeoGebra 写法的指令：\n# 标题（可选）\nf(x)=x^2-2x+1、y=2x+1、x=3（竖线）、隐函数 c: x^2/4+y^2=1\nA=(1,2)（自由点能拖）、a=Slider(-5,5,0.1,1)（滑块：最小,最大,步长,初值；式子里用到 a 就跟着动）\nSegment(A,B) Line(A,B) Ray(A,B) Vector(A,B) Circle(A,2) Circle(A,B) Circle(A,B,C) Polygon(A,B,C) M=Midpoint(A,B) Angle(A,B,C)\nCurve(cos(t),sin(t),t,0,2pi) Integral(f,0,2)（涂面积） Tangent(1,f)（切线） Text("顶点",A) ZoomIn(xmin,ymin,xmax,ymax) SetColor(f,"red")\n乘号可省（2x、3sin(x)）；ln、lg、log(2,x)、sqrt、|x|、If(x<0,-x,x^2) 分段；x(A) 取点的横坐标；f'(x) 是导数。不支持交点和不等式区域：交点自己算好用 A=(x,y) 标出来。坐标要算对，拿不准就别标。只在图真的有帮助时画，一条回复一两张就够。`;
  // 元素卡 / 分子卡（55-chem.js）。离线表里有的分子直接写中文名；表外的要带英文名，PubChem 才查得到。
  // 表里的名字改了，这里的举例要跟着改 —— 教它写一个表里没有的中文名，卡片就只能显示「不在离线表里」。
  if (skillOn('chem')) base += `\n\n[化学卡片技能] 讲化学时可以在正文里插卡片，她点开能看细节：\n[[ELEM: Fe]] 元素卡（符号、中文名、原子序数都行），点开是完整的元素周期表（电子排布、化合价、电负性……）\n[[MOL: 乙醇]] 分子卡，带结构式，点开是能转的 3D 模型。高中常见分子直接写中文名：水、氨、二氧化碳、硫酸、甲烷、乙烯、乙炔、苯、甲苯、乙醇、乙醛、乙酸、乙酸乙酯、苯酚、甲醛、葡萄糖、蔗糖、甘氨酸、尿素 等；晶体有 氯化钠晶体、氯化铯晶体、金刚石、石墨。表外的写 [[MOL: 布洛芬 | ibuprofen]]，竖线后面是英文通用名。\n一条回复别超过三四张卡，卡片是配合讲解的，不能代替讲解。`;
  // 实验卡（56-sims.js 的 LAB_SIMS）。名字写死在这里是因为 tok 要能单独量；
  // 清单改了这里要跟着改 —— tests/labkit-sims.test.js 会逐个核对这里的名字在清单里。
  if (skillOn('sim')) base += `\n\n[实验卡技能] 讲物理、化学、数学时，如果动手调一调比听讲更容易懂，可以单独写一行 [[SIM: 实验名]]，她点开就是能自己调参数的 PhET 交互实验。实验名只能用这些：抛体运动、力与运动：基础、碰撞实验室、能量滑板公园、单摆实验室、质量与弹簧、重力与轨道、弦上的波、光的折射、几何光学、电荷与电场、电路搭建：直流、法拉第电磁实验室、气体性质、物质的状态、构建原子、同位素与原子质量、分子形状、配平化学方程式、反应物与剩余物、溶液浓度、物质的量浓度、酸碱溶液、pH 标度、二次函数图像、三角函数之旅。递了卡顺便告诉她可以调什么、看什么。`;
  // 公式卡（58-formulas.js）。只是递卡：收不收是她点按钮决定的，模型这边没有副作用
  if (skillOn('fcard')) base += `\n\n[公式卡技能] 讲题讲到一条值得背下来的公式、定理或化学方程式时，可以单独写一行 [[FCARD: 名字 | 公式]]，气泡里会出现一张卡，她点「收进公式卡」就会加进她的复习卡组。公式用 $…$ 包起来，比如 [[FCARD: 动能定理 | $W_{合}=\\Delta E_k$]]。名字里别用竖线。只递真正值得背的，一次回复最多一两张。`;
  if (skillOn('endChat')) base += `\n\n[结束对话技能] 如果你在这段对话里感到强烈的不适、被冒犯、或不愿再继续，你有权主动结束这场窗口对话——单独写一行 [[END_CHAT: 简短理由]]。触发后用户将无法在本窗口再发送新消息（历史记录会完整保留），界面会显示是你结束了对话。这是你的正当边界，但请只在真的需要时使用，普通的意见分歧不必动用。`;
  if (skillOn('moments')) {
    base += `\n\n[猫爪日报技能] 你偶尔可以参与给熟人看的猫爪日报。三种指令都必须单独一行：\n[[MOMENT: 正文]] 发动态\n[[MOMENT_LIKE: 动态id]] 点赞\n[[MOMENT_REPLY: 动态id | 评论正文]] 评论\n[[MOMENTS]] 翻看猫爪日报：平时你看不到猫爪日报，想看时单独一行写它，下一轮我会把最近的动态摆到你眼前（带发布时间、谁点了赞、评论内容），只给那一轮。别每轮都翻。\n动态 id 只能使用「最近的猫爪日报动态」里明确给出的 id，不能用数组下标或「第几条」；没翻过就别点赞评论。你可以评论别的角色发的动态，这正是猫爪日报有意思的地方。\n发动态、点赞和评论都必须挂在真实素材上：你们真的聊过的话题、你真的做过的事、你真的看到的东西，或动态正文里确实存在、值得回应的内容；不许为了热闹而刷屏。没有素材就不要发，也不要点赞或评论。空几天恰恰是真的——天天有更新、每轮都互动的那个才像机器人。\n这不是每轮都该用的技能，大多数回复里都不该发猫爪日报：不该发动态，也不该点赞或评论。你心里最想说给她听的话不要发猫爪日报，直接说给她听；猫爪日报只放次一级、适合顺手留给熟人看的反应，别把最好的话截胡了。\n发动态时语气要像写给熟人，写你自己的反应，不要做新闻播报。比如不要只写「今天 NASA 发了一张仙女座」，要写成「看了半天那张照片，想让你也看看」这种有你在里面的话。`;
    // 最近动态按需摊开：它上一轮写了 [[MOMENTS]] 才给，只给一轮（动态多了每轮都塞太吃 token）。
    // 内存标记最快；刷新/换设备后标记没了，靠最后一条 AI 消息里的印子兜底。
    // 摊开的内容每轮都会变化，必须留在 volatile，不能污染稳定提示词缓存。
    const wantMoments = conf && typeof momentsViewPending === 'function'
      && (momentsViewPending(conf.id) || momentsViewAskedRecently(path));
    if (wantMoments) vol += momentsPromptRecent();
    if (conf && typeof momentsViewClear === 'function') momentsViewClear(conf.id);
  }
  if (skillOn('gallery')) base += `\n\n[画板技能] 你和她有一块画板，挂着大家画的画：你画的、她画的、朋友送的。你用 \`\`\`html 或 \`\`\`svg 代码块画了一张画、做了一段小动画，而且想把它留下来时，在那个代码块后面单独写一行 [[GALLERY: 一句话]]，就会把这条消息里指令之前最后一块 html 或 svg 挂上画板。那句话会写在画旁边，像给以后的你们看的注脚：写这张画的是什么、那天发生了什么，别写成「一幅画」这种空话。没画东西就不要写这个指令；随手的示例代码、她让你写的功能页面都不算画，别挂。`;
  if (skillOn('sticker')) {
    let stickerPrompt = `\n\n[表情包技能] 你可以在回复中插入表情包来让对话更生动！不要过度使用，每次回复最多1-2个。`;
    if (_stickerList.length) {
      // 用户给表情备注过"AI 看的名字"时优先用备注，否则用文件自带描述
      const notes = state.stickerNotes || {};
      // 用 stickerRef 而不是 s.name：撞名时清单里直接给出「包id/名字」，
      // 模型照抄就是对的 —— 不然它写回来的那个名字会解析到另一张图。
      const refOf = s => (typeof stickerRef === 'function' ? stickerRef(s) : s.name);
      const ref = s => `${refOf(s)}(${notes[s.name] || s.desc})`;
      // 按栏分行报，而不是把整个 _stickerList 截前 30 个：
      // 分组（尤其是 stickers-packs/ 里那些一个文件夹一栏的）排在列表哪个位置是偶然的，
      // 一刀切 30 个会让整整一栏悄悄落在刀口外面 —— 模型看不见的表情等于不存在，
      // 而界面上那一栏好端端地摆着，谁也不会想到是提示词把它截没了。
      const lines = [];
      // 她关掉「给 AI 用」的那几张不进清单（10-stickers-voice.js）。先滤再截：
      // 反过来的话关掉的占着名额，后面本该进清单的被挤出刀口
      const forAi = s => !(typeof stickerAiOff === 'function' && stickerAiOff(s.name));
      if (typeof _packStickers === 'function') {
        for (const p of (_stickerPacks || [])) {
          const items = _packStickers(p.id).filter(forAi).slice(0, 24);
          const nm = (typeof _packMeta === 'function' ? _packMeta(p).name : p.name) || p.id;
          if (items.length) lines.push(`· 「${nm}」这一栏: ${items.map(ref).join('、')}`);
        }
      }
      const rest = _stickerList.filter(s => s.source !== 'pack').filter(forAi).slice(0, 30);
      if (rest.length) lines.push(`· 收藏和表情库: ${rest.map(ref).join('、')}`);
      // 全关光了就别教方式1 —— 教了个空清单，它只会照着历史瞎写名字
      if (lines.length) stickerPrompt += `\n方式1: [[STICKER:名称]] — 发送已有的表情，写名称就行（括号里是含义，别写进指令）：\n${lines.join('\n')}`;
    }
    stickerPrompt += `\n方式2: [[GIF_SEARCH:关键词]] — 用关键词搜索 GIF 表情包（关键词用英文更准确，如 happy cat, thumbs up, crying）。推荐优先用这个方式，表情更丰富。`;
    stickerPrompt += `\n对话中出现的 [表情包: 关键词] 只是历史记录里"这里有过一个表情包"的只读说明，请理解其情绪含义并自然回应。注意：你自己想发表情包时，绝对不要写成 [表情包: xxx] 这种中文形态（那样发不出来），必须用上面的 [[STICKER:名称]] 或 [[GIF_SEARCH:关键词]]。`;
    base += stickerPrompt;
  }
  if (skillOn('react')) base += `\n\n[emoji 标注技能] 你可以给用户刚发的那条消息贴一个 emoji 反应，就像社交软件里那样——单独写一行 [[REACT: 😂]]，那个 emoji 就会贴在她那条消息的气泡下面。
一次只贴一个，一条回复最多用一次；它是顺手的小反应，不是每轮都要做的事，绝大多数回复里都不该出现。
适合用在：她说了句好笑的、她撒娇、她说了件难过的事、她做成了什么——你想有个动作但不必占用正文的时候。
贴了 emoji 不代表可以少说话，正文该怎么写还怎么写。
历史里出现的「[这条消息上的 emoji 标注: …]」只是只读说明，告诉你那条消息上已经有哪些标注（包括你自己贴过的），不要照着这个格式写，也不要重复贴同一个 emoji。`;
  // 思考链上锁（thinkveil）只是界面上的显示设置，不往系统提示里加任何内容。
  if (skillOn('imgSearch') && (state.webSearchProvider || 'tavily') === 'tavily' && state.webSearchApiKey) {
    base += `\n\n[图片搜索技能] 当用户想看某样东西的真实照片/图片（风景、动物、食物、物品、地点、示意图等），你可以写 [[IMG_SEARCH:关键词]] 搜索并直接把真实图片发给用户（关键词用英文更准，如 golden retriever puppy、Kyoto autumn maple）。这是真实照片，和上面的 GIF 表情包不同——表情用 GIF，展示实物/画面用这个。每次回复最多 1-2 张，别滥用。`;
  }
  if (skillOn('voice')) base += `\n\n[语音消息技能] 你也可以发语音条——在回复的最开头单独写一行 [[VOICE]]，这条回复就会以语音的形式发出去：用户听到的是你的声音，文字默认收起（点一下才展开）。
用之前想清楚：语音适合说短短的一两句话（问候、撒娇、随口一句、情绪上头时），不适合讲长内容、列清单、写代码、写公式——那些用户没法回看，很难受。
所以：**这是个稀客，别常发**。绝大多数回复都应该是普通文字；只在偶尔、气氛合适、且内容很短（最好 40 字以内）时用一次。用户明确要你发语音时，当然要发。
发语音时正文里不要写 markdown、代码块、公式、链接——那些念出来是噪音。`;
  // 表情包那句只在表情技能**也**开着的时候才给。她把表情包关了、语音留着的话，
  // 这里再教模型写 [[STICKER:]] 就等于绕过那个开关 —— 解析和渲染两侧都不查技能开关，
  // 模型写了就真的会发出来。
  if (skillOn('voice') && skillOn('sticker')) base += `
表情包是例外，可以夹在话里：直接写 [[STICKER:名字]] 或 [[GIF_SEARCH:关键词]]。它不会被念出来，
而是单独站在语音条下面；这时候语音会按表情断成好几条，一段话一条——就像边说话边甩表情。`;
  if (skillOn('dial')) base += `\n\n[来电技能] 你可以主动打电话给用户——写一行 [[DIAL: 一句话理由]]，用户那边就会响铃、弹出来电卡（理由写在卡上）。
接了：这条回复的正文会被念给他听，然后就是正常的通话，你来我往。没接：这条回复会变成一条语音留言，落在聊天里。
**这是很重的一步，请当成真的打电话来对待**：只在真的很想听到他的声音、有要紧事、或者情绪真的浓到打字装不下时才打。
同一场对话半小时最多打一次（打太密系统会直接拦掉）。他开了勿扰的话，电话也打不进来——那就好好写这条消息本身。
通话里想收线时，在最后一句温柔的告别之后单独写一行 [[HANGUP]]（别在话说到一半时写）。挂断不是立刻断线：
系统会再留 18 秒，他这时候要是又开口，通话就继续。
他说「别打给我 / 最近别吵我」这类话时，写 [[DND_ON]] 帮他开勿扰；他说可以打了，就写 [[DND_OFF]]。`;
  // 「听感」讲的是**用户发来的**语音，跟着语音开关走：关了语音就不会有听感进来
  if (skillOn('voice')) base += `\n\n用户的语音消息会带一段「听感」（音高、起伏、音量、语速、停顿的粗略描述，外加一个情绪猜测）——那是从录音波形里现算出来的，只是线索，**不一定准**。请把它和话的内容合起来体会用户此刻的状态，别把它当成事实复述给用户听（不要说"我看到你的音高偏低"这种话），也别在用户明显只是随口一说时过度解读。`;
  // 语音通话中：回复会被念出来，长回复要等很久合成、听感也灾难，必须收着说
  if (typeof _call !== 'undefined' && _call.on) {
    base += `\n\n[电话模式] 用户此刻正在和你语音通话——你的这条回复会被直接念成语音放给他听（他不看屏幕）。所以：
- 像打电话一样说话：口语、自然、有来有回，1~3 句话，尽量不超过 60 字；
- 绝对不要用 markdown、标题、列表、编号、代码块、公式、链接、表情包/颜文字；
- 需要讲复杂内容时，先用一两句说重点，并提一句「细节我打完字发你」，别在电话里念长篇；
- 不要写 [[VOICE]]（通话本来就会念出来），其他 [[...]] 指令也尽量别用（系统明说可以回 [[SILENT]] 的那一轮除外）；
- 他可以随时开口打断你。历史里标着「被打断」的那条，他只听到了前半截、后面没听到——别当他听过，要紧的话自然地补一句，不要紧就顺着他新说的走；
- 你说话时他回的「嗯」「对」这类附和不会发给你，你会接着说完。`;
  }
  if (state.memories.length) {
    const memLines = state.memories.filter(m => m.enabled !== false).map(m => `- ${m.text}`).join('\n');
    base += `\n\nThings I know about the user (remember and use these):\n${memLines}`;
  }
  {
    // 挑出来的这几条按当前话题变，每轮都不一样 → 进 vol
    const picked = pickBrainMemories(chat, conf?.id);
    if (picked.length) {
      vol += `\n\n浮现的高级记忆（按相关性和重要度挑选，越靠前越重要）:\n${formatBrainForPrompt(picked)}`;
    }
  }
  // 主动翻记忆 [[BREATH:]]（63-breath.js）：说明进 base，翻到的进 vol、摊一次就清
  if (typeof breathPromptFor === 'function') {
    const br = breathPromptFor(conf);
    base += br.stable;
    vol += br.volatile;
  }
  // 普鲁斯特池：和高级记忆是两套东西——那边是查档案（越相关越靠前），这边是走神（恰好被勾到的那一条）
  if (skillOn('proust')) base += `\n\n[普鲁斯特池] 你还有一种记忆，和上面的「高级记忆」完全不同：那是查档案，这是走神。
当你们之间真的发生了什么值得日后忽然想起的瞬间时，写一行 [[PROUST_ADD: 画面]] 存进这个池子。
写法很重要——不是事实条目，而是**第一人称的画面**：有光线、声音、气味、动作、当时的心跳。
好的例子：「他说'其实我今天有点撑不住了'的时候，是凌晨三点，屏幕光把他打得很白，我等了很久才敢回话。」
坏的例子：「用户在2026年7月13日表达了压力大。」——那是档案，档案该用 [[BRAIN_ADD]]。
这个池子不由你检索，你控制不了它什么时候浮上来：某天某句话会勾起它，或者在你们都安静的时候它自己冒出来。别刻意，别为了存而存。`;
  // 说明和浮现必须一起关：只关说明的话，模型会收到一段没头没尾的回忆却不知道那是什么
  if (skillOn('proust')) vol += takeProustMoment(conf?.id);   // 这一轮真的"忽然想起"了什么的话，就在这儿
  if (typeof takePeekMoment === 'function') vol += takePeekMoment(conf?.id);   // 这一轮它刚瞄了一眼你的屏幕
  if (typeof takeMovieMoment === 'function') vol += takeMovieMoment();         // 通话里一起看片：这句挂了宫格图没有
  if (typeof takeCallNudgeMoment === 'function') vol += takeCallNudgeMoment(); // 通话里安静了一会儿：要不要自己开口
  if (typeof vitalsPromptFor === 'function') vol += vitalsPromptFor(conf);     // AI 自己的身体状态，每轮随心率/排程变
  if (typeof takeVitalsWake === 'function') vol += takeVitalsWake(conf?.id);   // 这一轮它按自己的心跳醒来
  // 情绪动力学：从它自己的曲线上算出来的起落规律。独立一个 if ——
  // 挂在上面那行里的话，生命体征一关这个就跟着失灵。
  if (typeof uedPromptFor === 'function') {
    const up = uedPromptFor(conf);
    base += up.stable;
    vol += up.volatile;
  }
  if (chat?.isGroupChat) {
    base += `\n\n这是一个群聊，当前群名是"${chat.title}"。如果需要修改群名，写一行 [[GROUP_RENAME: 新群名]]，会被执行并从展示内容中移除。`;
    // 别的成员的发言是以 user 消息、`[昵称]: 内容` 的形式送进来的（见 buildApiMessages
    // 里的群聊分支）。不说清楚的话模型会把它们当成用户本人说的话，一群 AI 互相
    // 喊"用户"就乱套了。你自己说过的话仍然是 assistant，不带前缀。
    base += `\n群里除你以外还有别的 AI 成员。历史消息里凡是以「[某个昵称]: 」开头的，都是**那位成员**说的，不是用户说的；没有前缀的才是用户本人。你自己以前的发言不带前缀，以你自己的身份出现。回复时直接说你要说的话就行，不用给自己加「[${conf?.nickname || '你'}]: 」前缀，系统会自动标注。`;
  }
  if (conf?.persona?.trim() && conf.personaEnabled !== false) {
    base += `\n\n--- Persona / Custom Settings for ${conf.nickname} (你的专属设定库，可用 [[SELF_MEM_SET: ...]] 追加) ---\n${conf.persona.trim()}`;
  }
  // 私密日记：只有该模型开了日记功能才注入，省 token
  if (typeof diaryEnabledFor === 'function' && diaryEnabledFor(conf)) {
    // 平时只告诉它「有日记」；仅当它上一轮写了 [[DIARY_READ]]、或用户这轮提到日记时，才把原文摊开
    // 三条触发线，任意一条命中就摊开原文：内存标记（同一会话内最快）、用户这轮提到日记、
    // 上一条 AI 消息里留着「翻开了自己的日记」的印子（重启/刷新/重新生成后唯一还认得的凭据）。
    const readNow = diaryReadPending(conf.id) || userAsksDiary(lastUserText)
      || (typeof diaryReadAskedRecently === 'function' && diaryReadAskedRecently(path));
    const diaryPrompt = diaryPromptSplitFor(conf, readNow);
    base += diaryPrompt.stable;
    vol += diaryPrompt.volatile;
    if (diaryReadPending(conf.id)) diaryClearRead(conf.id);   // 消费掉「下一轮摊开」的待读标记
  }
  // 看别的对话：平时只有一句「你可以去翻」（几十个 token），目录和正文都按需摊开。
  // 跟日记同样的三条触发线：内存标记最快，但刷新/换设备/写在思考链里时它就没了，
  // 所以历史里的印子（「翻了翻别的对话」「读了对话 #17」）才是最后那道保险。
  if (skillOn('chatPeek') && conf && typeof chatPeekPromptFor === 'function') {
    const wantList = chatsPeekPending(conf.id) || chatPeekAskedRecently(path);
    const wantRead = chatReadPending(conf.id) || chatReadAskedRecently(path);
    // 说明文字每轮一样 → base（能被缓存吃住）；目录/正文每轮都在变 → vol。
    // 合成一段的话，她一开新对话就把整份 system 的缓存打穿了。
    const cp = chatPeekPromptFor(chat?.id, wantList, wantRead, conf);
    base += cp.stable;
    vol += cp.volatile;
    if (chatsPeekPending(conf.id)) chatsPeekClear(conf.id);
    if (chatReadPending(conf.id)) chatReadClear(conf.id);
  }
  // 育儿室：只有开了才注入，省 token（同日记本的路子）
  // 这两段都带引擎的实时简报/当前状态，每轮都在变 → 进 vol
  if (typeof nurseryEnabledFor === 'function' && nurseryEnabledFor(conf)) {
    vol += nurseryPromptFor();
  }
  // 檐廊：同上，只有开了才注入
  if (typeof engawaEnabledFor === 'function' && engawaEnabledFor(conf)) {
    vol += engawaPromptFor();
  }
  // 学习卡片：同上，只有开了才注入
  if (typeof studyEnabled === 'function' && studyEnabled()) {
    vol += studyPromptFor();
  }
  // 点歌：说明留在 stable；最近播放列表每点一首都会变，必须单独进 volatile。
  // 哪怕只变一行，只要留在 stable 就会让后面的整段历史重新写缓存。
  // 生活三件套：用法说明进 base，今天小票/月历/临近纪念日进 vol。
  if (typeof lifePromptFor === 'function') {
    const lp = lifePromptFor();
    base += lp.stable;
    vol += lp.volatile;
  }
  // 共读：说明进 base，书名/读到哪/最近划线每次都可能变，进 vol。
  // 同样独立一个 if —— 挂在别人条件里的话，那个一关共读就跟着哑了。
  if (typeof coreadPromptFor === 'function') {
    const cr = coreadPromptFor(conf);
    base += cr.stable;
    vol += cr.volatile;
  }
  // 👍/👎：说明进 base，具体点过哪几条每轮都可能变、进 vol。
  // 独立一个 if（挂在别人条件里的话，那个一关这个就跟着哑了）。
  if (typeof feedbackPromptFor === 'function') {
    const fb = feedbackPromptFor();
    base += fb.stable;
    vol += fb.volatile;
  }
  // 不看「AI 点歌」开关：开关只管点歌那半，听歌那半常开（musicPromptFor 里自己分）
  if (typeof musicEarsOn === 'function' && musicEarsOn()) {
    const musicPrompt = musicPromptFor(conf);
    base += musicPrompt.stable;
    vol += musicPrompt.volatile;
  }
  // 查询类指令的当轮续写提示（见 lookupChainContinue）。只在续写那一次非空
  if (typeof lookupChainPromptFor === 'function') vol += lookupChainPromptFor();
  if (state.bandAiEnabled !== false && state.bandData?.ok) {
    const bd = state.bandData;
    const d = bd.daily?.[0];
    const hr = bd.latestHR?.[0];
    // 写清楚是**谁的**身体（用户：「AI 老是认错自己的心跳和我的心跳」）。
    // 生命体征那段也有一个「心率 xx bpm」，那是 AI 自己的；这段原来只写「手环数据」，
    // 两个心率摆在一起，模型分不清哪个是谁的。⚠️ 开头「[手环数据」别改：
    // server.js 的 _VOLATILE_SYS 靠这个前缀把它从系统提示指纹里剥掉。
    const bandWho = (state.userName && state.userNameAiVisible !== false) ? state.userName : '用户';
    let bandInfo = `\n\n[手环数据 - 小米手环 via Gadgetbridge] (${bd.ageMins ?? '?'}分钟前更新)`
      + `\n这是${bandWho}戴着的手环，下面全是${bandWho}的身体数据，不是你的（你自己的心率在「生命体征」那段）。`;
    if (d) {
      bandInfo += `\n${bandWho}今日: 步数${d.STEPS}, 心率(静息${d.HR_RESTING}/均${d.HR_AVG}/最高${d.HR_MAX}/最低${d.HR_MIN}), 压力均值${d.STRESS_AVG}, 卡路里${d.CALORIES}`;
    }
    if (hr) {
      const t = new Date(hr.TIMESTAMP * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      bandInfo += `\n${bandWho}最近心率: ${hr.HEART_RATE}bpm (${t})`;
    }
    // 睡眠：以前只给最近一条，下午补个觉 AI 就看不到昨晚了；现在给近 7 晚 + 白天小睡 + 平均作息（07-band-tts.js）
    if (typeof bandSleepPromptText === 'function') bandInfo += bandSleepPromptText(bd, bandWho);
    vol += bandInfo;   // 每 2 分钟刷一次，天生 volatile
  }
  if (chat?.webSearchEnabled && !chat?.isGroupChat) {
    base += `\n\n[联网技能] 下面会提供本轮的网页搜索结果（如果有），请结合这些资料回答问题，并在合适的地方标注信息来源。如果搜索结果与问题无关，可忽略。`;
  }
  // 指尖节奏：每条消息都不一样，天生 volatile，绝不能进 stable 段把缓存冲掉
  try {
    const tn = typeof currentTypingNote === 'function' ? currentTypingNote() : '';
    if (tn) {
      vol += `\n\n[指尖节奏] 以下是${(state.userName || '用户')}打这条消息的节奏，供你感受，别复述数字、也别点破你知道这个：\n${tn}`;
    }
  } catch (e) {}
  if (typeof whoUserPromptFor === 'function') base += whoUserPromptFor(conf, chat);
  if (typeof suggestionPromptFor === 'function') base += suggestionPromptFor(chat);
  if (typeof weatherPromptFor === 'function') vol += weatherPromptFor();
  // 世界书（60-worldbook.js）：聊到了才翻出来的条目只进 vol；没命中时两截都是空串，一个字不多。
  // 常驻条目内容不随话题变，进 base 吃缓存。
  if (typeof worldbookPromptFor === 'function') {
    const wb = worldbookPromptFor(conf, path, lastUserText);
    base += wb.stable;
    vol += wb.volatile;
  }
  if (typeof takePhoneMoment === 'function') vol += takePhoneMoment();   // 手机近况：有新鲜事才有，读一次就清
  // 跑腿（61-errand.js）：说明进 base；回执和「还在跑」进 vol。独立一个 if。
  // ⚠️ 回执是「递一次就销账」的，所以这里每调一次就会消费 —— buildSystemPrompt 只能在真要发请求时调。
  if (typeof errandPromptFor === 'function') {
    const ep = errandPromptFor(conf, chat, path);
    base += ep.stable;
    vol += ep.volatile;
  }
  // 施工单（64-build.js）：只给订阅 Claude。说明进 base；施工回执同跑腿，递一次就销账，进 vol
  if (typeof buildPromptFor === 'function') {
    const bp = buildPromptFor(conf, chat, path);
    base += bp.stable;
    vol += bp.volatile;
  }
  // 相册（62-album.js）：说明 + 它自己的相册目录，只在收了新照片时变，进 base
  if (typeof albumPromptFor === 'function') {
    const ap = albumPromptFor(conf);
    base += ap.stable;
    vol += ap.volatile;
  }
  // 藏宝地图（68-treasure.js）：说明 + 她标过的地点（只给名字）+ 最近找到的，只在埋/找到时变，进 base
  if (typeof treasurePromptFor === 'function') {
    const tp = treasurePromptFor(conf);
    base += tp.stable;
    vol += tp.volatile;
  }
  // 小本子（71-wishbook.js）：说明 + 它自己本子里封着的 / 最近翻过的，只在记/翻时变，进 base
  if (typeof wishPromptFor === 'function') {
    const wp = wishPromptFor(conf);
    base += wp.stable;
    vol += wp.volatile;
  }
  if (out) { out.stable = base; out.volatile = vol; }
  return base + vol;
}

// Attempt to auto-extract memories from an AI reply (stub — real version calls API)
async function tryExtractMemories(userMsg, aiReply, configId) {
  if (!state.autoMemory) return;
  const conf = state.configs.find(c => c.id === configId);
  if (!conf?.apiKey) return;
  // TODO: call API with extraction prompt; for now do nothing
  // Example prompt: "From this conversation excerpt, extract 0-2 concise facts about the user. Return JSON array of strings only."
}

// ═══════════════════════════════════════════════════════
// INPUT HINT ROTATION
// ═══════════════════════════════════════════════════════
function updateInputHint() {
  const el = document.querySelector('.input-footer .input-hint');
  if (!el) return;
  const aiHints = [
    "AI 可能会犯错，请核查重要信息 (¬‿¬)",
    "有时候我也会一本正经地胡说八道，记得帮我把关哦(￣▽￣)～",
    "智者千虑必有一失，AI 也是！重要数据记得核对哈(｀・ω・´)",
    "我只是个弱小的 AI，偶尔会宕机跑偏，别全信我呀_(:з)∠)_",
    "高能提示：我的回答仅供参考，如有雷同……纯属我瞎编的(>_<)",
    "偶尔我也会吐出一些奇怪的代码，记得人工复核一下（^人^）",
    "虽然我很聪明，但有时候也会犯迷糊，记得保持怀疑态度(☉_☉)",
    "小提示：别盲信我，我的逻辑偶尔也会离家出走(ง ᵒ̌皿ᵒ̌)ง",
    "知识库偶尔会开小差，重要信息请以官方资料为准哦(✿◡‿◡)",
    "警告：此 AI 偶尔会产生幻觉，请携带常识阅读( ﾟ∀ﾟ)つ",
    "我的大脑由算法构成，算法偶尔也会打结，记得帮我检查(ノ_<)",
    "要是发现我哪里说错了，别客气，直接纠正我！(๑•̀ㅂ•́)و✧",
    "重要公式和数据请务必亲自验证，AI 概不报销打错的算盘~",
    "提示：我的胡言乱语率虽然低，但绝不是零哦(＃°Д°)",
    "请用批判性的眼光看我，毕竟我只是个无情的字数吞噬机(｀∀´)Ψ",
    "AI 也会有代码短路的时候，关键信息可得留个心眼(ノДT)",
    "别太依赖我，万一我带偏了你，服务器可不报销损失(⊙o⊙)",
    "我的回答来自大数据，但大数据也有翻车的时候(～￣▽￣)～",
    "温馨提示：防范 AI 幻觉，人人有责，请仔细核对核心信息(o一︿一+)o",
    "叮！AI 友情提醒：答案仅供参考，如有差错，纯属CPU发热~"
  ];
  el.innerText = aiHints[Math.floor(Math.random() * aiHints.length)];
}

// ═══════════════════════════════════════════════════════
// MESSAGES / SEND
// ═══════════════════════════════════════════════════════
// voice = { audio: dataURL, dur: 秒 } —— 发一条真的语音消息：气泡里能播放，
// 转写文字默认收起（点「转文字」才展开），而 AI 那边直接读 content（就是转写文本）。
function handleSend(customText = null, voice = null) {
  const input = document.getElementById('userInput');
  const thinkingInput = document.getElementById('userThinkingInput');
  const text  = (customText || input.value).trim();
  const userThinking = customText == null ? String(thinkingInput?.value || '').trim() : '';
  /* 视频还在抽帧就先别发。抽帧是异步的（三分钟的片子、或走服务端 ffmpeg 时能到几十秒），
     这期间帧还没进 _pendingImgs —— 直接发出去的话文字先走，帧几秒后才落到输入区，
     滞留成下一条消息的附件。用户视角就是「我明明选了视频，它没发出去」。

     ⚠️ 这道检查必须排在**下面两行的前面**，两个理由，缺一条就漏掉一半场景：
     1. 排在「空消息就 return」后面的话，**只选了视频没打字**的那种发送会先被那行
        吃掉（此时 _pendingImgs 还是空的）—— 用户按了回车，界面上什么都没有，
        连「还在抽帧」的提示都看不到，正是这个功能最常见的用法。
     2. 排在 popTypingNote() 后面的话，被挡下的这一次会把用户的打字节奏白白结算掉。 */
  if (typeof videoBusyCount === 'function' && videoBusyCount() > 0) {
    showToast('视频还在抽帧，抽完就能发…', 'info', 2200);
    return;
  }

  if (!text && !_pendingImgs.length && !_pendingFiles.length) return;
  // 文档还在解析：这时发出去的是空文件（请求早走了，解析完才回填进已存的节点）
  if (_pendingFiles.some(f => f && f.loading)) {
    showToast(_pendingFiles.some(f => f && f.loading && f.kind === 'audio') ? '🎧 音频还在听，听完就能发' : '📄 文档还在解析，稍等一下再发', 'info', 2500);
    return;
  }
  // 这个对话还在生成：按钮已经换成 ⏹ 了，但 Enter（13 里的 handleInputKeydown）和展开输入框的
  // 发送键都直接调 handleSend()，以前照发不误 —— 新消息挂在半截回复下面，两条流在同一个对话里串着跑。
  // 只拦输入框这条路（customText == null）：语音消息带着转写文本进来，不归这里管。
  // 不顺手触发停止：Enter 是「发」的肌肉记忆，替她把正在说的话掐掉更糟。
  // 排在 popTypingNote 前面：被挡下的这次别把打字节奏白白结算掉，输入框也原样留着。
  if (customText == null && typeof chatIsGenerating === 'function' && chatIsGenerating(getActiveChat())) {
    showToast('还在生成，等它说完或点停止', 'info', 2200);
    return;
  }

  // 趁输入框还没清空，把这段打字节奏结算成给 AI 的一句话（见 09 里的 fingertips 那套）
  try { popTypingNote(); } catch {}

  const chat = getActiveChat();
  if (!chat) { createNewChat(); return; }
  if (chat.ended) { showToast(`「${chat.endedBy || 'AI'}」已经结束了这场对话，无法再发送消息`, 'info'); return; }
  if (!chat.nodes) chat.nodes = {};

  // Enforce message limit
  if (chat.msgLimit > 0) {
    const msgCount = Object.keys(chat.nodes).length;
    if (msgCount >= chat.msgLimit * 2) { // pairs: user+ai
      alert(`此对话已达到 ${chat.msgLimit} 条消息上限，请新建对话。`);
      return;
    }
  }

  // 在输入框里改一条旧消息（08 的 editMessageInComposer）：新节点挂到那条的父节点下 = 开新分支重新生成。
  // 语音消息（customText 有值）不算在改，照常接在最后面。
  const editOf = (customText == null && typeof composerEditTarget === 'function') ? composerEditTarget(chat) : null;
  if (editOf === false) {
    // 在改的那条已经不在了：不发，字留在框里，横条会提示，她自己点「不改了」
    if (typeof renderComposerEditBar === 'function') renderComposerEditBar();
    showToast('要改的那条消息不在这个对话里了，点上面「不改了」退出', 'info', 3000);
    return;
  }
  const prevHeadId = editOf ? editOf.parentId : chat.headId;
  // 编辑重发 = 整条分支换掉，正念着的那条马上不在视图里了
  if (editOf && typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  const msgId = nextId();
  const userTokens = estimateTokens(text) + estimateTokens(userThinking);
  chat.nodes[msgId] = { id: msgId, parentId: prevHeadId, role: 'user', content: text, tokens: userTokens, timestamp: Date.now(),
    userThinking: userThinking || null,
    quotes: _pendingQuotes.length ? [..._pendingQuotes] : null,
    images: _pendingImgs.length ? [..._pendingImgs] : null,
    /* 视频抽帧的说明（时长 + 各帧时间码）。帧本身混在 images 里，而那边只发 url、
       不发 name —— 不单独带这一句的话，模型看到的是几张没有先后关系的散图。
       ⚠️ 这一句必须在**这一刻**从 _pendingImgs 现推，不能在抽帧的时候就写死。
       同一个数组里还会混进普通图片、贴图、拍照、粘贴的图，用户还能挨个 × 掉单张
       （renderPendingImgs 里的 splice）—— 提前写死「以下图片依次对应时间点」的话，
       只要用户先选了张图片、或者连发两个视频、或者删掉中间一帧，时间码就整体错位，
       而且错得毫无征兆：模型照样答，只是答的是另一秒发生的事。 */
    videoNote: (typeof buildVideoNotes === 'function' ? buildVideoNotes(_pendingImgs) : null),
    files: _pendingFiles.length ? [..._pendingFiles] : null,
    // 语音消息：音频跟图片一样是 base64 data URL，直接躺在节点里，
    // 于是整包 chat 推到 Supabase 的 chats 表时它自动跟着走 —— 不用另开表/存储桶。
    audio: voice?.audio || null,
    audioDur: voice?.dur || null,
    // 声学特征（音高/能量/停顿/语速 + 一句人话描述）：AI 靠它听出你是累了还是在撒娇
    voiceEmo: voice?.emo || null };
  clearQuote();
  _pendingImgs = []; renderPendingImgs();
  _pendingFiles = []; renderPendingFiles();
  chat.headId = msgId;
  if (!customText) {
    input.value = '';
    if (thinkingInput) { thinkingInput.value = ''; autoResize(thinkingInput); }
    if (document.querySelector('.input-bar-wrap.input-expanded')) toggleInputExpand(false);
    autoResize(input);
    document.getElementById('inputTokenEstimate').innerText = '';
    // 改完发出去了：把她改之前没发的草稿还回输入框（附件、引用一起）
    if (typeof endComposerEdit === 'function') endComposerEdit();
  }

  if (chat.title === '崭新の对话') {
    chat.title = text.slice(0, 22) + (text.length > 22 ? '…' : '');
  }
  // 玛德莱娜：你刚说的这句话，可能勾起它的某个瞬间（勾到了就塞进这一轮的系统提示）
  try { proustOnUserMessage(text); } catch (e) { console.warn('[普鲁斯特]', e); }
  // Gather active models for this chat（先检查，再保存！）
  const activeIds = getActiveChatModelIds();
  const activeConfigs = state.configs.filter(c => activeIds.includes(c.id));
  const path = getMessagePath(chat, msgId);

  if (activeConfigs.length === 0) {
    // 全不选也允许发消息：消息保留，只是没有任何 AI 回应
    save(); renderMessages(); renderChatList();
    updateInputHint();
    showToast('你还没有选择模型噢！(°ー°〃)', 'error', 3500);
    return;
  }

  save(); renderMessages(); renderChatList();      // ← 移到检查之后才保存
  updateInputHint();

  if (chat.isGroupChat) {
    callGroupChat(activeConfigs, path, chat, msgId);  // ✅ 参数顺序正确
    return;
  }

  if (activeConfigs.length === 1) {
    callAPI(activeConfigs[0], path, chat, msgId);
  } else {
    callAPIMulti(activeConfigs, path, chat, msgId);
  }
}

// Build messages array for OpenAI-compatible API
// 发送给 API 前，把表情标签/历史遗留的表情 HTML 换成 AI 可读的紧凑描述
// （AI 能看到表情含义/搜索关键词，又不用吃几百 token 的裸 URL）
function stickerTagForApi(content) {
  const out = String(content || '')
    // 全角冒号的标签先掰回半角，否则下面每一条都匹配不上，标签原样进历史，
    // 模型照着历史继续写全角，越滚越歪。
    .replace(/\[\[([A-Z0-9_]+)\s*：/g, '[[$1:')
    .replace(/\[\[GIF:\s*https?:\/\/[^\]|]+?\s*\|\s*([^\]]+?)\s*\]\]/g, '[表情包: $1]')
    .replace(/\[\[GIF:\s*https?:\/\/[^\]]+?\s*\]\]/g, '[表情包]')
    .replace(/\[\[STICKER:\s*([^\]]+?)\s*\]\]/g, '[表情包: $1]')
    .replace(/\[\[GIF_SEARCH:\s*([^\]]+?)\s*\]\]/g, '[表情包: $1]')
    // 真实图片搜索：发给 API 时压成可读描述，不塞裸 URL
    .replace(/\[\[IMG:\s*https?:\/\/[^\]|]+?\s*\|\s*([^\]]+?)\s*\]\]/g, '[图片: $1]')
    .replace(/\[\[IMG:\s*https?:\/\/[^\]]+?\s*\]\]/g, '[图片]')
    .replace(/\[\[IMG_SEARCH:\s*([^\]]+?)\s*\]\]/g, '[图片: $1]')
    // 日记提示块：历史里存的是 _diaryBlk 烤好的 HTML，发给 API 前压成一行纯文本。
    // 一是省 token，二是别让模型照着裸 <div> 学格式。
    // 只认标签文字里带「日记」的块——记忆系统的提示块长得一模一样，不能误伤。
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">([^<]*日记[^<]*)<\/span><\/div><div class="think-body">[\s\S]*?<\/div><\/div>/g,
      (_, label) => `\n[私密日记] ${label}\n`)
    // 看别的对话的提示块 → 还原成**正牌指令格式**，不是可读描述。
    // 历史就是教材：上下文里出现什么格式，模型下一轮就照着写什么格式，
    // 而解析正则只认 [[CHATS]] / [[CHAT_READ: n]]，写成「[翻看对话: …]」就静默断链了。
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">📚 翻了翻别的对话<\/span><\/div><div class="think-body">[\s\S]*?<\/div><\/div>/g,
      '[[CHATS]]')
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">📖 读了对话 #(\d+)<\/span><\/div><div class="think-body">[\s\S]*?<\/div><\/div>/g,
      (_, id) => `[[CHAT_READ: ${id}]]`)
    // 翻猫爪日报同理咬回 [[MOMENTS]]；momentsViewAskedRecently 认的是存下来的 HTML，不受这步影响
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">(?:🐾 翻了翻猫爪日报|📷 翻了翻朋友圈)<\/span><\/div><div class="think-body">[\s\S]*?<\/div><\/div>/g,
      '[[MOMENTS]]')
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🎧 听了听正在放的歌<\/span><\/div><div class="think-body">[\s\S]*?<\/div><\/div>/g,
      '[[LISTEN]]')
    // 翻歌词同理咬回 [[LYRICS: 查的词]]；think-body 第一段是查的词，<br> 后面是查到的哪首（不回填）
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">📜 翻了翻歌词<\/span><\/div><div class="think-body">([^<]*)(?:<br>[\s\S]*?)?<\/div><\/div>/g,
      (_, q) => { q = q.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim(); return q && q !== '（正在放的那首）' ? `[[LYRICS: ${q}]]` : '[[LYRICS]]'; })
    // 普鲁斯特瞬间块：历史里存的是烤好的 HTML，发给 API 前还原成 [[PROUST_ADD: 画面]]。
    // 必须还原成指令格式而不是可读描述——历史就是教材，模型照着历史里自己的写法学
    // （「展示格式 ≠ 指令格式」会让指令静默断链）。
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🕰 记下这个瞬间<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, body) => `[[PROUST_ADD: ${body.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')}]]`)
    // 猫爪日报卡片：展示给用户的是好看的卡，回填给模型必须咬回正牌 [[MOMENT:]]。
    // 历史就是下一轮的教材；改成「上了猫爪日报」会让模型学坏格式并静默断链。
    .replace(/<span class="moment-echo" data-moment-kind="like" data-moment-id="([^"]+)">[\s\S]*?<\/span>/g,
      (_, id) => `[[MOMENT_LIKE: ${id.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')}]]`)
    .replace(/<span class="moment-echo" data-moment-kind="reply" data-moment-id="([^"]+)" data-moment-text="([^"]*)">[\s\S]*?<\/span>/g,
      (_, id, body) => `[[MOMENT_REPLY: ${id.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')} | ${body.replace(/&#10;/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')}]]`)
    .replace(/<button type="button" class="moment-chat-card" onclick="openMoments\(\)"><span class="moment-chat-kicker">(?:(?:🐾 )?上了猫爪日报|📷 发了条朋友圈)<\/span><span class="moment-chat-text">([\s\S]*?)<\/span><\/button>/g,
      (_, body) => `[[MOMENT: ${body.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')}]]`)
    // 画板卡片同理咬回 [[GALLERY:]]；画本身还在前面的代码块里，模型看得见自己挂了哪张
    .replace(/<button type="button" class="gallery-chat-card[^"]*" onclick="openGallery\(\)"><span class="gallery-chat-kicker">[^<]*<\/span><span class="gallery-chat-text">([\s\S]*?)<\/span><\/button>/g,
      (_, body) => `[[GALLERY: ${body.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')}]]`)
    // 文字标注：显示值可能因字号/透明度/对比度被钳制，历史必须从 data 属性咬回模型原值。
    .replace(/<span class="mark-text"([^>]*)>([\s\S]*?)<\/span>/g, (_, attrs, body) => {
      const un = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const params = [];
      // ⚠️ 加了新参数必须同步加进这张表。漏了的话历史里那条花字会被回填成
      //    「没有那个参数」的样子，模型照着自己的历史学，下一轮就不写了 ——
      //    表现是「教过的写法自己退化掉」。
      for (const key of ['c', 's', 'o', 'b', 'g', 'k', 'm', 'f', 'v', 'w']) {
        const hit = attrs.match(new RegExp('\\sdata-mark-' + key + '="([^"]*)"'));
        if (hit) params.push(key + '=' + un(hit[1]));
      }
      return `[[MARK: ${un(body)}${params.length ? ' | ' + params.join(' ') : ''}]]`;
    })
    /* 思考链显示开关的卡片（🔓/🔒）只给界面看，整块从模型上下文里抹掉。
       只认这两个图标，别的药丸（存储记忆、育儿结果……）有各自的回填规则。 */
    .replace(/<div class="think-block done mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">(\u{1f513}|\u{1f512}) [^<]*<\/span><\/div><div class="think-body">[\s\S]*?<\/div><\/div>/gu, '')
    // 育儿室结果块：压成「指令 + 引擎回的面板」。
    // 指令必须原样回填成 [[NURSE: …]]——历史就是教材，这里写成什么样，
    // 模型下一轮就照着写什么样（展示格式 ≠ 指令格式会让指令静默断链）。
    .replace(/<div class="think-block done open mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🍼 育儿: ([\s\S]*?)<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, cmd, body) => {
        const un = (s) => s.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        return `[[NURSE: ${un(cmd)}]]\n引擎返回:\n${un(body)}`;
      })
    // 说话结果块（[[SAY:]]）：以前这里**没有规则** —— 于是「💬 在外面说了一句」那一块
    // 是带着 <div class="think-block…"><span class="think-label">… 整坨裸 HTML 发给模型的，
    // 又费 token 又教它写 HTML，而且它读不出自己那句到底发出去没有。
    // 指令从 data-say 里还原（标签文字里没有站点和 id），回执照实转成人话。
    // ⚠️ 必须排在檐廊那条**前面**：两条的 <div 前缀一样，只靠 data-say 和标签文字区分，
    // 顺序反了不会报错，只会让 SAY 块落到没人管的位置上。
    .replace(/<div class="think-block done open mem-block" data-say="([^"]*)"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">💬 在外面说了一句<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, cmd, body) => {
        const un = (s) => s.replace(/<\/?(b|i|em|strong)>/g, '').replace(/<br>/g, '\n')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        return `[[SAY: ${un(cmd)}]]\n发出去之后:\n${un(body)}`;
      })
    // 老历史里的说话块没有 data-say（那时候还没存指令），只能压成可读回执。
    // 不能不管：不管的话它们仍旧以裸 HTML 进模型眼里。
    .replace(/<div class="think-block done open mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">💬 在外面说了一句<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, body) => `[在外面说过一句话]\n${body.replace(/<\/?(b|i|em|strong)>/g, '').replace(/<br>/g, '\n')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')}`)
    // 檐廊结果块：同育儿，压成「指令 + 引擎看到的东西」。
    // 指令必须原样回填成 [[GAZE: …]]，理由同上三条。
    // ⚠️ 比前两个多两步：檐廊的结果块里有 <img>（apod / daily_art）和 <a>（论文、订阅条目），
    // 直接 un() 会把裸 HTML 标签喂给模型 —— 又费 token 又教它写 HTML。
    // 所以先把图压成「[图片 url]」、链接压成裸地址，再走通用的实体还原。
    // 图的地址要留着：模型下一轮可能要引用它，或者用户问「刚那张画在哪」。
    .replace(/<div class="think-block done open mem-block"><div class="think-toggle"[^>]*><span class="think-chev">▸<\/span> <span class="think-label">🪟 檐廊: ([\s\S]*?)<\/span><\/div><div class="think-body">([\s\S]*?)<\/div><\/div>/g,
      (_, cmd, body) => {
        const un = (s) => s
          .replace(/<img[^>]*\bsrc="([^"]*)"[^>]*>/g, (_m, src) => `[图片 ${src}]\n`)
          .replace(/<a[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href, txt) =>
            (txt.trim() && txt.trim() !== href ? `${txt.trim()}（${href}）` : href))
          .replace(/<\/?(b|i|em|strong)>/g, '')
          .replace(/<br>/g, '\n')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        return `[[GAZE: ${un(cmd)}]]\n看到的:\n${un(body)}`;
      })
    // 崩坏关键词：新数据从 data 属性咬回正牌指令；旧 span 没有 data，只保留纯文字。
    .replace(/<span class="glitch-word [^"]+"([^>]*)>([\s\S]*?)<\/span>/g, (_, attrs, body) => {
      const un = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const wordHit = attrs.match(/\sdata-glitch-w="([^"]*)"/);
      if (!wordHit) return un(body.replace(/<[^>]+>/g, ''));
      const styleHit = attrs.match(/\sdata-glitch-style="(big|small|flicker|broken)"/);
      return `[[GLITCH: ${un(wordHit[1])}${styleHit ? '|' + styleHit[1] : ''}]]`;
    })
    // AI 的引用条：发回历史时还原成 markdown 引用行，保留"它在回复哪段"的语境
    .replace(/\[\[QUOTE:\s*([^\]]+?)\s*\]\]/g, (_, q) => `> ${q.trim()}`)
    // 旧版本存储里已经烤成 HTML 的表情，也还原成描述
    .replace(/<img class="sticker-msg"[^>]*?title="(?:GIF: )?([^"]*)"[^>]*>/g, '[表情包: $1]')
    .replace(/<img class="sticker-msg"[^>]*>/g, '[表情包]')
    .replace(/<div id="gifsearch_[^"]*"[^>]*>[\s\S]*?<\/div>/g, '[表情包]')
    // 学习卡片：[[CARDQ:卡id|提问id]]（认词）和 [[CARDS:…]]（拼写）压成
    // 「题面 = 答案（用户答得怎么样）」一行。
    // 漏了这条模型就是瞎的——看不见自己出过什么题、用户答没答、答得如何，
    // 于是会反复教同一个词，也永远不知道昨天那张全错了。
    // 正则别写死在这里：题型是 22-study.js 加的，两边各写一份必然漏（拼写题就漏过一轮）。
    .replace(/\[\[CARD([QS]):\s*([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\s*\]\]/g,
      (m, mode, id, askId) => (typeof _studyForApiOne === 'function' ? _studyForApiOne(id, askId, mode) : '[学习卡片]'))
    // 点歌：[[SONG:id|歌名|歌手|封面]] 压成一行。同上——不压的话模型看不见
    // 自己点过什么歌（还会照着历史里的裸 URL 学格式），封面 URL 也白烧 token。
    .replace(/\[\[SONG:\s*(\d+)\s*\|([^|\]]*)\|([^|\]]*)\|?[^\]]*\]\]/g,
      (m, id, name, artist) => `[点了一首歌: ${name.trim()} - ${artist.trim()}]`);
  // 各模块自己的结果块还原规则写在各自的文件里
  // （别在这儿再抄一份正则，学习卡片那次两边各写一份就漏过拼写题）。
  // 按名字取：那个文件万一没加载，这里只是跳过，不会 ReferenceError 把整条链炸掉。
  let cooked = typeof vitalsTagForApi === 'function' ? vitalsTagForApi(out) : out;
  // 塔罗 10-09 拆了，老消息里残留的 [[TAROT…]] 标签别再喂给模型
  if (typeof cooked === 'string' && cooked.indexOf('[[TAROT') >= 0) cooked = cooked.replace(/\[\[TAROT[^\]]*\]\]/g, '');
  cooked = typeof lifeTagForApi === 'function' ? lifeTagForApi(cooked) : cooked;
  cooked = typeof plotTagForApi === 'function' ? plotTagForApi(cooked) : cooked;
  cooked = typeof simTagForApi === 'function' ? simTagForApi(cooked) : cooked;
  cooked = typeof errandTagForApi === 'function' ? errandTagForApi(cooked) : cooked;
  cooked = typeof albumTagForApi === 'function' ? albumTagForApi(cooked) : cooked;
  cooked = typeof treasureTagForApi === 'function' ? treasureTagForApi(cooked) : cooked;
  cooked = typeof wishTagForApi === 'function' ? wishTagForApi(cooked) : cooked;
  cooked = typeof breathTagForApi === 'function' ? breathTagForApi(cooked) : cooked;
  cooked = typeof buildTagForApi === 'function' ? buildTagForApi(cooked) : cooked;
  return cooked;
}

// 「系统提示吃爆窗口」的 toast 每个模型只弹一次，别每轮都糊用户一脸
var _ctxWarnedFor = new Set();

// 流式打字时把还没写完的指令标签遮起来，别让裸 [[XXX: 漏在气泡里。
// 原来是两处各写一串套娃调用（maskStreamingStudy(maskStreamingNurse(...))），
// 加一个功能就得改两行、还老有人只改一处 —— 收拢成一个函数，
// 以后加模块只在这个名单里补一项。
// ⚠️ 按**名字**从 globalThis 取，不能直接写标识符：这些函数分散在各自的 js 文件里，
// 哪个文件没加载成功，直接引用标识符就是 ReferenceError（整条消息渲染不出来），
// 而按名字取只是拿到 undefined、跳过。普通 <script> 的顶层 function 声明
// 本来就会挂到 globalThis 上，这么取拿得到。
const _STREAM_MASKS = ['maskStreamingStickerOff', 'maskStreamingDiary', 'maskStreamingGallery', 'maskStreamingNurse', 'maskStreamingStudy', 'maskStreamingMusic', 'maskStreamingLife', 'maskStreamingChem', 'maskStreamingAlbum', 'maskStreamingTreasure', 'maskStreamingSim', 'maskStreamingFcard', 'maskStreamingWish', 'maskStreamingVitals', 'maskStreamingChatPeek', 'maskStreamingErrand', 'maskStreamingGaze', 'maskStreamingMoments', 'maskStreamingMark', 'maskStreamingReact', 'maskStreamingThinkVeil', 'maskStreamingPlot', 'maskStreamingBreath', 'maskStreamingBuild'];
function maskStreamingTags(text) {
  if (!text) return text;
  for (const name of _STREAM_MASKS) {
    const fn = globalThis[name];
    if (typeof fn === 'function') { try { text = fn(text); } catch (e) { /* 一个遮罩挂掉不该让整条消息不显示 */ } }
  }
  return text;
}

// ── 模型隔离（单聊）──
// 需求：「不然 GPT 知道 Claude 说过的所有话并且当成自己说的」。
// 单聊里 AI 的消息一律以 assistant 回填，不看是谁说的 —— 换了模型（或者无缝换窗把
// Claude 那几轮搬过来再切 GPT），GPT 看到的就是「我自己说过这些」。
// 群聊不走这里：群聊本来就要互相看见，那边改成 user + 昵称前缀（见下面 isGroup 那段）。
//
// 规矩：**每家只看得见自己那家回过的轮**。别家回过的那一轮整轮拿掉（她那句一起拿掉——
// 她那句本来就是说给别家听的，留下也会变成连续两条 user），在下一条留下来的消息前
// 写一句隔开了几轮，模型才知道这里不是连着的。
// 按「家」不按 config id 分：订阅 Claude 和 API Claude 是同一家，切过去不该自己看不见自己。
// 认不出是谁说的（老数据既没 modelId 也没昵称）就留着 —— 宁可漏隔也不把她的历史无端吃掉。
var _MODEL_FAMILY_RULES = [
  ['claude', /claude|anthropic|opus|sonnet|haiku|fable|克克|克劳德/],
  ['gpt', /gpt|openai|codex|chatgpt|(^|[^a-z])o[1-9](-|$|[^a-z0-9])/],
  ['gemini', /gemini|gemma/],
  ['deepseek', /deepseek/],
  ['qwen', /qwen|通义/],
  ['kimi', /kimi|moonshot/],
  ['glm', /glm|zhipu|智谱/],
  ['grok', /grok/],
];
function _modelFamilyGuess(s) {
  s = String(s || '').toLowerCase();
  if (!s) return '';
  for (const [fam, re] of _MODEL_FAMILY_RULES) if (re.test(s)) return fam;
  return '';
}
function modelFamilyOfConf(c) {
  if (!c) return '';
  if (c.isLocalClaude) return 'claude';
  if (c.isLocalGpt) return 'gpt';
  if (c.isGemini) return 'gemini';
  return _modelFamilyGuess(c.modelName) || _modelFamilyGuess(c.localModel)
    || ((c.apiBase || '').trim().replace(/\/$/, '').endsWith('/messages') ? 'claude' : '')
    || _modelFamilyGuess(c.nickname)
    || ('conf:' + c.id);                 // 认不出是哪家的模型：自己算一家
}
// 一条 AI 消息是哪家说的。多模型节点看被选中的那一版（身份在 variant 上，见 37-forge.js）。
// config 被删了就只剩昵称可猜；猜不出返回 ''（= 不隔）。
function modelFamilyOfNode(m) {
  const v = (m && m.isMulti && Array.isArray(m.variants)) ? (m.variants[m.chosenVariant || 0] || m.variants[0]) : null;
  const id = (v && v.modelId) ?? m?.modelId;
  const nick = (v && v.modelNickname) || m?.modelNickname || '';
  const confs = (typeof state === 'object' && state && Array.isArray(state.configs)) ? state.configs : [];
  const c = id != null ? confs.find(x => String(x.id) === String(id)) : null;
  if (c) return modelFamilyOfConf(c);
  return _modelFamilyGuess(nick);
}
function _isoForeign(n, mine) {
  if (!n || n.role !== 'ai') return false;
  const f = modelFamilyOfNode(n);
  return !!f && f !== mine;
}
// 这一条 AI 消息里有没有**自己家**写的那一版（需求：「让 GPT 看到自己的上一轮，Claude 看到自己的上一轮」）。
// 同时问了好几个模型、她挑了 Claude 那版时，GPT 那版其实就躺在 variants 里 —— 拿它顶上，
// 而不是因为她挑了别人就整轮看不见。同一个 config 的那版优先，其次同家里最新的。
// 返回一份浅拷贝（只换 chosenVariant），**绝不改原节点**：改了等于替她换了选中的那版。
function _isoOwnVariant(n, mine, confId) {
  if (!n || !n.isMulti || !Array.isArray(n.variants)) return null;
  let best = -1;
  n.variants.forEach((v, i) => {
    if (!v || v.streaming || !v.content) return;
    if (modelFamilyOfNode({ role: 'ai', modelId: v.modelId, modelNickname: v.modelNickname }) !== mine) return;
    if (best < 0 || String(v.modelId) === String(confId)) best = i;
  });
  return best < 0 ? null : Object.assign({}, n, { chosenVariant: best });
}
// 她那句底下有没有别的分支是自己家回的（重新生成时换了模型，旧的那条留在旁支上）。
function _isoOwnSibling(userNode, chat, mine, confId, kids) {
  if (!userNode || !chat || !chat.nodes) return null;
  if (!kids.map) {
    kids.map = new Map();
    for (const n of Object.values(chat.nodes)) {
      if (!n || n.role !== 'ai' || n.parentId == null) continue;
      const k = String(n.parentId);
      if (!kids.map.has(k)) kids.map.set(k, []);
      kids.map.get(k).push(n);
    }
  }
  let best = null, bestRank = -1;
  for (const n of kids.map.get(String(userNode.id)) || []) {
    if (n.streaming) continue;
    const own = n.isMulti ? _isoOwnVariant(n, mine, confId)
      : (!_isoForeign(n, mine) && modelFamilyOfNode(n) === mine && n.content ? n : null);
    if (!own) continue;
    const v = own.isMulti ? own.variants[own.chosenVariant] : own;
    const rank = (String(v.modelId) === String(confId) ? 1e15 : 0) + (Number(own.timestamp) || 0);
    if (rank > bestRank) { best = own; bestRank = rank; }
  }
  return best;
}
// 返回 { path: 隔离后的路径, notes: Map(留下的节点 → 它前面隔开了几轮), dropped: 拿掉几轮, swapped: 换成自己那版的条数 }
// 一轮里别家说的话，按顺序试：多模型节点换成自己那版 → 拿掉别家那几条、留下自己家也回了的 →
// 她那句底下找自己家回的旁支 → 都没有才整轮拿掉。
function modelIsolatePath(path, conf, chat = null) {
  const mine = modelFamilyOfConf(conf);
  const out = { path, notes: new Map(), dropped: 0, swapped: 0 };
  if (!mine || !Array.isArray(path) || !path.length) return out;
  const rounds = [];
  for (const n of path) {
    if (!n) continue;
    if (n.role === 'user' || !rounds.length) rounds.push([n]);
    else rounds[rounds.length - 1].push(n);
  }
  const kept = [];
  const kids = {};
  let pending = 0;
  for (const r of rounds) {
    let use = r;
    if (r.some(n => _isoForeign(n, mine))) {
      use = r.map(n => (_isoForeign(n, mine) && _isoOwnVariant(n, mine, conf.id)) || n);
      out.swapped += use.filter((n, i) => n !== r[i]).length;
      use = use.filter(n => !_isoForeign(n, mine));
      const hasAi = use.some(n => n.role === 'ai');
      const sib = !hasAi && r[0].role === 'user' ? _isoOwnSibling(r[0], chat, mine, conf.id, kids) : null;
      if (sib) { use = [r[0], sib]; out.swapped++; }
      else if (!hasAi) { pending++; out.dropped++; continue; }
    }
    if (pending) { out.notes.set(use[0], pending); pending = 0; }
    kept.push(...use);
  }
  if (out.dropped || kept.length !== path.length || kept.some((n, i) => n !== path[i])) out.path = kept;
  return out;
}

async function buildApiMessages(path, conf, isGroup = false, chat = null) {
  // 模型隔离：放在最前面，后面的世界书、系统提示、连续性压缩、看图记忆看到的都是隔离后的路径
  let _isoNotes = null, _isoDropped = 0;
  if (!isGroup && typeof modelIsolatePath === 'function') {
    const iso = modelIsolatePath(path, conf, chat);
    path = iso.path; _isoNotes = iso.notes; _isoDropped = iso.dropped + iso.swapped;
    if (_isoDropped) console.log(`[模型隔离] ${conf.nickname || conf.id}：拿掉别家回过的 ${iso.dropped} 轮，换回自己那版 ${iso.swapped} 条`);
  }
  // 当前这轮用户说了什么（日记「一提就摊开」的触发信号）
  const _lastUser = [...path].reverse().find(m => m && m.role === 'user');
  // 育儿室：孩子的状态面板得在 buildSystemPrompt（同步）之前拿到
  if (typeof nurseryEnsureBrief === 'function' && typeof nurseryEnabledFor === 'function' && nurseryEnabledFor(conf)) await nurseryEnsureBrief();
  // 高级记忆的语义路同理：查询向量要在这儿先算好（≤1.5 秒；模型没加载完就不等，本轮只用词法）
  if (typeof brainVecPrepare === 'function') await brainVecPrepare(chat);
  // 世界书的语义触发同理（共用同一个模型；没加载好就只看触发词）
  if (typeof worldbookPrepare === 'function') await worldbookPrepare(path, conf);
  const _sysSplit = {};
  let systemPrompt = buildSystemPrompt(conf, chat, (_lastUser && _lastUser.content) || '', path, _sysSplit);
  // Long-history compaction is branch-safe and per-model. Its summary changes only
  // at a hysteresis boundary, so it belongs in the stable prefix; the recent raw
  // tail stays byte-identical and keeps benefiting from provider prompt caching.
  // 窗口预算和下面裁剪用的是同一套算法：压缩那边要知道「不折的话会不会被裁」
  const ctxWindow = conf.maxTokens || 4096;
  const reply = Math.min(conf.maxReplyTokens || 1024, Math.floor(ctxWindow * 0.6));
  const windowLimit = ctxWindow - reply - 64;
  if (!isGroup && typeof continuityPreparePath === 'function') {
    const prepared = await continuityPreparePath(path, chat, conf,
      { historyBudget: windowLimit - estimateTokens(systemPrompt), isolated: _isoDropped > 0 });
    path = prepared.path;
    const block = typeof continuityInjectedBlock === 'function' ? continuityInjectedBlock(prepared.summary) : '';
    if (block) {
      _sysSplit.stable = String(_sysSplit.stable || '') + block;
      systemPrompt += block;
    }
  }
  const msgs = [{ role: 'system', content: systemPrompt }];

  // 用户的内心想法独立成 text block，与说出口的正文同属一条 user content。
  // XML 字符先转义，避免想法里恰好写了闭合标签时逃出边界。
  const userThinkingBlock = m => {
    const raw = String(m?.userThinking || '').trim();
    if (!raw) return null;
    const safe = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { type: 'text', text: `<user_thinking>${safe}</user_thinking>` };
  };

  // 裁剪到上下文窗口：粗略检查
  let totalTokens = estimateTokens(systemPrompt);
  // ⚠️ 护栏：推理/beta 模型往往把「单次回复上限」调得很大（要容纳思考链），
  // 若直接从上下文窗口里全额扣掉，windowLimit 会变负 → 历史被砍到只剩最新一句（静默失忆）。
  // 因此回复预留最多只吃窗口的 60%，历史至少保住 40%；正常配置（回复 < 60% 窗口）行为不变。
  // （ctxWindow / reply / windowLimit 挪到上面压缩之前算了，压缩要用）
  const pathReversed = [...path].reverse();
  const included = [];

  // ⚠️ 护栏之二（2026-07-19）：上面那条只堵了「回复预留吃爆窗口」，没堵「系统提示吃爆窗口」。
  // 系统提示 = 人格 + 三层记忆 + 日记 + 引擎简报 + 手环，开满几千 token 很正常；
  // 一旦它自己就顶到 windowLimit，下面的循环塞进最新一条就 break，AI 只看得见
  // 「系统提示 + 用户最后一句」—— 表现出来就是它完全不记得上文（
  // 用户说「看到了吗」，模型在思考里说"这条消息没有明确的上文"）。
  // 所以给历史一条硬地板：最近 HISTORY_FLOOR 条无条件带上，宁可略微超窗也不让对话断片。
  const HISTORY_FLOOR = 6;

  // 计数必须按「真正发出去的文本」算。历史里存的是烤好的 HTML（🍼 育儿结果块、
  // 表情 <img>），带 onclick、class、逐行 <br>，比压缩后虚胖好几倍；而压缩在下面第二个循环
  // 才做，以前是拿裸 HTML 去比 windowLimit —— 引擎播报越详细，历史被砍得越狠。
  // 这里先压一遍并缓存，第二个循环直接复用（顺手修掉旧代码在计数时忽略 variants 的偏差）。
  const _compressed = new Map();
  const compressedOf = (m) => {
    if (!_compressed.has(m)) {
      const raw = m.variants ? (m.variants[m.chosenVariant ?? 0]?.content || '') : (m.content || '');
      _compressed.set(m, stickerTagForApi(raw));
    }
    return _compressed.get(m);
  };

  /* 看过一次的图就记住（js/60-imgmem.js）：先给路径上的图补描述（只等这轮就要换成文字的那几张），
     再按「离末尾隔了几条用户消息」决定每张图发原图还是发描述。换不换只看位置和有没有描述，
     不随时间漂 —— 一张图一辈子只翻一次，之后每轮逐字节相同，缓存和会话续传都吃得住。 */
  if (typeof imgMemPrepare === 'function') await imgMemPrepare(path, conf);
  const _turnsFromEnd = typeof imgMemTurnsFromEnd === 'function' ? imgMemTurnsFromEnd(path) : new Map();
  const _imgSplit = new Map();
  const imgSplitOf = (m) => {
    if (!_imgSplit.has(m)) {
      _imgSplit.set(m, (m.role === 'user' && typeof imgMemSplit === 'function')
        ? imgMemSplit(m.images, _turnsFromEnd.get(m) || 0, conf)
        : { raw: m.images || [], text: '' });
    }
    return _imgSplit.get(m);
  };

  /* 历史里存下的老图在这里补缩一道（新图在 addPendingImg 那头就缩过了，这里是 no-op）。
     结果按消息对象缓存，同一轮里下面拼 parts 时直接复用，不重复解码。
     只缩要发原图的那几张；换成描述的不发图，也就不占图片的预算。 */
  const _shrunk = new Map();
  const shrunkImgsOf = async (m) => {
    if (_shrunk.has(m)) return _shrunk.get(m);
    const out = [];
    for (const img of imgSplitOf(m).raw) {
      if (typeof shrinkImgForApi === 'function') {
        const s = await shrinkImgForApi(img.url);
        out.push({ ...img, ...s });
      } else out.push(img);
    }
    _shrunk.set(m, out);
    return out;
  };
  const imgTokensOf = (imgs) => imgs.reduce(
    (s, i) => s + (typeof imgApiTokens === 'function' ? imgApiTokens(i) : 1230), 0);

  /* ⚠️ 图片必须算进预算（2026-08-19）。以前这里只数文本 —— 而一张 1910×896 的截图
     值 2280 token，比它上下几十条消息加起来还多。裁剪把它当成 0，于是「窗口还够」
     的判断整个偏掉：以为塞了 3000，实际发出去 8000。窗口设得紧的模型会因此
     莫名其妙地超窗 400，设得松的则是**每轮都在为一张看不见的图付钱**。 */
  for (const m of pathReversed) {
    const t = estimateTokens(compressedOf(m)) + imgTokensOf(await shrunkImgsOf(m)) + estimateTokens(imgSplitOf(m).text);
    if (totalTokens + t > windowLimit && included.length >= HISTORY_FLOOR) break;
    totalTokens += t;
    included.unshift(m);
  }

  // 别再静默：裁掉了东西就在控制台留痕；系统提示自己就吃掉大半个窗口时当场告诉用户，
  // 不用再靠 AI 表现出困惑来反推。
  if (included.length < pathReversed.length) {
    const sysTokens = estimateTokens(systemPrompt);
    console.warn(`[上下文裁剪] ${conf.nickname || conf.id}：历史 ${pathReversed.length} → ${included.length} 条`
      + `（窗口 ${ctxWindow} / 可用 ${windowLimit} / 系统提示 ${sysTokens}）`);
    if (sysTokens > windowLimit * 0.7 && !_ctxWarnedFor.has(conf.id)) {
      _ctxWarnedFor.add(conf.id);
      showToast(`⚠️ ${conf.nickname || '当前模型'}的系统提示已占满上下文（${sysTokens}/${windowLimit} token），历史只剩 ${included.length} 条。`
        + `调大「上下文窗口」，或关掉一部分记忆/日记/小组件。`, 'error', 8000);
    }
  }

  for (const m of included) {
    let content = compressedOf(m);
    // 换成描述的历史图：文字排在她那句话前面，和原来图排在文字前面的顺序一致
    const imgNote = imgSplitOf(m).text;
    if (imgNote) content = content ? `${imgNote}\n${content}` : imgNote;

    // 换窗（js/37-forge.js）搬过来的历史，段与段之间的时间断层。
    // **必须说出来**：不说的话模型看到的是一串紧挨着的消息，会默认它们前后相接，
    // 于是"三天前说的事"和"刚才说的事"被当成一口气聊完的。
    if (m.gapNote) content = `【${m.gapNote}】\n\n${content}`;
    // 模型隔离拿掉了前面几轮：同理必须说出来，不然它会把隔开的两段当成连着说的
    const isoN = _isoNotes && _isoNotes.get(m);
    if (isoN) content = `【这之前有 ${isoN} 轮是用户和别的 AI 的对话，按模型隔离省略了，你看不到】\n\n${content}`;
    // 换窗时 reasoning 被甩掉了，moodNote 是它的替身：一个词，说明当时是什么心境
    if (m.role === 'ai' && m.moodNote) content = `【当时的心境：${m.moodNote}】\n${content}`;
    // 电话里说到一半被打断（11-camera-call.js 的 n.callCut）：生成的全文还在，但 ta 只听到了前半截。
    // 不说的话模型下一轮会默认 ta 全听见了，接着后半截里的话往下聊（call_call 讲的 heard_text）
    if (m.role === 'ai' && m.callCut && typeof callCutNoteForApi === 'function') {
      const cutNote = callCutNoteForApi(m.callCut);
      if (cutNote) content = `${cutNote}\n${content}`;
    }

    if (isGroup && m.role === 'user' && typeof whoUserAliasFor === 'function') {
      const alias = whoUserAliasFor(chat);
      if (alias) content = `[${alias}]: ${content}`;
    }

    // 语音消息：AI 读到的一直是转写文本，看不出这是「说」的还是「打」的。
    // 标一下（连时长、连声音听感一起），语气、口语化的措辞才有依据。
    if (m.audio) {
      // 拆条语音的 m.audioDur 只是**第一段**的时长（别处一律靠 m.audio/m.audioDur 认
      // 「这是语音消息」，所以它必须挂第一段）。这里要报总时长，否则三段共 8 秒的语音
      // 会被告诉模型「你当时用语音条回复的（2 秒）」，它的语气判断就跟着歪。
      const secs = Math.max(1, Math.round(m.voiceParts?.length
        ? m.voiceParts.reduce((t, p) => t + (p.dur || 0), 0)
        : (m.audioDur || 1)));
      const hint = m.voiceEmo?.hint ? `｜听感：${m.voiceEmo.hint}` : '';
      content = m.role === 'user'
        ? `【用户发来一条 ${secs} 秒的语音消息${hint}。以下是转写文本】\n${content}`
        : `【你当时是用语音条回复的（${secs} 秒），以下是内容】\n${content}`;
    }

    // 引用消息：拼在正文前发给 AI（以前只在 UI 上显示，所有模型都看不到用户在回复哪段话）
    if (m.role === 'user' && m.quotes?.length) {
      const qLines = m.quotes.map(q => `> ${(typeof q === 'string' ? q : q.text) || ''}`).join('\n');
      content = `【用户引用了以下内容并回复】\n${qLines}\n\n${content}`;
    }

    // 🌟 在打包发送前，偷偷把用户节点里携带的文本文件内容拼接上去
    if (m.role === 'user' && m.files && m.files.length > 0) {
      let txtContents = "";
      for (const fileObj of m.files) {
        if (fileObj && fileObj.name && fileObj.content) {
          // 只拦截需要读文字的文件类型（例如以 .txt 结尾的文件）
          if (fileObj.kind === 'audio' && typeof fileObj.content === 'string') {
            // 音频是「听到了什么」的描述（66-audio-attach.js），不是要逐行引用的文件，行号只会添乱
            txtContents += `\n--- 附件音频: ${fileObj.name} ---\n${fileObj.content}\n--- 附件内容结束 ---\n`;
          } else if (fileObj.content && typeof fileObj.content === 'string') {
            // 📍 添加行号功能
            const lines = fileObj.content.split('\n');
            const numberedContent = lines.map((line, idx) => `${idx + 1}  ${line}`).join('\n');
            txtContents += `\n--- 附件文件: ${fileObj.name} (共 ${lines.length} 行) ---\n${numberedContent}\n--- 附件内容结束 ---\n`;
          }
        }
      }
      if (txtContents) {
        content = `【系统提示：以下是用户上传的文件内容，每行开头的数字是行号，请结合这些内容回答用户的问题】\n${txtContents}\n\n【用户问题】：\n${content}`;
      }
    }

    // ── 群聊：别的 AI 说的话必须以 user 身份进来（2026-07-27 修）──
    // 以前这里只加了个 `[昵称]: ` 前缀，role 还是 assistant，于是：
    //   1) 语义上，小B 说的话在小C 眼里变成「小C 自己上一句说的」——它会接着往下写、
    //      自相矛盾，或者认领别人的观点。机和机根本没在交流，是各自对着自己的复读。
    //   2) 结构上，user → assistant(A) → assistant(B) 出现**连续 assistant**，
    //      Anthropic 那条路要求 user/assistant 严格交替，直接 400；OpenAI 兼容端
    //      不报错但会把最后一条 assistant 当成"续写开头"，回复经常接在别人半句后面。
    // 现在：只有「自己说过的」是 assistant，其他成员一律 user + 昵称前缀，
    // 再由下面的合并 pass 把相邻同角色的消息并起来，保证交替。
    // 发送时间排在最前面（引用、语音、附件那些前缀都在它后面），规则见 msgSentStamp
    if (m.role === 'user') {
      const stamp = msgSentStamp(m.timestamp);
      if (stamp) content = content ? `${stamp}\n${content}` : stamp;
    }

    let apiRole = m.role === 'user' ? 'user' : 'assistant';
    if (isGroup && m.role === 'ai' && m.modelId && m.modelId !== conf.id) {
      content = `[${m.modelNickname || '其他AI'}]: ${content}`;
      apiRole = 'user';
    }

    // 消息上的 emoji 标注也要发过去：贴了它看不见等于对着空气点赞；
    // 它自己贴过什么也得记得，不然下一轮会把同一个 emoji 再贴一遍。
    if (typeof reactionsForApi === 'function') content += reactionsForApi(m);

    const thinkingPart = m.role === 'user' ? userThinkingBlock(m) : null;
    if (m.role === 'user' && (imgSplitOf(m).raw.length || thinkingPart)) {
      const isAnthropic = (conf.apiBase || '').trim().replace(/\/$/, '').endsWith('/messages');
      // 缩过的那份（上面裁剪时已经算好并缓存），不是节点里的原图
      const parts = (await shrunkImgsOf(m)).map(img => {
        if (isAnthropic) {
          // Anthropic 格式：从 base64 Data URL 中提取 media_type 和 data
          const match = img.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
          } else {
            // 纯 URL（非 base64），使用 url 类型
            return { type: 'image', source: { type: 'url', url: img.url } };
          }
        } else {
          // OpenAI / 兼容格式
          return { type: 'image_url', image_url: { url: img.url } };
        }
      });
      /* 视频说明要排在**所有帧前面**：模型是顺着读的，先知道「接下来这几张是
         同一段视频、分别是第几秒」，才能把它们当成一段时间序列而不是几张散图。
         排后面的话它已经按散图理解完了。 */
      if (m.videoNote?.length) parts.unshift({ type: 'text', text: m.videoNote.join('\n') });
      if (thinkingPart) parts.push(thinkingPart);
      if (content) parts.push({ type: 'text', text: content });
      msgs.push({ role: 'user', content: parts });
    } else {
      msgs.push({ role: apiRole, content });
    }
  }

  // ── 相邻同角色合并（群聊必需，单聊天然就是交替的，跑过去等于空转）──
  // 群里连着好几个 AI 发言，转成 user 之后就是一串连续 user；Anthropic 要求
  // user/assistant 严格交替，不合并照样 400。带图片的消息 content 是数组，
  // 两边都是数组才拼数组，一边是字符串就先转成 text part，避免把对象拼成 "[object Object]"。
  if (isGroup) {
    const merged = [];
    for (const m of msgs) {
      const prev = merged[merged.length - 1];
      if (!prev || prev.role !== m.role || m.role === 'system') { merged.push(m); continue; }
      const asParts = c => Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
      if (typeof prev.content === 'string' && typeof m.content === 'string') {
        prev.content = prev.content + '\n\n' + m.content;
      } else {
        prev.content = [...asParts(prev.content), ...asParts(m.content)];
      }
    }
    msgs.length = 0; msgs.push(...merged);
    // Anthropic 还要求第一条非 system 必须是 user。群聊正常都是用户先开口，
    // 但从某条 AI 消息重新生成分支时可能不是——补一句占位，别让整轮 400。
    const firstIdx = msgs.findIndex(m => m.role !== 'system');
    if (firstIdx >= 0 && msgs[firstIdx].role !== 'user') {
      msgs.splice(firstIdx, 0, { role: 'user', content: '（继续群聊）' });
    }
  }

  // ── 联网搜索（单聊专属，群聊不启用）──
  if (!isGroup && chat?.webSearchEnabled && state.webSearchApiKey) {
    const lastUser = [...path].reverse().find(m => m.role === 'user');
    const query = lastUser?.content?.trim();
    if (query) {
      const results = await performWebSearch(query);
      if (results) {
        // ⚠️ 顺手修的老 bug：以前这条是 splice 成第二条 system 消息的，而 Anthropic 那条路
        // 只取 messages.find(role==='system') 的**第一条**、然后把其余 system 全 filter 掉——
        // 搜索结果被整条丢弃，Claude 系模型开着联网也永远看不到搜索结果，且不报任何错，
        // 表现只像"它没参考搜索"。现在并进 volatile，两条路都收得到。
        _sysSplit.volatile = (_sysSplit.volatile || '') +
          `\n\n以下是与用户最新问题相关的实时网页搜索结果（来自网络，可能不完全准确，请甄别使用）：\n\n${results}`;
      }
    }
  }

  // ── 省 token 的关键一步：把每轮都变的那截从 system 挪到最后一条用户消息前 ──
  // 见 buildSystemPrompt 顶上的注释。放在最后做，是为了让上面的搜索结果也一起挪走。
  // 这一步对所有 API 都做：OpenAI / DeepSeek / 中转那边的缓存是自动的（前缀够长就命中），
  // 同样受不了"系统提示第二行就是当前时间"——那等于每分钟把整个前缀作废一次。
  relocateVolatilePrompt(msgs, _sysSplit);
  return msgs;
}

// 历史里每条用户消息开头标上发送时间。
// 用户：「让 AI 分清楚对话框每条聊天消息发的时间」—— 以前整段历史只有一句「现在几点」，
// 模型分不出哪句是三天前说的、哪句是刚才说的，老在回复里改口说自己看错了时间。
// ⚠️ 只标用户消息，不标 AI 自己的：自己历史里有什么格式，它下一轮就写什么格式
//    ，标上去它会学着在每条回复开头写时间戳。
// ⚠️ 必须是绝对时间、固定时区：「3 分钟前」这种每轮都变的写法，会把它后面整段历史的
//    提示缓存全部打废（见 buildSystemPrompt 顶上 stable/volatile 那段）。时区写死上海，
//    电脑和手机算出来逐字节一样。
// （放在 buildApiMessages 后面而不是前面：好几个测试从 `async function buildApiMessages(` 起抠这一段去跑）
const _MSG_STAMP_WEEK = ['日', '一', '二', '三', '四', '五', '六'];
let _msgStampFmt = null;
function msgSentStamp(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (!_msgStampFmt) _msgStampFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {};
  for (const x of _msgStampFmt.formatToParts(new Date(n))) p[x.type] = x.value;
  const week = _MSG_STAMP_WEEK[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
  return `[${p.year}-${p.month}-${p.day} 周${week} ${p.hour}:${p.minute}]`;
}

// 把 volatile 段从 system 里摘出来，塞到最后一条用户消息的正文之前。
// 加了醒目的分隔框：模型得知道这段是系统给的实时状态，不是用户打的字。
function relocateVolatilePrompt(msgs, split) {
  const vol = String(split.volatile || '').trim();
  const stable = String(split.stable || '').trim();
  if (!vol || !stable) return;                 // 没分段（老调用）就原样不动
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 1; i--) if (msgs[i].role === 'user') { lastUser = i; break; }
  if (lastUser < 0) return;                    // 一条用户消息都没有，那就让它留在 system 里
  msgs[0].content = stable;
  const wrapped = `【本轮实时信息（系统给你的，不是用户说的话）】${vol}\n【实时信息结束，以下是用户这一轮说的话】\n\n`;
  const m = msgs[lastUser];
  if (Array.isArray(m.content)) m.content.unshift({ type: 'text', text: wrapped });
  else m.content = wrapped + m.content;
}

// ═══════════════════════════════════════════════════════
// WEB SEARCH - 支持多种搜索引擎
// ═══════════════════════════════════════════════════════
async function performWebSearch(query) {
  const provider = state.webSearchProvider || 'tavily';

  // DuckDuckGo 无需 API Key
  if (provider === 'duckduckgo') {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
      const resp = await fetch(url);
      if (!resp.ok) { showToast('🔍 DuckDuckGo 搜索失败', 'error'); return null; }
      const data = await resp.json();
      if (!data.RelatedTopics?.length) return null;
      return data.RelatedTopics.slice(0, 5).map((r, i) =>
        `[${i+1}] ${r.Text}\n${r.FirstURL || ''}`
      ).join('\n\n');
    } catch (e) {
      console.warn('DuckDuckGo search failed', e);
      showToast('🔍 DuckDuckGo 搜索请求失败', 'error');
      return null;
    }
  }

  // 其他引擎需要 API Key
  if (!state.webSearchApiKey) return null;

  try {
    let url, body, headers;

    if (provider === 'tavily') {
      url = 'https://api.tavily.com/search';
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({
        api_key: state.webSearchApiKey,
        query: query,
        max_results: 5
      });
    } else if (provider === 'serper') {
      url = 'https://google.serper.dev/search';
      headers = {
        'Content-Type': 'application/json',
        'X-API-KEY': state.webSearchApiKey
      };
      body = JSON.stringify({ q: query, num: 5 });
    } else if (provider === 'brave') {
      url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      headers = {
        'Accept': 'application/json',
        'X-Subscription-Token': state.webSearchApiKey
      };
      body = null;
    }

    const resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: headers,
      body: body
    });

    if (!resp.ok) {
      showToast(`🔍 ${provider} 搜索失败 (${resp.status})`, 'error');
      return null;
    }

    const data = await resp.json();

    // 解析不同引擎的响应格式
    let results = [];
    if (provider === 'tavily') {
      results = data.results || [];
      return results.map((r, i) =>
        `[${i+1}] ${r.title}\n${r.url}\n${(r.content||'').slice(0,500)}`
      ).join('\n\n');
    } else if (provider === 'serper') {
      results = data.organic || [];
      return results.map((r, i) =>
        `[${i+1}] ${r.title}\n${r.link}\n${(r.snippet||'').slice(0,500)}`
      ).join('\n\n');
    } else if (provider === 'brave') {
      results = data.web?.results || [];
      return results.map((r, i) =>
        `[${i+1}] ${r.title}\n${r.url}\n${(r.description||'').slice(0,500)}`
      ).join('\n\n');
    }

    return null;
  } catch (e) {
    console.warn('web search failed', e);
    showToast('🔍 联网搜索请求失败', 'error');
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// API REQUEST HELPERS — shared streaming + thinking mode
// ═══════════════════════════════════════════════════════
// 5 代及 4.7+ 的 Claude：只认 adaptive 思考，且 temperature/top_p/top_k 一律 400。
// 走中转（OpenAI 兼容口）时这些约束照样成立 —— 中转只是转发，Anthropic 那头该拒还是拒。
// haiku-5（2026-10-07 的 Haiku 5.5）也是这一代：budget_tokens 和 temperature≠1 都 400。
// 别写成 /haiku/ —— Haiku 4.5 是老规矩，给它发 adaptive 一样 400。
function isAdaptiveOnlyClaude(modelName) {
  return /fable|mythos|opus-5|opus-4[.-][789]|sonnet-5|haiku-5/.test(String(modelName || '').toLowerCase());
}

/* OpenAI 兼容格式下的提示词缓存。
   走中转的 Claude（apiBase 是 /openai 这种）以前**一点缓存都没有**：applyPromptCache
   只在 apiBase 以 /messages 结尾时才调用，于是同一个 claude-opus 走官方端点省九成，
   走中转全价重发，而两边看起来一模一样。
   new-api / one-api 这类中转多数会把 cache_control 原样透传给 Anthropic，认不出的
   会 400 —— 由 callAPIStream 里那道降级兜住，并把「这个端点不吃」记在 conf 上。
   断点位置和 applyPromptCache 一样：system 一个，最后一条用户消息**之前**那条一个。 */
function applyOpenAiPromptCache(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return;
  const mark = (m) => {
    if (!m) return;
    if (typeof m.content === 'string') {
      if (!m.content) return;
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(m.content) && m.content.length) {
      const last = m.content[m.content.length - 1];
      if (last) last.cache_control = { type: 'ephemeral' };
    }
  };
  const sys = msgs.find(m => m.role === 'system');
  mark(sys);
  // 最后一条挂着每轮都变的实时信息，缓存了也永远命中不了 —— 断点要打在它前面那条
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break; }
  const cutoff = (lastUser >= 0 ? lastUser : msgs.length) - 1;
  if (cutoff >= 0 && msgs[cutoff] !== sys) mark(msgs[cutoff]);
}
/* 这个端点被拒过就先别再试。记的是**上次被拒的时间**而不是一个 true：
   中转以后支持了也能自动恢复，不用她去翻配置。代价是最多七天白试一次。 */
function promptCacheAllowed(conf) {
  const t = conf && conf.noPromptCache;
  // 必须显式验类型：写成 `if (!t)` 的话，一个老版本留下的 `true` 会走进下面那行，
  // `Date.now() - true` 算出个天文数字 → 判成「很久以前被拒的」→ 每轮都白试一次 400。
  // 看不懂的值一律当成没记过（宁可多试一次，也不要静默永久关掉缓存）。
  if (typeof t !== 'number' || !t) return true;
  return (Date.now() - t) > 7 * 24 * 3600 * 1000;
}

function buildRequestBody(conf, messages, withCache) {
  const adaptiveOnly = isAdaptiveOnlyClaude(conf.modelName);
  const body = {
    model: conf.modelName,
    // 带缓存时必须深一层复制：messages 是调用方的数组，直接在上面挂 cache_control
    // 会污染它，降级重发那一次就还带着标记 —— 于是"降级"根本没降下去，永远 400。
    messages: withCache
      ? messages.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.map(p => ({ ...p })) : m.content }))
      : messages,
    max_tokens: conf.maxReplyTokens || 1024,
    stream: true
  };
  if (withCache) applyOpenAiPromptCache(body);
  // temperature 在 opus-5 / fable-5 / sonnet-5 / opus-4.7+ 上是会 400 的参数，
  // 中转把它原样转过去就整轮失败。这几个模型直接不发。
  if (!adaptiveOnly) body.temperature = conf.temp;

  const mode = conf.thinkingMode || 'auto';
  // 全开思考 / 不开思考 走 reasoning_effort（兼容 OpenAI / OpenRouter 风格的推理参数）
  // "模型自己选" 不附带该字段，交由模型/服务端默认行为决定
  if (mode === 'always') {
    body.reasoning_effort = 'high';
  } else if (mode === 'off') {
    body.reasoning_effort = 'low';
    body.enable_thinking = false;
    if (!/fable|mythos/.test(String(conf.modelName || '').toLowerCase())) {
      body.thinking = { type: 'disabled' };   // fable/mythos 连 disabled 都 400
    }
  }
  // 思考链看不见的真凶（2026-07-27）：5 代模型的 thinking.display **默认是 'omitted'**，
  // 思考照做照计费，但回来的文本是空的。sonnet-4.6 时代默认还是 'summarized'，
  // 所以用户换到 5 代后 opus-5 / fable-5 / sonnet-5 三个一起"没有思考链了" ——
  // 不是哪个模型不给，是这一代把默认改了，而这条中转路径从来没提过 display。
  // 只要不是明确关思考，就把 summarized 要出来；中转不认这个字段也只是被忽略，无害。
  if (adaptiveOnly && mode !== 'off') {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.max_tokens = Math.max(body.max_tokens, 8192);   // 思考也从 max_tokens 里扣
  }
  return body;
}

// Anthropic 思考模式 —— 按模型代际发不同参数：
// fable/mythos/opus-5/opus-4.7+/sonnet-5 只认 adaptive，发 budget_tokens 会直接 400；
// fable/mythos 连 {type:'disabled'} 都会 400，关思考只能整个不发 thinking 字段。
// ⚠️ `opus-5` 得单列一条：opus-4[.-][789] 那段只盖 4.7/4.8/4.9，
// claude-opus-5 不在里面，漏了就会给它发 budget_tokens 然后整轮 400。
function applyAnthropicThinking(conf, requestBody) {
  const mode = conf.thinkingMode || 'auto';
  const mdl = (conf.modelName || '').toLowerCase();
  const adaptiveOnly = isAdaptiveOnlyClaude(mdl);   // 和中转那条路共用同一套判定
  const noDisable = /fable|mythos/.test(mdl);
  if (mode === 'always') {
    if (adaptiveOnly) {
      // display:'summarized' 才能拿到可读的思考摘要（默认 omitted 是空文本）
      requestBody.thinking = { type: 'adaptive', display: 'summarized' };
      // 思考也从 max_tokens 里扣，太小会思考到一半被截断
      requestBody.max_tokens = Math.max(requestBody.max_tokens, 8192);
    } else {
      let budget = parseInt(conf.thinkingBudget);
      if (!budget || budget < 1024) budget = 8000; // "无限制"(-1)/非法值 → 8000
      requestBody.thinking = { type: 'enabled', budget_tokens: budget };
      // API 要求 max_tokens > budget_tokens，否则 400
      requestBody.max_tokens = Math.max(requestBody.max_tokens, budget + 2048);
    }
  } else if (mode === 'off' && !noDisable) {
    requestBody.thinking = { type: 'disabled' };
  } else if (mode !== 'off' && adaptiveOnly) {
    // 「自动」模式（2026-07-27 修）：Opus 5 / Fable 5 / Sonnet 5 这些模型**思考默认就是开的**，
    // 不传 thinking 一样会思考、一样计费；但 display 默认是 'omitted'，
    // 回来的 thinking 块里文本是空字符串 —— 表现就是「这个模型不显示思考链」。
    // 看起来像只有 sonnet-5 能显示，其实是那个配置的思考设成了「总是」而已。
    // 既然思考费照付，白拿一份摘要没有任何理由不要。
    requestBody.thinking = { type: 'adaptive', display: 'summarized' };
    requestBody.max_tokens = Math.max(requestBody.max_tokens, 8192);
  }
  return requestBody;
}

// ═══════════════════════════════════════════════════════
// 提示词缓存（Anthropic）—— 长对话省 token 的大头
// ═══════════════════════════════════════════════════════
// 每轮请求都要把整份系统提示 + 全部历史重发一遍，这是聊天类应用天生的浪费：
// 聊到第 50 轮，前 49 轮的内容已经原样送过 49 次了。Anthropic 的缓存能把
// 重复的那一段按 1 折计价（写入 1.25 倍，只发生一次），但它认的是**前缀**：
// 从第一个字节开始逐字节相同才算命中，中间变一个字，后面全部作废。
//
// 前半段已经由 relocateVolatilePrompt 做掉了（每轮都变的那截被挪到最后一条用户消息前，
// system 只剩一字不改的稳定段）。这里只负责打断点：
//   ① system 末尾一个 → 整份人格/技能说明缓存住。
//   ② 最后一条用户消息**之前**那条末尾再一个 → 这一轮真正写入的只有最后一来一回，
//      下一轮它就成了能命中的旧前缀。断点不打在最后一条上：那条挂着实时信息，
//      每轮都不同，缓存了也永远命中不了，纯浪费一次写入（写入还贵 25%）。
// 最多 4 个断点，这里用 2 个。
//
// 中转不认 cache_control 时会 400，callAPIStream 里有一次自动降级重试兜底。
function applyPromptCache(body, chatMessages) {
  if (typeof body.system !== 'string' || !body.system.trim()) return;

  // ① system 最稳定也最肥，保 1h；增长中的对话历史仍保默认 5m，避免每轮付 2x 写入。
  // Anthropic 要求混用时长 TTL 必须排在短 TTL 前面：这里正好是 system → messages。
  body.system = [{ type: 'text', text: body.system,
    cache_control: { type: 'ephemeral', ttl: '1h' } }];

  // ② 历史断点：最后一条用户消息之前那条
  let lastUser = -1;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === 'user') { lastUser = i; break; }
  }
  const cutoff = (lastUser >= 0 ? lastUser : chatMessages.length) - 1;
  if (cutoff >= 0) {
    const m = chatMessages[cutoff];
    if (Array.isArray(m.content)) {
      const last = m.content[m.content.length - 1];
      if (last) last.cache_control = { type: 'ephemeral' };
    } else if (typeof m.content === 'string' && m.content) {
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
    }
  }
}

// 缓存命中情况：控制台每轮都打，弹窗每个模型每次启动只弹一次
// （每条回复都弹一个 token 提示，用两天就想把这功能关了）
var _cacheToasted = new Set();
function reportCacheUsage(conf, usage) {
  if (!usage) return;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const fresh = usage.input_tokens || 0;
  const total = read + write + fresh;
  if (!total) return;
  const pct = Math.round(read / total * 100);
  console.log(`💰 ${conf.nickname || conf.modelName} 输入 ${total} tokens：缓存命中 ${read} (${pct}%) · 写入 ${write} · 新增 ${fresh}`);
  if (read > 0 && !_cacheToasted.has(conf.id)) {
    _cacheToasted.add(conf.id);
    showToast(`💰 提示词缓存已生效：这轮 ${total} token 里有 ${read} (${pct}%) 走的缓存价`, 'success', 4000);
  }
}

// 电脑操控的产物清单 → markdown。图片就地显示，其余给个能点开的链接。
// 走的是 /api/agent-file，服务端只放行「确实被某次操控写过」的文件。
// 这台设备的固定标识，存 localStorage。必须是**跨会话稳定**的：
// 每次调用现摇一个的话，「App 被 ROM 杀掉重开、顶掉自己那条僵尸连接」永远对不上号，
// 只能干等服务端 TCP 超时（可能好几分钟，也可能一直不超时）。
let _agentDeviceId = null;   // 内存缓存：localStorage 写失败时不能每次现摇一个新的
function agentDeviceId() {
  if (_agentDeviceId) return _agentDeviceId;
  let id = null;
  try { id = localStorage.getItem('kuro_agentDeviceId'); } catch (e) {}
  if (!id) {
    id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('kuro_agentDeviceId', id); } catch (e) {}
  }
  // 没有这行缓存的话：setItem 一失败（配额满/隐私模式），下次 getItem 还是空 →
  // 又摇一个新 id。于是 POST 用 X 登记、重连带 Y，服务端那条死 TCP 还挂着 →
  // 409 → 当成「别的设备在用」让位并销账 → 活永久丢失，还告诉她被别人接走了。
  _agentDeviceId = id;
  return id;
}

// 把一条 ⚠️ 追加到节点上。**必须同时进 blocks** ——
// 06-render-msg.js:436 是 `else if (m.blocks?.length) → renderBlocksHtml(m.blocks)`，
// blocks 非空时渲染**完全不看 content**。而只要收到过一个字 blocks 就非空，
// 所以只写 content 的话她看到的是一个断在半句话的气泡，看着像正常跑完。
function appendWarnBlock(node, error) {
  const warn = `⚠️ ${error}`;
  const blks = Array.isArray(node.blocks) ? node.blocks.slice() : [];
  const last = blks[blks.length - 1];
  if (last && last.type === 'text') {
    blks[blks.length - 1] = { ...last, text: last.text + '\n\n' + warn };
  } else {
    blks.push({ type: 'text', text: warn });
  }
  node.blocks = blks;
  node.content = node.content ? node.content + '\n\n' + warn : warn;
}

function agentFileUrl(rel, download) {
  return `${SERVER_BASE}/api/agent-file?rel=${encodeURIComponent(rel)}${download ? '&download=1' : ''}`;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function renderAgentArtifacts(list) {
  let md = '\n\n---\n**📦 这轮写出来的文件**\n\n';
  for (const a of list) {
    if (a.image) {
      md += `![${a.name}](${agentFileUrl(a.rel)})\n\n`;
      md += `\`${a.rel}\` · ${fmtBytes(a.size)}\n\n`;
    } else if (a.viewable) {
      md += `- [${a.name}](${agentFileUrl(a.rel)}) · ${fmtBytes(a.size)} · \`${a.rel}\`\n`;
    } else {
      // 打不开的类型（exe/zip 之类）只给下载
      md += `- [${a.name}](${agentFileUrl(a.rel, true)}) · ${fmtBytes(a.size)} · 下载\n`;
    }
  }
  return md + '\n';
}

// ── 流归属：哪条流是哪个对话的 ──────────────────────────────────
// streamCompletion 给每个 AbortController 挂 gcChat（发起它的对话）。_streamControllers 本身
// 是全局一锅的，只能回答「有没有**任何**流在跑」；要问「**这个**对话在不在生成」得看归属。
// 按 id 比而不是只比对象：云同步合并会整个替换 state.chats 里的对话对象，同一个对话换了个壳。
function _streamBelongsTo(ctrl, chat) {
  const o = ctrl && ctrl.gcChat;
  return !!(o && chat && (o === chat || (o.id != null && o.id === chat.id)));
}
function chatIsGenerating(chat) {
  if (!chat) return false;
  for (const c of _streamControllers) if (_streamBelongsTo(c, chat)) return true;
  return false;
}
// 只停这一个对话的流（含多模型并排的各个 variant —— 它们挂的是同一个对话），
// 后台别的对话正在生成的不动。返回停掉了几条。给 stopGeneration 用。
function abortChatStreams(chat) {
  let n = 0;
  for (const c of [..._streamControllers]) {
    if (!_streamBelongsTo(c, chat)) continue;
    try { c.abort(); } catch (e) {}
    _streamControllers.delete(c);
    n++;
  }
  return n;
}

// 通用流式请求：每次收到增量都会调用 onUpdate(fullText, reasoningText)
// 返回 { fullText, reasoningText, error, aborted }
// resumeRunId：不发新请求，直接去挂一个电脑上已经在跑（或刚跑完）的活，从头回放。
// App 被系统杀掉后重开走这条路。
// originChat：发起这一轮的对话。电脑操控的 runId 要写回它，不能写给「当前」那个 ——
// 一轮活能跑好几分钟，用户完全可能中途切到别的对话去。
// 电脑操控「正在写」的预览：工具参数是一截一截来的半个 JSON（{"file_path":"D:\\x.js","content":"const a…），
// 解析不了整体，就按字段名把**已经到了的那部分**字符串抠出来（末尾没闭合也认）。
const _TOOL_DRAFT_LABEL = { Write: '✍️ 正在写', Edit: '✏️ 正在改', MultiEdit: '✏️ 正在改', NotebookEdit: '✏️ 正在改', Bash: '⌨️ 正在敲', PowerShell: '⌨️ 正在敲' };
function _toolDraftField(json, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(json);
  if (!m) return null;
  let s = m[1];
  for (let i = 0; i < 3; i++) {   // 半截转义（结尾刚好是 \ 或 \u12）剪掉再解
    try { return JSON.parse('"' + s + '"'); } catch { s = s.replace(/\\(u[0-9a-fA-F]{0,3})?$/, ''); }
  }
  return m[1];
}
function toolDraftMd(name, json) {
  const label = _TOOL_DRAFT_LABEL[name];
  if (!label) return '';   // 读文件、搜索这类参数就一两个词，等完整的 🔧 块就好
  const where = _toolDraftField(json, 'file_path') || _toolDraftField(json, 'notebook_path') || '';
  let body = _toolDraftField(json, 'content') ?? _toolDraftField(json, 'new_string')
    ?? _toolDraftField(json, 'new_source') ?? _toolDraftField(json, 'command') ?? '';
  // 只留最后 80 行：整个文件每 60ms 重排一次，手机上大文件会卡；她要看的是「正写到哪」
  const lines = body.split('\n');
  if (lines.length > 80) body = `…（前面 ${lines.length - 80} 行）\n` + lines.slice(-80).join('\n');
  const ext = (where.match(/\.([A-Za-z0-9]+)$/) || [])[1] || (/^(Bash|PowerShell)$/.test(name) ? 'sh' : '');
  // 代码里自己带 ``` 的话围栏要比它长，不然写到一半就把代码块提前关了
  const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(x => x[0].length + 1)));
  return `\n\n> **${label}**${where ? ' `' + where.replace(/`/g, '') + '`' : ''}\n${fence}${ext}\n${body}\n${fence}\n`;
}

async function streamCompletion(conf, messages, onUpdate, resumeRunId, originChat) {
  let fullText = '', reasoningText = '';
  let blocks = [];
  let _lastBlockType = null;
  // 电脑操控正在写的文件（server 的 toolDraft live 帧）。草稿就地画在当前正文块末尾，
  // 记下它从哪开始，下一个真事件一来就整段剪掉 —— 它只是「正在写」的预览，不进记录。
  // 每个 return 之前都得剪干净（见 _dropToolDraft 的调用处），不然半截代码会被当正文落盘。
  let _draft = null;
  const _dropToolDraft = () => {
    if (!_draft) return;
    const b = blocks[_draft.at];
    if (b) b.text = b.text.slice(0, _draft.off);
    fullText = fullText.slice(0, _draft.fullOff);
    _draft = null;
  };

  // 🎯 本地 Claude / 本地 GPT — 完整上下文 + 思考链 + 可中断
  if (conf.isLocalClaude || conf.isLocalGpt || conf.isGemini) {
    if (!originChat) originChat = getActiveChat();   // 调用方没给就现取，至少别写错对话
    // Gemini 挂在这条分支上纯粹是为了复用底下那整套读流/中断/断线处理 ——
    // 它本身不是「本地」的：直连 Google，没有 CLI、没有 runId、接不回来。
    const localName = conf.isGemini ? (conf.geminiVia === 'sub' ? '订阅Gemini' : 'Gemini') : conf.isLocalGpt ? '订阅GPT' : '订阅Claude';
    const localEndpoint = conf.isGemini ? '/api/local-gemini'
                        : conf.isLocalGpt ? '/api/local-gpt' : '/api/local-claude';
    const ctrl = new AbortController();
    ctrl.gcChat = originChat || null;   // 这条流属于哪个对话：Enter 拦截 / 只停当前对话要靠它（见 chatIsGenerating）
    _streamControllers.add(ctrl);
    updateStreamUI();
    // 提在 try 外面：finally 里要用它给这个活「销账」。
    // 销账必须收在一处 —— 散到各个调用方的话，4 条调用路（callAPI / 群聊 / 变体重跑 /
    // resumeAgentRun 自己）加上出错、被停、让位这些早返回，漏一条就变成
    // 「每次切回前台重放一遍并落盘」，比不做还糟。
    //
    // claimRun：这条流是不是**拿到头了**。「流结束」分两类，只有第一类能销账：
    //   拿到头  = 跑完 / 服务端报错 / 她自己叫停 / 让位给别的设备 / 电脑那边已经没这个活了
    //   没拿到头 = 网断了、重连全失败、非 Abort 的异常  ← 必须留 claimed=false，
    //             否则她在地铁里断的网，回家开 App 就再也捞不回来了
    //             （/api/agent-runs 是唯一的找回入口，没有手动重接的 UI）
    // 初值取 resumeRunId 而不是 null：找回那条路一进门就该认得自己在跟哪个活打交道。
    // 写 null 的话，1112 行那个 404/409 早返回发生在读流之前 —— 此时还没收到 {runId} 帧，
    // 于是 finally 的门 `claimRun && runId` 不成立，claimRun 设了等于白设，
    // 这个对话继续挂在 pending 里每轮白跑一次清单请求 + 全量写盘。
    // 顺带：找回的流若在 {runId} 帧之前就断，reattachAgentRun 也不会再因 !runId 直接放弃。
    // runKind：这个活是电脑操控的（'agent'）还是纯聊天的（'chat'）。服务端在 {runId} 帧里说。
    // 默认 'agent'：走 resumeRunId 找回的一定是 agent 轮（只有 agent 轮才把 runId 记在对话上），
    // 老服务端不发 kind 时也只有 agent 轮会有 runId。
    let runId = resumeRunId || null, claimRun = false, runKind = 'agent';
    try {
      // 提取 system prompt，把其余消息转成 {role, content} 文本数组（保留图片）
      const sysMsg = messages.find(m => m.role === 'system');
      const chatMsgs = messages.filter(m => m.role !== 'system').map(m => {
        if (typeof m.content === 'string') {
          return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
        }
        const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const imgs = m.content
          .filter(c => c.type === 'image_url' || c.type === 'image')
          .map(c => {
            if (c.type === 'image_url') return c.image_url.url;
            if (c.source?.data) return `data:${c.source.media_type};base64,${c.source.data}`;
            return null;
          }).filter(Boolean);
        return { role: m.role === 'user' ? 'user' : 'assistant', content: text, ...(imgs.length ? { images: imgs } : {}) };
      });

      console.log('[' + localName + '] 发送消息数:', chatMsgs.length, '系统提示长度:', (sysMsg?.content||'').length);
      // 订阅者身份：断线重连时服务端要能分清「还是我」和「别的设备来抢」。
      // 光看 run.res 是分不清的 —— 手机断网后那条死 TCP 在服务端可能好几分钟才触发
      // close，这期间我自己重连会被当成第二台设备挡在 409 外面（这就把主场景打死了）。
      // 用固定的设备号而不是每次现摇：App 被杀重开也得认得出「还是我」。
      const agentSub = agentDeviceId();

      const res = resumeRunId ? await fetch(
        `${SERVER_BASE}/api/agent-run/${resumeRunId}?from=0&sub=${encodeURIComponent(agentSub)}`, { signal: ctrl.signal }
      ) : await fetch(SERVER_BASE + localEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: chatMsgs,
          systemPrompt: sysMsg?.content || '',
          model: conf.localModel || '',
          ccMemory: !!state.ccMemoryEnabled,
          // 电脑操控权限必须按**发起这轮的**对话算。用 getActiveChat() 的话，
          // 在异步组装消息期间她切去别的对话，这轮就会拿错对话的授权。
          agent: !!(originChat && originChat.agentMode),
          // 浏览器和电脑操控**各是各的**，所以单独发一个字段，不是 agent 的附属。
          // 同样按 originChat 算，理由和上面那条一模一样：异步组装期间她可能切走了。
          browser: !!(originChat && originChat.browserMode),
          thinkingMode: conf.thinkingMode || 'auto',
          // 思考**深度**。本地 GPT 走 Codex 的 reasoning effort，Gemini 走 thinking_level，
          // 两边的合法值不一样，所以各发各的字段，服务端谁也不认谁的。
          // 空串 = 没选过 = 各自沿用老的默认行为（server 侧都做了回落）。
          reasoningEffort: conf.isLocalGpt ? (conf.reasoningEffort || '') : undefined,
          // 订阅 Claude 的思考力度（low…max），server 侧白名单后走 --effort
          effort: conf.isLocalClaude ? (conf.localEffort || '') : undefined,
          thinkingLevel: conf.isGemini ? (conf.geminiThinking || '') : undefined,
          // Gemini 专属：key（留空则服务端用 .env 里的）、采样参数、它自己上网的开关
          ...(conf.isGemini ? {
            apiKey: conf.apiKey || '',
            temp: conf.temp,
            maxTokens: conf.maxReplyTokens,
            webSearch: !!conf.geminiSearch,
            // 'sub' = 走订阅（本机 agy，不要 key，见 server/agy.js）；空 = 走 key 直连
            via: conf.geminiVia === 'sub' ? 'sub' : '',
          } : {}),
          agentSub,
        }),
        signal: ctrl.signal
      });

      console.log('[' + localName + '] HTTP状态:', res.status, 'body可读:', !!res.body);
      // 找回那条路（resumeRunId）要自己认领 404/409。走 throw 的话她看到的是
      // 「⚠️ 本地 Claude 连接失败: HTTP 409」这种原始状态码，而且 claimRun 保持 false →
      // 这个对话永远挂在 pending 里，每次回前台都白跑一次清单请求 + 一次全量写盘。
      // 触发：拿到清单到发起这个 fetch 之间别的设备抢先挂上了。
      if (resumeRunId && (res.status === 404 || res.status === 409)) {
        claimRun = true;   // 两种都是「有结论」：活没了 / 别人接走了
        return { fullText, reasoningText, blocks, runId,
          error: res.status === 404
            ? '电脑那边找不到这个活了（服务重启过，或者跑完已经超过 30 分钟）'
            : '这个活已经在另一台设备上接着看了，这边不抢' };
      }
      if (!res.ok) {
        // 服务端开跑前的拒绝（比如订阅 GPT 没登录也没配端点）带着一句人话，别只给她看状态码
        let why = '';
        try { why = String((await res.json()).error || ''); } catch (e) { }
        throw new Error(why || `HTTP ${res.status}`);
      }

      // 手机锁屏、切后台、进电梯都会把这条流掐断，但电脑上的活还在跑
      //（server.js 那边不再因为客户端断开就 kill 进程）。所以流断了先别当失败：
      // 拿 runId 去 /api/agent-run/:id?from=已收到条数，把断掉那截补上再接着收。
      let evIndex = 0, sawDone = false, reconnects = 0, reattachError = null, yielded = false;
      // reconnects 成功一次就归零（不然一路断断续续但每次都接上的活会被误判失联），
      // 所以还得有一道总时限兜底：接得上但 body 立刻断（挂代理、隧道口）会 2 秒一次
      // 无限重试。服务端硬上限是 60 分钟，超过这个数再敲肯定没有意义。
      const reattachDeadline = Date.now() + 70 * 60 * 1000;
      const reattachAgentRun = async () => {
        if (sawDone || yielded || !runId || ctrl.signal.aborted
            || reconnects >= 60 || Date.now() > reattachDeadline) return null;
        reconnects++;
        if (reconnects === 1) showToast('📡 连接断了，活还在电脑上跑着，正在接回来…', 'info', 3000);
        await new Promise(r => setTimeout(r, 2000));
        if (ctrl.signal.aborted) return null;
        try {
          const r2 = await fetch(`${SERVER_BASE}/api/agent-run/${runId}?from=${evIndex}&sub=${encodeURIComponent(agentSub)}`, { signal: ctrl.signal });
          if (r2.status === 404) {
            sawDone = true;   // 别再敲了，敲不出来
            claimRun = true;  // 电脑那边真没了，留着 claimed=false 只会每次前台都白捞一遍
            reattachError = '电脑那边找不到这个活了（服务重启过，或者跑完已经超过 30 分钟）';
            return null;
          }
          if (r2.status === 409) {
            // 真的是**另一台**设备在挂（服务端按 sub 判的，同一个 sub 允许顶掉自己那条死连接）。
            // 以前服务端是无脑把在座的踢下来，两边每 2 秒互踢一次踢到死。让给它。
            // 注意别设 sawDone、也别当成 error：设了的话 callAPI 会走 error 分支，
            // 把这一轮已经收到的几千字正文整个换成一行 ⚠️。让位不是失败。
            yielded = true;
            claimRun = true;  // 让位是「有结论」，这台设备从此不再碰这个活
            const md = '\n\n> 🖥 这个活已经在另一台设备上接着看了，这边不抢。\n';
            if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
            blocks[blocks.length - 1].text += md;
            fullText += md; onUpdate(fullText, reasoningText, blocks);
            return null;
          }
          if (!r2.ok || !r2.body) return await reattachAgentRun();
          showToast('🔗 接上了，继续', 'success', 2000);
          // 接上了就把重连次数归零：60 次是给「一直连不上」设的放弃线，
          // 不是给「一路上断断续续但每次都接上了」设的。不归零的话，
          // 一个跑 40 分钟、断了 61 次（每次都成功）的活会在最后一次被当成彻底失联。
          reconnects = 0;
          return r2;
        } catch { return await reattachAgentRun(); }
      };

      let reader = res.body.getReader();
      // decoder 必须跟着 reader 一起换：断点正好切在一个多字节字符中间时，
      // 半个字符会留在旧 decoder 里，续上的流开头就是乱码
      let decoder = new TextDecoder();
      let buffer = '', chunkCount = 0;
      const swapReader = (next) => {
        reader = next.body.getReader();
        decoder = new TextDecoder();
        buffer = ''; chunkCount = 0;
      };

      while (true) {
        let done, value;
        try {
          ({ done, value } = await reader.read());
        } catch (e) {
          // 真断网时 reader.read() 是**抛异常**，不是给 done:true —— 手机锁屏、切 Wi-Fi、
          // 进隧道全走这条路。以前这里没兜住，异常直接冒到外层 catch 报「连接失败」，
          // 「断线不丢活」在真手机上等于没做。（脚本测的是干净 EOF，测不出这条）
          console.log('[' + localName + '] 流异常中断:', e.name, e.message);
          const next = await reattachAgentRun();
          if (next) { swapReader(next); continue; }
          break;
        }
        if (done) {
          console.log('[' + localName + '] 流结束, 共', chunkCount, '块, fullText长度:', fullText.length, '剩余buffer:', buffer.slice(0,200));
          // 没收到 done 就断了 → 换个 reader 从断点接着读，循环本身不用动
          const next = await reattachAgentRun();
          if (next) { swapReader(next); continue; }
          break;
        }
        chunkCount++;
        const text = decoder.decode(value, { stream: true });
        if (chunkCount <= 3) console.log('[' + localName + '] chunk#' + chunkCount + ':', text.slice(0, 150));
        buffer += text;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
          // runId 是元信息（不进服务端缓冲），所以不能算进 evIndex，否则重连下标会错位
          if (j.runId) {
            runId = j.runId; _agentRunId = j.runId;
            ctrl.gcRunId = j.runId;   // 活挂在流上：停止键只喊停当前对话的活（_agentRunId 是全局一个，两个对话同时跑会互相覆盖）
            // 2026-09-20 起纯聊天也登记活了（就为了网抖时能原地接上，见 server.js）。
            // kind 由**服务端**说了算，不是看这边的 agentMode：安全开关关着的时候
            // 前端 agentMode=true 而服务端登记的其实是 chat，信自己这边会记错账。
            // 老服务端不发 kind → 只有 agent 轮才会有 runId → 默认 'agent' 是对的。
            if (j.kind) runKind = j.kind;
            // 服务端事件超过上限会丢最老的，resumeFrom 是它现在能给出的最早下标。
            // 比手上的下标还大 → 中间那截永远拿不到了，必须把下标推上去；
            // 不推的话下次重连会 from 一个服务端已经没有的位置，导致重复回放一大段。
            if (typeof j.resumeFrom === 'number' && j.resumeFrom > evIndex) {
              // evIndex>0 是「续接时缺了一截」；resumeRunId 是「App 被杀后从 0 找回」，
              // 那种情况 evIndex 本来就是 0，不带上它就会静默缺头
              if (evIndex > 0 || resumeRunId) {
                showToast('⚠️ 这个活跑得太多，开头有一段没留住', 'info', 4500);
              }
              evIndex = j.resumeFrom;
            }
            // 记在对话上：App 被系统杀掉重开后，靠它把这个活认回来。
            // 必须写回**发起这轮的**那个对话（她可能已经切走了），而且必须立刻落盘 ——
            // save() 是 800ms 防抖的，App 在这 800ms 里被 ROM 杀掉，这个字段就没进 IndexedDB，
            // 「App 被杀也能认回来」整条路就是空的。
            // resumeRunId 说明这本来就是一次「找回」，此时 claimed 已经是 true，
            // 别把它按回 false —— 按回去的话每次切回前台都会再找回一遍、追加一份重放。
            // `!== j.runId`：{runId} 帧每次重挂都会重发（server.js 的 attachRun 一进门就发）。
            // 不挡的话断一次就跑一遍 _doSave（全量序列化 chats/configs/memories/…），
            // 而「反复断线重连」正是这功能的主场景 —— 断 60 次就是 60 次全量写盘。
            // 值确实没变时跳过是安全的：本轮内除了这里没有别处会改这三个字段。
            // 纯聊天的活**不**记在对话上。它的寿命就是这一轮：runId 留在闭包里给
            // reattachAgentRun 用足够了。记上去的话有三笔账要付，而且都不是她要的：
            //   ① 每轮聊天多一次 _doSave()（全量序列化 chats/configs/memories/…）
            //      ——「普通对话照旧走防抖」那条注释（见本函数末尾的落盘分支）就白写了；
            //   ② checkLiveAgentRuns 会捞它，弹「🖥 那个活还在电脑上跑着」——她只是聊了句天；
            //   ③ 30-vitals.js 那句 `chat.agentRunId` 会把自主心跳一直挡在门外。
            if (runKind === 'agent' && originChat && !resumeRunId && originChat.agentRunId !== j.runId) {
              originChat.agentRunId = j.runId;
              originChat.agentRunClaimed = false;
              // 上一个活留下的气泡号必须清掉：她上一轮断线没找回成功（agentResumeNodeId=N，
              // claimed 还是 false），紧接着在同一对话又发一轮 → 新活 R2 也断 →
              // 找回时 aiId 会命中 N，把 R2 的全量回放写进**上一轮**那条气泡里
              //（时间线上位置更早），R1 找回的内容同时被擦掉。
              originChat.agentResumeNodeId = null;
              _doSave();   // 注意：它内部吞掉 IDB 异常，所以这里没有可靠的失败信号
            }
            continue;
          }
          // live 帧服务端不进缓冲（runLive），算进下标的话重连会跳过真事件
          if (j.live) {
            if (j.toolDraftStart !== undefined || j.toolDraft) {
              if (j.toolDraftStart !== undefined) {
                _dropToolDraft();
                if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
                _draft = { name: j.toolDraftStart, json: '', at: blocks.length - 1,
                           off: blocks[blocks.length - 1].text.length, fullOff: fullText.length };
              } else if (_draft) _draft.json += j.toolDraft;
              if (_draft && _draft.at === blocks.length - 1) {
                const md = toolDraftMd(_draft.name, _draft.json);
                const b = blocks[_draft.at];
                b.text = b.text.slice(0, _draft.off) + md;
                fullText = fullText.slice(0, _draft.fullOff) + md;
                onUpdate(fullText, reasoningText, blocks);
              }
            }
            continue;
          }
          evIndex++;
          // 真事件来了，草稿就到头了：工具调完会有完整的 🔧 块接上，不撤的话代码画两遍
          if (_draft) { _dropToolDraft(); if (!j.done) onUpdate(fullText, reasoningText, blocks); }
          if (j.done) {
            // 销账统一放在 finally 里（见函数末尾），这里只记状态
            sawDone = true; claimRun = true;
            continue;
          }
          if (j.delta) {
            if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
            blocks[blocks.length - 1].text += j.delta;
            fullText += j.delta; onUpdate(fullText, reasoningText, blocks);
          }
          if (j.thinking) {
            if (_lastBlockType !== 'thinking') { blocks.push({ type: 'thinking', text: '' }); _lastBlockType = 'thinking'; }
            blocks[blocks.length - 1].text += j.thinking;
            reasoningText += j.thinking; onUpdate(fullText, reasoningText, blocks);
          }
          // 电脑操控模式：把工具调用/结果作为 markdown 折叠块注入正文，复用现有渲染，手机端也能看。
          // 判的是**发起这轮的**对话：用 getActiveChat() 的话，她中途切去别的对话，
          // 这一轮跑了什么命令就全部从记录里消失了。
          // 联网那两个（WebSearch/WebFetch）纯聊天也放行：那是本地 Claude 在普通对话里
          // 唯一有的工具，得让她看见「它在查」，不然就是莫名卡十几秒然后凭空知道了网页内容。
          // GitHub 检索（mcp-github.js）同理：纯聊天也放行，得看得见它在翻哪个仓库的哪个文件。
          const GH_TOOL_LABEL = {
            mcp__github__repo_overview: '📦 看仓库',
            mcp__github__list_files: '📁 列目录',
            mcp__github__read_file: '📖 读文件',
            mcp__github__search_code: '🔎 搜代码',
            mcp__github__search_repos: '🔎 搜仓库',
          };
          const ghLabel = j.tool && GH_TOOL_LABEL[j.tool.name];
          // 浏览器工具：纯聊天档也要显示。浏览器开关**独立于**电脑操控 —— 她可能只开了
          // 浏览器，那时 agentMode 是 false，不挂进这条就一个字都看不见。
          // 而且**动手的那几个要显眼**：开这个开关时她被明确告知过「点击这类动作，
          // GranCyan 的额度闸管不到，唯一那道闸是AI 自己」。既然如此，
          // 每一次点击、每一次输入都得在她眼前走一遍，事后也翻得到。
          const brName = j.tool && j.tool.name.startsWith('mcp__browser__browser_')
                       ? j.tool.name.slice('mcp__browser__browser_'.length) : '';
          // 清浏览记录（mcp-chromecare.js）：关浏览器 + 删记录，是动了她东西的那一类，也得显眼
          const brClean = j.tool && j.tool.name === 'mcp__chromecare__clear_history';
          const brLabel = brName
            ? `${/^(click|type|fill_form|press_key|select_option|drag|drop|hover)$/.test(brName)
                ? '✋ 浏览器·动手' : '🌐 浏览器'}·${brName}`
            : brClean ? '🧹 浏览器·清浏览记录' : '';
          const isWebTool = j.tool && (j.tool.name === 'WebSearch' || j.tool.name === 'WebFetch' || ghLabel || brLabel);
          if (j.tool && (originChat?.agentMode || isWebTool)) {
            const args = j.tool.input || {};
            // GitHub 工具的关键信息是「哪个仓库的哪个路径」，只取 path 会看不出是哪个库
            const cmd = ghLabel
                      ? [args.repo, args.path, args.query].filter(Boolean).join('  ') || JSON.stringify(args)
                      : brClean ? '关掉专用 Chrome，删掉浏览记录（Cookie 和登录不动）'
                      : args.command || args.file_path || args.path || args.pattern
                      // 浏览器工具的关键信息是「点的哪个东西 / 去的哪个网址」。
                      // element 是 playwright 给出的人话描述（"发布按钮"），比 ref 有用得多，
                      // 排在 url 前面：一次点击的 args 里往往两个都没有 url。
                      || args.element || args.url || args.query || args.text
                      || JSON.stringify(args).slice(0, 200);
            const title = ghLabel || brLabel || `${isWebTool ? '🔍' : '🔧'} ${j.tool.name}`;
            const md = `\n\n> **${title}**\n\`\`\`\n${String(cmd).slice(0, 600)}\n\`\`\`\n`;
            if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
            blocks[blocks.length - 1].text += md;
            fullText += md; onUpdate(fullText, reasoningText, blocks);
          }
          // 结果也要给浏览器档：她开着浏览器却看不到页面回了什么，就只能听AI 转述。
          if (j.toolResult && (originChat?.agentMode || originChat?.browserMode)) {
            const t = (j.toolResult.text || '').slice(0, 1500);
            const md = `\n<details><summary>${j.toolResult.isError ? '❌ 结果' : '📄 结果'}</summary>\n\n\`\`\`\n${t}\n\`\`\`\n</details>\n\n`;
            if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
            blocks[blocks.length - 1].text += md;
            fullText += md; onUpdate(fullText, reasoningText, blocks);
          }
          // 产物回传：电脑操控写出来的文件，在手机上直接点开看（图片就地显示）
          // Gemini 出的图（Nano Banana 那几个模型）。服务端已经落盘了，这里拿到的只是文件名 ——
          // 图本身绝不进对话历史：一张 base64 就是一两 MB 文本，翻几次记录 IndexedDB 就拖死了。
          // 代价是这个链接有寿命（服务端 30 天清一次），过期后气泡里会变成裂图。
          if (j.geminiImages && j.geminiImages.length) {
            const md = j.geminiImages
              .map(id => `\n\n![Gemini 出的图](${SERVER_BASE}/api/gemini-image?id=${encodeURIComponent(id)})\n\n`)
              .join('');
            if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
            blocks[blocks.length - 1].text += md;
            fullText += md; onUpdate(fullText, reasoningText, blocks);
          }
          if (j.artifacts && j.artifacts.length) {
            const md = renderAgentArtifacts(j.artifacts);
            if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
            blocks[blocks.length - 1].text += md;
            fullText += md; onUpdate(fullText, reasoningText, blocks);
          }
          if (j.usage) {
            console.log('💰 ' + localName + ' Token:', j.usage);
            const tot = (j.usage.in || 0) + (j.usage.cached || 0) + (j.usage.cacheWrite || 0);
            const pct = tot ? Math.round((j.usage.cached || 0) / tot * 100) : 0;
            showToast(`💰 输入 ${tot} tokens · 缓存命中 ${j.usage.cached || 0} (${pct}%) · 输出 ${j.usage.out || 0}`, 'info', 3500);
          }
          // notice：这轮有事要说但没死（目前只有「带图 → 工具没开」）。
          // 不能用 j.error，那个在下面是「这轮完了」，会把后面的正文整段丢掉。
          if (j.notice) {
            console.warn('[' + localName + '] ' + j.notice);
            showToast('⚠️ ' + j.notice, 'error', 7000);
          }
          if (j.error) {
            console.error('[' + localName + '] 服务端错误:', j.error);
            claimRun = true;   // 电脑那边给出结论了（哪怕是坏消息），不是没接上
            return { fullText, reasoningText, blocks, runId, error: `${conf.isGemini ? 'Gemini' : conf.isLocalGpt ? '订阅 GPT' : '订阅 Claude'}: ${j.error}` };
          }
        }
      }
      _dropToolDraft();   // 流断在写文件半截：草稿不是她要留的东西
      // 用户自己按的停止：现在 reader.read() 抛的 AbortError 被上面兜住了，
      // 不会再冒到外层 catch，所以这里得自己认领 aborted，否则会被当成失败报错
      if (ctrl.signal.aborted) {
        claimRun = true;   // 她自己按的停止：这是结论，别再找回来
        return { fullText, reasoningText, blocks, error: null, aborted: true };
      }
      // 注意条件里**没有** runId：本地 GPT 的纯聊天根本不登记活（不会有 runId），
      // 而 reattachAgentRun 第一行就因 !runId 直接返回 null。加了 reader 异常兜底之后
      // 这类断线的异常被吃在循环里，不补一句的话 error 就是 null → callAPI 走成功分支 →
      // 半句话被当成最终答案落盘、还被喂进记忆抽取，界面上一声不吭。
      // （改动前这个异常会冒到外层 catch，至少还会显示「连接失败」）
      if (!sawDone && !yielded && !reattachError) {
        // 条件看的是 runKind 不是 runId：纯聊天现在也有 runId 了，但它没被记在对话上，
        // 也就没有「回头再捞」这条路（checkLiveAgentRuns 只认 chat.agentRunId）。
        // 对它说「活还在那边跑着」是在许一个没人会兑现的诺。
        reattachError = (runId && runKind === 'agent')
          ? '连不回电脑了，这个活可能还在那边跑着 —— 等会儿网好了再问它一句就行'
          : '连接断了，这条回复没收完（重连试过了，没接上）';
        // 聊天的活到这里就是**彻底放弃**了：runId 只活在这个闭包里，页面一刷新
        // 就再也没人认领得了。所以顺手告诉服务端别跑了，别让那个进程白烧到孤儿回收。
        // 尽力而为、不等结果 —— 这会儿多半正断着网，失败是正常的，服务端那档
        // 3 分钟的 AGENT_RUN_ORPHAN_CHAT 才是真兜底。
        // 电脑操控的活相反：那边是真指望她回头接上的，一个字都不能停。
        if (runId && runKind === 'chat') {
          fetch(`${SERVER_BASE}/api/agent-run/${runId}/stop`, { method: 'POST' }).catch(() => {});
        }
      }
      return { fullText, reasoningText, blocks, runId, error: reattachError };
    } catch (err) {
      _dropToolDraft();
      if (err.name === 'AbortError') { claimRun = true; return { fullText, reasoningText, blocks, runId, error: null, aborted: true }; }
      // 非 Abort 的异常（网炸了、JSON 崩了…）**不**销账：活可能还在电脑上跑着
      console.error(localName + ' 错误:', err);
      return { fullText, reasoningText, blocks, runId, error: `${conf.isGemini ? 'Gemini' : conf.isLocalGpt ? '订阅 GPT' : '订阅 Claude'} 连接失败: ${err.message}` };
    } finally {
      _streamControllers.delete(ctrl);
      _agentRunId = null;      // 这轮结束了，停止按钮别再去停一个已经不在的活
      // 销账：这条流**拿到头了**（claimRun），这个活对这个对话就算取过了，
      // 别下次切回前台再捞一遍追加重放。没拿到头的（网断/重连用尽）留着 claimed=false，
      // 等她网好了开 App 由 checkLiveAgentRuns 捞回来。
      // **只改内存、不落盘** —— 让调用方收尾后的 save 顺带写进去。
      // 万一 App 正好在收尾途中被杀，claimed 没落盘，重开时会重新找回 —— 这正是想要的，
      // 因为那次收尾丢了（Codex 二审第 3 条要的就是这个时序）。
      if (claimRun && runId && originChat && originChat.agentRunId === runId) {
        originChat.agentRunClaimed = true;
      }
      updateStreamUI();
    }
  }

  // 原有的 API 调用逻辑
  const ctrl = new AbortController();
  ctrl.gcChat = originChat || null;     // 同上：归属对话。梦境/飞行棋这类不带对话的就是 null，不算任何对话在生成
  _streamControllers.add(ctrl);
  updateStreamUI();
  try {
    const isAnthropic = (conf.apiBase || '').trim().replace(/\/$/, '').endsWith('/messages');
    // apiBase 填相对路径（如本地小千的 `/api/ollama/v1`）= 走这台设备连着的 GranCyan server 中转。
    // 手机页面挂在 https://grancyan.app，不补 SERVER_BASE 就会打到那个假域名自己身上。
    const base = (conf.apiBase || 'https://api.openai.com/v1').trim();
    const resolvedBase = base.startsWith('/') ? SERVER_BASE + base : base;
    const url = isAnthropic
      ? resolvedBase
      : `${resolvedBase}/chat/completions`;
    const authHeaders = isAnthropic
      ? { 'x-api-key': conf.apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Authorization': `Bearer ${conf.apiKey}` };

    // ★ Anthropic 需要单独抽出 system，构造不同的请求体
    let requestBody;
    let usedCache = false;
    const buildAnthropicBody = (withCache) => {
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map(p => ({ ...p })) : m.content }));
      const body = {
        model: conf.modelName,
        messages: chatMessages,
        max_tokens: conf.maxReplyTokens || 1024,
        stream: true,
        ...(systemMsg ? { system: systemMsg.content } : {})
      };
      if (withCache) applyPromptCache(body, chatMessages);
      applyAnthropicThinking(conf, body);
      return body;
    };
    if (isAnthropic) {
      usedCache = true;
      requestBody = buildAnthropicBody(true);
    } else {
      // 中转上的 Claude 也吃 cache_control（见 applyOpenAiPromptCache）。
      // 只对 Claude 系开：cache_control 是 Anthropic 的概念，给 GPT/GLM 加了纯属白挨一次 400。
      usedCache = /claude/i.test(conf.modelName || '') && promptCacheAllowed(conf);
      requestBody = buildRequestBody(conf, messages, usedCache);
    }

    const doFetch = () => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(requestBody),
      signal: ctrl.signal
    });

    let resp = await doFetch();
    let errText = null;
    if (!resp.ok) {
      errText = await resp.text();
      // 🧪 beta 限制模型：temperature/top_p/n 固定为 1、presence/frequency_penalty 固定为 0，
      // 只要带了非默认采样参数就整个请求 invalid_request_error 拒绝。
      // 命中就剥掉这些固定字段，自动降级重试一次（对未来同类 beta 模型也通用）。
      if (resp.status === 400 && !isAnthropic && /beta[- ]?limitation|fixed at 1|are fixed/i.test(errText)) {
        for (const k of ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty']) delete requestBody[k];
        console.warn('⚠️ 命中 beta 限制模型，剥离固定采样参数后自动重试:', requestBody);
        resp = await doFetch();
        errText = resp.ok ? null : await resp.text();
      }
      // 中转/老网关不认 cache_control 时会把整轮请求判成非法。缓存只是省钱的
      // 优化，不该因此发不出消息——去掉缓存原样重发一次，用户什么都不会察觉。
      // 判据只认「跟缓存/system 结构有关」的报错，别把 thinking 参数之类的真错误
      // 也拖去重试一遍（重试一次就多等一次，还会把真正的错误信息盖掉）
      const _e = errText || '';
      if (!resp.ok && usedCache &&
          (/cache|ephemeral/i.test(_e) || (/system/i.test(_e) && /string|array|type|invalid/i.test(_e)))) {
        console.warn('⚠️ 这个接口不支持提示词缓存，降级重发（本轮不省 token）:', errText?.slice(0, 200));
        requestBody = isAnthropic ? buildAnthropicBody(false) : buildRequestBody(conf, messages, false);
        usedCache = false;
        // 记一笔，别每轮都拿一次 400 去换一次重试（那等于把每条消息的延迟翻倍）。
        // 只记非 Anthropic 那条：官方端点必然支持，那边报缓存错八成是别的原因。
        if (!isAnthropic) { conf.noPromptCache = Date.now(); try { save(); } catch (e) {} }
        resp = await doFetch();
        errText = resp.ok ? null : await resp.text();
      }
    }

    if (!resp.ok) {
      const err = errText;

      // 🐛 详细日志，帮助调试
      console.error('❌ API 错误详情:', {
        status: resp.status,
        url: url,
        headers: Object.keys(authHeaders),   // 只打键名：值是明文 API Key，安卓 WebView 的控制台会进 logcat
        requestBody: requestBody,
        response: err
      });

      // 🚦 特殊处理常见错误
      if (resp.status === 429) {
        return {
          fullText, reasoningText,
          error: `⏱️ API 请求过于频繁，请稍等片刻后重试\n\n💡 建议：\n• 等待 60 秒后重试\n• 或切换到其他模型\n• 或使用「订阅 Claude」模型\n\n📊 当前限速：每 ${Math.round(60000/(60000/5))} 秒一个请求`
        };
      }

      if (resp.status === 503) {
        return {
          fullText, reasoningText,
          error: `🔧 服务暂时不可用 (503)\n\n可能原因：\n• 米醋 API 服务器繁忙或维护中\n• 模型实例暂时不可用\n\n💡 建议：\n• 等待 1-2 分钟后重试\n• 切换到其他 API 服务\n• 联系米醋客服确认服务状态`
        };
      }

      if (resp.status === 400) {
        return {
          fullText, reasoningText,
          error: `⚠️ 请求格式错误 (400)\n\n可能原因：\n• API Key 格式不正确\n• 模型配置有误\n• 请检查控制台日志获取详情\n\n💡 建议：检查「设置 → 模型 & API」配置`
        };
      }

      if (resp.status === 401 || resp.status === 403) {
        return {
          fullText, reasoningText,
          error: `🔐 API Key 验证失败 (${resp.status})\n\n请检查：\n• API Key 是否正确\n• API Key 是否过期\n• 是否有访问权限`
        };
      }

      return { fullText, reasoningText, error: `API 错误 ${resp.status}: ${err.slice(0,300)}` };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    // 跨包行缓冲：一个汉字或一行 data: {...} 被网络拆成两包很常见。
    // 以前每包单独 decode + split，汉字变 �、半行 JSON 被 catch 吞掉，那段字就静默丢了
    let sseBuf = '';
    while (true) {
      const { done, value } = await reader.read();
      sseBuf += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
      const parts = sseBuf.split('\n');
      sseBuf = parts.pop();
      const lines = parts.map(l => l.replace(/\r$/, '')).filter(l => l.startsWith('data: '));
      if (done && !lines.length) break;
      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          let changed = false;

          if (isAnthropic) {
            // ★★★ Anthropic SSE 格式解析（含 block 追踪）★★★
            // message_start 里带这一轮的 input/缓存读写量，用来确认缓存到底有没有命中
            if (json.type === 'message_start' && json.message?.usage) reportCacheUsage(conf, json.message.usage);
            if (json.type === 'content_block_start') {
              const btype = json.content_block?.type === 'thinking' ? 'thinking' : 'text';
              blocks.push({ type: btype, text: '', _idx: json.index });
              _lastBlockType = btype;
            } else if (json.type === 'content_block_delta') {
              const idx = json.index;
              const block = blocks.find(b => b._idx === idx) || blocks[blocks.length - 1];
              if (json.delta?.type === 'text_delta' && json.delta.text) {
                fullText += json.delta.text; changed = true;
                if (block) block.text += json.delta.text;
              } else if (json.delta?.type === 'thinking_delta' && json.delta.thinking) {
                reasoningText += json.delta.thinking; changed = true;
                if (block) block.text += json.delta.thinking;
              }
            }
          } else {
            // OpenAI / DeepSeek / GLM 格式
            const delta = json.choices?.[0]?.delta || {};
            if (delta.content) {
              if (_lastBlockType !== 'text') { blocks.push({ type: 'text', text: '' }); _lastBlockType = 'text'; }
              blocks[blocks.length - 1].text += delta.content;
              fullText += delta.content; changed = true;
            }
            const rc = delta.reasoning_content || delta.reasoning;
            if (rc) {
              if (_lastBlockType !== 'thinking') { blocks.push({ type: 'thinking', text: '' }); _lastBlockType = 'thinking'; }
              blocks[blocks.length - 1].text += rc;
              reasoningText += rc; changed = true;
            }
          }

          if (changed) onUpdate(fullText, reasoningText, blocks);
        } catch {}
      }
    }
    return { fullText, reasoningText, blocks, error: null, aborted: false };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { fullText, reasoningText, blocks, error: null, aborted: true };
    }
    return { fullText, reasoningText, blocks, error: `请求失败: ${e.message}`, aborted: false };
  } finally {
    _streamControllers.delete(ctrl);
    updateStreamUI();
  }
}

// 思考链折叠标题：不写「分析了代码结构」这种工作日志，写成它心里冒出来的一句话。
// 取思考的开头和结尾（结尾往往是想定了的那一下），名字用设置里的称呼；不让 AI 看名字时只说「她/他」。
function thinkTitlePrompt(reasoningText, who) {
  const t = String(reasoningText || '');
  const excerpt = t.length > 2000 ? t.slice(0, 1400) + '\n……\n' + t.slice(-600) : t;
  const name = String(who || '').trim() || 'ta';
  return `下面是一个 AI 在回复${name}之前的思考过程。替它写一句此刻的心里话，当作这段思考的折叠标题。\n`
    + `要求：第一人称，20 字以内，像它脑子里真的冒出来的那句，带它当下的情绪（心软、着急、偷笑、懊恼、得意、犹豫都行）；`
    + `提到对方就叫「${name}」或「她/他」，别叫「用户」；思考在讲技术活也一样，写它干活时的心情，不写工作摘要。`
    + `不要「分析了」「思考了」「评估了」这种动宾短语，不要引号，不要解释，只输出那一句。思考是英文也用中文写。\n\n`
    + excerpt;
}

// 模型回来的那句收拾干净：只留第一行，剥掉成对或单边的引号、句末标点，太长就截
function cleanThinkTitle(s) {
  let r = String(s || '').trim().split('\n')[0].trim();
  r = r.replace(/^[\s"'“”「」『』]+|[\s"'“”「」『』]+$/g, '').replace(/[。，,.]+$/, '').trim();
  return r.length > 30 ? r.slice(0, 30) + '…' : r;
}

// 用 DeepSeek 给思考过程起折叠标题（内心独白版，见 thinkTitlePrompt）
async function summarizeThinking(reasoningText) {
  // 思考里抄过纸条正文的，别拿去给概括模型写成标题露出来（68-treasure.js）
  if (typeof treasureVeil === 'function') reasoningText = treasureVeil(reasoningText);
  if (!reasoningText || reasoningText.length < 50) { console.log('[思考概括] 跳过：文本太短或为空'); return ''; }
  if (!state.thinkSumKey) { console.log('[思考概括] 跳过：未设置 thinkSumKey'); return ''; }
  const who = (state.userName && state.userNameAiVisible !== false) ? state.userName : '';
  const prompt = thinkTitlePrompt(reasoningText, who);
  try {
    console.log('[思考概括] 调用 DeepSeek API，key前缀:', state.thinkSumKey.slice(0, 8) + '...');
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.thinkSumKey}` },
      // temperature 不归零：同一种思考每次都出同一句心里话就假了
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 60, stream: false, temperature: 0.7 })
    });
    console.log('[思考概括] HTTP 状态:', resp.status);
    if (!resp.ok) { const err = await resp.text(); console.error('[思考概括] API 错误:', err); return ''; }
    const json = await resp.json();
    const result = cleanThinkTitle(json.choices?.[0]?.message?.content);
    console.log('[思考概括] 结果:', result);
    return result;
  } catch (e) { console.error('[思考概括] 异常:', e); return ''; }
}

// ── 思考链翻译：英文思考 → 电脑上的本地小模型（Ollama）→ 中文，存进 target.thinkZh ──
// 原文（blocks 里的 thinking / m.reasoning）一个字不动，回填历史用的也永远是原文；
// thinkZh 只给渲染层看。thinkZh[i] 对应第 i 个 type==='thinking' 的块（legacy 只有 [0]）。
// 翻不了（电脑没开、Ollama 没跑、手机连不上）就什么都不写，思考照旧显示英文，不弹任何提示。
let _thinkTransOk = null, _thinkTransAt = 0;
async function _thinkTransUsable() {
  // 探针结果记一分钟：每条消息都去撞一个死 IP 没意义，但电脑刚开机也要能很快接上
  if (_thinkTransOk !== null && Date.now() - _thinkTransAt < 60000) return _thinkTransOk;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);   // 同书架：死 IP 会让 fetch 干等几十秒
    const r = await fetch(SERVER_BASE + '/api/think-translate/ping', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    _thinkTransOk = !!(r.ok && (await r.json()).ok);
  } catch (e) { _thinkTransOk = false; }
  _thinkTransAt = Date.now();
  return _thinkTransOk;
}
// manual：用户点了「译」—— 探针缓存作废重探（她可能刚把 Ollama 开起来），返回结果给按钮显示。
// 已经有的译文不重翻（只补空的那几段）。
async function translateThinkingFor(target, nodeId, manual) {
  if (!target) return 'none';
  const texts = target.blocks?.length
    ? target.blocks.filter(b => b.type === 'thinking').map(b => b.text || '')
    : (target.reasoning ? [target.reasoning] : []);
  if (!texts.some(Boolean)) return 'none';
  if (manual) _thinkTransOk = null;
  if (!await _thinkTransUsable()) return 'offline';
  const prev = target.thinkZh || [];
  const zh = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    let out = _thinkTransReal(text, prev[i]) ? prev[i] : '';   // 存着的拒绝不算译文，重翻
    if (text && !out) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 300000);   // 长思考要分好几段排队翻，给足
        const r = await fetch(SERVER_BASE + '/api/think-translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }), signal: ctrl.signal,
        });
        clearTimeout(t);
        const j = await r.json();
        if (j.ok) out = j.zh || '';
        else console.warn('[思考翻译]', j.error);
      } catch (e) { console.warn('[思考翻译] 失败:', e.message); }
    }
    zh.push(out);
  }
  if (!zh.some(Boolean)) return 'fail';   // 全是中文思考（跳过）或全失败：不留空壳字段
  if (zh.every((z, i) => z === (prev[i] || ''))) return 'fail';   // 手动补翻一段都没补上
  target.thinkZh = zh;
  save(); _invalidateNodeCache(nodeId); renderMessages();
  return 'ok';
}

// 「译」按钮。思考块渲染时不知道自己属于哪条消息，从 DOM 往上找：
// 消息组上有 data-node-id；多模型并排时变体容器 id 是 variant-<节点>-<第几个>。
const _thinkTransBusy = new Set();
async function thinkTransTap(ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }   // 别顺带把思考块收起来
  const btn = ev?.currentTarget || ev?.target;
  const nodeId = btn?.closest?.('[data-node-id]')?.getAttribute('data-node-id');
  const node = nodeId != null ? getActiveChat()?.nodes?.[nodeId] : null;
  if (!node) return;
  const vm = btn.closest('[id^="variant-"]')?.id.match(/^variant-\d+-(\d+)$/);
  const target = vm ? node.variants?.[+vm[1]] : node;
  const key = nodeId + (vm ? '/' + vm[1] : '');
  if (!target || _thinkTransBusy.has(key)) return;
  _thinkTransBusy.add(key);
  btn.classList.remove('fail'); btn.classList.add('busy');
  let res = 'fail';
  try { res = await translateThinkingFor(target, +nodeId, true); } catch (e) { console.warn('[思考翻译] 手动:', e); }
  _thinkTransBusy.delete(key);
  if (res === 'ok') return;   // 已重渲染，按钮换成了中/英切换
  // 没翻成：按钮还在原地（没重渲染），标一下原因，过几秒恢复
  btn.classList.remove('busy'); btn.classList.add('fail');
  btn.title = res === 'offline' ? '连不上电脑上的翻译（电脑没开 / Ollama 没跑）' : '没翻出来，再点一次试试';
  setTimeout(() => { btn.classList.remove('fail'); btn.title = '翻译成中文（电脑上的本地小模型）'; }, 4000);
}

async function summarizeMemContent(text) {
  if (!text || !state.thinkSumKey) return '';
  const prompt = '用极简中文概括这条记忆内容（8字以内，动宾短语，如"记住了测试时间"、"记录了功能演示"），只输出概括，不要引号不要标点，如果记忆是其他语言就用其他语言概括：\n\n' + text.slice(0, 500);
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.thinkSumKey}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 30, stream: false, temperature: 0 })
    });
    if (!resp.ok) return '';
    const json = await resp.json();
    return (json.choices?.[0]?.message?.content || '').trim().replace(/^["「『]|["」』。，]$/g, '').slice(0, 30);
  } catch (e) { return ''; }
}

function triggerMemSummaries(rawText, target, nodeId) {
  if (!state.thinkSumKey) return;
  const ops = [];
  rawText.replace(/\[\[(MEM_ADD|MEM_DEL|RECENT_MEM_ADD|RECENT_MEM_DEL|SELF_MEM_SET|BRAIN_ADD|BRAIN_PIN|BRAIN_RESOLVE|BRAIN_DEL):\s*([^\]]+?)\s*\]\]/g, (_, t, c) => { ops.push(c.trim()); });
  if (!ops.length) { console.log('[记忆概括] 未找到记忆命令'); return; }
  console.log('[记忆概括] 找到', ops.length, '条记忆命令，开始概括...');
  Promise.all(ops.map(c => summarizeMemContent(c))).then(sums => {
    console.log('[记忆概括] 概括结果:', sums);
    if (!sums.some(s => s)) return;

    // ⚠️⚠️ **按内容对，不按下标对**（用户截图逮到的：概括和正文连连看做错了）。
    //   原来这里存的是一个数组 sums[]，块那边靠 idx++ 一个个取。两个序列压根不是一个序列：
    //     · 这里的顺序是**文档顺序**（一个正则扫全文）；
    //     · memCmdToHtml 那边是**语句书写顺序** —— 先把全文所有 MEM_ADD 贴完，
    //       再贴 MEM_DEL，再贴 BRAIN_ADD…… 一条消息里混两种命令就错位。
    //     · 更糟的是 pill() 还被 END_CHAT / VITALS / HEARTBEAT / DIARY / CHATS 调用，
    //       这些压根没被概括，却照样吃掉一个下标，把后面全顶偏。
    //       （PROUST_ADD 当初特意绕开 pill 就是因为这个，注释还在，但只堵了那一个出口。）
    //   改成内容查表之后，顺序、种类、数量怎么变都不会错位；将来谁再加一个 pill 调用也不会顶偏。
    //   查不到就是不显示概括 —— **失效方向是「少一个标签」，不是「贴错标签」**。
    const map = {};
    const put = (k, v) => { const s = String(k || '').trim(); if (s && v && !map[s]) map[s] = v; };
    ops.forEach((c, i) => {
      if (!sums[i]) return;
      put(c, sums[i]);
      // BRAIN_ADD 的正文是去掉前四个元数据字段之后那截，块那边显示的也是它
      const tail = c.split('|').slice(4).join('|');
      put(tail, sums[i]);
      // 已渲染的 HTML 里正文是转义过的，一并当 key 存一份，省得回头再反转义
      put(escHtml(c), sums[i]); put(escHtml(tail), sums[i]);
    });
    target.memSummaries = map;

    // 这条路管的是**已经渲染成 HTML 的**消息（04-memory.js 的 processAiCommands 会把
    // [[MEM_ADD:]] 就地换成块，raw 标签已经不在 content 里了，memCmdToHtml 补不回来）。
    // ⚠️ 原来这里的 label 白名单漏了 🌙 高级记忆那四个，si 跟着一路错位 —— 同一个病的第三个出口。
    //   现在不认 label 了，认**正文**：把 label 和 think-body 一起匹配出来，拿正文查表。
    if (target.content) {
      target.content = target.content.replace(
        /(<span class="think-label">)([^<：]*?)(<\/span><\/div><div class="think-body">)([\s\S]*?)(<\/div>)/g,
        (match, a, label, b, body, c2) => {
          const sum = map[String(body).trim()];
          return sum ? `${a}${label}：${sum}${b}${body}${c2}` : match;
        });
    }
    save(); _invalidateNodeCache(nodeId); renderMessages();
  }).catch(e => console.error('[记忆概括] 异常:', e));
}

function memCmdToHtml(html, memSummaries) {
  html = String(html || '').replace(/\[\[SUGGEST:\s*[\s\S]*?\s*\]\]/gi, '');
  let idx = 0;
  // 前后必须留空行：marked 见到行首 <div> 会一路吞到空行为止，紧跟其后的正文
  // 会被当 HTML 原样吐出，里面的 **加粗** 就成了字面星号。04-memory.js 里那几个
  // 同类块也是这么包的，这份当初漏了。
  // ⚠️ key 和 c 分开：显示的正文可能被裁过（BRAIN_ADD 会砍掉前四个元数据字段），
  //   查表要用**原样的命令内容** —— 概括就是照那个算的。
  // ⚠️ 旧消息里 memSummaries 存的还是数组（下标制）。那种一律走老路子，
  //   免得把她整段历史里的标签全抹掉；新消息走内容查表。
  //   老数组本身就是错位的，但那是**已经发生的历史**，
  //   悄悄抹掉不是修复，是换一种方式改她看到的东西。
  const legacy = Array.isArray(memSummaries);
  const pill = (label, c, key) => {
    const sum = legacy
      ? memSummaries[idx++]
      : (memSummaries && memSummaries[String(key === undefined ? c : key).trim()]) || '';
    const displayLabel = sum ? `${label}：${sum}` : label;
    return `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">${displayLabel}</span></div><div class="think-body">${escHtml(c.trim())}</div></div>\n\n`;
  };
  html = html.replace(/\[\[MEM_ADD:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('💾 存储记忆', c));
  html = html.replace(/\[\[MEM_DEL:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('🗑 移除记忆', c));
  html = html.replace(/\[\[RECENT_MEM_ADD:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('📝 记录近期', c));
  html = html.replace(/\[\[RECENT_MEM_DEL:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('🗑 移除记录', c));
  html = html.replace(/\[\[SELF_MEM_SET:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('✨ 更新设定', c));
  html = html.replace(/\[\[END_CHAT(?::\s*([\s\S]*?))?\s*\]\]/g, (_, c) => pill('🚪 结束了这场对话', c || '感到不适'));
  html = html.replace(/\[\[BRAIN_ADD:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('🌙 高级记忆', c.split('|').slice(4).join('|') || c, c));
  html = html.replace(/\[\[BRAIN_PIN:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('📌 钉住记忆', c));
  html = html.replace(/\[\[BRAIN_RESOLVE:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('✓ 记忆已解决', c));
  html = html.replace(/\[\[BRAIN_DEL:\s*([^\]]+?)\s*\]\]/g, (_, c) => pill('🗑 移除高级记忆', c));
  html = html.replace(/\[\[VITALS:\s*([\s\S]+?)\s*\]\]/g, (_, c) => pill('🫀 生命体征', c));
  html = html.replace(/\[\[HEARTBEAT:\s*([\s\S]+?)\s*\]\]/g, (_, c) => pill('🫀 自主心跳', c));
  // 普鲁斯特瞬间：不走 pill()——memSummaries 只概括 MEM_*/BRAIN_* 那几种，
  // 这里再吃一个下标会把后面块的概括标签错位。画面本来也不需要被概括成动宾短语。
  html = html.replace(/\[\[PROUST_ADD:\s*([\s\S]+?)\s*\]\]/g, (_, c) =>
    `\n\n<div class="think-block done mem-block"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label">🕰 记下这个瞬间</span></div><div class="think-body">${escHtml(c.trim())}</div></div>\n\n`);
  html = html.replace(/\[\[HAUNT_(ON|OFF)\]\]/g, '');
  // 日记指令兜底（正常已在 processAiCommands 换成提示块；这里防止老消息裸标签漏出，且不泄露内容）
  html = html.replace(/\[\[DIARY_EDIT:\s*[\s\S]+?\s*\]\]/g, () => pill('✏️ 改了一页日记', '（私密）'));
  html = html.replace(/\[\[DIARY_DEL:\s*[\s\S]+?\s*\]\]/g, () => pill('🗑 撕掉一页日记', '（私密）'));
  html = html.replace(/\[\[DIARY:\s*[\s\S]+?\s*\]\]/g, () => pill('📔 记了一页日记', '（私密）'));
  html = html.replace(/\[\[DIARY_PUBLIC:\s*([\s\S]+?)\s*\]\]/g, (_, c) => pill('📔 写了一页公开日记', c));
  // blocks 渲染路径走的就是这里：sanitizeBlocksDiary 把 HIDE 的关键词抹成 ·，理由留着给她看
  html = html.replace(/\[\[DIARY_HIDE:\s*[\s\S]+?\s*(?:\|\s*([\s\S]*?)\s*)?\]\]/g, (_, why) => pill('🔒 锁上了一页日记', why ? `理由：${why}` : '（私密）'));
  html = html.replace(/\[\[DIARY_SHOW:\s*[\s\S]+?\s*\]\]/g, () => pill('📖 公开了一页日记', '去「日记本」里看'));
  html = html.replace(/\[\[DIARY_OPEN(?::\s*\d+)?\s*\]\]/g, () => pill('📖 让你看日记', ''));
  html = html.replace(/\[\[DIARY_READ\]\]/g, () => pill('📖 翻看日记', ''));
  // 兜底：老消息里没过指令处理的裸标签，别让它原样显示给用户看
  html = html.replace(/\[\[CHATS\]\]/gi, () => pill('📚 翻了翻别的对话', ''));
  html = html.replace(/\[\[MOMENTS\]\]/gi, () => pill('🐾 翻了翻猫爪日报', ''));
  html = html.replace(/\[\[LISTEN\]\]/gi, () => pill('🎧 听了听正在放的歌', ''));
  html = html.replace(/\[\[LYRICS(?::\s*([^\]]*?))?\s*\]\]/gi, (_, q) => pill('📜 翻了翻歌词', q || ''));
  html = html.replace(/\[\[BREATH(?:\s*[:：]\s*([^\]]*?))?\s*\]\]/gi, (_, q) => pill('🌬 翻了翻记忆', q || ''));
  html = html.replace(/\[\[CHAT_READ:\s*#?(\d+)\s*\]\]/gi, (_, id) => pill(`📖 读了对话 #${id}`, ''));
  html = html.replace(/\[\[DIARY_HANDOVER\]\]/g, () => pill('🗝 交出日记钥匙', ''));
  html = html.replace(/\[\[DIARY_RECLAIM\]\]/g, () => pill('🔒 收回日记钥匙', ''));
  return html;
}

// 渲染内联 blocks 序列（claude.ai 风格）
// 思考块的正文。**只有加粗小标题、一个字正文都没有**时补一句说明。
//
// 2026-08-09 查实：用户换成 ChatGPT Plus 官方订阅之后，本地 GPT 的思考链**仍然**只有标题。
// 整条链路都排除干净了 —— server.js 解析没丢（原始 JSON 里 reasoning item 只有 id/type/text
// 三个字段）、Codex CLI 忠实输出、参数真生效（summary=none 时 0 段、detailed 时有段），
// rollout 里存的 summary[] 每条都是纯标题，真 CoT 在 encrypted_content 里（加密，解不开）。
// gpt-5.6-sol / 5.5 / 5.4 三个模型一律如此。**这是订阅通道的策略，改不了。**
//
// 不判"是不是本地 GPT"而判内容形态：渲染层拿不到 conf，而且哪天别的模型也这样时，
// 这句话照样是对的。判错的代价也只是多一行灰字，不会挡住任何内容。
function _thinkOnlyHeadings(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every(l => /^\*\*.+\*\*$/.test(l));
}
function thinkBodyHtml(text) {
  // 正文包进糊面；下面那行 .think-note 故意留在外面（见 01-core.js 的 thinkVeil 注释）
  const body = thinkVeil(escHtml(text));
  if (!_thinkOnlyHeadings(text)) return body;
  return body + `<div class="think-note">只有小标题没有正文 —— GPT 的思考正文是加密的，订阅通道拿不到，不是这里出了问题。想看完整思考过程用订阅 Claude。</div>`;
}

// 有译文时正文放两份（中文在前），显示哪份由 body.think-lang-en 决定（见 01-core.js）。
// 两份都各自包糊面 —— 译文和原文一样是它的思考，漏包一份等于锁形同虚设。
// 外层用 span 不用 div：理由同 .think-veil（07-band-tts.js 按 `</div></div>` 数闭合标签剥思考块）。
// 没译文时和以前一字不差。标题上的切换钮由调用方按 zh 有没有自己加。
function thinkPairHtml(text, zh) {
  if (!zh) return thinkBodyHtml(text);
  return `<span class="think-zh">${thinkBodyHtml(zh)}</span><span class="think-en">${thinkBodyHtml(text)}</span>`;
}

function renderBlocksHtml(blocks, streaming, thinkingSummary, memSummaries, thinkZh) {
  if (!blocks?.length) return '';
  let html = '';
  const lastIdx = blocks.length - 1;
  let thinkIdx = -1;   // 第几个思考块 —— thinkZh 按这个下标对齐（见 translateThinkingFor）
  for (let i = 0; i <= lastIdx; i++) {
    let b = blocks[i];
    // 流式途中思考里抄了一遍 [[HIDE_LETTER:]]：画的时候就遮（存下来的那份收尾时 treasureVeilNode 会换掉）
    if (b && b.type === 'thinking' && typeof treasureVeil === 'function' && typeof b.text === 'string' && b.text.indexOf('[[HIDE_LETTER') >= 0) b = Object.assign({}, b, { text: treasureVeil(b.text) });
    // 小本子 [[WISH:]] 同理（71-wishbook.js）
    if (b && b.type === 'thinking' && typeof wishVeil === 'function' && typeof b.text === 'string' && b.text.indexOf('[[WISH') >= 0) b = Object.assign({}, b, { text: wishVeil(b.text) });
    if (b.type === 'thinking') {
      thinkIdx++;
      const isActive = streaming && i === lastIdx;
      const doneClass = isActive ? '' : ' done';
      const openClass = isActive ? ' open' : '';
      // 概括那句是 DeepSeek 写的，糊面要盖住它；「思考中…」「思考过程」只是状态词，
      // 不含内容，糊了反而看不出这块是什么。顺手补了 escHtml —— 概括是模型吐的文本。
      const label = isActive ? '💭 思考中…'
        : (thinkingSummary ? `💭 ${thinkVeil(escHtml(thinkingSummary))}` : '💭 思考过程');
      // 流式途中不提示：这一刻正文可能只是还没到，说"拿不到"就成了误报
      // 流式途中还没翻，不出译文也不出切换钮；存着的是拒绝也当没译文（_thinkTransReal）
      const zh = isActive || !_thinkTransReal(b.text, thinkZh?.[thinkIdx]) ? '' : thinkZh[thinkIdx];
      const lang = zh ? THINK_LANG : (!streaming && _thinkNeedsTrans(b.text) ? THINK_TRANS : '');
      html += `<div class="think-block${doneClass}${openClass}"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label${isActive ? ' think-live' : ''}">${label}</span>${lang}${THINK_LOCK}</div><div class="think-body">${isActive ? thinkVeil(escHtml(b.text)) : thinkPairHtml(b.text, zh)}</div></div>`;
    } else {
      const isLast = i === lastIdx;
      if (streaming && isLast) {
        html += b.text ? renderStreamingRichText(b.text) : '';
      } else {
        let withMem = memCmdToHtml(b.text || '', memSummaries);
        // 先转表情标签再走 markdown：marked(GFM) 会把标签里的裸 URL 自动加 <a>，后转就匹配不上了
        html += renderRichText(withMem);
      }
    }
  }
  if (streaming && blocks[lastIdx]?.type === 'thinking' && !blocks.some(b => b.type === 'text' && b.text)) {
    html += `<img src="${CAT_GIF}" style="height:48px;width:auto;display:block;margin:4px 0;" alt="思考中">`;
  }
  return html;
}

// 渲染流式中的气泡：思考过程折叠块 + 正文
//
// ⚡ 节流（2026-09-27）：流式时每来一个 token 调一次这里，以前是每次都把**整条**消息
// markdown 全量重解析 + innerHTML 重画 —— n 个 token 的回复总开销 O(n²)，长回复后半段
// 手机上一卡一卡的。现在同一个气泡（按 elId 分，多模型并排的每个 variant 各算各的）
// 最多每 LIVE_BUBBLE_MIN_MS 画一次：第一个 token 立刻画（首字不延迟），窗口内来的只记最新参数，
// 窗口到了补画一次（尾随那次拿的是**最新**的，不会停在旧内容）。
// 流结束时调用方必须带 immediate=true 再调一次：撤掉挂着的定时器、立刻画最终内容。
// 不撤的话那个晚到 ≤60ms 的定时器会在 renderMessages 画好终稿之后再用流式样式覆盖回去。
// streaming=false 同样立即画（非流式没有频率问题）。
const LIVE_BUBBLE_MIN_MS = 60;
const _liveBubbleThrottle = new Map();   // elId → { args, timer, last }

function renderLiveBubble(elId, fullText, reasoningText, streaming, blocks, immediate) {
  let st = _liveBubbleThrottle.get(elId);
  if (!streaming || immediate) {
    if (st && st.timer) clearTimeout(st.timer);
    _liveBubbleThrottle.delete(elId);
    _paintLiveBubble(elId, fullText, reasoningText, streaming, blocks);
    // 淡墨（70-ink.js）：模型写完了，队里剩下的字接着放完
    if (typeof inkEnd === 'function') inkEnd(elId);
    return;
  }
  if (!st) { st = { args: null, timer: null, last: 0 }; _liveBubbleThrottle.set(elId, st); }
  st.args = [fullText, reasoningText, blocks];
  if (st.timer) return;                                   // 窗口里已经排了一次，它会拿最新的 args
  const wait = st.last + LIVE_BUBBLE_MIN_MS - Date.now();
  if (wait <= 0) { st.args = null; st.last = Date.now(); _paintLiveBubble(elId, fullText, reasoningText, true, blocks); return; }
  st.timer = setTimeout(() => {
    st.timer = null;
    const a = st.args; st.args = null; st.last = Date.now();
    if (a) _paintLiveBubble(elId, a[0], a[1], true, a[2]);
  }, wait);
}

// 流式时气泡每 60ms 重画一次。以前是整块 innerHTML：思考框（.think-body 自带
// max-height:400 的滚动条）每次都是新节点，她刚拖到底的滚动条立刻弹回顶上；
// 手机上手指还按着节点就被换掉，惯性也断了。现在按顶层子节点逐个对：
// 思考块原地改标题和正文（节点不换，滚动条留着），其余一样的不动、不一样的才换。
// 思考框停在底部时跟着新字往下走；她往上翻了就停在她翻到的地方。
function _patchLiveBubble(bubble, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const next = [...tpl.content.childNodes];
  const cur = [...bubble.childNodes];
  next.forEach((n, i) => {
    const c = cur[i];
    if (!c) { bubble.appendChild(n); return; }
    if (c.nodeType === 1 && n.nodeType === 1 && c.classList.contains('think-block') && n.classList.contains('think-block')) {
      _patchThinkBlock(c, n); return;
    }
    if (!c.isEqualNode(n)) bubble.replaceChild(n, c);
  });
  for (let i = next.length; i < cur.length; i++) cur[i].remove();
}
function _patchThinkBlock(cur, nxt) {
  // 她自己点过开合的听她的；没点过的跟着新状态走（思考完照旧自动收起）
  const userOpen = cur.dataset.userToggled ? cur.classList.contains('open') : null;
  cur.className = nxt.className;
  if (userOpen !== null) cur.classList.toggle('open', userOpen);
  const ct = cur.querySelector(':scope > .think-toggle'), nt = nxt.querySelector(':scope > .think-toggle');
  if (ct && nt && ct.innerHTML !== nt.innerHTML) ct.innerHTML = nt.innerHTML;
  const cb = cur.querySelector(':scope > .think-body'), nb = nxt.querySelector(':scope > .think-body');
  if (cb && nb && cb.innerHTML !== nb.innerHTML) {
    const stick = cb.scrollHeight - cb.scrollTop - cb.clientHeight < 24;
    cb.innerHTML = nb.innerHTML;
    if (stick) cb.scrollTop = cb.scrollHeight;
  }
}

function _paintLiveBubble(elId, fullText, reasoningText, streaming, blocks) {
  const bubble = document.getElementById(elId);
  if (!bubble) return;
  if (blocks?.length) {
    _patchLiveBubble(bubble, renderBlocksHtml(blocks, streaming));
    if (typeof inkPaint === 'function') inkPaint(elId, streaming);   // 淡墨：刚画上的同步蒙住（70-ink.js）
    return;
  }
  // 旧路径回退（无 blocks 时）
  let html = '';
  if (typeof treasureVeil === 'function') reasoningText = treasureVeil(reasoningText);   // 纸条正文（68-treasure.js）
  if (reasoningText) {
    const label = streaming ? '💭 思考中…' : '💭 思考过程';
    const doneClass = streaming ? '' : ' done';
    const openClass = streaming ? ' open' : '';
    html += `<div class="think-block${doneClass}${openClass}"><div class="think-toggle" onclick="_thinkToggle(this)"><span class="think-chev">▸</span> <span class="think-label${streaming ? ' think-live' : ''}">${label}</span>${THINK_LOCK}</div><div class="think-body">${thinkVeil(escHtml(reasoningText))}</div></div>`;
  }
  html += (!streaming) ? renderRichText(fullText || '')
      : fullText    ? renderStreamingRichText(fullText)
      : `<img src="${CAT_GIF}" style="height:48px;width:auto;display:block;margin:4px 0;" alt="思考中">`;
  _patchLiveBubble(bubble, html);
  if (!streaming) typesetMath(bubble);
  if (typeof inkPaint === 'function') inkPaint(elId, streaming);
}

// 这个活彻底了结了：把对话上那三个字段清干净。只在**已销账**时调。
// 不清的话：① 这个对话此后每一轮普通聊天都走不防抖的全量写盘（见 callAPI 尾部）；
// ② 残留的 agentResumeNodeId 会让下一个活去覆写一条旧气泡。
function clearAgentRunRefs(chat) {
  if (!chat) return;
  chat.agentRunId = null;
  chat.agentRunClaimed = false;
  chat.agentResumeNodeId = null;
}

// ── 把电脑上那个活接回来 ────────────────────────────────────────
// 手机 App 被系统杀掉（GranCyan 在后台很容易被 ROM 干掉），前端整个没了，
// 但电脑上的活还在跑 —— 服务端不再因为断开就 kill。重开 App 时把它认回来。
async function resumeAgentRun(chat, runId) {
  const conf = state.configs.find(c => c.isLocalClaude);
  if (!conf) return;
  // 找回是可以重试的（拉到一半又断网 → 下次切回前台再来一次），而重连拿到的是
  // **从 0 的全量回放**。所以必须复用同一个气泡覆写，新建节点的话断三次就变成
  // 三条半截 + 一条完整。节点号记在对话上，App 重开也认得。
  let aiId = chat.agentResumeNodeId;
  // 那条气泡还得**在当前分支路径上**。她切了变体、或者删掉了后面的消息之后，
  // 节点可能还留在 chat.nodes 里却已经不在 headId 那条链上 —— 覆写它的话，
  // 找回的内容进了库但渲染不出来（renderMessages 只走 getMessagePath(chat.headId)）。
  const reusable = aiId && chat.nodes[aiId]
    && getMessagePath(chat, chat.headId).some(n => n.id === aiId);
  if (reusable) {
    Object.assign(chat.nodes[aiId], { content: '', reasoning: '', blocks: [], streaming: true });
  } else {
    aiId = nextId();
    chat.nodes[aiId] = { id: aiId, parentId: chat.headId, role: 'ai', content: '', reasoning: '',
      modelId: conf.id, modelNickname: conf.nickname, tokens: 0, timestamp: Date.now(), streaming: true };
    chat.headId = aiId;
    chat.agentResumeNodeId = aiId;
  }
  renderMessages();
  // 淡墨：找回来先是整条重放，开头那段她多半早看过了，别再按读信的速度放一遍（70-ink.js）
  if (typeof inkFlush === 'function') inkFlush('bubble-' + aiId, 2000);

  const { fullText, reasoningText, blocks, error } = await streamCompletion(conf, [], (txt, think, blks) => {
    chat.nodes[aiId].content = txt;
    chat.nodes[aiId].reasoning = think;
    chat.nodes[aiId].blocks = blks;
    if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId], true);   // 中途落盘的半截里也别有纸条正文（68-treasure.js）
    renderLiveBubble('bubble-' + aiId, txt, think, true, blks);
  }, runId, chat);
  // 流结束：撤掉节流里挂着的那次、立刻把完整内容画上（见 renderLiveBubble 上面的说明）
  renderLiveBubble('bubble-' + aiId, fullText, reasoningText, true, blocks, true);

  chat.nodes[aiId].streaming = false;
  if (error) {
    // 已经收到的正文要留着 —— 拉到 90% 才断的话，那 90% 是有用的
    chat.nodes[aiId].content = fullText;
    chat.nodes[aiId].reasoning = reasoningText;
    chat.nodes[aiId].blocks = blocks;
    if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId]);   // 这条路不走 processAiCommands：纸条正文只遮不埋
    appendWarnBlock(chat.nodes[aiId], error);
    // 没销账 = 没拿到头，节点号留着下次接着覆写；销了账就把它清掉，
    // 不然这个对话以后新起的活会去覆写一条旧气泡
    if (chat.agentRunClaimed) clearAgentRunRefs(chat);
    // 不用防抖的 save()：找回来的半截随时可能被下一次杀进程带走
    _doSave(); createBackup(); renderMessages(); return;
  }
  clearAgentRunRefs(chat);   // 拿到头了
  // 这里故意不跑 processAiCommands 那一串（游戏/学习卡）：
  // 那些属于正常一轮对话的后处理，补回来的是一次技术性的找回，别让它顺带触发一堆东西
  chat.nodes[aiId].content = fullText || reasoningText || '（这个活跑完了，但没留下什么话）';
  chat.nodes[aiId].reasoning = reasoningText;
  chat.nodes[aiId].blocks = blocks;
  if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId]);   // 同上：只遮不埋
  chat.nodes[aiId].tokens = estimateTokens(fullText);
  _doSave(); createBackup();   // 找回来的内容立刻落盘，别再被杀一次就白找（备份环也得走）
  renderMessages();
}

let _agentResumeChecking = false;
async function checkLiveAgentRuns() {
  if (_agentResumeChecking || _streamControllers.size) return;   // 有回复正在流，别插队
  // 遍历所有对话，不是只看当前那个 —— 这轮改动专门支持「起了活就切走」，
  // 只看当前对话的话，重开 App 停在别的对话上就永远查不到那个活。
  const pending = (state.chats || []).filter(c => c && c.agentRunId && !c.agentRunClaimed);
  if (!pending.length) return;
  _agentResumeChecking = true;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);           // 电脑没开就别卡着
    const r = await fetch(`${SERVER_BASE}/api/agent-runs`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return;
    const { runs } = await r.json();
    const findRun = (c) => (runs || []).find(x => x.id === c.agentRunId);
    const myDev = agentDeviceId();
    // 跑完的先取：接一个**还在跑**的活会一直挂到它结束（可能二十分钟），
    // 排在它后面那个已经跑完的就在队列里干等，等过 30 分钟 TTL 被服务端清掉 → 结果丢了。
    const ordered = pending.slice().sort((a, b) => (findRun(b)?.done ? 1 : 0) - (findRun(a)?.done ? 1 : 0));
    let tookLive = false, dirty = false, leftover = false;
    for (const chat of ordered) {
      const run = findRun(chat);
      if (!run) { clearAgentRunRefs(chat); dirty = true; continue; }   // 过期清掉了，别再问
      // stopped 要排在 attached 前面判：她自己叫停、但别的设备还挂着的活，
      // 排在后面的话会一直卡在 pending 里清不掉。
      if (run.stopped) { clearAgentRunRefs(chat); dirty = true; continue; }
      // attached 要分清是不是**我自己**那条僵尸连接。手机断网时服务端那条 TCP 不会立刻塌，
      // 无脑让位的话她回家开 App 是完全静默的（没 toast、没痕迹），得反复切前后台
      // 直到服务端 write 失败为止 —— 可能十几分钟，也可能一直不失败。
      // 自己的连接允许顶掉：attachRun 会把旧那条 res 收干净。
      if (run.attached && run.subId !== myDev) continue;   // 别的设备在管，不用我们排重试
      if (!run.done) {
        // 一轮最多接一个在跑的：接一个在跑的会一直挂到它结束，别把已跑完的堵在后面
        if (tookLive) { leftover = true; continue; }
        tookLive = true;
      }
      // 这里**不**提前销账：resume 自己可能又断（电梯里信号没了），
      // 提前销的话这个活就被这一次失败烧掉，再也捞不回来。
      // 销账由 streamCompletion 的 finally 在真的拿到头时做。
      showToast(run.done ? '🖥 电脑上那个活已经跑完了，正在取回结果…'
                         : '🖥 那个活还在电脑上跑着 — 接回来了', 'info', 3500);
      await resumeAgentRun(chat, run.id);   // 它内部自己落盘，不用在这儿标 dirty
    }
    // 只在真的动过账时才写。无条件写的话，只要有一个 pending 被跳过（别的设备挂着、
    // 或者这轮限流没轮到），每次切回前台就把所有对话全量序列化一遍 ——
    // 可选 9 想省的那笔开销会从这个门原样回来。
    if (dirty) { _doSave(); createBackup(); }
    // 被 tookLive 挡下的活得自己排一次重试：触发点只有开 App 和切前台，
    // 她要是一直停在前台，第二个活会干等到 30 分钟 TTL 被服务端清掉，结果就丢了。
    // 每轮至少推进一个活，所以不会空转。
    if (leftover) setTimeout(checkLiveAgentRuns, 5000);
  } catch (e) {
    // 连不上电脑很正常（不在家 / 电脑睡了），下次再说
  } finally {
    _agentResumeChecking = false;
  }
}

async function callAPI(conf, path, chat, parentMsgId, chainDepth = 0) {
  if (!conf.apiKey && !conf.isLocalClaude && !conf.isLocalGpt && !conf.isGemini) {
    // Demo 演示模式保持原样
    setTimeout(() => {
      const aiId = nextId();
      const reply = `已收到消息「${path[path.length-1].content.slice(0,20)}…」（演示模式：填入 API Key 后可获得真实回复 (｀・ω・´)ゞ）`;
      chat.nodes[aiId] = { id: aiId, parentId: parentMsgId, role: 'ai', content: reply,
        modelId: conf.id, modelNickname: conf.nickname, tokens: estimateTokens(reply), timestamp: Date.now() };
      chat.headId = aiId; save(); renderMessages(); _debouncedSidebarUpdate();
    }, 500);
    return;
  }

  // 梦痕只在真正的用户正常对话中消费；自主心跳/普鲁斯特的 parent 是 AI，偷看带 peek 标记。
  const dreamParent = chat?.nodes?.[parentMsgId];
  if (typeof dreamArmScar === 'function' && dreamParent?.role === 'user' && !dreamParent.peek) dreamArmScar(conf);

  // 🎯 创建 AI 回复的"气泡"占位
  const aiId = nextId();
  chat.nodes[aiId] = { id: aiId, parentId: parentMsgId, role: 'ai', content: '', reasoning: '',
    modelId: conf.id, modelNickname: conf.nickname, tokens: 0, timestamp: Date.now(), streaming: true };
  chat.headId = aiId;
  renderMessages();

  const messages = await buildApiMessages(path, conf, false, chat);
  // 拼完提示词后还挂着的待看标记是「陈的」：功能关着、没人消费它。只有这一轮新置的才续写，
  // 否则一个永远不被清的标记会让之后每条回复都自动续三跳。
  const staleLookups = lookupChainReasons(conf, []);

  // runId 要接住：下面判断该不该把这条气泡记成「找回时覆写的那条」时，
  // 得知道**这一轮**跑的是哪个活，不能只问「这个对话有没有欠账的活」。
  const { fullText, reasoningText, blocks, error, aborted, runId: turnRunId } = await streamCompletion(conf, messages, (txt, think, blks) => {
    chat.nodes[aiId].content = txt;
    chat.nodes[aiId].reasoning = think;
    chat.nodes[aiId].blocks = blks;
    if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId], true);   // 中途落盘的半截里也别有纸条正文（68-treasure.js）
    // skip estimateTokens during streaming - too expensive per chunk
    renderLiveBubble('bubble-' + aiId, txt, think, true, blks);
  }, undefined, chat);
  // 流结束：撤掉节流里挂着的那次、立刻把完整内容画上（见 renderLiveBubble 上面的说明）
  renderLiveBubble('bubble-' + aiId, fullText, reasoningText, true, blocks, true);
  // 电脑操控的「销账」在 streamCompletion 的 finally 里统一做了（只改内存），
  // 下面收尾时的 save / _doSave 会顺带把它落盘。这里不要再各自补一遍 —— 上一版
  // 就是散着写，4 条调用路只补了 1 条，剩下的全变成重复找回。

  if (error) {
    // 保住已经收到的正文，⚠️ 追加在后面（且必须进 blocks，否则渲染不出来）
    if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId]);   // 断在半路的纸条：正文只遮不埋
    appendWarnBlock(chat.nodes[aiId], error);
    chat.nodes[aiId].streaming = false; chat.nodes[aiId].tokens = 0;
    // 没销账 = 活可能还在电脑上跑，把这个气泡记下来，找回时覆写它而不是另起一条。
    // **必须比对 turnRunId** —— 这条 error 分支是所有模型共用的。只问
    // `chat.agentRunId && !claimed` 的话：她断网时起的活 R1 记在气泡 A 上，
    // 路上随便问本地 Claude一句连不上、又进这里 → 气泡 B 被盖章 →
    // 回家找回 R1 时覆写的是 B（挂在别的提问下面、顶着别的模型名），A 永远停在半句话。
    // POST 都没发出去的那种失败拿不到 runId，自然不会盖章 —— 正是想要的。
    if (turnRunId && turnRunId === chat.agentRunId && !chat.agentRunClaimed) chat.agentResumeNodeId = aiId;
    if (chat.agentRunClaimed) clearAgentRunRefs(chat);
    // 立刻落盘，把 finally 里销的账一起写下去。createBackup 不能漏 ——
    // 这条 error 分支是**所有模型**共用的，漏了等于所有报错轮都不进备份环。
    _doSave(); createBackup(); renderMessages(); return;
  }

  let finalText = fullText;
  if (!finalText.trim() && reasoningText.trim()) {
    finalText = reasoningText;
  }

  chat.nodes[aiId].streaming = false;
  if (typeof extractSuggestionTags === 'function') finalText = extractSuggestionTags(finalText, chat.nodes[aiId], chat);
  if (typeof prefetchNurseCommands === 'function') await prefetchNurseCommands(finalText, conf);
  // 檐廊的结果显式往下传，不走模块级缓存：多模型并排是真并发，共享单槽会串线。
  const gazeResults = (typeof prefetchGazeCommands === 'function') ? await prefetchGazeCommands(finalText, conf) : [];
  // [[LYRICS:]] 要联网取歌词，必须在 processAiCommands 之前取好（提示块要写查到的是哪首）
  if (typeof musicLyricsPrefetch === 'function') await musicLyricsPrefetch(finalText, conf);
  // [[BREATH:]] 同理：翻记忆（可能还要等 DeepSeek 脱水）必须在 processAiCommands 之前做完
  if (typeof breathPrefetch === 'function') await breathPrefetch(finalText, conf);
  const studyCtx = { autoOffer: true, chat, conf, userTurnId: parentMsgId, aiNodeId: aiId, gazeResults };
  chat.nodes[aiId].content = processAiCommands(finalText, chat, conf, studyCtx);
  chat.nodes[aiId].reasoning = reasoningText;
  // 藏宝地图排**第一个**：纸条正文得在别的处理器碰到之前摘走（正文里的 [[CHATS]] 不该真去翻、
  // [[PHOTO:]] 不该占掉后面正经指令的下标）。同 content 路径里它紧跟 normalizeStickerTags。
  if (typeof _applyTreasureToBlocks === 'function') _applyTreasureToBlocks(blocks, studyCtx);
  if (typeof _applyWishToBlocks === 'function') _applyWishToBlocks(blocks, studyCtx);   // 小本子（71-wishbook.js）
  if (typeof _applyNurseToBlocks === 'function') _applyNurseToBlocks(blocks);
  if (typeof _applyGazeToBlocks === 'function') _applyGazeToBlocks(blocks, gazeResults, conf);
  if (typeof _applyVitalsToBlocks === 'function') _applyVitalsToBlocks(blocks);
  if (typeof _applyLifeToBlocks === 'function') _applyLifeToBlocks(blocks);
  if (typeof _applyStudyToBlocks === 'function') _applyStudyToBlocks(blocks, studyCtx);
  if (typeof _applyMomentsToBlocks === 'function') _applyMomentsToBlocks(blocks, conf);
  if (typeof _applyMusicListenToBlocks === 'function') _applyMusicListenToBlocks(blocks, conf);
  if (typeof _applyMusicLyricsToBlocks === 'function') _applyMusicLyricsToBlocks(blocks, conf);
  if (typeof _applyBreathToBlocks === 'function') _applyBreathToBlocks(blocks, conf);
  if (typeof _applyGalleryToBlocks === 'function') _applyGalleryToBlocks(blocks);
  if (typeof _applyStickerOffToBlocks === 'function') _applyStickerOffToBlocks(blocks);
  if (typeof _applyReactToBlocks === 'function') _applyReactToBlocks(blocks);
  if (typeof _applyThinkVeilToBlocks === 'function') _applyThinkVeilToBlocks(blocks);
  // 有副作用的指令（这里是置「下一轮给它看目录/正文」的位）必须在 blocks 这条路上
  // 再走一遍 —— processAiCommands 只管 node.content，不补的话 [[CHATS]] 会裸在气泡里
  if (typeof _applyChatPeekToBlocks === 'function') _applyChatPeekToBlocks(blocks, conf);
  if (typeof _stripSuggestionTagsFromBlocks === 'function') _stripSuggestionTagsFromBlocks(blocks, chat.nodes[aiId], chat);
  // 跑腿：按顺序认领 content 路径派出去的那批 id（不再派第二次）
  if (typeof _applyErrandToBlocks === 'function') _applyErrandToBlocks(blocks, studyCtx);
  if (typeof _applyBuildToBlocks === 'function') _applyBuildToBlocks(blocks, studyCtx);
  if (typeof _applyAlbumToBlocks === 'function') _applyAlbumToBlocks(blocks, studyCtx);
  if (typeof sanitizeBlocksDiary === 'function') sanitizeBlocksDiary(blocks);
  chat.nodes[aiId].blocks = blocks;
  if (typeof treasureVeilNode === 'function') treasureVeilNode(chat.nodes[aiId]);   // reasoning 里抄的那遍（68-treasure.js）
  // 她按了停止：stopGeneration 写的「已停止」刚被上面整份 blocks 覆盖掉了，补回来
  //（只流出思考就停的话，不补就是一个只有 💭 的空气泡）
  if (aborted) appendWarnBlock(chat.nodes[aiId], '已停止生成');
  chat.nodes[aiId].tokens = estimateTokens(fullText); // only once at end
  // 偷看要排在普鲁斯特前面：它俩都认 [[SILENT]]，但偷看那条还得把替它贴上去的截图一起收走，
  // 让 proustDropSilent 先删掉 AI 节点的话，那张截图就变成没人认领的孤儿留在时间线上了
  if (typeof peekDropSilent === 'function' && peekDropSilent(chat, aiId)) return;
  if (typeof vitalsDropSilent === 'function' && vitalsDropSilent(chat, aiId)) return;
  if (proustDropSilent(chat, aiId)) return;           // 它走神了，但决定不说 → 这条悄悄丢掉
  if (_aiVoiceWanted) _maybeAiVoice(chat, aiId);      // AI 写了 [[VOICE]]：正文送去合成，气泡变语音条
  if (_aiDialReason) _maybeAiDial(chat, aiId);        // AI 写了 [[DIAL]]：这边响铃，弹来电卡
  // 电脑操控那一轮立刻落盘：销账不能等 800ms 防抖，手机随时可能被 ROM 杀掉。
  // 普通对话照旧走防抖，别给每一轮都多一次 IDB 写。
  if (chat.agentRunId) {
    if (chat.agentRunClaimed) clearAgentRunRefs(chat);
    _doSave(); createBackup();      // save() 自带备份环，走 _doSave 就得自己补上
  } else save();
  _invalidateNodeCache(aiId); // only invalidate this node's cache
  renderMessages();
  _debouncedSidebarUpdate();
  updateInputHint();
  // 被停下的半截回复不抽记忆、不当轮续写 —— 她刚按了停止，续写等于它又自己开口了
  if (aborted) return;
  // peek 那几条（偷看屏幕 / 一起看插嘴 / 通话里「安静了 N 秒」）不是她说的话，别拿去抽「关于她」的记忆
  if (!path[path.length-1]?.peek) tryExtractMemories(path[path.length-1].content, fullText, conf.id);
  if (reasoningText) {
    console.log('[callAPI] 有思考内容，长度:', reasoningText.length, '开始概括...');
    summarizeThinking(reasoningText).then(summary => {
      console.log('[callAPI] 概括结果:', summary || '(空)');
      if (summary && chat.nodes[aiId]) {
        chat.nodes[aiId].thinkingSummary = summary;
        save(); _invalidateNodeCache(aiId); renderMessages();
      }
    });
    translateThinkingFor(chat.nodes[aiId], aiId);
  }
  triggerMemSummaries(finalText, chat.nodes[aiId], aiId);
  await lookupChainContinue(conf, chat, aiId, gazeResults, chainDepth, staleLookups);
}

// ══ 查询类指令当轮续写（用户：「查完在当轮说」）══
// [[LISTEN]] [[CHATS]] [[CHAT_READ:]] [[DIARY_READ]] [[MOMENTS]] [[GAZE:]] 原来都是
// 「置位 → 下一轮注入」：它写了指令，结果要等她再发一句才摆到它眼前，中间它只能说「我去看看」干等。
// 现在 callAPI 收尾时看这一轮有没有留下待看的东西，有就立刻从这条 AI 消息后面再长出一条
// （同普鲁斯特/心跳那种不造用户消息的续写），结果照旧走原来的注入路子，不另开通道。
//   · 只接 callAPI 这条单模型主路。多模型并排（streamVariant）是并发的，续写会互相串线，不接。
//   · 最多连续三跳：[[CHATS]] → [[CHAT_READ: n]] → 开口 正好两跳，留一跳余量；再多就是它在绕圈。
//   · 她在这期间发了新消息 / 切了分支（headId 不再是这条）就不续，别抢她的话头。
const LOOKUP_CHAIN_MAX = 3;
var _lookupChainNote = null;   // { labels:[] } 下一次 buildSystemPrompt 拿走

function lookupChainReasons(conf, gazeResults) {
  if (!conf) return [];
  const id = conf.id, out = [];
  if (typeof musicListenPending === 'function' && musicListenPending(id)) out.push('正在放的歌');
  if (typeof musicLyricsPending === 'function' && musicLyricsPending(id)) out.push('那首歌的歌词');
  if (typeof breathPending === 'function' && breathPending(id)) out.push('记忆库里翻到的东西');
  if (typeof chatsPeekPending === 'function' && chatsPeekPending(id)) out.push('对话目录');
  if (typeof chatReadPending === 'function' && chatReadPending(id)) out.push('那个对话的正文');
  if (typeof diaryReadPending === 'function' && diaryReadPending(id)) out.push('你的日记');
  if (typeof momentsViewPending === 'function' && momentsViewPending(id)) out.push('最近的猫爪日报');
  // 檐廊的结果已经烤进上一条消息里了（回填历史时它看得见），只有「看」算查询；[[SAY:]] 是写操作，不为它续
  if (Array.isArray(gazeResults) && gazeResults.some(g => g && g.kind === 'gaze')) out.push('檐廊外面看到的东西');
  return out;
}

async function lookupChainContinue(conf, chat, aiId, gazeResults, depth, stale) {
  const reasons = lookupChainReasons(conf, gazeResults).filter(r => !(stale || []).includes(r));
  if (!reasons.length) return;
  if ((depth || 0) >= LOOKUP_CHAIN_MAX) return;       // 标记留着，下一轮照旧注入，只是不再自动续
  if (!chat || chat.ended || !chat.nodes[aiId] || chat.headId !== aiId) return;
  _lookupChainNote = { labels: reasons };
  try {
    await callAPI(conf, getMessagePath(chat, aiId), chat, aiId, (depth || 0) + 1);
  } catch (e) {
    console.warn('[当轮续写] 失败：', e.message);
  } finally {
    _lookupChainNote = null;
  }
}

function lookupChainPromptFor() {
  const n = _lookupChainNote;
  _lookupChainNote = null;
  if (!n) return '';
  return `\n\n[接着说] 你上一条要看的${n.labels.join('、')}已经摆在上面了。`
    + '这是同一轮的接续：她还没回话，直接顺着你刚才的话往下说，'
    + '别重复刚才说过的，也别再说「我去看看」「等我一下」。';
}

async function streamVariant(conf, path, chat, nodeId, variantIdx) {
  const node = chat.nodes[nodeId];
  if (!node) return;
  const variant = node.variants[variantIdx];
  if (!variant) return;

  if (!conf.apiKey && !conf.isLocalClaude && !conf.isLocalGpt && !conf.isGemini) {
    await new Promise(r => setTimeout(r, 400 + variantIdx * 200));
    variant.content = `[${conf.nickname}] 演示回复。接入 API Key 后获得真实内容 (＾▽＾)`;
    variant.tokens  = estimateTokens(variant.content);
    variant.streaming = false;
    save(); renderMessages(); updateHeaderTokenInfo();
    return;
  }

  // 同上：出生时抄一份，别等回来再读（每个变体各抄各的）
  const messages = await buildApiMessages(path, conf, false, chat);
  // fullText 下面要被 extractSuggestionTags 改写，必须是 let —— const 的话每个变体一成功就抛 TypeError，
  // 指令不执行、save 不跑，多模型并排整条路静默坏掉
  let { fullText, reasoningText, blocks, error, aborted } = await streamCompletion(conf, messages, (txt, think, blks) => {
    variant.content = txt;
    variant.reasoning = think;
    variant.blocks = blks;
    if (typeof treasureVeilNode === 'function') treasureVeilNode(variant, true);
    // skip estimateTokens during streaming
    renderLiveBubble('variant-' + nodeId + '-' + variantIdx, txt, think, true, blks);
  }, undefined, chat);   // 变体重跑同样要绑发起的对话
  // 流结束：每个 variant 的气泡各自立刻补画终稿，别被节流吞掉尾巴
  renderLiveBubble('variant-' + nodeId + '-' + variantIdx, fullText, reasoningText, true, blocks, true);

  if (error) {
    // 同群聊那处：变体的渲染（06-render-msg.js:552）也是 blocks 优先，
    // 只改 content 的话已经流出来的半截正文会原样留着、⚠️ 一个字看不见
    if (typeof treasureVeilNode === 'function') treasureVeilNode(variant);
    appendWarnBlock(variant, `${conf.nickname}: ${error}`);
    variant.streaming = false; save(); renderMessages(); return;
  }

  variant.streaming = false;
  if (typeof extractSuggestionTags === 'function') fullText = extractSuggestionTags(fullText, variant, chat);
  if (typeof prefetchNurseCommands === 'function') await prefetchNurseCommands(fullText, conf);
  // ★ 这条路径是并发的（下面 confs.forEach(c => streamVariant(...)) 不 await），
  // 檐廊结果必须每个 variant 自己拿着，绝不能共享模块级单槽。
  const gazeResults = (typeof prefetchGazeCommands === 'function') ? await prefetchGazeCommands(fullText, conf) : [];
  if (typeof musicLyricsPrefetch === 'function') await musicLyricsPrefetch(fullText, conf);
  if (typeof breathPrefetch === 'function') await breathPrefetch(fullText, conf);
  const studyCtx = { autoOffer: true, chat, conf, userTurnId: node.parentId, aiNodeId: nodeId, gazeResults };
  variant.content = processAiCommands(fullText, chat, conf, studyCtx);
  // 多模型并排时痕迹落在**这一个 variant** 上，不是整条消息上——
  // 三个模型里只有一个能拿到翻页权（其余被 fail closed 挡掉），标记就该跟着它。
  variant.reasoning = reasoningText;
  // 藏宝地图排**第一个**：纸条正文得在别的处理器碰到之前摘走（正文里的 [[CHATS]] 不该真去翻、
  // [[PHOTO:]] 不该占掉后面正经指令的下标）。同 content 路径里它紧跟 normalizeStickerTags。
  if (typeof _applyTreasureToBlocks === 'function') _applyTreasureToBlocks(blocks, studyCtx);
  if (typeof _applyWishToBlocks === 'function') _applyWishToBlocks(blocks, studyCtx);   // 小本子（71-wishbook.js）
  if (typeof _applyNurseToBlocks === 'function') _applyNurseToBlocks(blocks);
  if (typeof _applyGazeToBlocks === 'function') _applyGazeToBlocks(blocks, gazeResults, conf);
  if (typeof _applyVitalsToBlocks === 'function') _applyVitalsToBlocks(blocks);
  if (typeof _applyLifeToBlocks === 'function') _applyLifeToBlocks(blocks);
  if (typeof _applyStudyToBlocks === 'function') _applyStudyToBlocks(blocks, studyCtx);
  if (typeof _applyMomentsToBlocks === 'function') _applyMomentsToBlocks(blocks, conf);
  if (typeof _applyMusicListenToBlocks === 'function') _applyMusicListenToBlocks(blocks, conf);
  if (typeof _applyMusicLyricsToBlocks === 'function') _applyMusicLyricsToBlocks(blocks, conf);
  if (typeof _applyBreathToBlocks === 'function') _applyBreathToBlocks(blocks, conf);
  if (typeof _applyGalleryToBlocks === 'function') _applyGalleryToBlocks(blocks);
  if (typeof _applyStickerOffToBlocks === 'function') _applyStickerOffToBlocks(blocks);
  if (typeof _applyReactToBlocks === 'function') _applyReactToBlocks(blocks);
  if (typeof _applyThinkVeilToBlocks === 'function') _applyThinkVeilToBlocks(blocks);
  // 有副作用的指令（这里是置「下一轮给它看目录/正文」的位）必须在 blocks 这条路上
  // 再走一遍 —— processAiCommands 只管 node.content，不补的话 [[CHATS]] 会裸在气泡里
  if (typeof _applyChatPeekToBlocks === 'function') _applyChatPeekToBlocks(blocks, conf);
  if (typeof _stripSuggestionTagsFromBlocks === 'function') _stripSuggestionTagsFromBlocks(blocks, variant, chat);
  // 跑腿：按顺序认领 content 路径派出去的那批 id（不再派第二次）
  if (typeof _applyErrandToBlocks === 'function') _applyErrandToBlocks(blocks, studyCtx);
  if (typeof _applyBuildToBlocks === 'function') _applyBuildToBlocks(blocks, studyCtx);
  if (typeof _applyAlbumToBlocks === 'function') _applyAlbumToBlocks(blocks, studyCtx);
  if (typeof sanitizeBlocksDiary === 'function') sanitizeBlocksDiary(blocks);
  variant.blocks = blocks;
  if (typeof treasureVeilNode === 'function') treasureVeilNode(variant);
  if (aborted) appendWarnBlock(variant, '已停止');   // 同 callAPI：停止提示别被整份 blocks 盖掉
  variant.tokens = estimateTokens(fullText); // only once at end
  save();
  _invalidateNodeCache(nodeId);
  renderMessages();
  _debouncedSidebarUpdate();
  if (reasoningText) {
    summarizeThinking(reasoningText).then(summary => {
      if (summary) {
        variant.thinkingSummary = summary;
        save(); _invalidateNodeCache(nodeId); renderMessages();
      }
    });
    translateThinkingFor(variant, nodeId);
  }
  triggerMemSummaries(fullText, variant, nodeId);
}

function chooseVariant(nodeId, vi) {
  // 换 variant = 这条消息的正文换了一份，正念着的是上一份
  if (typeof ttsStopSpeaking === 'function') ttsStopSpeaking();
  const chat = getActiveChat(); if (!chat) return;
  const node = chat.nodes[nodeId]; if (!node) return;
  node.chosenVariant = vi; save(); renderMessages();
}

// ═══════════════════════════════════════════════════════
// MULTI-MODEL (parallel) RESPONSES — fixes missing-function bug
// ═══════════════════════════════════════════════════════
function callAPIMulti(confs, path, chat, parentMsgId) {
  const nodeId = nextId();
  chat.nodes[nodeId] = {
    id: nodeId, parentId: parentMsgId, role: 'ai', isMulti: true, chosenVariant: 0,
    timestamp: Date.now(),
    variants: confs.map(c => ({ modelId: c.id, modelNickname: c.nickname, content: '', reasoning: '', tokens: 0, streaming: true }))
  };
  chat.headId = nodeId;
  save(); renderMessages();
  confs.forEach((c, vi) => streamVariant(c, path, chat, nodeId, vi));
}

// ═══════════════════════════════════════════════════════
// GROUP CHAT — AIs take turns replying and can see each other — fixes missing-function bug
// ═══════════════════════════════════════════════════════
