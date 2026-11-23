/**
 * Bilibili AI Skip —— 设置存储层（settings.js）
 *
 * 设计要点：
 * 1. 唯一真实来源（source of truth）改为 chrome.storage.local，键名 bilijump.settings。
 *    storage.sync 存在网络依赖、配额限制与登录态依赖，扩展更新/浏览器重启后偶发丢失，
 *    因此只作为「跨设备镜像」尽力写入，写入失败不影响本地配置。
 * 2. 首次运行或从 2.3.x 升级时，自动把旧配置迁移到新结构：
 *    旧版把配置拆成 storage.sync 顶层 9 个键 + storage.sync.config 对象（initConfig 写入的默认值），
 *    迁移时以顶层键为最新意图覆盖 config，避免用户改动被默认值盖掉。
 * 3. 所有读写都经过 normalize()，缺字段补默认值，脏数据（字符串 "false"、越界数值）就地纠正。
 * 4. 同时支持三种运行环境：content script、MV3 service worker、popup 页面。
 */
(function (root) {
    "use strict";

    const STORE_KEY = "bilijump.settings";
    const BAN_MODELS_KEY = "bilijump.banModels";
    const PROMPT_KEY = "bilijump.prompt";
    const SCHEMA_VERSION = 2;

    const LOCAL_ENDPOINT = "http://127.0.0.1:31415";
    const LOCAL_CHAT_PATH = "/v1/chat/completions";
    // 不内置任何密钥：本地网关的 key 由用户首次在 popup 中填写，
    // 避免随仓库分发造成凭据泄露。留空时后台会给出明确提示。
    const LOCAL_API_KEY = "";

    // 2.3.x 及更早版本写在 storage.sync 顶层的键
    const LEGACY_KEYS = [
        "autoJump", "enabled", "tagFilter", "apiKey", "apiURL", "apiModel",
        "audioEnabled", "autoAudio", "aliApiKey"
    ];

    const DEFAULTS = {
        schemaVersion: SCHEMA_VERSION,
        enabled: true,
        autoJump: false,
        tagFilter: "",
        provider: "local",                       // local | custom，仅用于 UI 提示
        apiURL: LOCAL_ENDPOINT + LOCAL_CHAT_PATH,
        apiKey: LOCAL_API_KEY,
        apiModel: "",
        audioEnabled: true,
        autoAudio: false,
        aliApiKey: "",
        aliApiURL: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
        aliTaskURL: "https://dashscope.aliyuncs.com/api/v1/tasks/",
        cfApiKey: "Dmlpe9TkvsvBCE0N-FkqeRkN5ANCyHTnUSnAtGCH",
        cfApiURL: "https://api.cloudflare.com/client/v4/accounts/34c49ed8e1d2bd41c330fb65de4c5890/d1/database/c1ad567a-2375-49b4-83e2-d1de52a0902f/query",
        // 本地端点预设，方便一键回填
        localEndpoint: LOCAL_ENDPOINT,
        localApiKey: LOCAL_API_KEY,
        localModel: "",
        // 跳过鲁棒性参数
        skipMinDuration: 2,      // 短于该秒数的广告区间视为误判丢弃
        skipMaxGap: 0.8,         // 相邻区间间隔小于该值则合并，避免多计时器同时命中
        skipMaxRatio: 0.85,      // 广告总时长占比超过该值视为异常，转人工确认
        requestTimeoutMs: 120000,
        // 内置模型
        useBuiltinAdModel: true, // 离线广告识别模型（字幕分词 + 词表打分）
        useDanmakuSignal: true,  // 无字幕时用弹幕吐槽定位广告段
        useLocalASR: true,       // 本地 Whisper（whisper-tiny 已随包内置）
        useCloudAI: true,        // 内置模型无法判定时回退云端大模型
        useWebGPU: true,         // 允许使用 WebGPU 推理通道
        decisionThreshold: 0.5   // 微型决策模型的跳过阈值
    };

    const BOOLEAN_KEYS = ["enabled", "autoJump", "audioEnabled", "autoAudio", "useBuiltinAdModel", "useDanmakuSignal", "useLocalASR", "useCloudAI", "useWebGPU"];
    const NUMBER_KEYS = ["skipMinDuration", "skipMaxGap", "skipMaxRatio", "requestTimeoutMs", "decisionThreshold"];
    const STRING_KEYS = [
        "tagFilter", "apiURL", "apiKey", "apiModel", "aliApiKey", "aliApiURL",
        "aliTaskURL", "cfApiKey", "cfApiURL", "localEndpoint", "localApiKey",
        "localModel", "provider"
    ];

    /* ------------------------------------------------------------------ */
    /* storage 基础封装（sync 不可用时降级为空，不抛错）                    */
    /* ------------------------------------------------------------------ */

    function area(name) {
        try {
            const target = chrome.storage && chrome.storage[name];
            return target || null;
        } catch {
            return null;
        }
    }

    function areaGet(name, keys) {
        const target = area(name);
        if (!target) return Promise.resolve({});
        return new Promise(resolve => {
            try {
                target.get(keys, result => {
                    void chrome.runtime?.lastError;
                    resolve(result && typeof result === "object" ? result : {});
                });
            } catch {
                resolve({});
            }
        });
    }

    function areaSet(name, value) {
        const target = area(name);
        if (!target) return Promise.resolve(false);
        return new Promise(resolve => {
            try {
                target.set(value, () => {
                    void chrome.runtime?.lastError;
                    resolve(true);
                });
            } catch {
                resolve(false);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* URL 规范化                                                          */
    /* ------------------------------------------------------------------ */

    /** 把用户输入的端点补成可直接请求的 chat/completions 完整地址 */
    function normalizeChatUrl(raw) {
        let value = String(raw == null ? "" : raw).trim();
        if (!value) return "";
        if (/^\/\//.test(value)) value = "http:" + value;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "http://" + value;

        let url;
        try {
            url = new URL(value);
        } catch {
            return "";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";

        const path = url.pathname.replace(/\/+$/, "");
        if (/\/chat\/completions$/.test(path)) return url.origin + url.pathname.replace(/\/+$/, "");
        if (/\/v1$/.test(path)) return url.origin + path + "/chat/completions";
        if (/\/v1\//.test(path)) return url.origin + path;
        return url.origin + path + "/v1/chat/completions";
    }

    /** 是否为本机 http 端点（127.0.0.1 / localhost / ::1） */
    function isLocalUrl(raw) {
        let url;
        try {
            url = new URL(normalizeChatUrl(raw) || String(raw || ""));
        } catch {
            return false;
        }
        if (url.protocol !== "http:") return false;
        return url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
            url.hostname === "[::1]" || url.hostname === "::1";
    }

    /** 该端点的授权 match pattern（端口在 match pattern 中不可指定） */
    function originPattern(raw) {
        let url;
        try {
            url = new URL(normalizeChatUrl(raw) || String(raw || ""));
        } catch {
            return null;
        }
        if (url.protocol === "https:") return `${url.protocol}//${url.hostname}/*`;
        if (isLocalUrl(raw)) return `http://${url.hostname}/*`;
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* 归一化与迁移                                                        */
    /* ------------------------------------------------------------------ */

    function toBool(value, fallback) {
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
            const text = value.trim().toLowerCase();
            if (text === "true" || text === "1") return true;
            if (text === "false" || text === "0" || text === "") return false;
        }
        if (typeof value === "number") return value !== 0;
        return fallback;
    }

    function toNumber(value, fallback, min, max) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(Math.max(number, min), max);
    }

    function normalize(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const out = Object.assign({}, DEFAULTS);

        for (const key of Object.keys(source)) {
            if (source[key] !== undefined) out[key] = source[key];
        }

        for (const key of BOOLEAN_KEYS) out[key] = toBool(out[key], DEFAULTS[key]);
        for (const key of STRING_KEYS) {
            out[key] = typeof out[key] === "string" ? out[key].trim() : "";
        }

        out.skipMinDuration = toNumber(out.skipMinDuration, DEFAULTS.skipMinDuration, 0, 30);
        out.skipMaxGap = toNumber(out.skipMaxGap, DEFAULTS.skipMaxGap, 0, 5);
        out.skipMaxRatio = toNumber(out.skipMaxRatio, DEFAULTS.skipMaxRatio, 0.3, 1);
        out.requestTimeoutMs = toNumber(out.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 5000, 600000);
        out.decisionThreshold = toNumber(out.decisionThreshold, DEFAULTS.decisionThreshold, 0.05, 0.95);

        // apiURL 为空时回落到本地端点预设（只影响「从未配置过」的情况，不覆盖用户已有配置）
        if (!out.apiURL) out.apiURL = normalizeChatUrl(out.localEndpoint);
        if (!out.localEndpoint) out.localEndpoint = LOCAL_ENDPOINT;
        if (!out.localApiKey) out.localApiKey = LOCAL_API_KEY;
        if (!out.apiKey && isLocalUrl(out.apiURL)) out.apiKey = out.localApiKey;

        out.provider = out.provider === "custom" ? "custom" : "local";
        out.schemaVersion = SCHEMA_VERSION;
        return out;
    }

    /**
     * 合并旧配置。priority：defaults < config 对象 < 顶层键（顶层键由旧 popup 每次保存写入，代表最新意图）
     */
    function migrateLegacy(legacyConfig, topLevel) {
        const merged = Object.assign({}, DEFAULTS, legacyConfig || {});
        if (topLevel && typeof topLevel === "object") {
            for (const key of Object.keys(topLevel)) {
                if (topLevel[key] !== undefined && topLevel[key] !== null) merged[key] = topLevel[key];
            }
        }
        // 旧版把 API 地址存在 apiURL，若为空则保留新默认（本地端点），避免迁移后反而不可用
        if (!merged.apiURL) merged.apiURL = DEFAULTS.apiURL;
        return normalize(merged);
    }

    async function readLegacy() {
        const [syncData, localData] = await Promise.all([
            areaGet("sync", LEGACY_KEYS.concat(["config", "banModels", "prompt"])),
            areaGet("local", ["config", "banModels", "prompt"])
        ]);

        const topLevel = {};
        for (const key of LEGACY_KEYS) {
            if (syncData[key] !== undefined) topLevel[key] = syncData[key];
        }

        return {
            topLevel,
            legacyConfig: Object.assign({}, localData.config || {}, syncData.config || {}),
            banModels: syncData.banModels || localData.banModels || null,
            prompt: localData.prompt || syncData.prompt || ""
        };
    }

    /* ------------------------------------------------------------------ */
    /* 读写                                                                */
    /* ------------------------------------------------------------------ */

    async function persist(settings) {
        const payload = Object.assign({}, settings, {
            schemaVersion: SCHEMA_VERSION,
            updatedAt: Date.now()
        });
        await areaSet("local", { [STORE_KEY]: payload });
        mirrorToSync(payload);
        return payload;
    }

    /** 尽力镜像到 sync，让降级回旧版本的场景仍能读到配置；失败静默 */
    function mirrorToSync(settings) {
        const mirror = { config: {} };
        for (const key of LEGACY_KEYS) {
            mirror[key] = settings[key];
            mirror.config[key] = settings[key];
        }
        mirror.config.aliApiURL = settings.aliApiURL;
        mirror.config.aliTaskURL = settings.aliTaskURL;
        mirror.config.cfApiKey = settings.cfApiKey;
        mirror.config.cfApiURL = settings.cfApiURL;
        areaSet("sync", mirror).catch(() => {});
    }

    let loading = null;
    let cachedAt = 0;
    let invalidateBound = false;

    /** 其它上下文（popup / 另一个标签页）写入后，本上下文的缓存必须失效 */
    function bindInvalidate() {
        if (invalidateBound) return;
        invalidateBound = true;
        try {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName === "local" && changes[STORE_KEY]) loading = null;
            });
        } catch {
            // storage 不可用时忽略
        }
    }

    /**
     * 读取设置；首次调用会完成迁移并落盘。
     * 缓存 500ms，配合 onChanged 失效，跨上下文写入后最多 0.5s 内可见；
     * 需要绝对最新值时传 { fresh: true }（例如发请求前）。
     */
    function loadSettings(options) {
        bindInvalidate();
        const forceFresh = Boolean(options && options.fresh);
        if (!forceFresh && loading && Date.now() - cachedAt < 500) return loading;

        loading = (async () => {
            const primary = await areaGet("local", STORE_KEY);
            const stored = primary && primary[STORE_KEY];
            if (stored && typeof stored === "object" && Number(stored.schemaVersion) >= SCHEMA_VERSION) {
                return normalize(stored);
            }

            const legacy = await readLegacy();
            const base = stored && typeof stored === "object"
                ? Object.assign({}, legacy.legacyConfig, stored)
                : legacy.legacyConfig;
            const migrated = normalize(Object.assign({}, base, legacy.topLevel));
            await persist(migrated);
            if (legacy.banModels && Array.isArray(legacy.banModels)) {
                await areaSet("local", { [BAN_MODELS_KEY]: legacy.banModels });
            }
            return migrated;
        })();
        cachedAt = Date.now();
        return loading;
    }

    async function saveSettings(patch) {
        bindInvalidate();
        const current = await loadSettings();
        const next = normalize(Object.assign({}, current, patch || {}));
        const saved = await persist(next);
        loading = Promise.resolve(saved);
        cachedAt = Date.now();
        return saved;
    }

    function clearCache() {
        loading = null;
    }

    /** 订阅设置变化：只监听 local 主键，避免 sync 镜像回灌造成循环 */
    function watchSettings(callback) {
        let last = "";
        try {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName !== "local" || !changes[STORE_KEY]) return;
                const next = normalize(changes[STORE_KEY].newValue);
                const signature = JSON.stringify(next);
                if (signature === last) return;
                last = signature;
                callback(next);
            });
        } catch {
            // storage 不可用时静默
        }
    }

    async function loadBanModels() {
        const local = await areaGet("local", BAN_MODELS_KEY);
        if (Array.isArray(local[BAN_MODELS_KEY])) return local[BAN_MODELS_KEY];
        const legacy = await readLegacy();
        const models = Array.isArray(legacy.banModels) ? legacy.banModels : ["glm-4-flash"];
        await areaSet("local", { [BAN_MODELS_KEY]: models });
        return models;
    }

    async function getPrompt() {
        const local = await areaGet("local", PROMPT_KEY);
        if (typeof local[PROMPT_KEY] === "string" && local[PROMPT_KEY]) return local[PROMPT_KEY];
        const legacy = await readLegacy();
        if (legacy.prompt) {
            await areaSet("local", { [PROMPT_KEY]: legacy.prompt });
            return legacy.prompt;
        }
        return "";
    }

    const api = {
        STORE_KEY,
        SCHEMA_VERSION,
        LOCAL_ENDPOINT,
        LOCAL_API_KEY,
        DEFAULTS,
        normalize,
        normalizeChatUrl,
        isLocalUrl,
        originPattern,
        migrateLegacy,
        loadSettings,
        saveSettings,
        watchSettings,
        loadBanModels,
        getPrompt,
        clearCache
    };

    root.BJS = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
