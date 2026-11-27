let settings = {};
let banModels = ["glm-4-flash"];

let popups = { audioCheck: null, task: null, ai: null, ads: [], others: [] }, now_cid;

const SKIP_STATE = {
    session: 0,
    bvid: null,
    pvid: null,
    timer: null,
    markerWatch: null,
    markers: [],
    lastIntervals: [],
    videoHandlers: [],
    href: location.href,
    activeKey: "",
    retry: { key: "", count: 0 },
    // 被云端内容安全审核拦下的 cid：同一会话内不再重问，避免每次刷新都烧三次调用
    blockedCids: new Set()
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// "AI 分析中"最多挂 60 秒；超过就隐藏，别让播放器上一直杵着一条提示
const AI_POPUP_HIDE_MS = 60000;
// 云端识别总预算，超了就收手，避免多次超时把页面拖住几分钟
const ANALYSIS_DEADLINE_MS = 120000;

/** 是否使用本机端点：本机网关可以不指定模型名，走后端默认模型 */
function isLocalAPI() {
    const raw = String(settings.apiURL || "");
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(raw);
}

/** 轮询等待，替代原来无上限的 while(true)，避免视频不加载时永久挂起 */
function waitFor(getter, timeout = 15000, interval = 250) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const tick = () => {
            let value = null;
            try {
                value = getter();
            } catch {
                value = null;
            }
            if (value) return resolve(value);
            if (Date.now() - startedAt >= timeout) return resolve(null);
            setTimeout(tick, interval);
        };
        tick();
    });
}

/** 兼容 /video/BVxxx 与 /list/watchlater?bvid=&p= 两种页面结构 */
function parseVideoId() {
    const parts = location.pathname.split("/").filter(Boolean);
    const params = new URLSearchParams(location.search);
    if (parts[0] === "list" && parts[1] === "watchlater") {
        return { bvid: params.get("bvid") || "", pvid: params.get("p") };
    }
    if (parts[0] === "video") {
        return { bvid: parts[1] || "", pvid: params.get("p") };
    }
    return { bvid: "", pvid: null };
}

function note(message) {
    return popups.others.push(showPopup(message));
}

function clearAllPopups() {
    for (const key of ["audioCheck", "task", "ai"]) {
        popups[key]?.remove?.();
        popups[key] = null;
    }
    for (const item of popups.others.splice(0)) item?.remove?.();
    for (const item of popups.ads.splice(0)) item?.remove?.();
    popupCount = 0;
}

function matchTagFilter() {
    const raw = String(settings.tagFilter || "").trim();
    if (!raw) return false;
    const filters = raw.split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean);
    if (!filters.length) return false;
    const tags = Array.from(document.querySelectorAll(".tag-panel .tag .ordinary-tag a"))
        .map(node => node.textContent.trim().toLowerCase());
    const author = document.querySelector('meta[name="author"]')?.getAttribute("content");
    if (author) tags.push(author.trim().toLowerCase());
    return filters.some(filter => tags.some(tag => tag.includes(filter)));
}

/* ------------------------- 进度条广告区间标记 ------------------------- */

function removeMarkers() {
    for (const node of SKIP_STATE.markers.splice(0)) node.remove?.();
    for (const node of document.querySelectorAll(".bjs-ad-marker")) node.remove();
}

function renderAdMarkers(intervals, duration) {
    SKIP_STATE.lastIntervals = intervals || [];
    removeMarkers();
    if (!intervals?.length || !(duration > 0)) return;

    // 不同版本页面结构不同：新版有 schedule-segment 容器，旧版只有 schedule
    const hasSegments = document.querySelectorAll(".bpx-player-progress-schedule-segment").length > 0;
    const targets = [];
    if (hasSegments) {
        const main = document.querySelector(".bpx-player-progress");
        const shadow = document.querySelector(".bpx-player-shadow-progress-schedule-wrap");
        if (main) targets.push(main);
        if (shadow) targets.push(shadow);
    } else {
        targets.push(...Array.from(document.querySelectorAll(".bpx-player-progress-schedule")));
    }
    if (!targets.length) return;

    for (const ad of intervals) {
        for (const host of targets) {
            const marker = document.createElement("div");
            marker.className = "bpx-player-progress-schedule-current bjs-ad-marker";
            marker.dataset.bjsMarker = `${ad.start}-${ad.end}`;
            marker.style.transform = `translate(${(ad.start / duration) * 100}%, 0%) scaleX(${(ad.end - ad.start) / duration})`;
            marker.style.backgroundColor = "#df9938";
            marker.style.zIndex = "auto";
            marker.style.pointerEvents = "none";
            host.appendChild(marker);
            SKIP_STATE.markers.push(marker);
        }
    }

    for (const node of document.querySelectorAll(".bpx-player-progress-schedule-current:not(.bjs-ad-marker)")) {
        node.style.backgroundColor = "#13c58ae6";
        node.style.zIndex = "99";
    }

    // 播放器切换清晰度/分P 时会重建进度条，定时对账把标记补回来
    if (!SKIP_STATE.markerWatch) {
        SKIP_STATE.markerWatch = setInterval(() => {
            if (!SKIP_STATE.markers.length) return;
            if (SKIP_STATE.markers.some(node => document.contains(node))) return;
            const video = document.querySelector("video");
            renderAdMarkers(SKIP_STATE.lastIntervals, video?.duration || 0);
        }, 1500);
    }
}

/* ----------------------------- 区间与调度 ----------------------------- */

/** 清洗广告区间：复用 models.js 的实现，保证云端/内置/人工三种来源同一套规则 */
function normalizeAdIntervals(ads, duration) {
    if (typeof BJSModels !== "undefined") {
        return BJSModels.normalizeIntervals(ads, duration, {
            minDuration: Number(settings.skipMinDuration),
            maxGap: Number(settings.skipMaxGap)
        });
    }
    return [];
}

/** seek 后校验：B 站播放器有时会把进度拉回广告区间，做一次定点重试 */
function seekVideo(video, target) {
    const duration = Number.isFinite(video.duration) ? video.duration : target;
    const wanted = clamp(target, 0, Math.max(duration - 0.2, 0));
    video.currentTime = wanted;
    const startedAt = Date.now();
    let retried = false;

    const verify = () => {
        if (Date.now() - startedAt > 2000 || retried) return;
        const element = document.querySelector("video");
        if (!element) return;
        if (element.currentTime < wanted - 2.5) {
            retried = true;
            element.currentTime = wanted;
            styleLog(`seek 被回退，已重新定位到 ${wanted.toFixed(1)}s`);
            setTimeout(verify, 400);
        }
    };
    setTimeout(verify, 500);
}

function clearAdCard() {
    const card = popups.ads[0];
    if (card) {
        card.remove();
        popups.ads[0] = undefined;
    }
}

function showSkipCard(ad, target, current, video, suspicious) {
    const remaining = Math.max(Math.ceil(target - current), 1);

    if (popups.ads[0] && document.body.contains(popups.ads[0])) {
        const button = popups.ads[0].querySelector("#skip-button");
        if (button) button.textContent = String(remaining);
        return;
    }

    const container = document.querySelector(".bpx-player-container");
    if (!container) {
        styleLog("Player container not found.");
        return;
    }
    container.style.position = "relative";

    const card = document.createElement("div");
    card.dataset.bjsSkipCard = "1";
    card.innerHTML = `
        <div style="display: flex; align-items: flex-start; height: 100%;">
            <div style="width: 2px; height: 100%; background-color: #ff0000; margin-right: 10px;"></div>
            <div style="flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
                <div style="font-weight: bold; font-size: 16px;">广告 · ${ad.productName || "未命名"}<span style="font-size: 11px; color: #cccccc; font-weight: normal; margin-left: 8px;">(按 k 跳过)</span></div>
                <div style="height: 60px; display: flex; align-items: center; flex: 1;">
                    <div style="width: 40px; height: 40px; background-color: rgba(255, 255, 255, 0.2); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 10px; flex-shrink: 0;">
                        <button id="skip-button" title="按k或点击倒计时跳过" style="color: #fff; font-size: 14px; font-weight: bold; background: linear-gradient(135deg, #48D1CC, #48D1CC); border: none; border-radius: 50%; width: 100%; height: 100%; cursor: pointer; transition: all 0.3s ease;">${remaining}</button>
                    </div>
                    <div style="overflow: hidden; flex: 1;">
                        <div style="word-wrap: break-word;">${ad.adContent || ""}</div>
                    </div>
                </div>
                <div data-bjs-warn style="display: none; margin-top: 6px; font-size: 11px; color: #ffd54f;"></div>
            </div>
        </div>
    `;
    card.style.position = "absolute";
    card.style.bottom = "90px";
    card.style.right = "30px";
    card.style.width = "300px";
    card.style.padding = "15px";
    card.style.background = "linear-gradient(135deg, rgba(0, 0, 0, 0.3), rgba(50, 50, 50, 0.5))";
    card.style.color = "#fff";
    card.style.borderRadius = "8px";
    card.style.boxShadow = "0 4px 10px rgba(0, 0, 0, 0.3)";
    card.style.zIndex = "50";
    card.style.fontFamily = "Arial, sans-serif";
    card.style.lineHeight = "1.5";
    card.style.overflow = "hidden";
    card.style.transition = "background 0.3s ease";

    const closeButton = document.createElement("span");
    closeButton.innerHTML = "×";
    closeButton.style.position = "absolute";
    closeButton.style.top = "10px";
    closeButton.style.right = "15px";
    closeButton.style.cursor = "pointer";
    closeButton.style.fontSize = "18px";
    closeButton.style.color = "#fff";
    card.appendChild(closeButton);

    card.addEventListener("mouseenter", () => {
        card.style.background = "linear-gradient(135deg, rgba(0, 0, 0, 0.8), rgba(50, 50, 50, 1))";
    });
    card.addEventListener("mouseleave", () => {
        card.style.background = "linear-gradient(135deg, rgba(0, 0, 0, 0.3), rgba(50, 50, 50, 0.5))";
    });

    container.appendChild(card);

    closeButton.addEventListener("click", () => {
        ad.done = true;
        card.remove();
        popups.ads[0] = undefined;
    });

    card.querySelector("#skip-button").addEventListener("click", () => {
        ad.done = true;
        card.remove();
        popups.ads[0] = undefined;
        seekVideo(video, target);
        note("广告已跳过.");
        if (now_cid) updateTimes(now_cid, target - ad.start);
    });

    if (suspicious) {
        const warn = card.querySelector("[data-bjs-warn]");
        if (warn) {
            warn.textContent = "广告占比异常，已转为手动确认";
            warn.style.display = "block";
        }
    }

    popups.ads[0] = card;
}

/**
 * 单调度器：250ms 统一 tick，同一时刻命中的所有区间合并成一次 seek。
 * 原实现为每个广告各起一个 setInterval，区间重叠时会连续跳多次并互相覆盖状态。
 */
function startScheduler(intervals, video, alive) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const totalAdTime = intervals.reduce((sum, ad) => sum + (ad.end - ad.start), 0);
    const ratioLimit = Number(settings.skipMaxRatio) || 0.85;
    const suspicious = duration > 0 && totalAdTime > duration * ratioLimit;
    if (suspicious) {
        note(`广告总占比 ${Math.round((totalAdTime / duration) * 100)}%，已转人工确认`);
    }

    const guard = { lastSkipAt: 0, lastSkipTo: -1 };

    const stopScheduler = () => {
        if (SKIP_STATE.timer) {
            clearInterval(SKIP_STATE.timer);
            SKIP_STATE.timer = null;
        }
    };

    const tick = () => {
        if (!alive()) return stopScheduler();
        if (intervals.every(ad => ad.done)) return stopScheduler();

        const element = document.querySelector("video");
        if (!element || !document.contains(element)) return stopScheduler();

        const current = element.currentTime;
        const hit = intervals.filter(ad => !ad.done && current >= ad.start - 0.25 && current < ad.end - 0.3);
        if (!hit.length) {
            clearAdCard();
            return;
        }

        const target = Math.max(...hit.map(ad => ad.end));

        if (suspicious || !settings.autoJump) {
            showSkipCard(hit[0], target, current, element, suspicious);
            return;
        }

        const now = Date.now();
        const from = Math.min(...hit.map(ad => ad.start));

        // 防抖：连续 seek 会让播放器抖动
        if (now - guard.lastSkipAt < 700) return;
        // 目标在当前进度之前或等于上次跳转点：直接标记完成，避免来回循环
        if (target <= current + 0.4 || target <= guard.lastSkipTo + 0.4) {
            hit.forEach(ad => { ad.done = true; });
            return;
        }

        guard.lastSkipAt = now;
        guard.lastSkipTo = target;
        hit.forEach(ad => { ad.done = true; });

        seekVideo(element, target);
        note("广告已跳过.");
        if (now_cid) updateTimes(now_cid, target - from);
    };

    SKIP_STATE.timer = setInterval(tick, 250);
    tick();
}

/* ------------------------------ 会话管理 ------------------------------ */

function attachVideoListeners(video, session) {
    const onDurationChange = () => {
        if (session !== SKIP_STATE.session) return;
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;
        renderAdMarkers(SKIP_STATE.lastIntervals, duration);
    };
    SKIP_STATE.videoHandlers = [
        ["loadedmetadata", onDurationChange],
        ["durationchange", onDurationChange]
    ];
    for (const [type, handler] of SKIP_STATE.videoHandlers) {
        video.addEventListener(type, handler);
    }
}

function teardownSession(reason) {
    // 递增 session 让所有在途的识别/调度立即失效，避免旧会话回写新页面
    SKIP_STATE.session++;
    SKIP_STATE.activeKey = "";
    if (SKIP_STATE.timer) {
        clearInterval(SKIP_STATE.timer);
        SKIP_STATE.timer = null;
    }
    if (SKIP_STATE.markerWatch) {
        clearInterval(SKIP_STATE.markerWatch);
        SKIP_STATE.markerWatch = null;
    }
    removeMarkers();
    const video = document.querySelector("video");
    if (video) {
        for (const [type, handler] of SKIP_STATE.videoHandlers) video.removeEventListener(type, handler);
    }
    SKIP_STATE.videoHandlers = [];
    SKIP_STATE.lastIntervals = [];
    clearAllPopups();
    document.getElementById("bilibili-ai-skip-correct")?.remove();
    if (reason) styleLog(reason);
}

let keyHandlerBound = false;
function installKeyHandler() {
    if (keyHandlerBound) return;
    keyHandlerBound = true;
    document.addEventListener("keydown", event => {
        const key = String(event.key || "").toLowerCase();
        if (key === "k") {
            for (const card of popups.ads) {
                if (!card || !document.body.contains(card)) continue;
                const button = card.querySelector("#skip-button");
                if (button) {
                    button.click();
                    break;
                }
            }
        } else if (popups.audioCheck && document.body.contains(popups.audioCheck)) {
            if (key === "y") popups.audioCheck.querySelector("#yes-button")?.click();
            if (key === "n") popups.audioCheck.querySelector("#no-button")?.click();
        }
    });
}

async function startAdSkipping() {
    if (!settings.enabled) return;

    const { bvid, pvid } = parseVideoId();
    if (!bvid) {
        // 离开视频页：清掉计时器与标记，避免在非视频页残留轮询
        teardownSession();
        return;
    }

    // 同一视频已有会话在跑就直接返回。B 站一次跳转会改变多次 URL（加 spm_id_from 等），
    // 之前每次变化都强启一个会话，导致同一条视频并发识别两遍、提示互相覆盖。
    const videoKey = `${bvid}:${pvid ?? ""}`;
    if (SKIP_STATE.activeKey === videoKey) return;

    teardownSession();
    const session = ++SKIP_STATE.session;
    const alive = () => session === SKIP_STATE.session && Boolean(settings.enabled);

    SKIP_STATE.bvid = bvid;
    SKIP_STATE.pvid = pvid;
    SKIP_STATE.activeKey = videoKey;

    try {
        if (matchTagFilter()) {
            note("过滤列表，跳过");
            return;
        }

        const video = await waitFor(() => {
            const element = document.querySelector("video");
            return element && Number.isFinite(element.duration) && element.duration > 0 ? element : null;
        }, 45000, 300);
        if (!alive()) return;
        if (!video) {
            // 播放器延迟渲染：有限次重试，避免一次失败就永久放弃
            const key = `${bvid}:${pvid ?? ""}`;
            if (SKIP_STATE.retry.key !== key) SKIP_STATE.retry = { key, count: 0 };
            if (SKIP_STATE.retry.count < 4) {
                SKIP_STATE.retry.count++;
                // 本次会话到此为止，释放占用，否则去重逻辑会把重试挡掉
                if (SKIP_STATE.activeKey === key) SKIP_STATE.activeKey = "";
                note(`视频未就绪，${5} 秒后重试（${SKIP_STATE.retry.count}/4）`);
                setTimeout(() => {
                    // 期间若已切换视频，交给新会话处理，不要重复识别
                    if (!alive() || !settings.enabled) return;
                    startAdSkipping();
                }, 5000);
            } else {
                note("视频始终未就绪，已停止本次识别");
            }
            return;
        }
        SKIP_STATE.retry = { key: `${bvid}:${pvid ?? ""}`, count: 0 };

        note(`视频长度：${Math.ceil(video.duration)}s`);
        if (video.duration < 120) {
            note("短视频，无需分析广告");
            return;
        }

        attachVideoListeners(video, session);

        let adsData = await adRecognition(bvid, pvid, alive);
        for (let i = 1; i < 3 && adsData === null; i++) {
            if (!alive()) return;
            note("Re-fetch AD data.");
            await sleep(800);
            adsData = await adRecognition(bvid, pvid, alive);
        }
        if (!alive()) return;

        // 识别期间可能已经切到别的视频，丢弃过期结果
        const current = parseVideoId();
        if (current.bvid !== bvid || current.pvid !== pvid) return;

        styleLog("广告数据: " + JSON.stringify(adsData));

        const intervals = normalizeAdIntervals(adsData?.ads, video.duration);
        if (!intervals.length) {
            note(adsData?.msg || "无有效数据");
            return;
        }

        renderAdMarkers(intervals, video.duration);
        startScheduler(intervals, video, alive);
    } catch (error) {
        console.info("Failed to fetch ad time:", error);
    }
}

/** SPA 路由监听：B 站切换视频不刷新页面，必须自行感知 URL 变化 */
function watchNavigation() {
    const check = () => {
        if (location.href === SKIP_STATE.href) return;
        SKIP_STATE.href = location.href;
        startAdSkipping();
    };

    try {
        for (const method of ["pushState", "replaceState"]) {
            const original = history[method];
            if (typeof original !== "function") continue;
            history[method] = function (...args) {
                const result = original.apply(this, args);
                setTimeout(check, 0);
                return result;
            };
        }
    } catch {
        // 隔离环境下 patch 可能无效，下面还有兜底轮询
    }

    addEventListener("popstate", check);
    addEventListener("hashchange", check);
    setInterval(check, 1000);

    const titleNode = document.querySelector("head > title") || document.head;
    if (titleNode) {
        new MutationObserver(check).observe(titleNode, { childList: true, subtree: true, characterData: true });
    }
}

(async function bootstrap() {
    try {
        settings = await BJS.loadSettings();
        banModels = await BJS.loadBanModels();
    } catch (error) {
        console.warn("[Bilibili AI Skip] settings bootstrap failed:", error);
        settings = typeof BJS !== "undefined" ? BJS.normalize({}) : {};
    }

    BJS.watchSettings(next => {
        const wasEnabled = Boolean(settings.enabled);
        settings = next;
        if (wasEnabled === Boolean(next.enabled)) return;
        if (next.enabled) startAdSkipping();
        else teardownSession("插件已关闭");
    });

    installKeyHandler();
    watchNavigation();

    if (settings.enabled) startAdSkipping();
    activeLog();
})();

/**
 * 用弹幕定位广告段（无字幕场景的兜底）。
 * 只做时间定位、不写共享库：弹幕信号是弱证据，不适合污染云端数据。
 */
async function detectByDanmaku(cid, bvid, pvid) {
    if (settings.useDanmakuSignal === false || typeof BJSModels === "undefined") return null;

    try {
        const response = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { credentials: "include" });
        if (!response.ok) return null;
        const xml = await response.text();
        if (!xml || xml.indexOf("<d ") === -1) return null;

        const entries = BJSModels.parseDanmaku(xml);
        // 弹幕太少时统计没有意义，直接放弃，避免误判
        if (entries.length < 20) return null;

        const video = document.querySelector("video");
        const ads = BJSModels.detectAdsFromDanmaku(entries, { duration: video?.duration || 0 });
        if (!ads.length) return null;

        styleLog(`弹幕信号命中 ${ads.length} 段: ${ads.map(ad => `${ad.start.toFixed(0)}-${ad.end.toFixed(0)}`).join(", ")}`);
        const payload = {
            ads: ads.map(ad => ({
                start_time: ad.start.toFixed(2),
                end_time: ad.end.toFixed(2),
                product_name: ad.productName,
                ad_content: ad.text
            })),
            msg: "识别到广告",
            model: "builtin:danmaku"
        };

        popups.others.push(showPopup(`弹幕信号：${ads.length} 段（${entries.length} 条弹幕）`));
        correctButton(cid, payload, bvid, pvid);
        return payload;
    } catch (error) {
        styleLog("弹幕信号不可用: " + error.message);
        return null;
    }
}

/* --------------------------- 识别结果本地缓存 --------------------------- */
// 同一个视频反复打开（刷新、站内往返）不该每次都重新问云端。
// 键用 bvid:pvid（拿到结果不必先请求 view 接口），值里带 cid 供纠错按钮使用。
const RESULT_CACHE_KEY = "bilijump.resultCache";
const RESULT_CACHE_VERSION = 4;
const RESULT_CACHE_MAX = 300;
const RESULT_CACHE_TTL_ADS = 14 * 24 * 3600 * 1000;   // 有广告的结论稳定，存久一点
const RESULT_CACHE_TTL_EMPTY = 3 * 24 * 3600 * 1000;  // 无广告的结论更可能是漏判，短一些

function cacheKeyOf(bvid, pvid) {
    return `${bvid}:${pvid == null ? "" : pvid}`;
}

async function readCachedResult(bvid, pvid) {
    try {
        const store = (await chrome.storage.local.get(RESULT_CACHE_KEY))[RESULT_CACHE_KEY] || {};
        const entry = store[cacheKeyOf(bvid, pvid)];
        if (!entry || entry.v !== RESULT_CACHE_VERSION) return null;
        if (!entry.cid || !entry.data || !Array.isArray(entry.data.ads)) return null;
        const ttl = entry.data.ads.length ? RESULT_CACHE_TTL_ADS : RESULT_CACHE_TTL_EMPTY;
        if (!Number.isFinite(entry.ts) || Date.now() - entry.ts > ttl) return null;
        return { cid: entry.cid, data: entry.data };
    } catch {
        return null;
    }
}

async function writeCachedResult(bvid, pvid, cid, data) {
    if (!data || !Array.isArray(data.ads)) return;
    try {
        const store = Object.assign({}, (await chrome.storage.local.get(RESULT_CACHE_KEY))[RESULT_CACHE_KEY] || {});
        store[cacheKeyOf(bvid, pvid)] = { v: RESULT_CACHE_VERSION, ts: Date.now(), cid, data };
        const keys = Object.keys(store);
        if (keys.length > RESULT_CACHE_MAX) {
            keys.sort((a, b) => (store[a]?.ts || 0) - (store[b]?.ts || 0))
                .slice(0, keys.length - RESULT_CACHE_MAX)
                .forEach(key => delete store[key]);
        }
        await chrome.storage.local.set({ [RESULT_CACHE_KEY]: store });
    } catch {
        // 缓存失败不影响主流程
    }
}

async function adRecognition(bvid, pvid, alive = () => true) {
    try {
        let resultS = await chrome.storage.local.get('subtitle');

        // 命中本地缓存直接返回：省掉 view / player / 字幕 / 云端 四段往返
        const cached = await readCachedResult(bvid, pvid);
        if (cached) {
            if (!alive()) return null;
            styleLog(`本地缓存命中：${bvid}:${pvid ?? ""}（${cached.data.ads.length} 段）`);
            popups.others.push(showPopup("使用本地缓存"));
            correctButton(cached.cid, cached.data, bvid, pvid);
            return cached.data;
        }

        let response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {credentials: "include"});
        const videoData = await response.json(), aid = videoData.data.aid, cid = videoData.data.pages?.[pvid?pvid-1:pvid]?.cid || videoData.data.cid, title = videoData.data.title;
        now_cid = cid;
        if (!alive()) return null;

        //showPopup(`视频ID: ${bvid}`);
        //showPopup(`CID: ${cid}`);
        styleLog(`PID: ${pvid}`);

        // 共享库（Cloudflare）：没配置就整段跳过，省一次往返；
        // 出错也只当没缓存，绝不能因为共享库挂了就中断识别
        let dbResults = null;
        if (settings.cfApiURL && settings.cfApiKey) {
            dbResults = await new Promise(resolve => {
                try {
                    chrome.runtime.sendMessage({
                        action: "dbQuery",
                        url: settings.cfApiURL,
                        method: "POST",
                        cfApiKey: settings.cfApiKey,
                        body: {sql: "/* chrome */ SELECT data,model FROM bilijump WHERE cid = ? LIMIT 1;", params: [cid]}
                    }, response => {
                        if (chrome.runtime.lastError) return resolve(null);
                        if (!response?.success) {
                            styleLog("共享库查询失败: " + (response?.error || "unknown"));
                            return resolve(null);
                        }
                        resolve(response?.data?.result?.[0]?.results?.[0] || null);
                    });
                } catch (error) {
                    styleLog("共享库查询异常: " + error.message);
                    resolve(null);
                }
            });
        }
        let tempAds = {};
        try {
            tempAds = JSON.parse(dbResults?.data || "{}");
        } catch {
            tempAds = {};
        }
        if(dbResults?.data && tempAds?.ads && tempAds?.msg) {
            popups.others.push(showPopup(`使用云端数据, 模型: ${dbResults?.model}.`));
            correctButton(cid, tempAds, bvid, pvid);
            writeCachedResult(bvid, pvid, cid, tempAds);
            return tempAds;
        }

        // API 配置校验已后移到「云端回退」分支，内置模型无需任何 Key

        response = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, {
            credentials: "include"
        });
        const playerData = await response.json(), subtitleUrl = playerData.data?.subtitle?.subtitles?.[0]?.subtitle_url;


        let subtitle = "", type;

        // 无字幕时先用弹幕信号兜底：零成本、不需要 Key、不需要下载模型。
        // 弹幕里出现"广告/恰饭/软广"的位置通常与广告段对齐，命中就直接返回。
        if (!subtitleUrl) {
            const danmakuResult = await detectByDanmaku(cid, bvid, pvid);
            if (danmakuResult) return danmakuResult;
        }

        if (subtitleUrl) {
            type = '字幕';
            popups.others.push(showPopup("使用字幕分析."));
            response = await fetch(`https:${subtitleUrl}`);
            const subtitleData = await response.json();

            subtitleData.body.forEach(item => {
                subtitle += `${item.from} --> ${item.to}\n${item.content}\n`;
            });
        }else if(!subtitle && settings.audioEnabled) {
            type = '音频';
            if (resultS?.subtitle?.hasOwnProperty(cid)) {
                subtitle = resultS.subtitle[cid];
                popups.others.push(showPopup("使用音频缓存."));
            }else {
                if(!settings["aliApiKey"]) {
                    // 这是「没有素材」而不是「LLM 配置错」：不要把提示写成配置报错，
                    // 否则用户会误以为本地端点没生效
                    return {ads:[], msg:"该视频没有字幕；音频识别需填阿里云 Key（可在设置中填写，或关闭“启用音频分析”）"};
                }
                let aliModel;
                try {
                    const v2Usage = await getLocalAliUsage(settings.aliApiKey, "paraformer-v2");
                    if (v2Usage.remaining > 0) {
                        aliModel = "paraformer-v2";
                    } else {
                        const v1Usage = await getLocalAliUsage(settings.aliApiKey, "paraformer-v1");
                        if (v1Usage.remaining > 0) {
                            aliModel = "paraformer-v1";
                            showPopup("paraformer-v2 额度已用完，改用 paraformer-v1.");
                        }
                    }
                } catch (error) {
                    styleLog("Failed to read Paraformer remaining quota: " + error.message);
                    return {ads:[], msg:"无法读取 Paraformer 剩余额度，已停止音频分析."};
                }
                if (!aliModel) {
                    showPopup("paraformer-v2 和 v1 剩余额度均为 0，已停止音频分析.");
                    return {ads:[], msg:"Paraformer 剩余额度均为 0，未调用音频识别."};
                }
                if (settings.autoAudio)  {
                    popups.others.push(showPopup("01:00 后解锁音频分析."));
                    while(document.querySelector('video').currentTime < 45) {
                        if(window.location.pathname.split('/')[2] !== bvid || new URLSearchParams(window.location.search).get('p') !== pvid) {
                            return {ads:[], msg:"上下文已切换."};
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    //await new Promise(resolve => setTimeout(resolve, document.querySelector('video').currentTime < 60 ? (60 - document.querySelector('video').currentTime) * 1000 : 0));
                } else if(!await checkPopup()) {
                    return {ads:[], msg:"用户拒绝音频分析, 识别结束."};
                }

                popups.others.push(showPopup("使用音频分析."));
                response = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}&cid=${cid}&qn=0&fnver=0&fnval=80&fourk=1`, {
                    credentials: "include"
                });
                const playerData = await response.json(), audioUrl = playerData?.data?.dash?.audio?.[0]?.base_url;

                if(!audioUrl) {
                    return {ads:[], msg:"获取不到音频文件."};
                }
                popups.others.push(showPopup("提交音频文件."));
                styleLog("audioUrl: " + audioUrl);
                const ossAudioUrl = await uploadAudioToDashScope(audioUrl, aliModel);
                const taskId = await submitTranscriptionTask(ossAudioUrl, aliModel);
                styleLog("Task submitted successfully, Task ID: " + taskId);

                popups.others.push(showPopup("等待音频分析结果."));
                const results = await waitForTaskCompletion(taskId, aliModel);

                for (const result of results) {
                    if (result.subtask_status === "SUCCEEDED") {
                        const transcription = await fetchTranscription(result.transcription_url);
                        subtitle = generateSubtitle(transcription);

                        resultS = await chrome.storage.local.get('subtitle');
                        const updatedSubtitles = {
                          ...(resultS.subtitle || {}),
                          [cid]: subtitle
                        };
                        await chrome.storage.local.set({subtitle: updatedSubtitles});
                        //styleLog("Subtitle content:\n", subtitle);
                    } else {
                        styleLog(`Subtask failed for file ${result.file_url}, status: ${result.subtask_status}`);
                        if(result.code === "SUCCESS_WITH_NO_VALID_FRAGMENT") {
                            return {ads:[], msg:"音频无有效片段."};
                        } else {
                            return {ads:[], msg:`音频解析失败：${result.message}`};
                        }
                    }
                }
            }
        }

        if (!subtitle) {
            return {
                ads: [],
                msg: settings.audioEnabled
                    ? "未取到字幕或音频文本，已跳过"
                    : "该视频没有字幕，且未启用音频识别，已跳过"
            };
        }

        subtitle = `标题: ${title}

内容:

` + subtitle;

        // ① 云端优先：大模型判断最准，配了就用它先跑
        let resultAD = null, usedModel = "", total_tokens = 0;
        let cloudBlocked = null, cloudSkipped = "";
        if (!alive()) return null;

        // 本地分析立刻开跑、与云端并行：云端失败或被拦时，兜底结果已经算好，不必再等一轮
        const builtinPromise = settings.useBuiltinAdModel !== false && typeof BJSModels !== "undefined"
            ? (async () => {
                try {
                    const video = document.querySelector("video");
                    return await BJSModels.analyzeAds(subtitle, {
                        duration: video?.duration || 0,
                        threshold: settings.decisionThreshold,
                        useWebGPU: settings.useWebGPU !== false
                    });
                } catch (error) {
                    styleLog("内置模型不可用: " + error.message);
                    return null;
                }
            })()
            : Promise.resolve(null);

        // 云端跑不起来的三种原因：没配置 / 模型被禁 / 该视频字幕已被审核拦过
        if (settings.useCloudAI === false) {
            cloudSkipped = "已关闭云端识别";
        } else {
            const missing = ["apiKey", "apiURL"].filter(key => !settings[key]);
            if (!settings.apiModel && !isLocalAPI()) missing.push("apiModel");
            if (missing.length) {
                cloudSkipped = `未配置 ${missing[0]}`;
            } else if (banModels.includes(settings.apiModel)) {
                cloudSkipped = `${settings.apiModel} 在禁用名单`;
            } else if (SKIP_STATE.blockedCids.has(String(cid))) {
                // 同一 session 里重问只会拿到同一个审核结论
                cloudBlocked = "内容安全审核";
            }
            if (cloudSkipped) styleLog(`云端跳过：${cloudSkipped}，改用本地分析`);
            if (cloudBlocked) styleLog(`CID: ${cid}, 本次会话内已被审核拦截，改用本地分析`);
        }

        if (!cloudSkipped && !cloudBlocked) {

            // 必须用局部引用关自己那张卡片：popups.ai 是全局单槽，
            // 两个会话并发时互相覆盖，会导致关闭到别人的卡片、自己的卡片永久残留
            const aiPopup = showPopup("AI 分析中...", 1);
            popups.ai = aiPopup;
            popups.others.push(aiPopup);

            // 一分钟还没出结果就别再把"AI 分析中"挂在播放器上；请求仍在后台跑
            const aiWatchdog = setTimeout(() => {
                if (!aiPopup.isConnected) return;
                closePopup(aiPopup);
                if (popups.ai === aiPopup) popups.ai = null;
                note("分析超过 1 分钟，已隐藏进度提示（仍在后台进行）");
            }, AI_POPUP_HIDE_MS);

            try {
                let data, aiResponse;
                const startedAt = Date.now();
                for (let i = 0; i < 3 && !resultAD; i++) {
                    if (!alive()) break;
                    // 已经折腾太久就收手，避免三连超时把播放页拖住好几分钟
                    if (Date.now() - startedAt > ANALYSIS_DEADLINE_MS) {
                        note("分析耗时过长，已停止本次云端识别");
                        break;
                    }
                    data = await callOpenAI(subtitle, { retry: i > 0 });
                    aiResponse = data?.choices?.[0]?.message?.content;
                    total_tokens = data?.usage?.total_tokens;

                    if (!data) break;
                    if (!aiResponse) {
                        showPopup("AI 解析失败.");
                        showPopup('Re-fetch AI.');
                        continue;
                    }

                    // 审核结论不是广告判定：同一段字幕重试只会得到同一个结论，直接收手
                    const safety = typeof BJSModels !== "undefined" && BJSModels.detectSafetyVerdict
                        ? BJSModels.detectSafetyVerdict(aiResponse)
                        : null;
                    if (safety) {
                        cloudBlocked = safety.categories || safety.status || "内容安全审核";
                        SKIP_STATE.blockedCids.add(String(cid));
                        // 只写日志：结论文案由下方统一返回，避免同一原因连弹两次
                        styleLog(`CID: ${cid}, 云端返回安全审核结论（${cloudBlocked}），已停止重试`);
                        break;
                    }

                    // 模型可能把推理过程一起吐出来，走带括号配对的提取器，而不是裸 JSON.parse
                    resultAD = typeof BJSModels !== "undefined"
                        ? BJSModels.extractJson(aiResponse)
                        : null;
                    if (!resultAD) {
                        styleLog(`CID: ${cid}, 响应中未找到合法 JSON, resp: ${String(aiResponse).slice(0, 300)}`);
                        showPopup("AI 返回内容不是合法 JSON，正在重试.");
                        continue;
                    }
                }
                if (resultAD) usedModel = settings.apiModel;
            } finally {
                clearTimeout(aiWatchdog);
                closePopup(aiPopup);
                if (popups.ai === aiPopup) popups.ai = null;
            }
        }

        // ② 云端没给出结论，或云端说「没广告」但本地明确命中时，用内置模型兜底
        if (!resultAD || !resultAD.ads.length) {
            const builtin = await builtinPromise;
            const cloudSaidNone = Boolean(resultAD);
            // 云端说没有、本地说有：只在本地置信度够高时才推翻云端，避免词表误报
            if (builtin && (!cloudSaidNone || Number(builtin.confidence) >= 0.6)) {
                if (cloudSaidNone) {
                    styleLog(`云端判无广告，本地命中 ${builtin.ads.length} 段（置信度 ${builtin.confidence}），采用本地结果`);
                }
                resultAD = builtin;
                usedModel = builtin.model;
                popups.others.push(showPopup(`内置模型：${builtin.ads.length} 段，置信度 ${builtin.confidence}`));
            } else if (!cloudSaidNone && settings.useBuiltinAdModel !== false && typeof BJSModels !== "undefined") {
                styleLog("内置模型未发现广告段落");
            }
        }

        // ③ 云端与本地都没有结论时，最后试一次弹幕信号（弱证据，不写库）
        if (!resultAD) {
            const dm = await detectByDanmaku(cid, bvid, pvid);
            if (dm) return dm;
        }

        if (!resultAD || !resultAD?.ads || !resultAD?.msg) {
            const reason = cloudBlocked
                ? `云端拒绝了这段字幕（${cloudBlocked}）`
                : cloudSkipped ? `云端未参与（${cloudSkipped}）` : "云端未给出结论";
            return { ads: [], msg: `${reason}，本地分析也未发现广告` };
        }
        // 会话已被新页面取代时，不要再写库、不要动 UI
        if (!alive()) return null;

        // 云端读的是文本不是时间轴，起止点常落在句子中间；吸附到句边界（只在同一句内扩，不跨句）
        if (resultAD.ads.length && typeof BJSModels !== "undefined" && BJSModels.snapIntervalsToCues) {
            const cues = BJSModels.parseSubtitle(subtitle);
            if (cues.length) {
                const snapped = BJSModels.snapIntervalsToCues(resultAD.ads, cues, { maxExtend: 4 });
                if (Array.isArray(snapped)) resultAD = Object.assign({}, resultAD, { ads: snapped });
            }
        }

        styleLog(`CID: ${cid}, data: ${JSON.stringify(resultAD)}`);
        const cachedSubtitle = type === '音频' ? subtitle : '';
        chrome.runtime.sendMessage({
            action: "dbQuery", url: settings.cfApiURL, method: "POST", cfApiKey: settings.cfApiKey,
            body: {
                sql: `INSERT INTO bilijump (aid, bid, cid, data, subtitle, title, type, model, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cid) DO UPDATE SET data = excluded.data, subtitle = excluded.subtitle;`,
                params: [aid, bvid, cid, JSON.stringify(resultAD), cachedSubtitle, title, type, usedModel, total_tokens]
            }
        });

        correctButton(cid, resultAD, bvid, pvid);
        writeCachedResult(bvid, pvid, cid, resultAD);
        resultS = await chrome.storage.local.get('subtitle');
        if (resultS?.subtitle?.hasOwnProperty(cid)) {
            delete resultS.subtitle[cid];
            await chrome.storage.local.set({ subtitle: resultS.subtitle });
        }
        return resultAD;
    } catch (error) {
        showPopup("Error: " + JSON.stringify(error));
        if(popups.audioCheck) closePopup(popups.audioCheck);
        if(popups.task) closePopup(popups.task);
        if(popups.ai) closePopup(popups.ai);
        return null;
    }
}

async function getReRecognitionSubtitle(aid, cid, title) {
    const playerResponse = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, {
        credentials: "include"
    });
    if (!playerResponse.ok) throw new Error(`获取视频字幕失败: ${playerResponse.status}`);

    const playerData = await playerResponse.json();
    const subtitleUrl = playerData.data?.subtitle?.subtitles?.[0]?.subtitle_url;
    if (subtitleUrl) {
        const resolvedUrl = subtitleUrl.startsWith('//') ? `https:${subtitleUrl}` : subtitleUrl;
        const subtitleResponse = await fetch(resolvedUrl);
        if (!subtitleResponse.ok) throw new Error(`下载视频字幕失败: ${subtitleResponse.status}`);
        const subtitleData = await subtitleResponse.json();
        const subtitle = (subtitleData.body || [])
            .map(item => `${item.from} --> ${item.to}\n${item.content}\n`)
            .join('');
        if (subtitle) {
            showPopup("使用视频字幕重新分析.");
            return `标题: ${title}\n\n内容:\n\n${subtitle}`;
        }
    }

    const localResult = await chrome.storage.local.get('subtitle');
    const localSubtitle = localResult?.subtitle?.[cid];
    if (localSubtitle) {
        showPopup("使用本地音频缓存重新分析.");
        return `标题: ${title}\n\n内容:\n\n${localSubtitle}`;
    }

    const dbResults = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            action: "dbQuery",
            url: settings.cfApiURL,
            method: "POST",
            cfApiKey: settings.cfApiKey,
            body: {sql: "SELECT subtitle FROM bilijump WHERE cid = ? LIMIT 1;", params: [cid]}
        }, response => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (response?.success) {
                resolve(response?.data?.result?.[0]?.results?.[0]);
            } else {
                reject(new Error(response?.error || "读取音频缓存失败"));
            }
        });
    });
    if (dbResults?.subtitle) {
        showPopup("使用云端音频缓存重新分析.");
        return dbResults.subtitle;
    }

    throw new Error("未找到视频字幕或音频缓存");
}

async function callOpenAI(subtitle, options = {}) {
    const promptText = (typeof BJS !== "undefined" ? await BJS.getPrompt() : "") ||
        (await chrome.storage.sync.get('prompt')).prompt;
    const messages = [
        { role: "system", content: promptText },
        { role: "user", content: subtitle }
    ];

    // 推理型模型常常把思考过程当正文吐出来，第一次调用拿不到 JSON。
    // 重试时追加一条明确约束，把输出拉回纯 JSON，避免每次都白烧一次请求。
    if (options.retry) {
        messages.push({
            role: "user",
            content: "上一次回复只有推理过程、没有 JSON，无法解析。请只输出一个 JSON 对象，形如 "
                + "{\"ads\":[{\"start_time\":\"12.5\",\"end_time\":\"30.0\",\"product_name\":\"产品名\",\"ad_content\":\"一句话描述\"}],"
                + "\"msg\":\"识别到广告\"}，不要输出任何解释、思考或 Markdown。"
        });
    }

    const requestData = {
        model: settings.apiModel,
        max_tokens: 8192,
        json_mode: options.jsonMode !== false, // 让后端优先走 response_format，不支持时自动降级
        messages
    };

    const response = await new Promise(resolve => {
        chrome.runtime.sendMessage({
            action: "fetchOpenAI",
            body: requestData
        }, result => {
            resolve(chrome.runtime.lastError
                ? {success: false, error: chrome.runtime.lastError.message}
                : result);
        });
    });

    if (!response?.success) {
        const errorMessage = response?.error || "Unknown error";
        if (errorMessage.startsWith("Missing API access permission for ")) {
            const origin = errorMessage.match(/^Missing API access permission for (.+?)\. Grant it/)?.[1];
            showPopup(origin ? `请为 API 地址 ${origin} 进行授权。` : "请为 API 地址进行授权。");
            chrome.runtime.sendMessage({action: "openApiSettings", origin});
        } else {
            // 上游 502 的解释可能长达几百字，播放器里放不下；去重前缀 + 截断
            const text = String(errorMessage).replace(/\s+/g, " ").trim();
            const message = /^API\s*(请求失败|request failed)/i.test(text) ? text : "API 请求失败：" + text;
            showPopup(message.length > 160 ? message.slice(0, 160) + "…" : message);
        }
        return null;
    }
    const data = response.data;
    if (data.error?.message) {
        showPopup("API error: " + data.error.message);
        return null;
    }

    return data;
}

let popupCount = 0;

function closePopup(popup) {
    if (!popup) return;
    // 元素可能已被 teardown 移除，此处必须幂等：重复关闭不能把 popupCount 扣成负数
    const connected = popup.isConnected;
    popup.remove();
    for (const key in popups) {
        if (key === 'ads') continue;
        if (popups[key] === popup) popups[key] = null;
    }
    popups.ads = popups.ads.filter(item => item !== popup);
    popups.others = popups.others.filter(item => item !== popup);
    if (connected) popupCount = Math.max(0, popupCount - 1);
    adjustPopupPositions();
}

async function checkPopup() {
    const userChoice = await new Promise((resolve) => {
        const popup = document.createElement('div');
        popup.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; height: 100%;">
                <div style="font-weight: bold; font-size: 16px; margin-bottom: 10px;">没有可识别字幕</div>
                <div style="font-size: 14px; margin-bottom: 15px;">是否启用音频分析? 音频分析大约需要一分钟。</div>
                <div style="display: flex; gap: 10px;">
                    <button id="yes-button" style="padding: 5px 15px; background: #1a73e8; color: #fff; border: none; border-radius: 4px; cursor: pointer;">是(y)</button>
                    <button id="no-button" style="padding: 5px 15px; background: #ccc; color: #333; border: none; border-radius: 4px; cursor: pointer;">否(n)</button>
                </div>
            </div>
        `;
        popup.style.position = 'absolute';
        popup.style.bottom = '90px';
        popup.style.right = '30px';
        popup.style.width = '300px';
        popup.style.padding = '15px';
        popup.style.background = 'linear-gradient(135deg, rgba(0, 0, 0, 0.3), rgba(50, 50, 50, 0.5))';
        popup.style.color = '#fff';
        popup.style.borderRadius = '8px';
        popup.style.boxShadow = '0 4px 10px rgba(0, 0, 0, 0.3)';
        popup.style.zIndex = '1000';
        popup.style.fontFamily = 'Arial, sans-serif';
        popup.style.lineHeight = '1.5';

        popup.addEventListener('mouseenter', function() {
            popup.style.background = 'linear-gradient(135deg, rgba(0, 0, 0, 0.5), rgba(50, 50, 50, 7))';
        });
        popup.addEventListener('mouseleave', function() {
            popup.style.background = 'linear-gradient(135deg, rgba(0, 0, 0, 0.3), rgba(50, 50, 50, 0.5))';
        });

        const playerContainer = document.querySelector('.bpx-player-container');
        if (playerContainer) {
            playerContainer.appendChild(popup);
        } else {
            console.info('Player container not found.');
            resolve(false);
            return;
        }

        popup.querySelector('#yes-button').addEventListener('click', () => {
            popup.remove();
            resolve(true);
        });
        popup.querySelector('#no-button').addEventListener('click', () => {
            popup.remove();
            resolve(false);
        });
        popups.audioCheck = popup;
        //popups.others.push(popups.audioCheck);
    })
    return userChoice;
}

function showPopup(msg,persist) {
    styleLog(msg);
    var popup = document.createElement('div');
    popup.innerText = msg;
    popup.style.position = 'absolute';
    popup.style.bottom = `${80 + popupCount * 60}px`;
    popup.style.right = '10px';
    popup.style.padding = '10px';
    popup.style.background = 'linear-gradient(135deg, rgba(0, 0, 0, 0.3), rgba(50, 50, 50, 0.5))';
    popup.style.color = '#fff';
    popup.style.borderRadius = '5px';
    popup.style.zIndex = '1000';
    popup.classList.add('popup');

    // 播放器容器可能尚未渲染（首屏延迟加载），退化为挂到 body，避免提示直接丢失
    var playerContainer = document.querySelector('.bpx-player-container');
    var host = playerContainer;
    if (!host) {
        host = document.body;
        popup.style.position = 'fixed';
        popup.style.bottom = `${24 + popupCount * 40}px`;
        popup.style.right = '16px';
    }
    host.appendChild(popup);
    popupCount++;

    adjustPopupPositions();
    if (!persist) {
        setTimeout(function() {
            closePopup(popup);
        }, 7000);
    }
    return popup;
}

function getVideoElement() {
    return document.querySelector('video');
}

function secondsToTime(seconds, forceHours = false) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '--:--';
    seconds = Math.floor(seconds);
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0 || forceHours) {
        return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

let isSettingTime = false;
let targetSegmentElement = null;
let targetTimeType = null;
let progressClickListener = null;
let activeTimeSettingButton = null; 

function showCorrectionPopup(cid, currentAdsData) {
    const existingPopup = document.getElementById('bilibili-ai-skip-correction-popup');
    if (existingPopup) {
        closePopup(existingPopup);
        return;
    }

    const cancelTimeSelectionMode = () => {
        if (!isSettingTime) return;

        const progressBar = document.querySelector('.bpx-player-progress-wrap');
        const timeSelectionStatus = document.getElementById('time-selection-status');

        if (progressBar && progressClickListener) {
            progressBar.removeEventListener('click', progressClickListener);
            progressBar.style.cursor = '';
            styleLog("Bilibili AI Skip: Removed progress bar click listener.");
        }

        if (activeTimeSettingButton) {
            const isStartButton = activeTimeSettingButton.classList.contains('set-start-time');
            activeTimeSettingButton.textContent = isStartButton ? 'Set Start' : 'Set End';
            styleLog(`Bilibili AI Skip: Reset button text for ${isStartButton ? 'start' : 'end'} time.`);
        }

        if (timeSelectionStatus) {
             timeSelectionStatus.textContent = '';
             timeSelectionStatus.style.display = 'none';
             styleLog("Bilibili AI Skip: Cleared and hid time selection status.");
        }

        isSettingTime = false;
        targetSegmentElement = null;
        targetTimeType = null;
        progressClickListener = null;
        activeTimeSettingButton = null;
        styleLog("Bilibili AI Skip: Time selection mode cancelled.");
    };

    const popup = document.createElement('div');
    popup.id = 'bilibili-ai-skip-correction-popup';
    popup.innerHTML = `
        <div style="display: flex; flex-direction: column; height: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <span style="font-weight: bold; font-size: 18px;">人工纠错</span>
                <button id="close-correction-popup" style="background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; line-height: 1;">×</button>
            </div>
            <div id="time-selection-status" style="min-height: 20px; text-align: center; color: #ffeb3b; margin-bottom: 10px; font-size: 13px; display: none;"></div>
            <div id="ad-segments-container" style="min-height: 100px; max-height: 350px; overflow-y: auto; margin-bottom: 15px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; padding: 10px;">
                <div id="ad-segments"></div>
                <div id="empty-state" style="text-align: center; color: #ccc; padding: 20px; display: none;">当前未识别到广告片段。<br>您可以手动添加。</div>
            </div>
            <div style="display: flex; gap: 10px; justify-content: space-between; margin-top: 5px;">
                <button id="ai-re-recog" style="flex-basis: 25%; padding: 8px; background: #a19cef; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">AI重新识别</button>
                <button id="add-segment" style="flex-basis: 25%; padding: 8px; background: #4caf50; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">增加片段</button>
                <button id="confirm-no-ads" style="flex-basis: 25%; padding: 8px; background: #ff9800; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">无广告</button>
                <button id="submit-button" style="flex-basis: 25%; padding: 8px; background: #1a73e8; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">提交</button>
            </div>
        </div>
    `;
    popup.style.position = 'absolute';
    popup.style.bottom = '120px';
    popup.style.right = '30px';
    popup.style.width = '420px';
    popup.style.padding = '20px';
    popup.style.background = 'linear-gradient(135deg, rgba(0, 0, 0, 0.6), rgba(50, 50, 50, 0.8))';
    popup.style.color = '#fff';
    popup.style.borderRadius = '12px';
    popup.style.boxShadow = '0 6px 12px rgba(0, 0, 0, 0.4)';
    popup.style.zIndex = '50';
    popup.style.fontFamily = '"Arial", sans-serif';
    popup.style.lineHeight = '1.6';
    popup.style.backdropFilter = 'blur(8px)';


    const playerContainer = document.querySelector('.bpx-player-container');
    if (!playerContainer) {
        showPopup('错误：无法找到播放器容器');
        return;
    }
    playerContainer.appendChild(popup);
    if (popups?.others) {
         popups.others.push(popup);
    } else {
         console.warn("Bilibili AI Skip: popups.others array not found. Popup management might be affected.");
    }

    const adSegmentsContainer = popup.querySelector('#ad-segments');
    const emptyStateDiv = popup.querySelector('#empty-state');
    const timeSelectionStatus = popup.querySelector('#time-selection-status');

     const enterTimeSelectionMode = (segmentElement, timeType, buttonElement) => {
        if (isSettingTime && activeTimeSettingButton === buttonElement) {
            styleLog(`Bilibili AI Skip: Re-clicked the active setting button. Cancelling selection.`);
            cancelTimeSelectionMode();
            return;
        }

        if (isSettingTime) {
            styleLog("Bilibili AI Skip: Switching time selection target. Cancelling previous mode.");
            cancelTimeSelectionMode();
        }

        const video = getVideoElement();
        const progressBar = document.querySelector('.bpx-player-progress-wrap');

        if (!video || !progressBar) {
            showPopup('错误：无法找到视频或进度条');
            styleLog("Bilibili AI Skip: Video or progress bar element not found for time setting.");
            return;
        }

        isSettingTime = true;
        targetSegmentElement = segmentElement;
        targetTimeType = timeType;
        activeTimeSettingButton = buttonElement;

        buttonElement.textContent = 'Setting...';
        timeSelectionStatus.textContent = `请点击播放器进度条以设置${timeType === 'start' ? '开始' : '结束'}时间`;
        timeSelectionStatus.style.display = 'block';
        progressBar.style.cursor = 'crosshair';
        progressClickListener = (event) => {
            const rect = progressBar.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const barWidth = progressBar.offsetWidth;
            const duration = video.duration;

            if (!isNaN(duration) && duration > 0 && barWidth > 0) {
                const clickedTime = Math.max(0, Math.min(duration, (offsetX / barWidth) * duration));
                const timeDisplaySpan = segmentElement.querySelector(timeType === 'start' ? '.start-time-display' : '.end-time-display');
                if (timeDisplaySpan) {
                     timeDisplaySpan.textContent = secondsToTime(clickedTime);
                     segmentElement.setAttribute(`data-${timeType}-seconds`, clickedTime.toFixed(3));
                     console.log(`Bilibili AI Skip: Set ${timeType} time to ${clickedTime.toFixed(3)}s (${secondsToTime(clickedTime)})`);
                     if(timeType === 'start') {
                        segmentElement.dataset.sortTime = clickedTime.toFixed(3);
                     }
                } else {
                     console.info("Bilibili AI Skip: Time display span not found for", timeType);
                }
                video.currentTime = clickedTime;
                cancelTimeSelectionMode();

            } else {
                console.warn("Bilibili AI Skip: Could not calculate time. Duration or bar width invalid.", {duration, barWidth});
                showPopup("无法获取时间，请确保视频已加载");
            }
        };

        progressBar.addEventListener('click', progressClickListener);
    };

    function addAdSegment(ad = { start_time: null, end_time: null, product_name: '', ad_content: '' }) {
        const segment = document.createElement('div');
        segment.className = 'ad-segment';
        segment.style.marginBottom = '15px';
        segment.style.padding = '15px';
        segment.style.background = 'rgba(255, 255, 255, 0.1)';
        segment.style.borderRadius = '8px';
        segment.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        segment.style.position = 'relative';

        const startTimeSeconds = (ad.start_time !== null && !isNaN(parseFloat(ad.start_time))) ? parseFloat(ad.start_time) : null;
        const endTimeSeconds = (ad.end_time !== null && !isNaN(parseFloat(ad.end_time))) ? parseFloat(ad.end_time) : null;

        segment.setAttribute('data-start-seconds', startTimeSeconds !== null ? startTimeSeconds.toFixed(3) : '');
        segment.setAttribute('data-end-seconds', endTimeSeconds !== null ? endTimeSeconds.toFixed(3) : '');
        segment.dataset.sortTime = startTimeSeconds !== null ? startTimeSeconds.toFixed(3) : Infinity;

        segment.innerHTML = `
            <button class="remove-segment" style="position: absolute; top: 8px; right: 8px; padding: 2px 6px; background: #f44336; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1;">删除</button>
            <div style="display: flex; gap: 10px; margin-bottom: 10px; align-items: center;">
                <div style="flex: 1; text-align: center;">
                    <label style="font-size: 13px; display: block; margin-bottom: 5px;">开始时间</label>
                    <span class="start-time-display" style="font-size: 16px; font-weight: bold; color: #a0ffa0; display: block; margin-bottom: 5px; border: 2px solid transparent; padding: 2px 4px; border-radius: 3px;">${secondsToTime(startTimeSeconds)}</span>
                    <button class="set-start-time" style="padding: 4px 8px; background: #03a9f4; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Set Start</button>
                </div>
                <div style="width: 20px; text-align: center; font-size: 16px;">→</div>
                <div style="flex: 1; text-align: center;">
                    <label style="font-size: 13px; display: block; margin-bottom: 5px;">结束时间</label>
                    <span class="end-time-display" style="font-size: 16px; font-weight: bold; color: #ffa0a0; display: block; margin-bottom: 5px; border: 2px solid transparent; padding: 2px 4px; border-radius: 3px;">${secondsToTime(endTimeSeconds)}</span>
                    <button class="set-end-time" style="padding: 4px 8px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Set End</button>
                </div>
            </div>
            <div class="mini-progress" style="height: 6px; background: rgba(255,255,255,0.3); border-radius: 3px; margin-bottom: 10px; position: relative; overflow: hidden;">
                <div class="mini-progress-indicator" style="position: absolute; height: 100%; background: #ffeb3b; left: 0%; width: 0%;"></div>
            </div>
            <label style="margin-bottom: 5px; font-size: 13px; display: block;">产品名称:</label>
            <input type="text" class="product-name" style="width: 100%; margin-bottom: 10px; padding: 8px; color: #000; background: #fff; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; box-sizing: border-box;" value="${ad.product_name || ''}">
            <label style="margin-bottom: 5px; font-size: 13px; display: block;">广告内容:</label>
            <textarea class="ad-content-textarea" style="width: 100%; height: 60px; padding: 8px; color: #000; background: #fff; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; box-sizing: border-box; resize: vertical;">${ad.ad_content || ''}</textarea>
        `;

        const updateMiniProgress = () => {
             const video = getVideoElement();
             if (!video || !video.duration || isNaN(video.duration) || video.duration <= 0) return;
             const duration = video.duration;
             const startAttr = segment.getAttribute('data-start-seconds');
             const endAttr = segment.getAttribute('data-end-seconds');
             const indicator = segment.querySelector('.mini-progress-indicator');

             if (!indicator) return;

             const start = (startAttr && !isNaN(parseFloat(startAttr))) ? parseFloat(startAttr) : null;
             const end = (endAttr && !isNaN(parseFloat(endAttr))) ? parseFloat(endAttr) : null;

             if (start !== null && end !== null && end > start) {
                 const leftPercent = (start / duration) * 100;
                 const widthPercent = ((end - start) / duration) * 100;
                 indicator.style.left = `${Math.max(0, leftPercent)}%`;
                 indicator.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
             } else {
                 indicator.style.left = '0%';
                 indicator.style.width = '0%';
             }
        };

        updateMiniProgress();
        const observer = new MutationObserver(mutations => {
             if (mutations.some(m => m.attributeName === 'data-start-seconds' || m.attributeName === 'data-end-seconds')) {
                  updateMiniProgress();
             }
        });
        observer.observe(segment, {
            attributes: true, attributeFilter: ['data-start-seconds', 'data-end-seconds']
        });
        const videoElem = getVideoElement();
        if (videoElem) {
            if (videoElem.readyState >= 1) {
                updateMiniProgress();
            } else {
                 videoElem.addEventListener('loadedmetadata', updateMiniProgress, {once: true});
            }
        }

        const sortSegmentsVisually = () => {
            const segments = Array.from(adSegmentsContainer.children).filter(el => el.classList.contains('ad-segment'));
            segments.sort((a, b) => {
                const timeA = parseFloat(a.dataset.sortTime ?? Infinity);
                const timeB = parseFloat(b.dataset.sortTime ?? Infinity);
                return timeA - timeB;
            });
            segments.forEach(seg => adSegmentsContainer.appendChild(seg));
        }

        adSegmentsContainer.appendChild(segment);
        sortSegmentsVisually();

        segment.querySelector('.remove-segment').addEventListener('click', () => {
            if(targetSegmentElement === segment) {
                cancelTimeSelectionMode();
            }
            segment.remove();
            observer.disconnect();
             const videoElem = getVideoElement();
             if (videoElem) videoElem.removeEventListener('loadedmetadata', updateMiniProgress);
            checkEmptyState();
        });

        const setStartButton = segment.querySelector('.set-start-time');
        setStartButton.addEventListener('click', () => {
            enterTimeSelectionMode(segment, 'start', setStartButton);
        });

        const setEndButton = segment.querySelector('.set-end-time');
        setEndButton.addEventListener('click', () => {
            enterTimeSelectionMode(segment, 'end', setEndButton);
        });

        checkEmptyState();
    }

    function checkEmptyState() {
        const segmentCount = adSegmentsContainer.children.length;
        emptyStateDiv.style.display = segmentCount === 0 ? 'block' : 'none';
    }

    const initialAds = (currentAdsData && currentAdsData.ads ? currentAdsData.ads : [])
        .map(ad => ({
            start_time: !isNaN(parseFloat(ad.start_time)) ? parseFloat(ad.start_time) : null,
            end_time: !isNaN(parseFloat(ad.end_time)) ? parseFloat(ad.end_time) : null,
            product_name: ad.product_name,
            ad_content: ad.ad_content
        }));
    initialAds.forEach(ad => addAdSegment(ad));
    checkEmptyState();

    popup.querySelector('#add-segment').addEventListener('click', () => {
        addAdSegment();
    });

    popup.querySelector('#close-correction-popup').addEventListener('click', () => {
        cancelTimeSelectionMode();
        closePopup(popup);
    });

    async function submitCorrection(adsData, message, model, allowUnchanged = false) {
        cancelTimeSelectionMode();
        if (typeof settings === 'undefined' || !settings.cfApiURL || !settings.cfApiKey) {
            showPopup("提交失败：无法访问配置");
            return;
        }

        if (!allowUnchanged && JSON.stringify(adsData) == JSON.stringify(currentAdsData)) {
            const submitButton = popup.querySelector('#submit-button');
            if(submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = '提交';
            }
            showPopup("数据无变化");
            return; 
        }

        try {
            await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    action: "dbQuery",
                    url: settings.cfApiURL,
                    method: "POST",
                    cfApiKey: settings.cfApiKey,
                    body: {
                        sql: `UPDATE bilijump SET data = ?, model = ? WHERE cid = ?;`,
                        params: [JSON.stringify(adsData), model, cid]
                    }
                }, response => {
                    if (chrome.runtime.lastError) {
                         console.info("Bilibili AI Skip: chrome.runtime.lastError:", chrome.runtime.lastError.message);
                         reject(new Error(chrome.runtime.lastError.message || 'Unknown background script error'));
                    } else if (response && response.success) {
                         styleLog('Bilibili AI Skip: Database update successful for correction.');
                         resolve();
                    } else {
                         const errorMsg = (response && response.error) ? response.error : 'Unknown background error';
                         console.info("Bilibili AI Skip: Correction submission error -", errorMsg);
                         reject(new Error(errorMsg));
                    }
                });
            });

            showPopup(message);
            styleLog('Bilibili AI Skip: Correction submitted successfully.');
            closePopup(popup);
            showPopup("页面将在3秒后刷新...");
            setTimeout(() => { location.reload(); }, 3000);
        } catch (error) {
             showPopup('提交失败：' + error.message);
             console.info('Bilibili AI Skip: Submission failed:', error);
        }
    }

    popup.querySelector('#ai-re-recog').addEventListener('click', async () => {
        if (window.confirm("您确定使用 AI 重新识别广告吗？这将覆盖之前的记录。")) {
            try {
                const missing = ["apiKey", "apiURL"].filter(key => !settings[key]);
                if (!settings.apiModel && !isLocalAPI()) missing.push("apiModel");
                if (missing.length) {
                    note(`Please set ${missing[0]} in extension settings`);
                    return;
                }

                if (banModels.includes(settings.apiModel)) {
                    showPopup(`禁用 ${settings.apiModel} 模型，效果太差`);
                    return;
                }

                let bvid = window.location.pathname.split('/')[2], pvid = new URLSearchParams(window.location.search).get('p');
                if(bvid == 'watchlater') bvid = new URLSearchParams(window.location.search).get('bvid');
                let response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {credentials: "include"});
                if (!response.ok) throw new Error(`获取视频信息失败: ${response.status}`);
                const videoData = await response.json();
                const aid = videoData.data?.aid;
                const cid = videoData.data?.pages?.[pvid ? pvid - 1 : pvid]?.cid || videoData.data?.cid;
                const title = videoData.data?.title || document.title;
                if (!aid || !cid) throw new Error("获取视频信息失败");

                popups.others.push(showPopup("重新获取视频字幕/音频缓存..."));
                const subtitle = await getReRecognitionSubtitle(aid, cid, title);

                const rePopup = showPopup(`使用 ${settings.apiModel} 重新分析中...`, 1);
                popups.ai = rePopup;
                popups.others.push(rePopup);
                const reWatchdog = setTimeout(() => {
                    if (!rePopup.isConnected) return;
                    closePopup(rePopup);
                    if (popups.ai === rePopup) popups.ai = null;
                    styleLog("重新识别超过 1 分钟，已隐藏进度提示");
                }, AI_POPUP_HIDE_MS);

                let data = await callOpenAI(subtitle), aiResponse = data?.choices?.[0]?.message?.content, total_tokens = data?.usage?.total_tokens;
                for(let i = 1; i < 3 && !aiResponse; i++) {
                    showPopup('Re-fetch AI.');
                    data = await callOpenAI(subtitle, { retry: true });
                    if (!data) break;
                    aiResponse = data.choices?.[0]?.message?.content;
                    total_tokens = data.usage?.total_tokens;
                }
                clearTimeout(reWatchdog);
                closePopup(rePopup);
                if (popups.ai === rePopup) popups.ai = null;


                if (!aiResponse) {
                    showPopup("AI 解析失败.");
                    return
                }

                const jsonMatch = aiResponse.match(/```json([\s\S]*?)```/);
                let resultAD;
                if (jsonMatch && jsonMatch[1]) {
                    const jsonContent = jsonMatch[1].trim();
                    resultAD = JSON.parse(jsonContent);
                }else {
                    try {
                        resultAD = JSON.parse(aiResponse);
                    } catch (error) {
                        showPopup("AAI 分析结果获取失败. " + error);
                        return
                    }
                }

                await submitCorrection(resultAD, '重新识别已完成.', settings.apiModel, true);
            } catch (error) {
                closePopup(popups.ai);
                showPopup("重新识别失败: " + error.message);
                styleLog("AI re-recognition error: " + error.message);
            }
        } else {
            showPopup('取消提交');
        }
    });

    popup.querySelector('#confirm-no-ads').addEventListener('click', () => {
        if (window.confirm("您确定这个视频没有广告内容吗？这将覆盖之前的记录。")) {
             const noAdsData = {
                 ads: [],
                 msg: "未识别到广告"
             };
             submitCorrection(noAdsData, '已提交', 'artificial');
        } else {
            showPopup('取消提交');
        }
    });

    popup.querySelector('#submit-button').addEventListener('click', async () => {
        cancelTimeSelectionMode();

        const segments = adSegmentsContainer.querySelectorAll('.ad-segment');
        const ads = [];
        let validationError = null;
        let firstErrorElement = null;

        for (const segment of segments) {
            const startTimeStr = segment.getAttribute('data-start-seconds');
            const endTimeStr = segment.getAttribute('data-end-seconds');
            const productNameInput = segment.querySelector('.product-name');
            const adContentTextarea = segment.querySelector('.ad-content-textarea');
            const startTimeDisplay = segment.querySelector('.start-time-display');
            const endTimeDisplay = segment.querySelector('.end-time-display');

            const productName = productNameInput.value.trim();
            const adContent = adContentTextarea.value.trim();

            startTimeDisplay.style.borderColor = 'transparent';
            endTimeDisplay.style.borderColor = 'transparent';
            productNameInput.style.borderColor = '';
            adContentTextarea.style.borderColor = '';

            const startTime = (startTimeStr && !isNaN(parseFloat(startTimeStr))) ? parseFloat(startTimeStr) : null;
            const endTime = (endTimeStr && !isNaN(parseFloat(endTimeStr))) ? parseFloat(endTimeStr) : null;

            if (startTime === null) {
                validationError = '存在未设置的开始时间';
                startTimeDisplay.style.borderColor = 'red';
                if (!firstErrorElement) firstErrorElement = segment.querySelector('.set-start-time');
                break;
            }
            if (endTime === null) {
                validationError = '存在未设置的结束时间';
                endTimeDisplay.style.borderColor = 'red';
                 if (!firstErrorElement) firstErrorElement = segment.querySelector('.set-end-time');
                break;
            }
             if (startTime >= endTime) {
                 validationError = `开始时间 (${secondsToTime(startTime)}) 必须早于结束时间 (${secondsToTime(endTime)})`;
                 startTimeDisplay.style.borderColor = 'red';
                 endTimeDisplay.style.borderColor = 'red';
                 if (!firstErrorElement) firstErrorElement = startTimeDisplay;
                 break;
             }

            if (ads.length > 0) {
                const prevAd = ads[ads.length - 1];
                const prevEndTime = parseFloat(prevAd.end_time);
                if (startTime < prevEndTime) {
                    validationError = `片段重叠：开始时间 (${secondsToTime(startTime)}) 早于上一个片段的结束时间 (${secondsToTime(prevEndTime)})`;
                    startTimeDisplay.style.borderColor = 'orange';
                    const prevSegment = segments[ads.length -1];
                    if(prevSegment) prevSegment.querySelector('.end-time-display').style.borderColor = 'orange';
                    if (!firstErrorElement) firstErrorElement = startTimeDisplay;
                    break;
                }
            }

            if (!productName) {
                 validationError = '产品名称不能为空';
                 productNameInput.style.borderColor = 'red';
                  if (!firstErrorElement) firstErrorElement = productNameInput;
                 break;
             }
             if (!adContent) {
                 validationError = '广告内容不能为空';
                 adContentTextarea.style.borderColor = 'red';
                  if (!firstErrorElement) firstErrorElement = adContentTextarea;
                 break;
             }

            ads.push({
                start_time: startTime.toFixed(2),
                end_time: endTime.toFixed(2),
                product_name: productName,
                ad_content: adContent
            });
        }

        if (validationError) {
            showPopup('提交失败：' + validationError);
            styleLog('Bilibili AI Skip: Validation failed -' + validationError);
            if (firstErrorElement && typeof firstErrorElement.focus === 'function') {
                 firstErrorElement.focus();
            }
             if(firstErrorElement) {
                  const errorSegment = firstErrorElement.closest('.ad-segment');
                  if(errorSegment) {
                       errorSegment.style.transition = 'outline 0.1s ease-in-out';
                       errorSegment.style.outline = '2px solid red';
                       setTimeout(() => { errorSegment.style.outline = 'none'; }, 2000);
                  }
             }
            return;
        }

        ads.sort((a, b) => parseFloat(a.start_time) - parseFloat(b.start_time));

        const mergedAds = [];
        let currentAd = null;
        const mergeThreshold = 1.0;

        for (const ad of ads) {
            const adStart = parseFloat(ad.start_time);
            const adEnd = parseFloat(ad.end_time);
            if (!currentAd) {
                currentAd = { ...ad, start_time: adStart, end_time: adEnd };
            } else if (adStart <= currentAd.end_time + mergeThreshold) {
                currentAd.end_time = Math.max(currentAd.end_time, adEnd);
                currentAd.product_name = `${currentAd.product_name} | ${ad.product_name}`;
                currentAd.ad_content = `${currentAd.ad_content}\n---\n${ad.ad_content}`;
            } else {
                mergedAds.push({
                    ...currentAd,
                    start_time: currentAd.start_time.toFixed(2),
                    end_time: currentAd.end_time.toFixed(2)
                });
                currentAd = { ...ad, start_time: adStart, end_time: adEnd };
            }
        }
        if (currentAd) {
            mergedAds.push({
                ...currentAd,
                start_time: currentAd.start_time.toFixed(2),
                end_time: currentAd.end_time.toFixed(2)
            });
        }

        const correctedAdsData = {
            ads: mergedAds,
            msg: mergedAds.length > 0 ? "识别到广告" : "未识别到广告"
        };

        const submitButton = popup.querySelector('#submit-button');
        if(submitButton) submitButton.disabled = true; submitButton.textContent = '提交中...';

        try {
            if(window.confirm("确定提交？这将覆盖之前的记录。")) {      
                await submitCorrection(correctedAdsData, '纠错提交成功！', 'artificial');
            }else {
                showPopup('取消提交');
                if(submitButton) submitButton.disabled = false; submitButton.textContent = '提交';
            }
        } catch (error) {
             if(submitButton) submitButton.disabled = false; submitButton.textContent = '提交';
        }
    });
}

const adjustPopupPositions = () => {
    document.querySelectorAll('.popup').forEach((el, i, arr) => {
        el.style.bottom = `${100 + (arr.length - i - 1) * (el.offsetHeight + 10)}px`;
    });
};

const getTime = (seconds) => {
    const pad = n => n.toString().padStart(2, '0');
    return [
        Math.floor(seconds / 3600),
        Math.floor(seconds % 3600 / 60),
        Math.floor(seconds % 60)
    ].map(pad).join(':');
};

async function getLocalAliUsage(apiKey, model) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({action: "getAliUsage", apiKey, model}, response => {
      if (chrome.runtime.lastError || !response?.success) {
        reject(new Error(chrome.runtime.lastError?.message || response?.error || "读取剩余额度失败"));
        return;
      }
      resolve(response.data);
    });
  });
}

async function submitTranscriptionTask(audioURL, model) {
  const requestBody = {
    model,
    input: { file_urls: [audioURL] },
    parameters: { channel_id: [0] }
  };
  if (model === "paraformer-v2") {
    requestBody.parameters.language_hints = ["zh", "en", "ja", "yue", "ko", "de", "fr", "ru"];
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: "fetchDashScope",
      url: settings.aliApiURL,
      method: "POST",
      apiKey: settings.aliApiKey,
      ossResourceResolve: audioURL.startsWith("oss://"),
      body: requestBody
    }, response => {
      if (response.success) {
        resolve(response.data.output.task_id);
      } else {
        styleLog("Background fetch error: " + JSON.stringify(response.error));
        reject(new Error(response.error));
      }
    });
  });
}

async function uploadAudioToDashScope(audioURL, model) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: "uploadDashScopeTemp",
      audioUrl: audioURL,
      apiKey: settings.aliApiKey,
      model
    }, response => {
      if (response?.success) {
        resolve(response.url);
      } else {
        styleLog("DashScope temporary upload error: " + JSON.stringify(response?.error));
        reject(new Error(response?.error || "DashScope temporary upload failed"));
      }
    });
  });
}

async function waitForTaskCompletion(taskId, model) {
  while (true) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: "fetchDashScope",
          url: `${settings.aliTaskURL}${taskId}`,
          method: "GET",
          apiKey: settings.aliApiKey
        }, response => {
          if (response.success) {
            resolve(response.data);
          } else {
            styleLog("Background fetch error: " + JSON.stringify(response.error));
            reject(new Error(response.error));
          }
        });
      });

      styleLog("Task status: " + response?.output?.task_status);

      switch (response.output.task_status) {
        case "SUCCEEDED":
            showPopup("音频解析成功.");
            closePopup(popups.task);
            if (Number(response.usage?.duration) > 0) {
                await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: "recordAliUsage",
                        apiKey: settings.aliApiKey,
                        model,
                        duration: response.usage.duration,
                        taskId
                    }, recordResponse => {
                        if (chrome.runtime.lastError || !recordResponse?.success) {
                            styleLog("Failed to record Paraformer usage: " +
                                (chrome.runtime.lastError?.message || recordResponse?.error || "Unknown error"));
                        }
                        resolve();
                    });
                });
            }
            return response.output.results;
        case "FAILED":
            showPopup("音频解析失败.");
            closePopup(popups.task);
            //throw new Error(`Task failed: ${response.error?.message || "Unknown error"}`);
            return response.output.results;
        case "RUNNING":
        case "PENDING":
            if (!popups.task) {
                popups.task = showPopup("音频解析中...", 1);
                popups.others.push(popups.task);
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
            break;
        default:
            showPopup("音频解析遇到未知错误.");
            throw new Error(`Unknown task status: ${response.output.task_status}`);
      }
    } catch (error) {
      styleLog("Error checking task status: " + JSON.stringify(error));
      throw error;
    }
  }
}

async function fetchTranscription(transcriptionURL) {
    try {
        const response = await fetch(transcriptionURL);
        if (!response.ok) {
            throw new Error(`Failed to fetch transcription: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        styleLog("Error fetching transcription: " + JSON.stringify(error));
        throw error;
    }
}

function generateSubtitle(transcription) {
    const transcripts = JSON.parse(transcription).transcripts[0].sentences;
    let subtitle = "";
    
    transcripts.forEach(sentence => {
        const from = (sentence.begin_time / 1000).toFixed(2);
        const to = (sentence.end_time / 1000).toFixed(2);
        subtitle += `${from} --> ${to}\n${sentence.text}\n`;
    });
    
    return subtitle;
}

function updateTimes(cid, skip_time) {
     chrome.runtime.sendMessage({
        action: "dbQuery", url: settings.cfApiURL, method: "POST", cfApiKey: settings.cfApiKey,
        body: {
            sql: `UPDATE bilijump SET times = times + 1, skip_time = skip_time + ? WHERE cid = ?;`,
            params: [Math.ceil(skip_time), cid]
        }
    });
}

let buttonWaitTimer = 0;

function correctButton(cid, data, bid, pid) {
    const current = parseVideoId();
    if (bid !== current.bvid || pid !== current.pvid) return;

    const ads = Array.isArray(data?.ads) ? data.ads : [];
    const adLength = ads.length;
    const adTime = ads.reduce((sum, ad) => sum + (parseFloat(ad.end_time) - parseFloat(ad.start_time)), 0);
    const iconUse = Math.max(adLength < 3 ? adLength : 3, adTime == 0 ? 0 : adTime <= 45 ? 1 : adTime <= 90 ? 2 : 3);

    buttonWaitTimer = buttonWaitTimer || 0;
    const playerRight = document.querySelector('.bpx-player-control-bottom-right');
    if (!playerRight) {
        // 控制栏可能延迟渲染，最多重试 10 秒，避免直接抛错
        if (buttonWaitTimer++ < 20) {
            setTimeout(() => correctButton(cid, data, bid, pid), 500);
        } else {
            buttonWaitTimer = 0;
        }
        return;
    }
    buttonWaitTimer = 0;

    document.getElementById('bilibili-ai-skip-correct')?.remove();

    const correct = document.createElement('div');
    correct.innerHTML = `<div class="bpx-player-ctrl-quality-result"><img src="${chrome.runtime.getURL('icons/icon48_red_' + iconUse + '.png')}" alt="icon" style="width: 22px; height: 22px; bottom: ${6 - iconUse}px;"><span style="color: hsla(0,0%,100%,.8);">纠错  </span> </div>`;
    correct.id = 'bilibili-ai-skip-correct';
    correct.style.width = 'auto';
    correct.style.height = '22px';
    correct.style.marginRight = '20px';
    correct.addEventListener('click', () => showCorrectionPopup(cid, data));
    playerRight.prepend(correct);
}

async function activeLog() {
    try {
        const stored = await chrome.storage.sync.get('uid');
        if (!stored?.uid || !settings.cfApiURL) return;
        chrome.runtime.sendMessage({
            action: "dbQuery", url: settings.cfApiURL, method: "POST", cfApiKey: settings.cfApiKey,
            body: {
                sql: `INSERT INTO bilijump_active(uid) VALUES(?);`,
                params: [stored.uid]
            }
        });
    } catch (error) {
        styleLog("activeLog skipped: " + error.message);
    }
}

function styleLog(msg) {
    console.info("%c Bilibili AI Skip %c " + msg + " ", "padding: 2px 6px; border-radius: 3px 0 0 3px; color: #fff; background: #a19cef; font-weight: bold;", "padding: 2px 6px; border-radius: 0 3px 3px 0; color: #fff; background: #FF6699; font-weight: bold;")
}
