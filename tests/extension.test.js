/* 离线验证：设置层（迁移/规范化/持久化）+ 内置模型（识别/决策/区间清洗）。
   运行：node tests/extension.test.js */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "BilibiliAiSkip");
let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
    }
}

function checkTrue(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    }
}

/* ---------------------- chrome.storage 内存桩 ---------------------- */
function createChromeStub(initial) {
    const store = { local: Object.assign({}, initial.local), sync: Object.assign({}, initial.sync) };
    const listeners = [];
    const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

    const makeArea = name => ({
        get(keys, callback) {
            const result = {};
            if (keys == null) {
                Object.assign(result, clone(store[name]));
            } else if (typeof keys === "string") {
                if (store[name][keys] !== undefined) result[keys] = clone(store[name][keys]);
            } else if (Array.isArray(keys)) {
                for (const key of keys) if (store[name][key] !== undefined) result[key] = clone(store[name][key]);
            } else {
                for (const key of Object.keys(keys)) {
                    result[key] = store[name][key] !== undefined ? clone(store[name][key]) : keys[key];
                }
            }
            if (callback) setTimeout(() => callback(result), 0);
            return Promise.resolve(result);
        },
        set(values, callback) {
            const changes = {};
            for (const key of Object.keys(values)) {
                changes[key] = { oldValue: clone(store[name][key]), newValue: clone(values[key]) };
                store[name][key] = clone(values[key]);
            }
            setTimeout(() => {
                for (const listener of listeners) listener(changes, name);
                if (callback) callback();
            }, 0);
            return Promise.resolve();
        },
        remove(keys) {
            for (const key of [].concat(keys)) delete store[name][key];
            return Promise.resolve();
        }
    });

    return {
        store,
        chrome: {
            runtime: { lastError: undefined, getURL: p => `chrome-extension://test/${p}` },
            storage: {
                local: makeArea("local"),
                sync: makeArea("sync"),
                onChanged: { addListener: fn => listeners.push(fn) }
            }
        }
    };
}

/* --------------------------- 1. 设置层 --------------------------- */
async function testSettings() {
    console.log("\n[1] 设置层 settings.js");

    const legacy = createChromeStub({
        sync: {
            // 旧版本 popup 写入的顶层键
            enabled: true,
            autoJump: true,
            tagFilter: "老番茄,影视飓风",
            apiURL: "https://api.deepseek.com/v1/chat/completions",
            apiKey: "sk-legacy",
            apiModel: "deepseek-chat",
            audioEnabled: false,
            autoAudio: false,
            aliApiKey: "sk-ali",
            // 旧版本 initConfig 写入的默认配置
            config: { enabled: false, cfApiKey: "cf-key", cfApiURL: "https://cf.example/query", apiURL: "" },
            banModels: ["glm-4-flash"]
        },
        local: {}
    });

    global.chrome = legacy.chrome;
    delete require.cache[require.resolve(path.join(ROOT, "settings.js"))];
    const BJS = require(path.join(ROOT, "settings.js"));

    check("端点补全（无 path）", BJS.normalizeChatUrl("http://127.0.0.1:31415"), "http://127.0.0.1:31415/v1/chat/completions");
    check("端点补全（无 scheme）", BJS.normalizeChatUrl("127.0.0.1:31415"), "http://127.0.0.1:31415/v1/chat/completions");
    check("端点补全（/v1 结尾）", BJS.normalizeChatUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
    check("端点保持（完整路径）", BJS.normalizeChatUrl("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1/chat/completions");
    check("端点拒绝（ftp）", BJS.normalizeChatUrl("ftp://x/y"), "");

    checkTrue("本机端点识别 127.0.0.1", BJS.isLocalUrl("http://127.0.0.1:31415"));
    checkTrue("本机端点识别 localhost", BJS.isLocalUrl("http://localhost:31415/v1/chat/completions"));
    checkTrue("公网端点不识别为本机", !BJS.isLocalUrl("https://api.openai.com/v1/chat/completions"));
    check("本机端点 match pattern", BJS.originPattern("http://127.0.0.1:31415"), "http://127.0.0.1/*");

    const settings = await BJS.loadSettings();
    check("迁移：顶层键覆盖 config（enabled）", settings.enabled, true);
    check("迁移：tagFilter 保留", settings.tagFilter, "老番茄,影视飓风");
    check("迁移：apiURL 保留用户配置", settings.apiURL, "https://api.deepseek.com/v1/chat/completions");
    check("迁移：cfApiKey 从 config 继承", settings.cfApiKey, "cf-key");
    check("迁移：schemaVersion 落为 2", settings.schemaVersion, 2);
    checkTrue("迁移：写入 storage.local 主键", Boolean(legacy.store.local["bilijump.settings"]));
    checkTrue("迁移：sync 镜像仍在（兼容旧版本）", legacy.store.sync.enabled === true);

    const ban = await BJS.loadBanModels();
    check("迁移：banModels", ban, ["glm-4-flash"]);

    const saved = await BJS.saveSettings({ autoJump: false, skipMinDuration: 3 });
    check("保存：合并而非覆盖", saved.tagFilter, "老番茄,影视飓风");
    check("保存：布尔归一化", saved.autoJump, false);
    check("保存：数值生效", saved.skipMinDuration, 3);
    check("保存：越界数值被裁剪", (await BJS.saveSettings({ skipMaxRatio: 5 })).skipMaxRatio, 1);

    // 外部上下文（popup）写入后，本上下文缓存必须失效
    await legacy.chrome.storage.local.set({ "bilijump.settings": Object.assign({}, saved, { apiModel: "external-model" }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    const afterExternal = await BJS.loadSettings();
    check("缓存失效：读到外部写入", afterExternal.apiModel, "external-model");

    // 全新安装：无任何旧配置 → 默认走本地端点
    const fresh = createChromeStub({ sync: {}, local: {} });
    global.chrome = fresh.chrome;
    delete require.cache[require.resolve(path.join(ROOT, "settings.js"))];
    const FreshBJS = require(path.join(ROOT, "settings.js"));
    const freshSettings = await FreshBJS.loadSettings();
    check("首装：默认本地端点", freshSettings.apiURL, "http://127.0.0.1:31415/v1/chat/completions");
    check("首装：不内置任何密钥", freshSettings.apiKey, "");
    check("首装：本地密钥预设也为空", freshSettings.localApiKey, "");
    check("首装：内置模型默认开启", freshSettings.useBuiltinAdModel, true);
}

/* --------------------------- 2. 内置模型 --------------------------- */
function testModels() {
    console.log("\n[2] 内置模型 models.js");
    const models = require(path.join(ROOT, "models.js"));
    const lexicon = JSON.parse(fs.readFileSync(path.join(ROOT, "models", "ad-lexicon.json"), "utf8"));
    const decision = JSON.parse(fs.readFileSync(path.join(ROOT, "models", "decision.json"), "utf8"));

    const subtitle = [
        "0.00 --> 2.50", "今天我们来聊聊这款耳机的降噪表现。",
        "2.50 --> 6.00", "先说说佩戴感受，耳罩很软，长时间戴不夹头。",
        "6.00 --> 36.00", "本视频由某某品牌赞助。",
        "8.00 --> 12.00", "现在官方旗舰店有限时优惠，领券下单立减两百。",
        "12.00 --> 18.00", "点击下方链接进入直播间，小黄车里有专属优惠码。",
        "18.00 --> 24.00", "到手价只要三九九，还包邮，七天无理由退换。",
        "24.00 --> 30.00", "库存不多了，感兴趣的朋友可以扫码进群。",
        "30.00 --> 36.00", "好，我们继续回到音质部分。",
        "36.00 --> 60.00", "低频下潜不错，中频人声清晰，高频略有毛刺。",
        "60.00 --> 90.00", "整体来说，这条耳机的性价比还是比较高的。",
        "90.00 --> 120.00", "以上就是本期视频的全部内容，感谢观看。"
    ].join("\n");

    const segments = models.parseSubtitle(subtitle);
    check("字幕解析条数", segments.length, 11);
    check("字幕解析首条起点", segments[0].from, 0);

    const candidates = models.detectCandidates(segments, lexicon);
    checkTrue("识别到广告候选区间", candidates.length >= 1, `实际 ${candidates.length} 段`);
    if (candidates.length) {
        const first = candidates[0];
        checkTrue("区间覆盖广告主体（起点）", first.start <= 8.5, `start=${first.start}`);
        checkTrue("区间覆盖广告主体（终点）", first.end >= 30, `end=${first.end}`);
        checkTrue("区间未吞掉结尾正片", first.end <= 36.5, `end=${first.end}`);
        checkTrue("命中关键词", first.termHits > 5, `${first.termHits} 个`);

        const verdict = models.decide(
            models.extractFeatures(first, { duration: 120, sourceConfidence: 0.9 }),
            decision, 0.5
        );
        checkTrue("决策模型判定跳过", verdict.skip, `p=${verdict.probability.toFixed(3)}`);
        checkTrue("决策概率合理（>0.6）", verdict.probability > 0.6, `p=${verdict.probability.toFixed(3)}`);
    }

    // 反向用例：正片里只出现一次弱信号，不应被判为广告
    const normal = models.parseSubtitle([
        "0.00 --> 10.00", "这期视频我想推荐几个我觉得不错的学习方法。",
        "10.00 --> 40.00", "第一个方法是番茄工作法，专注二十五分钟休息五分钟。",
        "40.00 --> 80.00", "第二个方法是间隔重复，把复习安排在遗忘曲线之前。",
        "80.00 --> 120.00", "第三个方法是主动回忆，合上书自己讲一遍。"
    ].join("\n"));
    const normalCandidates = models.detectCandidates(normal, lexicon);
    check("正片不产生候选区间", normalCandidates.length, 0);

    // 决策模型对弱候选必须给低分
    const weak = { score: 3, start: 5, end: 12, termHits: 1, ctaHits: 0, text: "推荐" };
    const weakVerdict = models.decide(models.extractFeatures(weak, { duration: 120 }), decision, 0.5);
    checkTrue("弱候选不跳过", !weakVerdict.skip, `p=${weakVerdict.probability.toFixed(3)}`);

    /* ---- 英文素材：源自真实日志 BV13uaG6BErF（词表曾只有中文，评分全 0） ---- */
    const englishSub = models.parseSubtitle([
        "0.00 --> 12.00", "This is the HUAWEI MatePad Air Z, and it has a physical shortcut key.",
        "120.00 --> 180.00", "The screen supports one hundred and forty four hertz refresh rate.",
        "300.00 --> 310.67", "Okay, that is everything about the hardware.",
        "310.67 --> 312.312", "From now through the thirty first of october,",
        "312.312 --> 313.295", "buy a HUAWEI MatePad Air Z",
        "313.295 --> 315.15", "and get a two hundred yuan limited time discount.",
        "315.35 --> 317.044", "plus a one hundred and fifty yuan education discount",
        "317.044 --> 318.315", "and a fifteen percent national subsidy,",
        "318.315 --> 319.735", "for a lowest starting price of two thousand",
        "319.735 --> 320.76", "two hundred and fifty two yuan!",
        "321 --> 321.581", "plus a limited time,",
        "321.581 --> 322.047", "free Worry Free",
        "322.047 --> 323.602", "Bundle valued at eight hundred and fifty six yuan",
        "323.602 --> 325.44", "and a Perks Bundle worth two hundred and seventy seven yuan.",
        "325.76 --> 327.28", "If interested, do check it out!",
        "327.62 --> 332.166", "Lastly, feel free to chat in the comments."
    ].join("\n"));
    const englishCandidates = models.detectCandidates(englishSub, lexicon);
    checkTrue("英文广告被识别", englishCandidates.length >= 1, `实际 ${englishCandidates.length} 段`);
    if (englishCandidates.length) {
        const ad = englishCandidates[0];
        // 第一句 "From now through the thirty first of october" 无关键词，起点会略晚；
        // 设计上宁可晚 1~2s，也不提前吞掉正片，因此不含正向扩张
        checkTrue("英文区间起点仅略晚（≤2s）", ad.start - 310.67 >= -0.5 && ad.start - 310.67 <= 2,
            `start=${ad.start}, 偏差=${(ad.start - 310.67).toFixed(2)}s`);
        checkTrue("英文区间不吞掉片尾互动", ad.end <= 327.5, `end=${ad.end}`);
        const verdict = models.decide(models.extractFeatures(ad, { duration: 335 }), decision, 0.5);
        checkTrue("英文候选判定跳过", verdict.skip, `p=${verdict.probability.toFixed(3)}`);
    }
    // "feel free to chat" 不能因为 free 被误判
    const chatOnly = models.detectCandidates(models.parseSubtitle([
        "0.00 --> 10.00", "Let us start with the design.",
        "10.00 --> 20.00", "Lastly, feel free to chat in the comments.",
        "20.00 --> 30.00", "We will see you next time."
    ].join("\n")), lexicon);
    check("闲聊不触发候选", chatOnly.length, 0);

    /* ---- 大模型输出提取：日志里返回的是推理过程而不是 JSON ---- */
    const noisy = "我们需要回答用户：分析字幕内容识别可能广告段落，并严格返回 JSON：{\"ads\": [...], \"msg\": \"识别到广告\"}。"
        + "广告从 310.67 到 327.28。最后输出："
        + "{\"ads\":[{\"start_time\":\"310.67\",\"end_time\":\"327.28\",\"product_name\":\"华为MatePad Air Z\",\"ad_content\":\"限时优惠\"}],\"msg\":\"识别到广告\"}";
    const parsedNoisy = models.extractJson(noisy);
    checkTrue("从推理文本中提取 JSON", Boolean(parsedNoisy));
    check("提取到的条数", parsedNoisy?.ads?.length, 1);
    check("提取到的 msg", parsedNoisy?.msg, "识别到广告");

    checkTrue("代码围栏提取",
        models.extractJson("```json\n{\"ads\":[{\"start_time\":\"1\",\"end_time\":\"9\"}],\"msg\":\"ok\"}\n```")?.ads?.length === 1);
    checkTrue("think 标签被剥离",
        models.extractJson("<thinking>先想想{\"ads\":[]}</thinking>{\"ads\":[{\"start_time\":\"2\",\"end_time\":\"8\"}],\"msg\":\"ok\"}")?.ads?.length === 1);
    check("缺 msg 时补默认值",
        models.extractJson("{\"ads\":[{\"start_time\":\"2\",\"end_time\":\"8\"}]}")?.msg, "识别到广告");
    check("无 JSON 返回 null", models.extractJson("完全没有结构化内容"), null);

    // 日志里出现过：模型把提示词示例结构原样回显，时间字段是 "..."，必须判无效
    check("回显示例结构被判无效",
        models.extractJson("{\"ads\":[{\"start_time\":\"...\",\"end_time\":\"...\",\"product_name\":\"...\",\"ad_content\":\"...\"}],\"msg\":\"识别到广告\"}"),
        null);
    check("回显后紧跟真实数据时取真实数据",
        models.extractJson("{\"ads\":[{\"start_time\":\"...\",\"end_time\":\"...\"}],\"msg\":\"x\"}"
            + "{\"ads\":[{\"start_time\":\"22.14\",\"end_time\":\"33.68\",\"product_name\":\"英特尔酷睿\"}],\"msg\":\"识别到广告\"}")?.ads?.[0]?.product_name,
        "英特尔酷睿");
    checkTrue("数字型时间戳可用",
        models.extractJson("{\"ads\":[{\"start_time\":22.14,\"end_time\":33.68}],\"msg\":\"ok\"}")?.ads?.length === 1);
    checkTrue("mm:ss 时间可用",
        models.extractJson("{\"ads\":[{\"start_time\":\"0:12\",\"end_time\":\"1:05\"}],\"msg\":\"ok\"}")?.ads?.length === 1);
    checkTrue("起止颠倒的条目被丢弃",
        models.extractJson("{\"ads\":[{\"start_time\":\"40\",\"end_time\":\"10\"}],\"msg\":\"ok\"}") === null);
    check("空 ads 属于合法的未识别",
        models.extractJson("{\"ads\":[],\"msg\":\"未识别到广告\"}")?.msg, "未识别到广告");

    /* ---- 中文促销（日志里 STEPX 那类购机权益话术） ---- */
    const promo = models.detectCandidates(models.parseSubtitle([
        "0.00 --> 20.00", "这台手机的屏幕是六点七英寸的直屏。",
        "20.00 --> 40.00", "性能方面用的是今年的旗舰芯片。",
        "200.00 --> 206.00", "最后说一下购买信息，",
        "206.00 --> 214.00", "购机享十二个月会员权益，赠送保护壳和充电套装。",
        "214.00 --> 222.00", "三九九九元起售，限时礼包随单发出，可参与换新计划。",
        "222.00 --> 240.00", "好，这期视频就到这里。"
    ].join("\n")), lexicon);
    checkTrue("中文购机话术被识别", promo.length >= 1, `实际 ${promo.length} 段`);
    // 单纯提到价格与配件不能算广告
    const plain = models.detectCandidates(models.parseSubtitle([
        "0.00 --> 20.00", "包装里附送了充电器和数据线。",
        "20.00 --> 40.00", "机身重量是四百八十克，放包里不算沉。",
        "40.00 --> 60.00", "接口有两个雷电口和一个耳机孔。"
    ].join("\n")), lexicon);
    check("纯描述不触发候选", plain.length, 0);

    // 区间清洗：重叠合并 / 0 长度丢弃 / 越界裁剪 / 起止颠倒
    const cleaned = models.normalizeIntervals([
        { start_time: "10", end_time: "20", product_name: "A", ad_content: "a" },
        { start_time: "19", end_time: "25", product_name: "B", ad_content: "b" },
        { start_time: "30", end_time: "30", product_name: "C", ad_content: "c" },
        { start_time: "85", end_time: "130", product_name: "D", ad_content: "d" },
        { start_time: "50", end_time: "40", product_name: "E", ad_content: "e" }
    ], 100, { minDuration: 2, maxGap: 0.8 });
    check("区间清洗：条数", cleaned.length, 3);
    check("区间清洗：重叠合并", [cleaned[0].start, cleaned[0].end], [10, 25]);
    check("区间清洗：合并标签", cleaned[0].productName, "A | B");
    check("区间清洗：越界裁剪", [cleaned[2].start, cleaned[2].end], [85, 100]);
    check("区间清洗：起止颠倒修正", [cleaned[1].start, cleaned[1].end], [40, 50]);
    check("区间清洗：合并间隙可配", models.normalizeIntervals([
        { start_time: "10", end_time: "20" }, { start_time: "20.5", end_time: "30" }
    ], 100, { minDuration: 2, maxGap: 0 }).length, 2);

    // CPU/GPU 应使用同一权重与同一数学形式
    const z = models.matvecCpu(decision.weights, new Array(decision.weights.length).fill(0), decision.bias);
    check("matvec 偏置项", Number(z.toFixed(4)), decision.bias);
    check("sigmoid(0)", Number(models.sigmoid(0).toFixed(4)), 0.5);
}

(async () => {
    await testSettings();
    testModels();
    console.log(`\n结果：${passed} 通过, ${failed} 失败`);
    process.exit(failed ? 1 : 0);
})();
