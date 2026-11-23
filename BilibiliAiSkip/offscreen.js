/**
 * 本地语音识别宿主（offscreen document）
 *
 * 为什么需要这个页面：MV3 的 service worker 里没有 AudioContext，也不保证有 WebGPU，
 * 而解码音频与跑推理都需要 DOM 环境。所以由 background 创建一个 offscreen 文档承载。
 *
 * 运行资产不随仓库分发，需要先执行：
 *   node tools/fetch-asr-assets.mjs
 * 缺失时本模块会明确返回「未安装」，调用方回退到阿里云 ASR。
 */
"use strict";

const MODEL_ID = "whisper-tiny";
const VENDOR = "vendor/transformers.min.js";
const WASM_DIR = "vendor/";
const MODEL_DIR = "models/asr/";

let runtimePromise = null;
let transcriberPromise = null;

function assetUrl(relative) {
    return chrome.runtime.getURL(relative);
}

async function assetExists(relative) {
    try {
        const response = await fetch(assetUrl(relative), { method: "HEAD" });
        return response.ok;
    } catch {
        return false;
    }
}

async function assetsReady() {
    return await assetExists(VENDOR)
        && await assetExists(`${MODEL_DIR}${MODEL_ID}/onnx/encoder_model_quantized.onnx`);
}

/**
 * 加载推理库。
 * 注意：dist/transformers.min.js 是 ESM（文件尾部是 export{...}），没有 UMD 全局，
 * 用 <script src> 加载拿不到任何东西（会报「未导出 Transformers」），必须动态 import。
 */
function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = import(assetUrl(VENDOR))
        .then(module => {
            if (!module?.pipeline) throw new Error("transformers.js 未导出 pipeline");
            return module;
        })
        .catch(error => {
            runtimePromise = null;
            throw new Error(`加载 ${VENDOR} 失败：${error.message}`);
        });
    return runtimePromise;
}

async function ensureTranscriber(onProgress) {
    if (transcriberPromise) return transcriberPromise;

    transcriberPromise = (async () => {
        const { env, pipeline } = await loadRuntime();

        // 只从扩展包内加载，绝不联网：模型 id 直接对应 models/asr/<id>/
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = assetUrl(MODEL_DIR);
        env.backends.onnx.wasm.wasmPaths = assetUrl(WASM_DIR);
        // 不要强制 numThreads：这条链路的 dist 只带 -threaded.jsep 版本的 wasm，
        // 强制单线程会去找不存在的单线程文件；让它按环境自行决定。

        const options = {
            dtype: "q8",
            progress_callback: data => {
                if (data?.status === "progress" && typeof onProgress === "function") {
                    onProgress(data);
                }
            }
        };

        try {
            // WebGPU 优先：wasm 单线程跑 14 分钟音频太慢
            return await pipeline("automatic-speech-recognition", MODEL_ID, { ...options, device: "webgpu" });
        } catch (error) {
            console.warn("[BJS ASR] WebGPU 不可用，回退 wasm:", error?.message);
            return await pipeline("automatic-speech-recognition", MODEL_ID, { ...options, device: "wasm" });
        }
    })();

    try {
        return await transcriberPromise;
    } catch (error) {
        transcriberPromise = null;
        throw error;
    }
}

/** 拉音频 → 解码为 16kHz 单声道 Float32 */
async function decodeAudio(audioUrl) {
    const response = await fetch(audioUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`音频下载失败: ${response.status}`);
    const buffer = await response.arrayBuffer();

    const context = new OfflineAudioContext(1, 16000, 16000);
    const decoded = await context.decodeAudioData(buffer);
    if (decoded.numberOfChannels === 1 && decoded.sampleRate === 16000) {
        return decoded.getChannelData(0);
    }

    // 多声道下混 + 重采样到 16k
    const length = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
}

async function transcribe(audioUrl) {
    if (!await assetsReady()) {
        return { ok: false, code: "ASSETS_MISSING", error: "本地语音模型未安装（node tools/fetch-asr-assets.mjs）" };
    }

    const samples = await decodeAudio(audioUrl);
    if (!samples.length) return { ok: false, code: "EMPTY_AUDIO", error: "音频解码为空" };

    const transcriber = await ensureTranscriber();
    const result = await transcriber(samples, {
        language: "chinese",
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true
    });

    return { ok: true, text: String(result?.text || ""), chunks: result?.chunks || [] };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "bjs-offscreen") return;

    if (message.type === "ping") {
        assetsReady().then(ready => sendResponse({ ok: true, ready }));
        return true;
    }

    if (message.type === "transcribe") {
        transcribe(message.audioUrl)
            .then(sendResponse)
            .catch(error => sendResponse({ ok: false, code: "ASR_FAILED", error: error?.message || String(error) }));
        return true;
    }
});
