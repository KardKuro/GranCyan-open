# 本地情绪声音（CosyVoice3）怎么装

GranCyan 的 `/api/tts` 在 voice 是 `cosy-<样本名>` 时走这里；没装也没关系，会自动退回 Edge 的男声。
装在哪由环境变量决定：

| 变量 | 默认 | 是什么 |
|---|---|---|
| `GRANCYAN_VOICE_DIR` | （无，不设就不启用） | 引擎目录：`CosyVoice\`（源码）、`models\Fun-CosyVoice3-0.5B\`、`voices\` |
| `GRANCYAN_VOICE_PY` | `python` | 装了 torch 的 Python 3.10（写完整路径） |
| `GRANCYAN_VOICE_IDLE_MIN` | `10` | 多少分钟没人用就关掉推理进程、把显存还回去 |

## 实际跑通过的安装步骤

```bash
VOICE_DIR=/path/to/voice-engine          # 之后设成 GRANCYAN_VOICE_DIR
ENV_DIR=/path/to/conda-envs/cosyvoice    # Python 环境放哪都行

# 1. 源码（带 Matcha-TTS 子模块）
git clone --depth 1 --recursive https://github.com/FunAudioLLM/CosyVoice.git $VOICE_DIR/CosyVoice

# 2. Python 3.10 环境
conda create -y -p $ENV_DIR python=3.10
PY=$ENV_DIR/python.exe                   # 之后设成 GRANCYAN_VOICE_PY
$PY -m pip install --no-cache-dir torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cu121
# openai-whisper 这个老版本在新 setuptools 下编不过：先降 setuptools，再关掉构建隔离装
$PY -m pip install --no-cache-dir "setuptools<70" wheel
$PY -m pip install --no-cache-dir --no-build-isolation openai-whisper==20231117
# 其余按 CosyVoice/requirements.txt，去掉 gradio/tensorboard/deepspeed/tensorrt 这些推理用不到的，加一个 lameenc（出 mp3）
$PY -m pip install --no-cache-dir conformer==0.3.2 diffusers==0.29.0 hydra-core==1.3.2 HyperPyYAML==1.2.3 inflect==7.3.1 \
  librosa==0.10.2 lightning==2.2.4 matplotlib==3.7.5 modelscope==1.20.0 numpy==1.26.4 omegaconf==2.3.0 onnx==1.16.0 \
  onnxruntime==1.18.0 protobuf==4.25 rich==13.7.1 soundfile==0.12.1 transformers==4.51.3 x-transformers==2.11.24 \
  wetext==0.0.4 wget==3.2 gdown==5.1.0 einops tiktoken rootutils lameenc pyarrow==18.1.0
# yaml 里引用了数据处理模块，缺它模型都加载不起来；0.3.4 要编译，装二进制轮子
$PY -m pip install --no-cache-dir --only-binary=:all: pyworld

# 2.5 文本规范化（数字/单位念成中文）：wetext 每次构造都去 modelscope 拉 pengzhendong/wetext，
#     那个接口要登录、还会限流，拉不到就静默变成「no frontend」。提前把四个 fst 下到引擎目录：
for f in zh/tn/tagger.fst zh/tn/verbalizer.fst en/tn/tagger.fst en/tn/verbalizer.fst; do
  mkdir -p $VOICE_DIR/wetext/$(dirname $f)
  curl -sSL -o $VOICE_DIR/wetext/$f https://www.modelscope.cn/models/pengzhendong/wetext/resolve/master/$f
done   # ⚠️ 下完看大小：被限流时回的是 137 字节的 JSON，不是 fst

# 3. 模型：ModelScope FunAudioLLM/Fun-CosyVoice3-0.5B-2512，只下推理要的（约 5GB，整个仓库 9.3GB）
#    要：CosyVoice-BlankEN/*、campplus.onnx、configuration.json、cosyvoice3.yaml、flow.pt、hift.pt、llm.pt、speech_tokenizer_v3.onnx
#    不要：flow.decoder.estimator.fp32.onnx（TensorRT 才用）、llm.rl.pt、speech_tokenizer_v3.batch.onnx
#    ⚠️ 下完核 sha256（仓库文件列表 API 里有）。这次就有一个文件被两条下载同时写坏了，大小对、内容错。

# 4. 打包后的 exe 读不到 asar 里的脚本，要拷一份到引擎目录
cp scripts/voice/cosy_sidecar.py $VOICE_DIR/
```

## 实测（一台 6GB 显存的笔记本）

| | |
|---|---|
| 冷启动（含请 Ollama 让出显卡） | 约 61–66 秒 |
| 显存 | 约 1.9–2.2 GB（qwen 4.1G 和它塞不进同一张卡，所以启动时请 Ollama 先卸） |
| 进程提交内存 | 稳定 5.2 GB，加载瞬间峰值 7 GB |
| 一句 4 秒的话 | 约 3.5–4 秒（RTF≈0.85–1.0） |
| 通话长回复首句出声 | 约 3.6 秒（按句流水线；整段一次合成要 9.5 秒） |

为了跑到这个速度，`cosy_sidecar.py` 对 CosyVoice 打了几处补丁（都在文件里写了为什么）：
fp16 直接建在 GPU 上、speech tokenizer 用到才载、参考音特征存盘、**LLM 解码录成 CUDA Graph**
（测试机一次 kernel 启动 44µs，原版 Qwen 一步两千多个 kernel = 118ms/token，RTF 3.5）、采样向量化。

## 声线

`voices\<名字>.wav` + `voices\<名字>.txt`（wav 里那句话的原文），名字只能小写字母数字连字符。
放进去设置里就多一个「本地样本」选项，不用重启。样本 3~10 秒、干净人声、一个人说话最好。

默认的 `keke` 是拿 Edge 的云健（沉稳男声）念一句当参考音克隆出来的——所以平常语气下还带一点播音腔，
换成真人样本会好很多。
