#!/usr/bin/env node
/**
 * 一次性下载本地语音识别所需的运行资产（默认不随仓库分发）。
 *
 * 用法：
 *   node tools/fetch-asr-assets.mjs            # 下载/修复
 *   node tools/fetch-asr-assets.mjs --check    # 只校验体积
 *
 * 产物：
 *   BilibiliAiSkip/vendor/transformers.min.js                推理库
 *   BilibiliAiSkip/vendor/ort-wasm-simd-threaded.jsep.wasm   含 WebGPU 的 wasm 后端
 *   BilibiliAiSkip/models/asr/whisper-tiny/*                 whisper-tiny INT8
 *
 * 两个踩过的坑，这里都处理了：
 *   1. @huggingface/transformers v4 的 dist 不再附带 wasm（只有 js），
 *      所以钉在 3.7.5 —— 它的 dist 带 ort-wasm-simd-threaded.jsep.wasm，支持 WebGPU。
 *   2. 下载中断会留下半截文件，若按「文件存在就跳过」，错误会被永久掩盖。
 *      因此每个文件都记了期望字节数，尺寸不符就重下。
 */
import { createWriteStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "BilibiliAiSkip");

const TRANSFORMERS_VERSION = "3.7.5";
const MODEL_REPO = "Xenova/whisper-tiny";
const MIRROR = "https://hf-mirror.com";
const JSDELIVR = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist`;

const ASSETS = [
  { url: `${JSDELIVR}/transformers.min.js`, out: "vendor/transformers.min.js", bytes: 873307 },
  // ort 是「.mjs 加载器 + .wasm 本体」成对使用的，只放 .wasm 会报
  // "Failed to fetch dynamically imported module: ...jsep.mjs"
  { url: `${JSDELIVR}/ort-wasm-simd-threaded.jsep.mjs`, out: "vendor/ort-wasm-simd-threaded.jsep.mjs", bytes: 44484 },
  { url: `${JSDELIVR}/ort-wasm-simd-threaded.jsep.wasm`, out: "vendor/ort-wasm-simd-threaded.jsep.wasm", bytes: 21596019 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/config.json`, out: "models/asr/whisper-tiny/config.json", bytes: 2248 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/tokenizer.json`, out: "models/asr/whisper-tiny/tokenizer.json", bytes: 2480466 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/tokenizer_config.json`, out: "models/asr/whisper-tiny/tokenizer_config.json", bytes: 282683 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/preprocessor_config.json`, out: "models/asr/whisper-tiny/preprocessor_config.json", bytes: 339 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/generation_config.json`, out: "models/asr/whisper-tiny/generation_config.json", bytes: 3716 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/special_tokens_map.json`, out: "models/asr/whisper-tiny/special_tokens_map.json", bytes: 2194 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/added_tokens.json`, out: "models/asr/whisper-tiny/added_tokens.json", bytes: 2082 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/normalizer.json`, out: "models/asr/whisper-tiny/normalizer.json", bytes: 52666 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/vocab.json`, out: "models/asr/whisper-tiny/vocab.json", bytes: 1036584 },
  { url: `${MIRROR}/${MODEL_REPO}/resolve/main/merges.txt`, out: "models/asr/whisper-tiny/merges.txt", bytes: 493869 },
  {
    url: `${MIRROR}/${MODEL_REPO}/resolve/main/onnx/encoder_model_quantized.onnx`,
    out: "models/asr/whisper-tiny/onnx/encoder_model_quantized.onnx",
    bytes: 10124910
  },
  {
    url: `${MIRROR}/${MODEL_REPO}/resolve/main/onnx/decoder_model_merged_quantized.onnx`,
    out: "models/asr/whisper-tiny/onnx/decoder_model_merged_quantized.onnx",
    bytes: 30727765
  }
];

const checkOnly = process.argv.includes("--check");
const mb = n => `${(n / 1048576).toFixed(1)} MB`;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function looksComplete(asset, size) {
  if (asset.bytes) return size === asset.bytes;
  return size >= (asset.minBytes || 1);
}

async function fetchChunk(url, start, end, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}`, "User-Agent": "bilijump-ai-fetch/1.0" }
    });
    // 有的源忽略 Range 直接回 200 全量，交给调用方处理
    if (response.status === 200) return { full: Buffer.from(await response.arrayBuffer()) };
    if (response.status !== 206) throw new Error(`分片请求返回 ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const want = end - start + 1;
    if (buffer.length !== want) throw new Error(`分片长度 ${buffer.length}，期望 ${want}`);
    return { buffer };
  } catch (error) {
    if (attempt < 2) return fetchChunk(url, start, end, attempt + 1);
    throw error;
  }
}

/**
 * 分段下载：这条链路上的代理会在数 MB 处掐断长连接，
 * 单次流式下载大文件必然截断，只能按小分片取。
 */
async function downloadRanged(asset, target) {
  const total = asset.bytes;
  const chunkSize = 512 * 1024;
  const handle = await open(target, "w");

  try {
    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, total - 1);
      const part = await fetchChunk(asset.url, start, end);

      if (part.full) {
        await handle.write(part.full, 0, part.full.length, 0);
        break;
      }
      await handle.write(part.buffer, 0, part.buffer.length, start);
    }
  } finally {
    await handle.close();
  }

  const written = await sizeOf(target);
  if (written !== total) {
    await unlink(target).catch(() => {});
    throw new Error(`写入不完整：${written} 字节，应为 ${total}`);
  }
  return written;
}

async function download(asset, target) {
  await mkdir(dirname(target), { recursive: true });
  if (asset.bytes) {
    try {
      return await downloadRanged(asset, target);
    } catch (error) {
      throw error;
    }
  }

  const response = await fetch(asset.url, { headers: { "User-Agent": "bilijump-ai-fetch/1.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }

  const written = await sizeOf(target);
  if (!looksComplete(asset, written)) {
    await unlink(target).catch(() => {}); // 半截文件必须删掉，否则下次会被当成完整文件跳过
    throw new Error(`写入不完整：${written} 字节`);
  }
  return written;
}

let completeCount = 0;
let fixedCount = 0;
let failed = 0;

for (const asset of ASSETS) {
  const target = join(EXT, asset.out);
  const existing = await sizeOf(target);
  const complete = existing > 0 && looksComplete(asset, existing);

  if (checkOnly) {
    if (complete) {
      console.log(`✓ ${asset.out.padEnd(60)} ${mb(existing)}`);
      completeCount++;
    } else {
      console.log(`✗ ${asset.out.padEnd(60)} ${existing ? `残缺 ${mb(existing)}` : "缺失"}`);
      failed++;
    }
    continue;
  }

  if (complete) {
    console.log(`· 跳过 ${asset.out} ${mb(existing)}`);
    completeCount++;
    continue;
  }
  if (existing > 0) {
    console.log(`! 修复 ${asset.out}（原 ${mb(existing)} 不完整）`);
    fixedCount++;
  }

  try {
    const written = await download(asset, target);
    console.log(`✓ ${asset.out} ${mb(written)}`);
  } catch (error) {
    console.error(`✗ ${asset.out} — ${error.message}`);
    failed++;
  }
}

if (checkOnly) {
  console.log(failed ? `\n${failed} 个文件缺失或不完整` : "\n资产齐全");
} else {
  console.log(`\n完整 ${completeCount} 个，修复 ${fixedCount} 个，失败 ${failed} 个`);
}
if (failed) process.exitCode = 1;
