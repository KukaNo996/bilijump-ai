/**
 * Bilibili AI Skip —— 内置模型运行时（models.js）
 *
 * 三个内置能力：
 *   1. 广告识别模型（models/ad-lexicon.json）：中文植入广告词表 + CTA 模式 + 区间聚合，
 *      纯本地计算，不发网络请求、不需要 API Key，可离线工作。
 *   2. 微型决策模型（models/decision.json）：8 维特征 → 跳过概率的二分类器，
 *      决定「这个候选区间是否真的要跳过」，用于压掉词表识别的误判。
 *   3. WebGPU 推理通道：8→1 的矩阵向量乘在 WGSL compute shader 上执行；
 *      启动时用同一组权重与 CPU 结果做一次自校验，不一致就永久禁用 GPU，
 *      保证着色器写错也不会影响判定结果。
 *
 * 语音识别：浏览器端需要 Whisper 类 ONNX 权重（数十 MB），不随包分发。
 * transcribe() 会在缺失权重时明确抛错，调用方回退到云端 ASR。
 */
(function (root) {
    "use strict";

    const MODEL_PATHS = {
        lexicon: "models/ad-lexicon.json",
        decision: "models/decision.json"
    };

    const state = {
        lexicon: null,
        decision: null,
        loading: null,
        gpu: undefined,        // undefined=未探测 null=不可用
        gpuError: "",
        gpuVerified: false,
        gpuDisabled: false
    };

    /* ------------------------------ 基础工具 ------------------------------ */

    function sigmoid(x) {
        if (x >= 0) {
            const z = Math.exp(-x);
            return 1 / (1 + z);
        }
        const z = Math.exp(x);
        return z / (1 + z);
    }

    function toSeconds(value) {
        const parts = String(value).trim().split(":").map(Number);
        if (!parts.length || parts.some(Number.isNaN)) return NaN;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0];
    }

    async function loadJSON(path) {
        if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
            const response = await fetch(chrome.runtime.getURL(path));
            if (!response.ok) throw new Error(`加载 ${path} 失败（${response.status}）`);
            return response.json();
        }
        throw new Error("当前环境无法加载模型文件");
    }

    /* --------------------------- 广告识别：分词打分 --------------------------- */

    /** 解析 "1.23 --> 4.56\n文本" 形式的字幕，兼容 SRT 的 hh:mm:ss,mmm */
    function parseSubtitle(text) {
        const lines = String(text || "").replace(/\r/g, "").split("\n");
        const segments = [];
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)\s*$/);
            if (!match) continue;
            const from = toSeconds(match[1].replace(",", "."));
            const to = toSeconds(match[2].replace(",", "."));
            const content = (lines[i + 1] || "").trim();
            if (!Number.isFinite(from) || !Number.isFinite(to) || !content) continue;
            segments.push({ from, to: Math.max(to, from), text: content });
            i++;
        }
        return segments;
    }

    const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    /** 词表打分：中文用包含匹配，纯 ASCII 词用单词边界，避免 "ad" 命中 "read" */
    function scoreText(text, lexicon) {
        const source = String(text || "");
        const lower = source.toLowerCase();
        let score = 0;
        const hits = [];
        for (const term of Object.keys(lexicon.terms)) {
            if (!term) continue;
            const weight = Number(lexicon.terms[term]) || 0;
            const isAscii = /^[\x00-\x7f]+$/.test(term);
            const matched = isAscii
                ? new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(source)
                : lower.includes(term.toLowerCase());
            if (matched) {
                score += weight;
                hits.push(term);
            }
        }
        return { score, hits };
    }

    function countCta(text, lexicon) {
        const lower = String(text || "").toLowerCase();
        let count = 0;
        for (const pattern of lexicon.ctaPatterns || []) {
            if (lower.includes(String(pattern).toLowerCase())) count++;
        }
        return count;
    }

    function highestWeightTerm(hits, lexicon) {
        let best = "";
        let bestWeight = 0;
        for (const term of hits) {
            const weight = Number(lexicon.terms[term]) || 0;
            if (weight > bestWeight) {
                bestWeight = weight;
                best = term;
            }
        }
        return best;
    }

    /** 把带信号的相邻字幕聚合成候选区间，再按 gap 拆分超长窗口 */
    function detectCandidates(segments, lexicon, options) {
        const params = Object.assign({}, lexicon.params, options || {});
        const scored = segments.map(segment => {
            const result = scoreText(segment.text, lexicon);
            return {
                from: segment.from,
                to: segment.to,
                text: segment.text,
                score: result.score,
                hits: result.hits,
                cta: countCta(segment.text, lexicon)
            };
        });

        const signals = scored.filter(segment => segment.score > 0);
        const runs = [];
        let run = null;

        for (const segment of signals) {
            if (run && segment.from - run.end <= params.windowGap) {
                run.end = Math.max(run.end, segment.to);
                run.score += segment.score;
                run.termHits += segment.hits.length;
                run.ctaHits += segment.cta;
                run.segments.push(segment);
                continue;
            }
            if (run) runs.push(run);
            run = {
                start: segment.from,
                end: segment.to,
                score: segment.score,
                termHits: segment.hits.length,
                ctaHits: segment.cta,
                segments: [segment]
            };
        }
        if (run) runs.push(run);

        // 超长窗口按最大间隙切开，避免把整段视频当成一个广告
        const expanded = [];
        for (const item of runs) {
            if (item.end - item.start <= params.maxWindowSeconds) {
                expanded.push(item);
                continue;
            }
            let part = null;
            for (const segment of item.segments) {
                if (part && segment.from - part.end <= params.expandGap) {
                    part.end = Math.max(part.end, segment.to);
                    part.score += segment.score;
                    part.termHits += segment.hits.length;
                    part.ctaHits += segment.cta;
                    part.segments.push(segment);
                    continue;
                }
                if (part) expanded.push(part);
                part = {
                    start: segment.from,
                    end: segment.to,
                    score: segment.score,
                    termHits: segment.hits.length,
                    ctaHits: segment.cta,
                    segments: [segment]
                };
            }
            if (part) expanded.push(part);
        }

        // 不向相邻句扩张：宁可少跳一点，也不要吞掉正片
        // （区间已由同一条信号链决定，边界就是首末个命中句）

        return expanded
            .filter(item => item.score >= params.scoreThreshold && item.end - item.start >= params.minAdDuration)
            .map(item => ({
                start: item.start,
                end: item.end,
                score: item.score,
                termHits: item.termHits,
                ctaHits: item.ctaHits,
                productName: highestWeightTerm(item.segments.flatMap(segment => segment.hits), lexicon),
                text: item.segments.map(segment => segment.text).join("").slice(0, 300)
            }))
            .sort((a, b) => a.start - b.start);
    }

    /**
     * 清洗广告区间（云端 AI / 内置模型 / 人工纠错共用）：
     * 反转起止、clamp 到视频时长、丢弃 0 长度与过短区间、合并重叠或相邻区间。
     */
    function normalizeIntervals(ads, duration, options) {
        const opts = options || {};
        const minDuration = Number.isFinite(Number(opts.minDuration)) ? Number(opts.minDuration) : 2;
        const maxGap = Number.isFinite(Number(opts.maxGap)) ? Number(opts.maxGap) : 0.8;
        const list = [];

        for (const ad of Array.isArray(ads) ? ads : []) {
            let start = parseFloat(ad?.start_time);
            let end = parseFloat(ad?.end_time);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (start > end) [start, end] = [end, start];
            if (Number.isFinite(duration) && duration > 0) {
                start = Math.min(Math.max(start, 0), duration);
                end = Math.min(Math.max(end, 0), duration);
            }
            if (!(end > start) || end - start < minDuration) continue;
            list.push({
                start,
                end,
                productName: String(ad.product_name || "").trim(),
                adContent: String(ad.ad_content || "").trim()
            });
        }

        list.sort((a, b) => a.start - b.start);

        const merged = [];
        for (const ad of list) {
            const last = merged[merged.length - 1];
            if (last && ad.start <= last.end + maxGap) {
                last.end = Math.max(last.end, ad.end);
                if (ad.productName && !last.productName.includes(ad.productName)) {
                    last.productName = last.productName ? `${last.productName} | ${ad.productName}` : ad.productName;
                }
                if (ad.adContent && !last.adContent.includes(ad.adContent)) {
                    last.adContent = last.adContent ? `${last.adContent}\n---\n${ad.adContent}` : ad.adContent;
                }
                continue;
            }
            merged.push(Object.assign({}, ad));
        }
        return merged;
    }

    /* --------------------------- 弹幕信号（无字幕兜底） --------------------------- */

    /** 解析 dm/list.so 返回的 XML，取出「时间 + 文本」 */
    function parseDanmaku(xml) {
        const text = String(xml || "");
        const entries = [];
        const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const time = parseFloat(String(match[1]).split(",")[0]);
            if (!Number.isFinite(time)) continue;
            const content = match[2]
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, "&")
                .trim();
            if (!content) continue;
            entries.push({ time, text: content });
        }
        return entries.sort((a, b) => a.time - b.time);
    }

    /**
     * 用弹幕定位广告区间。
     * 只作为「无字幕、无音频识别」时的兜底信号：强词（广告/恰饭/软广）命中即成立，
     * 弱词单独出现不算，避免把「跳过片头」这类弹幕误判成广告。
     */
    function detectAdsFromDanmaku(entries, options) {
        // config 显式传入时优先（便于离线测试），否则用已加载的词表
        const config = (options && options.config) || (state.lexicon && state.lexicon.danmaku) || null;
        if (!config) return [];
        const params = Object.assign({
            window: 30, minScore: 3, strongOnly: true,
            padBefore: 5, padAfter: 6, minDuration: 8, maxAds: 5
        }, config.params || {}, options || {});

        const strong = config.strong || {};
        const medium = config.medium || {};
        const scored = [];

        for (const entry of entries) {
            let score = 0;
            let strongHits = 0;
            for (const term of Object.keys(strong)) {
                if (entry.text.includes(term)) {
                    score += Number(strong[term]) || 0;
                    strongHits++;
                }
            }
            for (const term of Object.keys(medium)) {
                if (entry.text.includes(term)) score += Number(medium[term]) || 0;
            }
            if (score > 0) scored.push({ time: entry.time, text: entry.text, score, strongHits });
        }
        if (!scored.length) return [];

        // 相邻吐槽聚成一个窗口
        const groups = [];
        for (const item of scored) {
            const last = groups[groups.length - 1];
            if (last && item.time - last.end <= params.window) {
                last.end = item.time;
                last.score += item.score;
                last.strongHits += item.strongHits;
                last.texts.push(item.text);
                continue;
            }
            groups.push({
                start: item.time,
                end: item.time,
                score: item.score,
                strongHits: item.strongHits,
                texts: [item.text]
            });
        }

        const candidates = groups.filter(group => {
            // 强词命中 (广告/恰饭/软广) 直接成立；否则要累计到阈值
            if (params.strongOnly && group.strongHits > 0) return true;
            return group.score >= params.minScore;
        });

        const ads = candidates.map(group => ({
            start: Math.max(group.start - params.padBefore, 0),
            end: group.end + params.padAfter,
            confidence: Math.min(1, Number((group.score / (params.minScore * 2)).toFixed(3))),
            productName: "弹幕信号",
            text: group.texts.join(" / ").slice(0, 200)
        }));

        ads.sort((a, b) => a.start - b.start);
        const merged = [];
        for (const ad of ads) {
            const last = merged[merged.length - 1];
            if (last && ad.start <= last.end + 1) {
                last.end = Math.max(last.end, ad.end);
                last.confidence = Math.max(last.confidence, ad.confidence);
                continue;
            }
            merged.push(ad);
        }
        return merged
            .filter(ad => ad.end - ad.start >= params.minDuration)
            .slice(0, params.maxAds);
    }

    /* --------------------------- 微型决策模型 --------------------------- */

    function matvecCpu(weights, features, bias) {
        let sum = Number(bias) || 0;
        for (let i = 0; i < weights.length; i++) {
            sum += (Number(weights[i]) || 0) * (Number(features[i]) || 0);
        }
        return sum;
    }

    /** 候选区间 → 8 维特征，顺序必须与 decision.json 的 features 一致 */
    function extractFeatures(candidate, context) {
        const duration = Number(context?.duration) || 0;
        const length = Math.max(candidate.end - candidate.start, 0.001);
        const chars = String(candidate.text || "").length;
        return [
            Math.min(candidate.score / 12, 3),
            duration > 0 ? length / duration : 0.05,
            length,
            duration > 0 ? candidate.start / duration : 0,
            candidate.termHits,
            candidate.ctaHits,
            chars / length,
            Number.isFinite(context?.sourceConfidence) ? context.sourceConfidence : 0.9
        ];
    }

    /** 标准化后做线性判定；返回概率与是否跳过 */
    function decide(features, model, threshold) {
        const means = model.means || [];
        const scales = model.scales || [];
        const standardized = features.map((value, index) => {
            const scale = Number(scales[index]) || 1;
            return (Number(value) - (Number(means[index]) || 0)) / scale;
        });
        const z = matvecCpu(model.weights, standardized, model.bias);
        const probability = sigmoid(z);
        const cut = Number.isFinite(threshold) ? threshold : (Number(model.threshold) || 0.5);
        return { probability, skip: probability >= cut, z };
    }

    /* ----------------------------- WebGPU 通道 ----------------------------- */

    async function ensureGpu(enabled) {
        if (state.gpu !== undefined) return state.gpu;
        state.gpu = null;
        if (!enabled) {
            state.gpuError = "已关闭 WebGPU";
            return null;
        }
        try {
            if (typeof navigator === "undefined" || !navigator.gpu) {
                throw new Error("浏览器未提供 navigator.gpu");
            }
            // Windows 上 powerPreference 会被忽略并打印警告，这里不传
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("未获取到 GPU 适配器");
            const device = await adapter.requestDevice();
            state.gpu = { device, adapter, queue: device.queue };
            state.gpuError = "";
        } catch (error) {
            state.gpu = null;
            state.gpuError = error.message;
        }
        return state.gpu;
    }

    // 注意：WGSL 里 meta / input / output / common / filter / resource 等均为保留字，
    // 标识符一律带 Data 后缀，避免 CreateShaderModule 直接编译失败。
    const MATVEC_WGSL = `
@group(0) @binding(0) var<storage, read> weightData: array<f32>;
@group(0) @binding(1) var<storage, read> featureData: array<f32>;
@group(0) @binding(2) var<storage, read> paramData: array<u32>;
@group(0) @binding(3) var<storage, read_write> resultData: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let cols: u32 = paramData[0];
    let rows: u32 = paramData[1];
    let row: u32 = gid.x;
    if (row >= rows) { return; }
    var acc: f32 = 0.0;
    for (var c: u32 = 0u; c < cols; c = c + 1u) {
        acc = acc + weightData[c] * featureData[row * cols + c];
    }
    resultData[row] = acc;
}
`;

    /**
     * 一批候选区间共用同一组权重，一行一个样本，一次 dispatch 出全部点积。
     * 返回不含 bias 的点积数组。
     */
    async function gpuDotBatch(weights, featureRows) {
        const gpu = await ensureGpu(true);
        if (!gpu) throw new Error(state.gpuError || "WebGPU 不可用");

        const cols = weights.length;
        const rows = featureRows.length;
        if (!cols || !rows) return [];

        const flat = new Float32Array(rows * cols);
        for (let row = 0; row < rows; row++) flat.set(featureRows[row], row * cols);

        const byteLength = value => Math.max(value * 4, 16);
        const weightBuffer = gpu.device.createBuffer({
            size: byteLength(cols),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        gpu.queue.writeBuffer(weightBuffer, 0, new Float32Array(weights));

        const featureBuffer = gpu.device.createBuffer({
            size: byteLength(rows * cols),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        gpu.queue.writeBuffer(featureBuffer, 0, flat);

        const paramBuffer = gpu.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        gpu.queue.writeBuffer(paramBuffer, 0, new Uint32Array([cols, rows, 0, 0]));

        const resultBytes = byteLength(rows);
        const resultBuffer = gpu.device.createBuffer({
            size: resultBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        const readBuffer = gpu.device.createBuffer({
            size: resultBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const module = gpu.device.createShaderModule({ code: MATVEC_WGSL });
        const pipeline = gpu.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
        const bindGroup = gpu.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: weightBuffer } },
                { binding: 1, resource: { buffer: featureBuffer } },
                { binding: 2, resource: { buffer: paramBuffer } },
                { binding: 3, resource: { buffer: resultBuffer } }
            ]
        });

        const encoder = gpu.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.max(1, Math.ceil(rows / 64)));
        pass.end();
        encoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, resultBytes);
        gpu.queue.submit([encoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const result = Array.from(new Float32Array(readBuffer.getMappedRange()).slice(0, rows));
        readBuffer.unmap();
        for (const buffer of [weightBuffer, featureBuffer, paramBuffer, resultBuffer, readBuffer]) buffer.destroy();

        return result;
    }

    /** 启动自校验：GPU 与 CPU 结果必须一致，否则禁用 GPU 通道 */
    async function selfTestGpu(model) {
        if (state.gpuVerified || state.gpuDisabled) return state.gpuVerified;
        try {
            const features = model.means.map((mean, index) => mean + (Number(model.scales[index]) || 1) * 0.5);
            const expected = matvecCpu(model.weights, features, 0);
            const actual = (await gpuDotBatch(model.weights, [features]))[0];
            if (Number.isFinite(actual) && Math.abs(actual - expected) <= 0.01) {
                state.gpuVerified = true;
            } else {
                state.gpuDisabled = true;
                state.gpuError = `GPU/CPU 结果不一致（${actual} vs ${expected.toFixed(4)}），已回退 CPU`;
                console.warn("[Bilibili AI Skip] " + state.gpuError);
            }
        } catch (error) {
            state.gpuDisabled = true;
            state.gpuError = error.message;
        }
        return state.gpuVerified;
    }

    /** 批量判定：GPU 已校验走 GPU，否则（或 GPU 出错）整批回退 CPU，结果一致 */
    async function decideBatch(featureRows, model, threshold) {
        const standardized = featureRows.map(row => row.map((value, index) => {
            const scale = Number(model.scales[index]) || 1;
            return (Number(value) - (Number(model.means[index]) || 0)) / scale;
        }));

        let dots = null;
        if (state.gpuVerified && state.gpu) {
            try {
                dots = await gpuDotBatch(model.weights, standardized);
            } catch (error) {
                state.gpuVerified = false;
                state.gpuError = error.message;
                dots = null;
            }
        }
        if (!dots) dots = standardized.map(row => matvecCpu(model.weights, row, 0));

        const cut = Number.isFinite(threshold) ? threshold : (Number(model.threshold) || 0.5);
        const bias = Number(model.bias) || 0;
        return standardized.map((row, index) => {
            const z = (Number(dots[index]) || 0) + bias;
            const probability = sigmoid(z);
            return { probability, skip: probability >= cut, z };
        });
    }

    /* ------------------------------- 对外接口 ------------------------------- */

    async function init(options) {
        if (state.lexicon && state.decision) return api;
        if (state.loading) return state.loading;

        state.loading = (async () => {
            const [lexicon, decision] = await Promise.all([
                loadJSON(MODEL_PATHS.lexicon),
                loadJSON(MODEL_PATHS.decision)
            ]);
            state.lexicon = lexicon;
            state.decision = decision;
            if (options?.useWebGPU !== false) {
                await ensureGpu(true);
                await selfTestGpu(decision);
            }
            return api;
        })();

        try {
            return await state.loading;
        } catch (error) {
            state.loading = null;
            throw error;
        }
    }

    /**
     * 本地识别广告。返回 null 表示内置模型没有把握，交给调用方决定是否走云端。
     * @returns {Promise<null|{ads:Array, msg:string, model:string, confidence:number}>}
     */
    async function analyzeAds(subtitleText, context) {
        await init({ useWebGPU: context?.useWebGPU !== false });
        const segments = parseSubtitle(subtitleText);
        if (segments.length < 3) return null;

        const candidates = detectCandidates(segments, state.lexicon);
        if (!candidates.length) return null;

        const duration = Number(context?.duration) || segments[segments.length - 1].to;
        const threshold = Number(context?.threshold);
        const features = candidates.map(candidate => extractFeatures(candidate, { duration, sourceConfidence: 0.9 }));
        const verdicts = await decideBatch(features, state.decision, threshold);

        const ads = [];
        let confidenceSum = 0;

        candidates.forEach((candidate, index) => {
            const verdict = verdicts[index];
            confidenceSum += verdict.probability;
            if (!verdict.skip) return;
            ads.push({
                start_time: candidate.start.toFixed(2),
                end_time: candidate.end.toFixed(2),
                product_name: candidate.productName || "内置模型命中",
                ad_content: candidate.text,
                confidence: Number(verdict.probability.toFixed(3))
            });
        });

        if (!ads.length) return null;

        return {
            ads,
            msg: ads.length ? "识别到广告" : "未识别到广告",
            model: state.gpuVerified ? "builtin:lexicon+mini-decide(gpu)" : "builtin:lexicon+mini-decide(cpu)",
            confidence: Number((confidenceSum / candidates.length).toFixed(3))
        };
    }

    function tryJson(text) {
        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
            return null;
        }
    }

    /** 宽松时间解析：接受 12.5 / "12.5" / "01:12" / "00:01:12" */
    function toSecondsLoose(value) {
        if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
        const text = String(value == null ? "" : value).trim();
        if (!text) return NaN;
        if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
        const parts = text.split(":").map(Number);
        if (parts.some(Number.isNaN)) return NaN;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return NaN;
    }

    /**
     * 校验并清洗模型返回的广告对象。
     * 实测有些模型会把提示词里的示例结构原样回显（start_time:"..."），
     * 这种「有 ads 但一条都不合法」的结果必须判为无效，交给重试，否则会把假数据写进库。
     */
    function sanitizeAdPayload(value) {
        if (!value || typeof value !== "object" || !Array.isArray(value.ads)) return null;
        const ads = value.ads.filter(ad => {
            const start = toSecondsLoose(ad?.start_time);
            const end = toSecondsLoose(ad?.end_time);
            return Number.isFinite(start) && Number.isFinite(end) && end > start;
        });
        if (value.ads.length && !ads.length) return null;
        const msg = typeof value.msg === "string" && value.msg
            ? value.msg
            : (ads.length ? "识别到广告" : "未识别到广告");
        return Object.assign({}, value, { ads, msg });
    }

    /**
     * 识别「内容安全审核结论」被当作正文返回来。
     * 实测网关/上游在审核不通过时会把审核结果当成 assistant 消息内容：
     *   {"User Safety":"unsafe","Response Safety":"safe","Safety Categories":"Violence"}
     * 这不是解析失败：同一段字幕重试只会得到同样的结论，必须立刻收手，
     * 否则三次重试就是三次纯浪费（每次都要等一个完整的往返）。
     */
    function detectSafetyVerdict(raw) {
        if (raw == null) return null;
        let text = String(raw).trim();
        if (!text) return null;
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence && fence[1]) text = fence[1].trim();

        const value = tryJson(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;

        const flatKeys = Object.keys(value).map(key => key.toLowerCase().replace(/[\s_-]/g, ""));
        const signature = ["usersafety", "responsesafety", "safetycategories", "safetyrating"];
        if (!flatKeys.some(key => signature.includes(key))) return null;

        const pick = (...names) => {
            for (const name of names) {
                if (value[name] != null && value[name] !== "") return value[name];
            }
            return "";
        };
        const status = String(pick("User Safety", "user_safety", "userSafety") || "").toLowerCase();
        const categories = pick("Safety Categories", "safety_categories", "safetyCategories");

        return {
            // 即使结论是 safe，它也不是广告判定结果，同样不该重试
            blocked: status !== "safe",
            status: status || "unknown",
            categories: Array.isArray(categories) ? categories.join(", ") : String(categories || ""),
            raw: text.slice(0, 200)
        };
    }

    /**
     * 从大模型输出里提取 JSON 对象。
     * 实际观测到有些模型会把推理过程直接吐出来（"我们需要回答用户：…"），
     * 甚至中间夹一段带 [...] 的伪 JSON，所以不能只用 ```json 围栏或 JSON.parse。
     */
    function extractJson(raw) {
        if (raw == null) return null;
        let text = String(raw).trim();
        if (!text) return null;

        // 去掉 think 区块与代码围栏
        text = text.replace(/<(think|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi, " ").trim();
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence && fence[1]) text = fence[1].trim();

        const direct = sanitizeAdPayload(tryJson(text));
        if (direct) return direct;

        // 逐个 "{" 做括号配对（跳过字符串内的括号），取第一个能解析成广告结构的片段
        for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    inString = !inString;
                    continue;
                }
                if (inString) continue;
                if (ch === "{") {
                    depth++;
                } else if (ch === "}") {
                    depth--;
                    if (depth !== 0) continue;
                    const parsed = sanitizeAdPayload(tryJson(text.slice(start, i + 1)));
                    if (parsed) return parsed;
                    break;
                }
            }
        }
        return null;
    }

    /** 语音识别：需要本地 ONNX 权重，未内置时明确返回不可用 */
    async function transcribe(audioUrl) {
        throw new Error("未内置语音模型权重（需自行放入 models/asr/ 后再启用）");
    }

    async function asrStatus() {
        const gpu = await ensureGpu(true);
        return {
            webgpu: Boolean(gpu),
            webgpuError: state.gpuError,
            gpuVerified: state.gpuVerified,
            weightsReady: false,
            note: "WebGPU 通道可用；语音模型权重未内置，音频分析仍走云端 ASR"
        };
    }

    function status() {
        return {
            loaded: Boolean(state.lexicon && state.decision),
            webgpu: Boolean(state.gpu),
            webgpuError: state.gpuError,
            gpuVerified: state.gpuVerified,
            lexiconTerms: state.lexicon ? Object.keys(state.lexicon.terms).length : 0,
            decisionFeatures: state.decision ? state.decision.features.length : 0
        };
    }

    const api = {
        init,
        analyzeAds,
        decide,
        decideBatch,
        extractJson,
        detectSafetyVerdict,
        extractFeatures,
        detectCandidates,
        parseSubtitle,
        scoreText,
        parseDanmaku,
        detectAdsFromDanmaku,
        normalizeIntervals,
        sanitizeAdPayload,
        toSecondsLoose,
        matvecCpu,
        sigmoid,
        transcribe,
        asrStatus,
        status
    };

    root.BJSModels = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
