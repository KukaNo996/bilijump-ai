#!/usr/bin/env node
/**
 * 一次性下载本地语音识别所需的运行资产（默认不随仓库分发）。
 *
 * 用法：
 *   node tools/fetch-asr-assets.mjs            # 下载全部
 *   node tools/fetch-asr-assets.mjs --check    # 只检查已存在文件的体积
 *
 * 产物：
 *   BilibiliAiSkip/vendor/transformers.min.js          推理库（约 1 MB）
 *   BilibiliAiSkip/vendor/ort-wasm-simd-threaded.jsep.wasm   含 WebGPU 的 wasm 后端（约 20.6 MB）
 *   BilibiliAiSkip/models/asr/whisper-tiny/*           whisper-tiny INT8（约 41 MB）
 *
 * 选 INT8 而不是 fp32：体积从 150 MB 降到 41 MB，精度损失对「关键词命中」影响有限。
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "BilibiliAiSkip");

const TRANSFORMERS_VERSION = "4.3.2";
const MODEL_REPO = "Xenova/whisper-tiny";
const MIRROR = "https://hf-mirror.com";

const ASSETS = [
  {
    url: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`,
    out: "vendor/transformers.min.js"
  },
  {
    url: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`,
    out: "vendor/ort-wasm-simd-threaded.jsep.wasm"
  },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/config.json`, out: "models/asr/whisper-tiny/config.json" },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/tokenizer.json`, out: "models/asr/whisper-tiny/tokenizer.json" },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/preprocessor_config.json`, out: "models/asr/whisper-tiny/preprocessor_config.json" },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/generation_config.json`, out: "models/asr/whisper-tiny/generation_config.json" },
  {
    url: `${MIRROR}/${MODEL_REPO}/resolve/main/onnx/encoder_model_quantized.onnx`,
    out: "models/asr/whisper-tiny/onnx/encoder_model_quantized.onnx"
  },
  {
    url: `${MIRROR}/${MODEL_REPO}/resolve/main/onnx/decoder_model_merged_quantized.onnx`,
    out: "models/asr/whisper-tiny/onnx/decoder_model_merged_quantized.onnx"
  }
];

const checkOnly = process.argv.includes("--check");

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

const mb = n => `${(n / 1048576).toFixed(1)} MB`;

async function download(url, target) {
  const response = await fetch(url, { headers: { "User-Agent": "bilijump-ai-fetch/1.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") || 0);
  if (!total) throw new Error("服务器未返回 Content-Length，可能是错误页");

  await mkdir(dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const written = await sizeOf(target);
  if (written !== total) throw new Error(`写入不完整：${mb(written)} / ${mb(total)}`);
  return written;
}

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const asset of ASSETS) {
  const target = join(EXT, asset.out);
  const existing = await sizeOf(target);
  if (checkOnly) {
    console.log(`${existing ? "✓" : "✗"} ${asset.out.padEnd(58)} ${mb(existing)}`);
    if (!existing) failed++;
    continue;
  }
  if (existing > 0) {
    console.log(`· 跳过（已存在）${asset.out} ${mb(existing)}`);
    skipped++;
    continue;
  }
  try {
    const written = await download(asset.url, target);
    console.log(`✓ ${asset.out} ${mb(written)}`);
    downloaded++;
  } catch (error) {
    console.error(`✗ ${asset.out} — ${error.message}`);
    failed++;
  }
}

if (checkOnly) {
  console.log(failed ? `\n还缺 ${failed} 个文件，运行不带参数的命令下载` : "\n资产齐全");
} else {
  console.log(`\n新下载 ${downloaded} 个，跳过 ${skipped} 个，失败 ${failed} 个`);
  if (failed) process.exitCode = 1;
}
