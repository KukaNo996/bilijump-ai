document.addEventListener('DOMContentLoaded', () => {
    const keys = ['autoJump', 'enabled', 'tagFilter', 'apiKey', 'apiURL', 'apiModel', 'audioEnabled', 'autoAudio', 'aliApiKey',
        'useBuiltinAdModel', 'useDanmakuSignal', 'useLocalASR', 'useCloudAI', 'useWebGPU'];
    const apiURLInput = document.getElementById('apiURL');
    const apiURLDrop = document.getElementById('apiURLDropdown');
    const apiKeyInput = document.getElementById('apiKey');
    const apiKeyDrop = document.getElementById('apiKeyDropdown');
    const apiAccessStatus = document.getElementById('apiAccessStatus');
    const aliApiKeyInput = document.getElementById('aliApiKey');
    const aliUsage = document.getElementById('aliUsage');
    const aliUsageRemaining = {
        'paraformer-v2': document.getElementById('aliUsageRemainingV2'),
        'paraformer-v1': document.getElementById('aliUsageRemainingV1')
    };
    const freeOption = document.getElementById('free');
    const localOption = document.getElementById('localEndpoint');
    let aiConfig;
    let aliUsageRequestId = 0;

    const formatNumber = value => Number(value).toLocaleString('zh-CN', {maximumFractionDigits: 4});

    const showAliUsage = (model, data) => {
        const button = aliUsageRemaining[model];
        button.textContent = formatNumber(data.remaining);
        button.dataset.remaining = String(data.remaining);
        button.disabled = false;
        aliUsage.title = '根据本扩展分别记录的模型任务用量计算；点击剩余额度可手动修改';
    };

    const loadAliUsage = () => {
        const apiKey = aliApiKeyInput.value.trim();
        const requestId = ++aliUsageRequestId;
        if (!apiKey) {
            Object.values(aliUsageRemaining).forEach(button => {
                button.textContent = '36,000';
                button.dataset.remaining = '36000';
                button.disabled = true;
            });
            aliUsage.title = '请先输入阿里云 API Key';
            return;
        }

        Object.entries(aliUsageRemaining).forEach(([model, button]) => {
            button.textContent = '...';
            chrome.runtime.sendMessage({action: 'getAliUsage', apiKey, model}, response => {
                if (requestId !== aliUsageRequestId || apiKey !== aliApiKeyInput.value.trim()) return;
                if (chrome.runtime.lastError || !response?.success) {
                    button.textContent = '--';
                    button.disabled = true;
                    aliUsage.title = chrome.runtime.lastError?.message || response?.error || '读取失败';
                    return;
                }
                showAliUsage(model, response.data);
            });
        });
    };

    const scheduleAliUsageLoad = debounce(loadAliUsage, 300);

    Object.entries(aliUsageRemaining).forEach(([model, button]) => {
        button.addEventListener('click', () => {
            const apiKey = aliApiKeyInput.value.trim();
            if (!apiKey) {
                alert('请先输入阿里云 API Key');
                return;
            }
            const input = prompt(`请输入 ${model} 剩余额度（秒）`, button.dataset.remaining || '36000');
            if (input === null) return;
            const remaining = Number(input.replace(/,/g, '').trim());
            if (!Number.isFinite(remaining) || remaining < 0 || remaining > 36000) {
                alert('请输入 0 到 36,000 之间的数字');
                return;
            }
            chrome.runtime.sendMessage({action: 'setAliRemaining', apiKey, model, remaining}, response => {
                if (chrome.runtime.lastError || !response?.success) {
                    alert(chrome.runtime.lastError?.message || response?.error || '保存失败');
                    return;
                }
                showAliUsage(model, response.data);
            });
        });
    });

    const save = debounce(() => {
        const settings = Object.fromEntries(keys.map(key => {
            const element = document.getElementById(key);
            return [key, element.type === 'checkbox' ? element.checked : element.value.trim()];
        }));

        if (settings.apiKey && settings.apiURL && settings.apiModel) {
            chrome.storage.sync.get({apiHistory: {}}, result => {
                result.apiHistory[settings.apiKey] = {url: settings.apiURL, model: settings.apiModel};
                chrome.storage.sync.set({apiHistory: result.apiHistory});
            });
        }

        // 写入 storage.local（主存储），并尽力镜像到 sync，扩展更新/重启不会丢
        BJS.saveSettings(settings).then(() => {
            chrome.action.setIcon({path: settings.enabled ? 'icons/icon48_red_3.png' : 'icons/icon48_blue.png'});
            const status = document.getElementById('status');
            status.textContent = 'Saved';
            status.classList.add('show');
            setTimeout(() => (status.classList.remove('show'), status.textContent = ''), 1000);
        }).catch(error => {
            const status = document.getElementById('status');
            status.textContent = '保存失败: ' + error.message;
            status.classList.add('show');
        });
    }, 300);

    const getApiOrigin = () => (typeof BJS !== 'undefined' ? BJS.originPattern(apiURLInput.value.trim()) : null);

    const updateApiAccessStatus = () => {
        const origin = getApiOrigin();
        if (!origin) {
            apiAccessStatus.textContent = '请输入有效的 HTTPS API URL，或本机 HTTP 地址';
            return;
        }

        chrome.permissions.contains({origins: [origin]}, granted => {
            if (origin === getApiOrigin()) {
                apiAccessStatus.textContent = granted ? `已授权 ${origin}` : `尚未授权 ${origin}`;
            }
        });
    };

    BJS.loadSettings().then(settings => {
        keys.forEach(key => {
            const element = document.getElementById(key);
            if (!element) return;
            const value = settings[key];
            if (element.type === 'checkbox') element.checked = Boolean(value);
            else element.value = value === undefined || value === null ? '' : value;
            element.addEventListener(element.type === 'checkbox' ? 'change' : 'input', save);
        });
        updateApiAccessStatus();
        loadAliUsage();
        refreshModelStatus();
    });

    aliApiKeyInput.addEventListener('input', scheduleAliUsageLoad);

    chrome.runtime.sendMessage({action: 'kvQuery', k: 'bilijump-ai-api-config'}, response => {
        if (chrome.runtime.lastError || !response?.success) {
            console.warn('Failed to load free API config:', chrome.runtime.lastError?.message || response?.error);
            return;
        }
        aiConfig = response.data;
        freeOption.textContent = aiConfig?.apiDesc || 'free';
    });

    const refreshModelStatus = async () => {
        const element = document.getElementById('modelStatus');
        if (!element) return;
        try {
            await BJSModels.init({useWebGPU: document.getElementById('useWebGPU').checked});
            const snapshot = BJSModels.status();
            const gpu = snapshot.gpuVerified ? 'WebGPU 已校验' : (snapshot.webgpu ? 'WebGPU 待校验' : 'CPU 模式');
            element.textContent = `词表 ${snapshot.lexiconTerms} 项 · 决策特征 ${snapshot.decisionFeatures} 维 · ${gpu}`;
            if (snapshot.webgpuError) element.title = snapshot.webgpuError;
        } catch (error) {
            element.textContent = '内置模型加载失败：' + error.message;
        }
    };

    document.getElementById('testApi').addEventListener('click', () => {
        const button = document.getElementById('testApi');
        const status = document.getElementById('apiTestStatus');
        button.disabled = true;
        status.textContent = '正在测试连接…';
        chrome.runtime.sendMessage({
            action: 'probeOpenAI',
            override: { apiURL: apiURLInput.value.trim(), apiKey: apiKeyInput.value.trim() }
        }, response => {
            button.disabled = false;
            if (chrome.runtime.lastError || !response?.success) {
                status.textContent = '连接失败：' + (chrome.runtime.lastError?.message || response?.error || '未知错误');
                return;
            }
            const data = response.data || {};
            const models = Array.isArray(data.models) && data.models.length
                ? ` · 模型 ${data.models.slice(0, 3).join(', ')}`
                : '';
            status.textContent = `连接正常 · ${data.latencyMs}ms${models}`;
        });
    });

    document.getElementById('grantApiAccess').addEventListener('click', () => {
        const origin = getApiOrigin();
        if (!origin) {
            apiAccessStatus.textContent = '请输入有效的 HTTPS API URL，或本机 HTTP 地址';
            return;
        }

        chrome.permissions.request({origins: [origin]}, granted => {
            if (origin !== getApiOrigin()) return;
            if (chrome.runtime.lastError) {
                apiAccessStatus.textContent = `授权失败: ${chrome.runtime.lastError.message}`;
            } else if (granted) {
                apiAccessStatus.textContent = `已授权 ${origin}，正在刷新视频页面`;
                chrome.runtime.sendMessage({action: "reloadApiSourceTab", origin});
            } else {
                apiAccessStatus.textContent = `未授予 ${origin}`;
            }
        });
    });

    apiURLInput.addEventListener('click', event => {
        apiURLDrop.style.display = 'block';
        apiKeyDrop.style.display = 'none';
        event.stopPropagation();
    });
    apiURLInput.addEventListener('input', updateApiAccessStatus);

    apiURLDrop.addEventListener('click', event => {
        if (event.target.closest('a')) return;
        const option = event.target.closest('.dropdown-option');
        if (!option) return;

        if (option === localOption) {
            // 本机端点：host_permissions 已包含 http://127.0.0.1/*，无需额外授权
            apiURLInput.value = BJS.DEFAULTS.apiURL;
            if (!apiKeyInput.value.trim()) {
                // 密钥不随仓库内置，这里只给提示，不覆盖用户已填的值
                apiKeyInput.placeholder = '本机端点需填写密钥（扩展不内置）';
                apiKeyInput.focus();
            }
            const modelInput = document.getElementById('apiModel');
            modelInput.value = '';
            modelInput.placeholder = '可留空，使用本地网关默认模型';
        } else if (option === freeOption) {
            if (!aiConfig) {
                apiAccessStatus.textContent = '免费 API 配置暂不可用';
                return;
            }
            apiKeyInput.value = aiConfig.apiKey || '';
            apiURLInput.value = aiConfig.apiURL || '';
            document.getElementById('apiModel').value = aiConfig.apiModel || '';
        } else {
            apiURLInput.value = option.dataset.value || '';
            apiKeyInput.value = '';
            document.getElementById('apiModel').value = '';
        }

        apiURLDrop.style.display = 'none';
        save();
        updateApiAccessStatus();
    });

    apiKeyInput.addEventListener('click', event => {
        event.stopPropagation();
        apiURLDrop.style.display = 'none';
        chrome.storage.sync.get({apiHistory: {}}, result => {
            const history = result.apiHistory;
            if (!Object.keys(history).length) return;

            apiKeyDrop.innerHTML = Object.entries(history).reverse().map(([key, value]) =>
                `<div class="dropdown-option" data-k="${key}" data-u="${value.url}" data-m="${value.model}" style="display: flex; align-items: center; padding: 5px 10px; gap: 10px;">
                    <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">
                        ${new URL(value.url).host}
                    </span>
                    <small style="color: #aaa; font-family: monospace; white-space: nowrap; flex-shrink: 0;">
                        ${key.slice(0, 7)}...${key.slice(-4)}
                    </small>
                    <span class="delete-btn" style="color: #999; cursor: pointer; font-size: 18px; line-height: 1; flex-shrink: 0;" title="删除">×</span>
                </div>`
            ).join('');
            apiKeyDrop.style.display = 'block';
        });
    });

    apiKeyDrop.addEventListener('click', event => {
        const option = event.target.closest('.dropdown-option');
        if (!option) return;

        if (event.target.classList.contains('delete-btn')) {
            const key = option.dataset.k;
            option.remove();
            chrome.storage.sync.get({apiHistory: {}}, result => {
                delete result.apiHistory[key];
                chrome.storage.sync.set({apiHistory: result.apiHistory});
                if (!Object.keys(result.apiHistory).length) apiKeyDrop.style.display = 'none';
            });
            return;
        }

        apiKeyInput.value = option.dataset.k;
        apiURLInput.value = option.dataset.u;
        document.getElementById('apiModel').value = option.dataset.m;
        apiKeyDrop.style.display = 'none';
        save();
        updateApiAccessStatus();
    });

    document.addEventListener('click', event => {
        if (!apiURLInput.contains(event.target) && !apiURLDrop.contains(event.target)) apiURLDrop.style.display = 'none';
        if (!apiKeyInput.contains(event.target) && !apiKeyDrop.contains(event.target)) apiKeyDrop.style.display = 'none';
    });
});

const debounce = (fn, wait) => {
    let timer;
    return (...args) => (clearTimeout(timer), timer = setTimeout(() => fn(...args), wait));
};
