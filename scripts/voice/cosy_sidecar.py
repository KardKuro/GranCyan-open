# -*- coding: utf-8 -*-
"""
本地情绪声音的推理小服务（CosyVoice3）。由 server/tts-local.js 按需拉起、闲了就关。

只听 127.0.0.1，端口由父进程给（默认 0 = 系统挑一个空的），模型加载完往 stdout 打一行
    READY <port>
父进程认这一行才开始发请求。带 --watch-stdin 时 stdin 被关掉（父进程没了）就自己退出——
Windows 上子进程不会跟着父进程死，不这样做的话 server 一崩，这只就攥着两个 G 显存变成孤儿。

POST /tts  JSON {text, voice, instruct, speed}
  voice    : voices 目录下的样本名（<name>.wav + <name>.txt，txt 是 wav 里那句话的原文）
  instruct : 空 = 零样本克隆（韵律跟参考音走）；非空 = instruct2（js/voice-style.js 里那张表给的）
回 audio/mpeg（整句）。

调试：COSY_MEMTRACE=1 打每一步的提交内存/显存；COSY_PROFILE=1 打 LLM 和 token2wav 各花多久；
COSY_NO_GRAPH=1 关掉 CUDA Graph 解码（对照用）。
GET /health → {"ok":true,"sr":...,"voices":[...]}
"""
import argparse
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument('--root', required=True, help='CosyVoice 仓库目录')
ap.add_argument('--model', required=True, help='Fun-CosyVoice3-0.5B 模型目录')
ap.add_argument('--voices', required=True, help='参考音目录')
ap.add_argument('--port', type=int, default=0)
ap.add_argument('--fp32', action='store_true', help='关掉 fp16（显存够、想要更稳的时候）')
ap.add_argument('--watch-stdin', action='store_true',
                help='stdin 关了就退出（父进程拉起时带上；手动跑时别带，stdin 是空设备会立刻退）')
args = ap.parse_args()

sys.path.insert(0, args.root)
sys.path.insert(0, os.path.join(args.root, 'third_party', 'Matcha-TTS'))
# modelscope 默认把东西缓存进 C:\Users\...\.cache —— 引到引擎目录，别往 C 盘塞
ENGINE_DIR = os.path.dirname(os.path.abspath(args.voices))
os.environ.setdefault('MODELSCOPE_CACHE', os.path.join(ENGINE_DIR, 'cache'))



def memtrace(tag):
    """COSY_MEMTRACE=1 时打一行：这一步之后进程的提交内存（Windows 上真正会撑爆的是它，不是物理内存）。"""
    if os.environ.get('COSY_MEMTRACE') != '1' or os.name != 'nt':
        return
    import ctypes
    import ctypes.wintypes as w

    class PMC(ctypes.Structure):
        _fields_ = [('cb', w.DWORD), ('a', w.DWORD)] + [(n, ctypes.c_size_t) for n in
                    ('pws', 'ws', 'qpp', 'qp', 'qpnp', 'qnp', 'commit', 'peak')]
    k = ctypes.windll.kernel32
    k.GetCurrentProcess.restype = w.HANDLE
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD]
    c = PMC()
    c.cb = ctypes.sizeof(c)
    ctypes.windll.psapi.GetProcessMemoryInfo(k.GetCurrentProcess(), ctypes.byref(c), c.cb)
    vram = torch.cuda.memory_allocated() >> 20 if 'torch' in sys.modules and torch.cuda.is_initialized() else 0
    print('[cosy] mem %-24s commit %5dMB peak %5dMB vram %5dMB' % (tag, c.commit >> 20, c.peak >> 20, vram), file=sys.stderr, flush=True)


import numpy as np  # noqa: E402
import torch  # noqa: E402
import lameenc  # noqa: E402
import onnxruntime  # noqa: E402

# ⚠️ speech tokenizer（924MB 的 onnx）只在「从参考音提特征」时用一次，而特征会存盘缓存。
# 但 CosyVoice 的 frontend 一构造就把它整个载进内存——这台 15G 的机器上，Ollama + 几个 claude
# 已经把提交内存吃到只剩几个 G，再加它就是 bad allocation，还会连累别的程序申请不到内存
# （2026-10-03 实测：推理进程启动时 bash 都 fork 不出来了）。
# 所以换成「用到才建、用完就扔」的壳：平时根本不进内存。
_RealSession = onnxruntime.InferenceSession


class _LazySession:
    def __init__(self, *a, **kw):
        self._a, self._kw, self._s = a, kw, None

    def _real(self):
        if self._s is None:
            print('[cosy] 载入 speech tokenizer（提参考音特征）', file=sys.stderr, flush=True)
            self._s = _RealSession(*self._a, **self._kw)
        return self._s

    def get_inputs(self):
        return self._real().get_inputs()

    def run(self, *a, **kw):
        return self._real().run(*a, **kw)

    def release(self):
        self._s = None


def _session_factory(path, *a, **kw):
    if 'speech_tokenizer' in os.path.basename(str(path)):
        return _LazySession(path, *a, **kw)
    return _RealSession(path, *a, **kw)


onnxruntime.InferenceSession = _session_factory
# 文本规范化（数字、单位念成中文）用 wetext，它每次构造都去 modelscope 拉 pengzhendong/wetext——
# 那个接口要登录/会限流（2026-10-03 实测 403 + 「操作过于频繁」），拉不到就静默变成「no frontend」，
# 「3点」这种就念不对了。所以 fst 文件提前下到引擎目录的 wetext\ 里，这里直接指过去。
_WETEXT = os.path.join(ENGINE_DIR, 'wetext')
if os.path.isfile(os.path.join(_WETEXT, 'zh', 'tn', 'tagger.fst')):
    import wetext.wetext as _wt  # noqa: E402
    _wt.snapshot_download = lambda *a, **k: _WETEXT
else:
    print('[cosy] ⚠️ 没有 %s，数字/单位会念不准' % _WETEXT, file=sys.stderr, flush=True)
import cosyvoice.cli.cosyvoice as _cv  # noqa: E402
from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402

# ⚠️ 同一个原因的第二刀：yaml 一构造就是 llm+flow 共 8.4 亿参数的 fp32 CPU 副本，
# 再加 Qwen from_pretrained 的临时副本，进程提交量冲到 6.8GB（2026-10-03 实测）。
# fp16 模式下 llm/flow 反正马上要 .half()，那就直接以 fp16 构建，峰值砍一半。
# hift（声码器）不在 CosyVoice 的 fp16 范围里，构建完转回 fp32——它没有构造时算出来的
# buffer，参数随后被权重文件整个覆盖，所以转回去是精确的。
if not args.fp32:
    _real_yaml = _cv.load_hyperpyyaml

    # 而且直接建在 GPU 上：CPU 那份副本本身就是好几个 G 的提交内存。
    def _fp16_yaml(*a, **kw):
        old = torch.get_default_dtype()
        torch.set_default_dtype(torch.float16)
        torch.set_default_device('cuda')
        try:
            cfg = _real_yaml(*a, **kw)
        finally:
            torch.set_default_dtype(old)
            torch.set_default_device('cpu')
        if 'hift' in cfg:
            cfg['hift'].float()
        memtrace('yaml built')
        return cfg

    _cv.load_hyperpyyaml = _fp16_yaml

    # 第三刀：官方 load() 把 state dict 读进来以后，模块还在 CPU 上就灌，再 .to(device)。
    # 模块已经在 GPU 上了，权重也直接读到 GPU（显存里瞬时多一份 fp32，灌完就释放），
    # CPU 这边不留副本。⚠️ 别用 mmap 读：Windows 上那是写时复制映射，照样整份算提交内存。
    import cosyvoice.cli.model as _cm

    def _lean_load(self, llm_model, flow_model, hift_model):
        for mod, f in ((self.llm, llm_model), (self.flow, flow_model)):
            sd = torch.load(f, map_location=self.device, weights_only=True)
            mod.load_state_dict(sd, strict=True)
            del sd
            torch.cuda.empty_cache()
            mod.to(self.device).eval()
        sd = torch.load(hift_model, map_location=self.device, weights_only=True)
        self.hift.load_state_dict({k.replace('generator.', ''): v for k, v in sd.items()}, strict=True)
        self.hift.to(self.device).eval()
        memtrace('weights loaded')

    _cm.CosyVoiceModel.load = _lean_load

# ── 速度：CUDA Graph 解码 ─────────────────────────────────────────────
# 2026-10-03 实测：这台机器（Windows + 笔记本 7735H）每次 CUDA kernel 启动要 44µs，
# 而 HF 版 Qwen 解码一步要发两千多个小 kernel → 一步 118ms，RTF 3.5（5 秒的话合成 19 秒）。
# 算力本身没问题（fp16 矩阵乘 13 TFLOPS），GPU 一直在等 CPU 喂。
# 所以把「一步 Qwen 前向 + 解码头 + log_softmax」录成一张 CUDA Graph，每步只 replay 一次。
# KV cache 换成固定大小的 StaticCache（4096 个位置也就 50MB 显存），图里的张量地址才能固定。
# 录图失败就退回 CosyVoice 原版的逐步解码（慢，但能出声）。
GRAPH_MAX = 4096
_graph_state = {'dec': None, 'failed': ''}


class _GraphDecoder:
    def __init__(self, lm):
        from transformers import StaticCache
        self.lm = lm
        self.qwen = lm.llm.model.model           # Qwen2Model（不带 lm_head）
        w = lm.speech_embedding.weight
        self.cache = StaticCache(config=lm.llm.model.config, max_batch_size=1, max_cache_len=GRAPH_MAX,
                                 device=w.device, dtype=w.dtype)
        self.emb = torch.zeros(1, 1, w.shape[1], device=w.device, dtype=w.dtype)
        self.pos = torch.zeros(1, dtype=torch.long, device=w.device)
        self.graph = None
        self.out = None

    def _step(self, emb, pos):
        h = self.qwen(inputs_embeds=emb, cache_position=pos, past_key_values=self.cache, use_cache=True).last_hidden_state
        # 原版在 autocast 下算 log_softmax（会提到 fp32），这里显式转 float，结果一致
        return self.lm.llm_decoder(h[:, -1]).float().log_softmax(dim=-1)

    @torch.inference_mode()
    def capture(self):
        s = torch.cuda.Stream()
        s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s):
            for _ in range(3):
                self._step(self.emb, self.pos)
        torch.cuda.current_stream().wait_stream(s)
        self.graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(self.graph, capture_error_mode='thread_local'):
            self.out = self._step(self.emb, self.pos)
        self.cache.reset()

    @torch.inference_mode()
    def run(self, lm_input, sampling, min_len, max_len):
        self.cache.reset()
        L = lm_input.shape[1]
        logp = self._step(lm_input.to(self.emb.dtype), torch.arange(L, device=self.emb.device))
        out_tokens = []
        for i in range(min(max_len, GRAPH_MAX - L)):
            top_ids = self.lm.sampling_ids(logp.squeeze(dim=0), out_tokens, sampling, ignore_eos=i < min_len)
            if top_ids in self.lm.stop_token_ids:
                break
            yield top_ids
            out_tokens.append(top_ids)
            self.emb.copy_(self.lm.speech_embedding.weight[top_ids].reshape(1, 1, -1))
            self.pos.fill_(L + i)
            self.graph.replay()
            logp = self.out


def _setup_graph(lm):
    try:
        dec = _GraphDecoder(lm)
        t = time.time()
        dec.capture()
        _graph_state['dec'] = dec
        print('[cosy] CUDA Graph 解码已启用（录图 %.1fs）' % (time.time() - t), file=sys.stderr, flush=True)
    except Exception as e:
        _graph_state['failed'] = repr(e)
        print('[cosy] ⚠️ CUDA Graph 录不了，退回逐步解码（会慢）：%r' % e, file=sys.stderr, flush=True)


import cosyvoice.llm.llm as _llm  # noqa: E402
_orig_wrapper = _llm.Qwen2LM.inference_wrapper


def _graph_wrapper(self, lm_input, sampling, min_len, max_len, uuid):
    dec = _graph_state['dec']
    if dec is None or dec.lm is not self or hasattr(self, 'vllm'):
        yield from _orig_wrapper(self, lm_input, sampling, min_len, max_len, uuid)
        return
    yield from dec.run(lm_input, sampling, min_len, max_len)


_llm.Qwen2LM.inference_wrapper = _graph_wrapper

# 采样：原版 nucleus_sampling 是 Python 循环逐个取 GPU 标量（每个 token 二十几次同步，
# 在这台机器上每次同步都要几十微秒）。改成向量化，选中集合完全一样：
# 第 i 个（按概率降序）入选 ⇔ 它前面的累计概率 < top_p 且 i < top_k。
import cosyvoice.utils.common as _common  # noqa: E402


def _nucleus_sampling(weighted_scores, top_p=0.8, top_k=25):
    sorted_value, sorted_idx = weighted_scores.softmax(dim=0).sort(descending=True, stable=True)
    before = sorted_value.cumsum(0) - sorted_value
    keep = (before < top_p) & (torch.arange(sorted_value.shape[0], device=sorted_value.device) < top_k)
    prob, idx = sorted_value[keep], sorted_idx[keep]
    return idx[prob.multinomial(1, replacement=True)].item()


def _ras_sampling(weighted_scores, decoded_tokens, sampling, top_p=0.8, top_k=25, win_size=10, tau_r=0.1):
    top_ids = _nucleus_sampling(weighted_scores, top_p=top_p, top_k=top_k)
    rep_num = decoded_tokens[-win_size:].count(top_ids)
    if rep_num >= win_size * tau_r:
        weighted_scores[top_ids] = -float('inf')
        top_ids = _common.random_sampling(weighted_scores, decoded_tokens, sampling)
    return top_ids


_common.nucleus_sampling = _nucleus_sampling
_common.ras_sampling = _ras_sampling

if os.environ.get('COSY_PROFILE') == '1':
    # 分段计时：LLM 吐 speech token（自回归，逐个）和 token→波形（flow+hift）各花多久
    import cosyvoice.cli.model as _cmp
    _orig_llm_job = _cmp.CosyVoiceModel.llm_job

    def _timed_llm_job(self, *a, **kw):
        t = time.time()
        r = _orig_llm_job(self, *a, **kw)
        n = sum(len(v) for v in self.tts_speech_token_dict.values())
        print('[cosy] prof llm %.0fms tokens~%d' % ((time.time() - t) * 1000, n), file=sys.stderr, flush=True)
        return r
    _cmp.CosyVoiceModel.llm_job = _timed_llm_job
    for _cls in (_cmp.CosyVoice2Model, _cmp.CosyVoice3Model):
        if 'token2wav' in _cls.__dict__:
            def _mk(orig):
                def _timed_t2w(self, *a, **kw):
                    torch.cuda.synchronize()
                    t = time.time()
                    r = orig(self, *a, **kw)
                    torch.cuda.synchronize()
                    print('[cosy] prof token2wav %.0fms' % ((time.time() - t) * 1000), file=sys.stderr, flush=True)
                    return r
                return _timed_t2w
            _cls.token2wav = _mk(_cls.__dict__['token2wav'])

t0 = time.time()
memtrace('imports done')
cosy = AutoModel(model_dir=args.model, fp16=not args.fp32)
memtrace('model ready')
if os.environ.get('COSY_NO_GRAPH') != '1':
    _setup_graph(cosy.model.llm)
    memtrace('graph captured')
SR = cosy.sample_rate
print('[cosy] 模型加载 %.1fs，sr=%d，fp16=%s' % (time.time() - t0, SR, not args.fp32), file=sys.stderr, flush=True)

# 同一时刻只合成一句：一块 6G 的卡，两句并行只会一起慢、还可能一起 OOM
gpu_lock = threading.Lock()

# 参考音的特征提一次就够（speech tokenizer 在 CPU 上跑，一次几百毫秒）。
# 按 (wav, txt) 的 mtime 认缓存：换了样本文件不用重启。
_spk_cache = {}


def voice_files(name):
    if not name or not all(c.isalnum() or c == '-' for c in name):
        raise ValueError('非法样本名')
    wav = os.path.join(args.voices, name + '.wav')
    txt = os.path.join(args.voices, name + '.txt')
    if not os.path.isfile(wav) or not os.path.isfile(txt):
        raise FileNotFoundError('没有这个样本：' + name)
    return wav, txt


def speaker(name):
    wav, txt = voice_files(name)
    key = (os.path.getmtime(wav), os.path.getmtime(txt))
    hit = _spk_cache.get(name)
    if hit and hit[0] == key:
        return hit[1]
    # 磁盘缓存：文件名带上两个 mtime，换了样本自然对不上、重新提
    disk = os.path.join(args.voices, '.cache', '%s-%d-%d.pt' % (name, int(key[0]), int(key[1])))
    if os.path.isfile(disk):
        try:
            info = torch.load(disk, map_location=cosy.frontend.device, weights_only=True)
            _spk_cache[name] = (key, info)
            return info
        except Exception as e:
            print('[cosy] 特征缓存读不了，重新提：%r' % e, file=sys.stderr, flush=True)
    with open(txt, 'r', encoding='utf-8') as f:
        prompt = f.read().strip()
    # CosyVoice3 的零样本要求 prompt_text 前面带这串系统前缀（见官方 example.py）
    info = cosy.frontend.frontend_zero_shot('', 'You are a helpful assistant.<|endofprompt|>' + prompt, wav, SR, '')
    del info['text']
    del info['text_len']
    tok = cosy.frontend.speech_tokenizer_session
    if isinstance(tok, _LazySession):
        tok.release()                      # 提完就扔，别让 924MB 一直攥着
    try:
        os.makedirs(os.path.dirname(disk), exist_ok=True)
        torch.save({k: v.cpu() for k, v in info.items()}, disk + '.tmp')
        os.replace(disk + '.tmp', disk)
    except Exception as e:
        print('[cosy] 特征缓存写不进去（不影响）：%r' % e, file=sys.stderr, flush=True)
    _spk_cache[name] = (key, info)
    return info


def model_inputs(text, name, instruct):
    """和 CosyVoice 自己的 inference_zero_shot / inference_instruct2 等价，但特征走上面的缓存。
    instruct2 不能直接用官方的 zero_shot_spk_id：带 spk id 时它会拿缓存里的 prompt_text
    （参考音原文）顶掉指令，指令就静默失效了——所以这里自己换。"""
    spk = speaker(name)
    for seg in cosy.frontend.text_normalize(text, split=True, text_frontend=True):
        tok, tok_len = cosy.frontend._extract_text_token(seg)
        mi = dict(spk)
        mi['text'], mi['text_len'] = tok, tok_len
        if instruct:
            itok, itok_len = cosy.frontend._extract_text_token(instruct)
            mi['prompt_text'], mi['prompt_text_len'] = itok, itok_len
            mi.pop('llm_prompt_speech_token', None)
            mi.pop('llm_prompt_speech_token_len', None)
        yield mi


def new_encoder():
    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(SR)
    enc.set_channels(1)
    enc.set_quality(5)
    return enc


def pcm16(t):
    a = t.squeeze().detach().float().cpu().numpy()
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


def lift_quiet(wav):
    """响度下限：「轻声」那条出来近乎耳语（2026-10-03 实测 RMS 0.013，平常 0.05），
    手机外放根本听不清。耳语的质感留着，只把整体音量抬到平常附近，峰值不超过 0.95。"""
    rms = float(wav.pow(2).mean().sqrt())
    peak = float(wav.abs().max())
    if rms <= 1e-6 or rms >= LOUD_FLOOR:
        return wav
    return wav * min(LOUD_FLOOR / rms, 0.95 / max(peak, 1e-6))


LOUD_FLOOR = 0.045


def synth(text, name, instruct, speed):
    """合成一整句，回 mp3 字节。整句合成完再编码：响度要按整句算。
    （不做 HTTP 流式：通话那头按句切开流水线念，见 js/11-camera-call.js 的 _callSpeakParts）"""
    with gpu_lock:
        parts = [out['tts_speech'].float() for mi in model_inputs(text, name, instruct)
                 for out in cosy.model.tts(**mi, stream=False, speed=speed)]
    if not parts:
        return b''
    enc = new_encoder()
    return bytes(enc.encode(pcm16(lift_quiet(torch.cat(parts, dim=-1))))) + bytes(enc.flush())


def list_voices():
    try:
        return sorted(f[:-4] for f in os.listdir(args.voices)
                      if f.endswith('.wav') and os.path.isfile(os.path.join(args.voices, f[:-4] + '.txt')))
    except OSError:
        return []


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ok': True, 'sr': SR, 'voices': list_voices()})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/tts':
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n).decode('utf-8'))
            text = str(req.get('text') or '').strip()
            name = str(req.get('voice') or '')
            instruct = str(req.get('instruct') or '')
            speed = float(req.get('speed') or 1.0)
            if not text:
                raise ValueError('缺少 text')
            speed = min(1.5, max(0.5, speed))
            voice_files(name)
        except Exception as e:  # 参数错就是参数错，别让它进 GPU 锁
            return self._json(400, {'error': str(e)})
        t = time.time()
        try:
            buf = synth(text, name, instruct, speed)
        except Exception as e:
            print('[cosy] 合成失败：%r' % e, file=sys.stderr, flush=True)
            return self._json(500, {'error': str(e)})
        self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        self.send_header('Content-Length', str(len(buf)))
        self.send_header('X-Synth-Ms', str(int((time.time() - t) * 1000)))
        self.end_headers()
        self.wfile.write(buf)


def watch_parent():
    try:
        while sys.stdin.read(1):
            pass
    except Exception:
        pass
    os._exit(0)


if args.watch_stdin:
    threading.Thread(target=watch_parent, daemon=True).start()
srv = ThreadingHTTPServer(('127.0.0.1', args.port), H)
# 预热一句：第一次真合成会触发 CUDA kernel 编译/显存分配，别让第一个真请求替它付这笔
try:
    names = list_voices()
    if names:
        synth('嗯。', names[0], '', 1.0)
except Exception as e:
    print('[cosy] 预热失败（不影响）：%r' % e, file=sys.stderr, flush=True)
memtrace('warmed up')
print('READY %d' % srv.server_address[1], flush=True)
srv.serve_forever()
