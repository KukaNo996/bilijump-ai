// 共享设置层：MV3 service worker 用 importScripts 载入；Firefox 事件页由 manifest 预先载入
if (typeof importScripts === "function") {
  try {
    importScripts("settings.js");
  } catch (error) {
    console.warn("Failed to load settings.js:", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchDashScope") {
    fetch(message.url, {
      method: message.method || "POST",
      headers: {
        "Authorization": `Bearer ${message.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
        ...(message.ossResourceResolve ? { "X-DashScope-OssResourceResolve": "enable" } : {})
      },
      body: JSON.stringify(message.body)
    })
    .then(response => response.json())
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "fetchOpenAI") {
    fetchOpenAI(message.body)
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "probeOpenAI") {
    probeOpenAI(message.override)
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "resetSettings") {
    resetSettings()
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "getAliUsage") {
    getAliUsage(message.apiKey, message.model)
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "setAliRemaining") {
    setAliRemaining(message.apiKey, message.model, message.remaining)
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "recordAliUsage") {
    recordAliUsage(message.apiKey, message.model, message.duration, message.taskId)
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "openApiSettings") {
    openApiSettings(sender.tab?.windowId, sender.tab?.id, message.origin)
    .then(() => sendResponse({ success: true }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "reloadApiSourceTab") {
    reloadApiSourceTab(message.origin)
    .then(() => sendResponse({ success: true }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "uploadDashScopeTemp") {
    uploadDashScopeTemp(message.audioUrl, message.apiKey, message.model || "paraformer-v2")
    .then(url => sendResponse({ success: true, url }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "dbQuery") {
    fetch(message.url, {
      method: message.method || "POST",
      headers: {
        "Authorization": `Bearer ${message.cfApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message.body)
    })
    .then(response => response.json())
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "kvQuery") {
    getConfig(message.k)
    .then(data => sendResponse({ success: true, data: data }))
    .catch(error => sendResponse({ success: false, error: error }));
    return true;
  }
});

let apiPermissionReloadInProgress = false;

chrome.permissions.onAdded.addListener(permissions => {
  handleApiPermissionAdded(permissions).catch(error => {
    console.warn("Failed to refresh the API source tab:", error);
  });
});

async function handleApiPermissionAdded(permissions) {
  const grantedOrigins = permissions.origins || [];
  const { apiPermissionOrigin } = await chrome.storage.local.get("apiPermissionOrigin");
  if (apiPermissionOrigin && grantedOrigins.includes(apiPermissionOrigin)) {
    await reloadApiSourceTab(apiPermissionOrigin);
  }
}

async function openApiSettings(windowId, sourceTabId, origin) {
  if (Number.isInteger(sourceTabId) && typeof origin === "string") {
    await chrome.storage.local.set({
      apiPermissionSourceTabId: sourceTabId,
      apiPermissionOrigin: origin
    });
  }

  if (chrome.action?.openPopup) {
    try {
      await chrome.action.openPopup(windowId === undefined ? undefined : { windowId });
      return;
    } catch {
      // Fall back when the toolbar popup cannot be opened programmatically.
    }
  }

  const createOptions = {
    url: chrome.runtime.getURL("popup.html"),
    active: true
  };

  if (Number.isInteger(windowId)) {
    createOptions.windowId = windowId;
  }

  await chrome.tabs.create(createOptions);
}

async function reloadApiSourceTab(origin) {
  if (apiPermissionReloadInProgress) return;
  apiPermissionReloadInProgress = true;
  try {
    const { apiPermissionSourceTabId, apiPermissionOrigin } = await chrome.storage.local.get([
      "apiPermissionSourceTabId",
      "apiPermissionOrigin"
    ]);
    if (!Number.isInteger(apiPermissionSourceTabId) || !apiPermissionOrigin) return;
    if (origin && origin !== apiPermissionOrigin) return;
    if (!await chrome.permissions.contains({ origins: [apiPermissionOrigin] })) return;

    await chrome.storage.local.remove(["apiPermissionSourceTabId", "apiPermissionOrigin"]);
    await chrome.tabs.reload(apiPermissionSourceTabId);
  } finally {
    apiPermissionReloadInProgress = false;
  }
}

async function getSettingsSafe() {
  if (typeof BJS === "undefined") {
    throw new Error("设置模块未加载（settings.js）");
  }
  // 请求前必须拿最新配置：popup 刚保存完不应读到旧缓存
  return BJS.loadSettings({ fresh: true });
}

function buildChatUrl(rawUrl) {
  const normalized = typeof BJS !== "undefined" ? BJS.normalizeChatUrl(rawUrl) : rawUrl;
  if (!normalized) throw new Error(`API 地址无效：${rawUrl || "(空)"}`);
  return new URL(normalized);
}

async function ensureApiPermission(url) {
  const pattern = typeof BJS !== "undefined"
    ? BJS.originPattern(url.href)
    : (url.protocol === "https:" ? `https://${url.hostname}/*` : null);
  if (!pattern) {
    throw new Error("Only HTTPS or local HTTP API URLs are supported");
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) {
    // 保留原始前缀，content.js 依赖它触发授权引导
    throw new Error(`Missing API access permission for ${pattern}. Grant it in the extension settings.`);
  }
  return pattern;
}

function requestOnce(url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url.href, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal
  }).then(async response => {
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      text
    };
  }).finally(() => clearTimeout(timer));
}

/** 兼容非标准 OpenAI 返回结构（本地网关常见 content / message.content / output.text） */
function adaptChatResponse(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data.choices) && data.choices.length) return data;
  const text = data.content ?? data.message?.content ?? data.response ??
    data.output?.text ?? data.result?.content ?? data.result?.text;
  if (typeof text !== "string" || !text) return data;
  return Object.assign({}, data, {
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }]
  });
}

function describeFailure(result) {
  const raw = result.data?.error?.message || result.data?.message ||
    (result.text || "").trim() || result.statusText || "Unknown error";
  // 上游 502 会附带几百字的故障链说明，播放器里放不下，压缩成一行
  const detail = String(raw).replace(/\s+/g, " ").trim();
  return `API 请求失败 (${result.status}): ${detail.length > 200 ? detail.slice(0, 200) + "…" : detail}`;
}

async function fetchOpenAI(body) {
  const settings = await getSettingsSafe();
  const url = buildChatUrl(settings.apiURL);
  const isLocal = typeof BJS !== "undefined" ? BJS.isLocalUrl(url.href) : url.hostname === "127.0.0.1";

  await ensureApiPermission(url);

  const apiKey = String(settings.apiKey || "").trim();
  if (!apiKey && !isLocal) {
    throw new Error("请先在扩展设置中填写 API Key");
  }

  const payload = Object.assign({}, body || {});
  const jsonMode = payload.json_mode !== false;
  delete payload.json_mode; // 内部开关，不能透传给网关
  if (!payload.model) delete payload.model; // 本地网关可留空使用默认模型
  if (!payload.max_tokens && !payload.max_completion_tokens) payload.max_tokens = 8192;
  if (jsonMode) payload.response_format = { type: "json_object" };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeoutMs = Number(settings.requestTimeoutMs) || 120000;
  let result;
  try {
    result = await requestOnce(url, headers, payload, timeoutMs);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）${isLocal ? "，请确认本地端点正在运行" : ""}`);
    }
    throw new Error(`无法连接 API${isLocal ? "（本地端点未启动？）" : ""}: ${error.message}`);
  }

  // 部分网关不认 response_format，直接 400/422；去掉该参数重试一次
  if (!result.ok && (result.status === 400 || result.status === 422) && payload.response_format) {
    const relaxed = Object.assign({}, payload);
    delete relaxed.response_format;
    try {
      const retry = await requestOnce(url, headers, relaxed, timeoutMs);
      if (retry.ok) result = retry;
    } catch {
      // 保持原始错误
    }
  }

  // 部分本地网关只认 x-api-key，不认 Bearer；401/403 时回退一次
  if ((result.status === 401 || result.status === 403) && apiKey) {
    const fallbackHeaders = Object.assign({}, headers, { "x-api-key": apiKey, "api-key": apiKey });
    try {
      const retry = await requestOnce(url, fallbackHeaders, payload, timeoutMs);
      if (retry.ok) result = retry;
    } catch {
      // 保持原始错误
    }
  }

  if (!result.ok && (result.status === 401 || result.status === 403) && !apiKey) {
    // 仓库不内置任何密钥，本地网关要求鉴权时必须提示用户去填
    throw new Error("端点要求鉴权：请在扩展设置中填写 API Key");
  }

  if (!result.ok) throw new Error(describeFailure(result));
  return adaptChatResponse(result.data);
}

/** 探活：优先 /v1/models，其次 /health，供 popup 的「测试连接」使用 */
async function probeOpenAI(override) {
  const settings = await getSettingsSafe();
  const url = buildChatUrl(override?.apiURL || settings.apiURL);
  await ensureApiPermission(url);
  const apiKey = String(override?.apiKey ?? settings.apiKey ?? "").trim();
  const headers = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }

  const base = url.origin + (url.pathname.replace(/\/v1\/.*$/, "") || "");
  const candidates = [`${base}/v1/models`, `${base}/health`, `${base}/v1/health`];
  const started = Date.now();
  let lastError = "无可用探活接口";

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(candidate, { method: "GET", headers, signal: controller.signal });
      const text = await response.text();
      if (response.ok) {
        let models = null;
        try {
          const parsed = JSON.parse(text);
          models = Array.isArray(parsed?.data) ? parsed.data.map(item => item.id).filter(Boolean) : null;
        } catch {
          models = null;
        }
        return {
          endpoint: url.href,
          probeUrl: candidate,
          latencyMs: Date.now() - started,
          models
        };
      }
      lastError = `${candidate} → ${response.status}`;
    } catch (error) {
      lastError = `${candidate} → ${error.name === "AbortError" ? "超时" : error.message}`;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`连接失败：${lastError}`);
}

async function resetSettings() {
  await chrome.storage.local.remove("bilijump.settings");
  if (typeof BJS !== "undefined") BJS.clearCache();
  return getSettingsSafe();
}

const ALI_MONTHLY_QUOTA_SECONDS = 36000;
let aliUsageUpdateQueue = Promise.resolve();

function normalizeAliModel(model) {
  const value = model || "paraformer-v2";
  if (value !== "paraformer-v1" && value !== "paraformer-v2") {
    throw new Error("不支持的 Paraformer 模型");
  }
  return value;
}

function getAliUsageStorageKey(apiKey, model) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("请输入阿里云 API Key");
  const normalizedModel = normalizeAliModel(model);

  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const legacyV2Key = `aliUsage:${month}:${(hash >>> 0).toString(16)}:${key.length}`;
  return normalizedModel === "paraformer-v2" ? legacyV2Key : `${legacyV2Key}:${normalizedModel}`;
}

async function getAliUsage(apiKey, model) {
  const normalizedModel = normalizeAliModel(model);
  const storageKey = getAliUsageStorageKey(apiKey, normalizedModel);
  const stored = await chrome.storage.local.get(storageKey);
  const record = stored[storageKey] || {};
  return {
    model: normalizedModel,
    used: Number(record.used) || 0,
    limit: ALI_MONTHLY_QUOTA_SECONDS,
    remaining: Math.max(ALI_MONTHLY_QUOTA_SECONDS - (Number(record.used) || 0), 0)
  };
}

function updateAliUsage(apiKey, model, update) {
  const normalizedModel = normalizeAliModel(model);
  const storageKey = getAliUsageStorageKey(apiKey, normalizedModel);
  const run = async () => {
    const stored = await chrome.storage.local.get(storageKey);
    const record = stored[storageKey] || { used: 0, taskIds: [] };
    const updated = update(record);
    await chrome.storage.local.set({ [storageKey]: updated });
    const used = Number(updated.used) || 0;
    return {
      model: normalizedModel,
      used,
      limit: ALI_MONTHLY_QUOTA_SECONDS,
      remaining: Math.max(ALI_MONTHLY_QUOTA_SECONDS - used, 0)
    };
  };
  aliUsageUpdateQueue = aliUsageUpdateQueue.then(run, run);
  return aliUsageUpdateQueue;
}

function setAliRemaining(apiKey, model, remaining) {
  const seconds = Number(remaining);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > ALI_MONTHLY_QUOTA_SECONDS) {
    throw new Error(`剩余额度必须是 0 到 ${ALI_MONTHLY_QUOTA_SECONDS} 之间的数字`);
  }
  return updateAliUsage(apiKey, model, record => ({
    ...record,
    used: ALI_MONTHLY_QUOTA_SECONDS - seconds,
    taskIds: Array.isArray(record.taskIds) ? record.taskIds : []
  }));
}

function recordAliUsage(apiKey, model, duration, taskId) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("任务用量无效");
  const id = String(taskId || "").trim();
  if (!id) throw new Error("任务 ID 无效");

  return updateAliUsage(apiKey, model, record => {
    const taskIds = Array.isArray(record.taskIds) ? record.taskIds : [];
    if (taskIds.includes(id)) return record;
    return {
      used: (Number(record.used) || 0) + seconds,
      taskIds: [...taskIds, id].slice(-1000)
    };
  });
}

async function uploadDashScopeTemp(audioUrl, apiKey, model) {
  const sourceUrl = new URL(audioUrl);
  if (!/(^|\.)bilivideo\.(com|cn)$/i.test(sourceUrl.hostname)) {
    throw new Error("Unsupported Bilibili audio host");
  }

  await ensureBilibiliAudioHeaders();
  const audioResponse = await fetch(sourceUrl.href, { method: "GET", cache: "no-store" });
  if (!audioResponse.ok) {
    throw new Error(`Bilibili audio download failed: ${audioResponse.status}`);
  }

  const audioBlob = await audioResponse.blob();
  const policyResponse = await fetch(
    `https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
    { headers: { "Authorization": `Bearer ${apiKey}` } }
  );
  if (!policyResponse.ok) {
    throw new Error(`DashScope upload policy failed: ${policyResponse.status}`);
  }

  const policyResult = await policyResponse.json();
  const policy = policyResult.data;
  if (!policy?.upload_host || !policy?.upload_dir) {
    throw new Error(policyResult.message || "Invalid DashScope upload policy");
  }

  const maxBytes = Number(policy.max_file_size_mb) * 1024 * 1024;
  if (Number.isFinite(maxBytes) && maxBytes > 0 && audioBlob.size > maxBytes) {
    throw new Error(`Audio file exceeds DashScope temporary upload limit (${policy.max_file_size_mb} MB)`);
  }

  const uploadHost = new URL(policy.upload_host);
  if (uploadHost.protocol !== "https:" || !uploadHost.hostname.endsWith(".aliyuncs.com")) {
    throw new Error("Invalid DashScope upload host");
  }

  const fileName = `${crypto.randomUUID()}.m4a`;
  const key = `${policy.upload_dir}/${fileName}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id);
  form.append("Signature", policy.signature);
  form.append("policy", policy.policy);
  form.append("x-oss-object-acl", policy.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", audioBlob, fileName);

  const uploadResponse = await fetch(uploadHost.href, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    throw new Error(`DashScope temporary upload failed: ${uploadResponse.status}`);
  }

  return `oss://${key}`;
}

async function ensureBilibiliAudioHeaders() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{
          header: "Referer",
          operation: "set",
          value: "https://www.bilibili.com/"
        }]
      },
      condition: {
        regexFilter: "^https?://[^/]+\\.bilivideo\\.(com|cn)/",
        resourceTypes: ["xmlhttprequest"]
      }
    }]
  });
}

/**
 * 初始化：把旧配置迁移进 storage.local（幂等），并补齐 prompt / banModels。
 * 不再用「默认值整体覆盖」，避免扩展更新或浏览器重启时冲掉用户设置。
 */
async function initConfig() {
  if (typeof BJS === "undefined") return null;
  const settings = await BJS.loadSettings();
  await BJS.loadBanModels();
  return settings;
}

async function getConfig(k) {
  let url = `https://api.cloudflare.com/client/v4/accounts/34c49ed8e1d2bd41c330fb65de4c5890/storage/kv/namespaces/1c7e51cc9ae546748c5afc55df196f85/values/${encodeURIComponent(k)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const response = await fetch(url, { headers: { "Authorization": `Bearer Dmlpe9TkvsvBCE0N-FkqeRkN5ANCyHTnUSnAtGCH`, "Content-Type": "application/json"} });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Ignore errors to allow for retry
    }
  }
  return null;
}

async function loadPrompt() {
  const cached = typeof BJS !== "undefined" ? await BJS.getPrompt() : "";
  if (cached) return cached;

  const promptURL = chrome.runtime.getURL('prompt.txt');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(promptURL);
      if (response.ok) {
        const promptText = await response.text();
        await chrome.storage.local.set({ "bilijump.prompt": promptText });
        return promptText;
      }
    } catch {
      // 重试
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  console.warn("Failed to load bundled prompt.txt");
  return "";
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.sync.get('uid');
  if (!stored?.uid) {
    await chrome.storage.sync.set({ uid: crypto.randomUUID() });
  }
  // 更新/安装/降级都只做迁移与缺失补齐，绝不覆盖用户已保存的配置
  await initConfig();
  await loadPrompt();
  if (details?.reason === 'update') {
    console.info("Bilibili AI Skip updated; settings migrated to chrome.storage.local");
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启后复核一次迁移结果，保证本地配置可用
  await initConfig();
  await loadPrompt();
});
