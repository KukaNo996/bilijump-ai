/* 清单与资源完整性检查：node tests/manifest.test.js */
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "BilibiliAiSkip");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    }
};
const exists = relative => fs.existsSync(path.join(EXT, relative));

console.log("\n[清单] manifest.json");
check("Manifest V3", manifest.manifest_version === 3);
check("版本号已升级", /^2\.4\./.test(manifest.version), manifest.version);
check("本地端点写入 host_permissions", manifest.host_permissions.includes("http://127.0.0.1/*"),
    JSON.stringify(manifest.host_permissions));
check("localhost 写入 host_permissions", manifest.host_permissions.includes("http://localhost/*"));

const scripts = manifest.content_scripts[0].js;
check("content_scripts 顺序：settings → models → content",
    JSON.stringify(scripts) === JSON.stringify(["settings.js", "models.js", "content.js"]), scripts.join(","));
check("声明 storage 权限", manifest.permissions.includes("storage"));

const war = (manifest.web_accessible_resources[0] || {}).resources || [];
check("模型文件可被内容脚本读取", war.some(item => item.includes("models/")), war.join(","));

console.log("\n[资源] 文件存在性");
for (const file of ["settings.js", "models.js", "content.js", "background.js", "popup.js", "popup.html", "prompt.txt",
    "models/ad-lexicon.json", "models/decision.json"]) {
    check(file, exists(file));
}
for (const icon of Object.values(manifest.icons)) {
    check(icon, exists(icon));
}

console.log("\n[模型] 权重文件结构");
const lexicon = JSON.parse(fs.readFileSync(path.join(EXT, "models", "ad-lexicon.json"), "utf8"));
const decision = JSON.parse(fs.readFileSync(path.join(EXT, "models", "decision.json"), "utf8"));
check("词表条目数量 ≥ 60", Object.keys(lexicon.terms).length >= 60, String(Object.keys(lexicon.terms).length));
check("CTA 模式存在", Array.isArray(lexicon.ctaPatterns) && lexicon.ctaPatterns.length > 5);
check("决策特征 8 维", decision.features.length === 8);
check("权重/均值/方差维度一致",
    decision.weights.length === 8 && decision.means.length === 8 && decision.scales.length === 8);
check("权重无 NaN", decision.weights.every(Number.isFinite));

console.log("\n[WebGPU] WGSL 保留字检查");
const modelsSource = fs.readFileSync(path.join(EXT, "models.js"), "utf8");
const shaderStart = modelsSource.indexOf("const MATVEC_WGSL");
const shaderEnd = modelsSource.indexOf("`;", shaderStart);
const shader = shaderStart === -1 ? "" : modelsSource.slice(shaderStart, shaderEnd);
// meta / input / output 等是 WGSL 保留字，用作标识符会导致 CreateShaderModule 直接失败
const reserved = ["meta", "input", "output", "common", "filter", "resource", "shared", "static", "typedef", "unless", "using", "virtual"];
const offenders = reserved.filter(word => new RegExp(`var<[^>]*>\\s*${word}\\s*:`).test(shader));
check("着色器存在", shader.length > 0);
check("未使用 WGSL 保留字作标识符", offenders.length === 0, offenders.join(","));
check("着色器声明了 4 个绑定", (shader.match(/@binding\(/g) || []).length === 4);
check("workgroup_size 为 64", /workgroup_size\(64\)/.test(shader));
check("requestAdapter 未传参数（Windows 会忽略并告警）", !/requestAdapter\(\s*\{/.test(modelsSource));

console.log("\n[行为] 超时提示与请求容错");
const contentSource = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
check("超时隐藏阈值 60 秒", /AI_POPUP_HIDE_MS\s*=\s*60000/.test(contentSource));
check("主流程看门狗已清理", contentSource.includes("clearTimeout(aiWatchdog)"));
check("重新识别也有看门狗", contentSource.includes("clearTimeout(reWatchdog)"));
check("云端总预算存在", /ANALYSIS_DEADLINE_MS\s*=\s*120000/.test(contentSource));
check("重试带 JSON 约束", contentSource.includes("retry: i > 0"));
check("请求携带 json_mode", contentSource.includes("json_mode"));
check("后端剥离内部开关",
    fs.readFileSync(path.join(EXT, "background.js"), "utf8").includes("delete payload.json_mode"));
check("后端使用 response_format",
    fs.readFileSync(path.join(EXT, "background.js"), "utf8").includes("response_format"));
// 无字幕且未配阿里云 Key 属于「没素材」，不能报成配置错误误导用户
check("无字幕提示不再写成配置报错", !contentSource.includes("Please set aliApiKey"));
check("无字幕提示说明原因", contentSource.includes("该视频没有字幕"));

console.log("\n[本地语音] 实验功能接线");
const bgSource = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
check("offscreen 页面存在", exists("offscreen.html") && exists("offscreen.js"));
check("声明 offscreen 权限", manifest.permissions.includes("offscreen"));
check("background 创建 offscreen 文档", bgSource.includes("chrome.offscreen.createDocument"));
check("background 转发识别请求", bgSource.includes("asrTranscribe"));
check("content 侧有本地识别入口", contentSource.includes("transcribeLocally"));
check("默认关闭（需先装资产）", /useLocalASR:\s*false/.test(fs.readFileSync(path.join(EXT, "settings.js"), "utf8")));
check("popup 有开关", fs.readFileSync(path.join(EXT, "popup.html"), "utf8").includes('id="useLocalASR"'));
const ignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
check("大体积资产不入库", ignore.includes("BilibiliAiSkip/vendor/") && ignore.includes("BilibiliAiSkip/models/asr/"));
check("提供资产下载脚本", fs.existsSync(path.join(__dirname, "..", "tools", "fetch-asr-assets.mjs")));

console.log("\n[页面] popup.html 脚本加载顺序");const html = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
const order = ["settings.js", "models.js", "popup.js"].map(file => html.indexOf(`src="${file}"`));
check("settings.js 先于 popup.js", order[0] > -1 && order[0] < order[2]);
check("models.js 先于 popup.js", order[1] > -1 && order[1] < order[2]);
for (const id of ["useBuiltinAdModel", "useCloudAI", "useWebGPU", "modelStatus", "testApi", "localEndpoint"]) {
    check(`元素 #${id}`, html.includes(`id="${id}"`));
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
