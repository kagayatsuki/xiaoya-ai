// 该函数会被序列化后注入到页面主世界执行，不能引用外部变量
function installHook() {
  if (window.__WHUT_AI_HOOK__) return 'already';
  window.__WHUT_AI_HOOK__ = true;

  const logs = [];
  const MAX = 3000;

  const fmt = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || String(a);
      return JSON.stringify(a);
    } catch (e) {
      try { return String(a); } catch (e2) { return '[unprintable]'; }
    }
  };

  ['log', 'info', 'warn', 'error', 'debug'].forEach((m) => {
    const orig = console[m] ? console[m].bind(console) : null;
    console[m] = (...args) => {
      try {
        const text = args.map(fmt).join(' ');
        logs.push({ m, t: text, ts: Date.now() });
        if (logs.length > MAX) logs.splice(0, logs.length - MAX);
      } catch (e) {}
      if (orig) return orig(...args);
    };
  });

  window.__WHUT_AI_LOGS__ = logs;
  return 'installed';
}

// 该函数会被序列化后注入到页面主世界执行
function getLogs() {
  try {
    return (window.__WHUT_AI_LOGS__ || []).slice();
  } catch (e) {
    return [];
  }
}

// ---- 视频看完后每 30 秒点击右上角「点我完成任务」 ----
// 点击由后台 alarms + scripting 注入完成，不依赖页面里的 content script，
// 所以隐藏窗口、扩展重载前就打开的标签页也能工作。
const FINISH_ALARM_PREFIX = 'finish:';
const FINISH_MAX_CLICKS = 6; // 30 秒一次，最多重试 3 分钟
const FINISH_MAX_MISSES = 10;
const MYCOURSE_URL_RE = /^https:\/\/whut\.ai-augmented\.com\/.*\/mycourse\//;

const finishAlarmName = (tabId) => FINISH_ALARM_PREFIX + tabId;

async function createFinishAlarm(tabId) {
  // 隐藏窗口里的页面定时器会被节流，用 alarms 驱动 30 秒轮询
  try {
    await chrome.alarms.create(finishAlarmName(tabId), { periodInMinutes: 0.5 });
  } catch (e) {
    // 旧版 Chrome 的周期下限是 1 分钟
    try { await chrome.alarms.create(finishAlarmName(tabId), { periodInMinutes: 1 }); } catch (e2) {}
  }
}

// 已有轮询就不重建，避免把下一次触发时间往后推
async function ensureFinishAlarm(tabId) {
  try {
    const existing = await chrome.alarms.get(finishAlarmName(tabId));
    if (existing) return;
  } catch (e) {}
  await createFinishAlarm(tabId);
}

async function stopFinishPolling(tabId) {
  try { await chrome.alarms.clear(finishAlarmName(tabId)); } catch (e) {}
  try { await chrome.storage.session.remove('finishState:' + tabId); } catch (e) {}
}

async function getFinishState(tabId) {
  try {
    const key = 'finishState:' + tabId;
    const data = await chrome.storage.session.get(key);
    return data[key] || {};
  } catch (e) {
    return {};
  }
}

async function setFinishState(tabId, patch) {
  const next = { ...(await getFinishState(tabId)), ...patch };
  try { await chrome.storage.session.set({ ['finishState:' + tabId]: next }); } catch (e) {}
  return next;
}

function reportFinishStatus(tabId, action, detail, extra) {
  try {
    chrome.storage.local.set({
      ['finishStatus:' + tabId]: { tabId, action, detail: detail || '', at: Date.now(), ...(extra || {}) },
    });
  } catch (e) {}
}

// 注入到页面隔离世界执行：探测播放状态与按钮，按需补报进度并点击
async function finishProbeClick(options) {
  const opts = options || {};
  const BTN_TEXT = '点我完成任务';
  const BTN_ICON = 'icon-dianwowanchengrenwu';
  const DONE_ICON = 'icon-studied';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isVisible = (el) => {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch (e) {
      return false;
    }
  };

  const toButton = (el) => {
    if (!el || !el.closest) return el;
    return el.closest('.ta_icon_btn') || el.closest('button') || el.closest('[role="button"]') || el;
  };

  let button = null;
  for (const icon of document.querySelectorAll('.ta_icon_btn i.' + BTN_ICON)) {
    if (isVisible(icon)) {
      button = toButton(icon);
      break;
    }
  }

  if (!button) {
    const root = document.body || document.documentElement;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if ((node.nodeValue || '').trim() !== BTN_TEXT) continue;
        const host = node.parentElement;
        if (!host || !isVisible(host)) continue;
        button = toButton(host);
        break;
      }
    }
  }

  // 已完成时站点把图标换成 icon-studied、文字换成「已完成」
  const doneButton = !button && [...document.querySelectorAll('.ta_icon_btn i.' + DONE_ICON)].find((el) => {
    if (!isVisible(el)) return false;
    return (toButton(el).textContent || '').trim().indexOf('已完成') === 0;
  });
  const finished = !!doneButton;

  let video = null;
  let area = 0;
  for (const item of document.querySelectorAll('video')) {
    if (!isVisible(item)) continue;
    const rect = item.getBoundingClientRect();
    const size = rect.width * rect.height;
    if (size > area) {
      area = size;
      video = item;
    }
  }

  const duration = video ? Number(video.duration) : 0;
  const currentTime = video ? Number(video.currentTime) : 0;
  const ended = !!(video && video.ended);
  const ratio = video && duration > 0 ? currentTime / duration : 0;
  const paused = !video || video.paused;
  // 只有播完或停在结尾附近才点，仍在播放时不打断
  const nearEnd = ended || (duration > 0 && ratio >= 0.95 && paused);

  const info = {
    url: location.href,
    finished,
    hasButton: !!button,
    disabled: !!(button && button.classList && button.classList.contains('disable')),
    hasVideo: !!video,
    area: Math.round(area),
    duration: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : 0,
    currentTime: Number.isFinite(currentTime) ? Math.round(currentTime * 10) / 10 : 0,
    ratio: Math.round(ratio * 1000) / 1000,
    ended,
    paused,
    nearEnd,
    clicked: false,
    flushed: false,
  };

  // 站点只在 timeupdate / pause / seek 时上报进度，播完后末尾 ≤30 秒那段会漏报，
  // 服务端 checkTaskStatus 可能一直判定「视频尚未看完」。播放器监听的是原生 pause
  // 事件，这里补发一次，站点会把累计时长 + 末尾尾巴一起上报，再点按钮。
  const flushTail = async () => {
    if (!video || !(duration > 0) || !nearEnd) return;
    try {
      video.dispatchEvent(new Event('pause', { bubbles: false }));
      info.flushed = true;
      await sleep(600);
    } catch (e) {}
  };

  if (opts.action === 'flush') {
    await flushTail();
    return info;
  }

  if (opts.action !== 'click' || !button || info.disabled) return info;
  // 本框架里有视频但还没看完时绝不点击（后台也会先判断一遍，这里再兜一层）
  if (video && !nearEnd) return info;

  await flushTail();

  try {
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    }));
    info.clicked = true;
    console.log('[WHUT AI] 点击「点我完成任务」', location.href);
  } catch (e) {
    info.error = String((e && e.message) || e);
  }

  return info;
}

function injectFinishProbe(tabId, frameIds, action) {
  return chrome.scripting.executeScript({
    target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
    func: finishProbeClick,
    args: [{ action }],
  });
}

// 连续多次没找到按钮/视频就认为这个页面不需要轮询
async function countFinishMiss(tabId, action, detail) {
  const state = await getFinishState(tabId);
  const misses = (state.misses || 0) + 1;
  if (misses >= FINISH_MAX_MISSES) {
    reportFinishStatus(tabId, action, `${detail}，停止轮询`);
    await stopFinishPolling(tabId);
    return true;
  }
  await setFinishState(tabId, { misses });
  reportFinishStatus(tabId, 'waiting', detail);
  return false;
}

async function runFinishTick(tabId) {
  let results;
  try {
    results = await injectFinishProbe(tabId, null, 'probe');
  } catch (e) {
    // 个别框架不允许注入时退回主框架（按钮和播放器都在主框架里）
    try {
      results = await injectFinishProbe(tabId, [0], 'probe');
    } catch (e2) {
      const text = String((e2 && e2.message) || e2);
      if (/no tab with id|not found|cannot access|tab was closed/i.test(text)) {
        await stopFinishPolling(tabId);
      }
      return;
    }
  }

  const frames = (results || []).map((item) => ({ frameId: item.frameId, ...(item.result || {}) }));
  const buttonFrame = frames.find((f) => f.hasButton);
  const finishedFrame = frames.find((f) => f.finished);
  const videoFrames = frames.filter((f) => f.hasVideo && f.area >= 40000);
  const videoFrame = videoFrames[0];

  if (finishedFrame) {
    reportFinishStatus(tabId, 'finishing', '任务已完成，停止轮询');
    await stopFinishPolling(tabId);
    return;
  }

  if (!buttonFrame) {
    // 任务完成后按钮会消失，连续几次找不到就停止轮询
    await countFinishMiss(tabId, 'no-button', '页面没有找到「点我完成任务」');
    return;
  }

  if (!videoFrame) {
    // 只处理视频任务；文档/讨论等页面不自动点完成
    await countFinishMiss(tabId, 'no-video', '没有检测到视频');
    return;
  }

  await setFinishState(tabId, { misses: 0 });

  const loadingFrame = videoFrames.find((f) => !(f.duration > 0));
  if (loadingFrame) {
    reportFinishStatus(tabId, 'loading', '视频加载中，暂不点击');
    return;
  }

  const playingFrame = videoFrames.find((f) => !f.nearEnd);
  if (playingFrame) {
    reportFinishStatus(tabId, 'playing', `视频还在播放 ${Math.round((playingFrame.ratio || 0) * 100)}%`);
    return;
  }

  if (buttonFrame.disabled) {
    reportFinishStatus(tabId, 'disabled', '按钮当前不可点击');
    return;
  }

  const state = await getFinishState(tabId);
  const clicks = state.clicks || 0;
  if (clicks >= FINISH_MAX_CLICKS) {
    reportFinishStatus(tabId, 'giveup', `已点击 ${clicks} 次仍未完成，停止轮询`);
    await stopFinishPolling(tabId);
    return;
  }

  if (videoFrame && videoFrame.frameId !== buttonFrame.frameId) {
    try { await injectFinishProbe(tabId, [videoFrame.frameId], 'flush'); } catch (e) {}
  }

  let clicked = null;
  try {
    const res = await injectFinishProbe(tabId, [buttonFrame.frameId], 'click');
    clicked = res && res[0] && res[0].result;
  } catch (e) {
    reportFinishStatus(tabId, 'error', `点击失败：${(e && e.message) || e}`);
    return;
  }

  if (clicked && clicked.clicked) {
    await setFinishState(tabId, { clicks: clicks + 1 });
    reportFinishStatus(tabId, 'clicked', clicked.flushed ? '已补报末尾进度并点击' : '已点击', { clicks: clicks + 1 });
  } else {
    reportFinishStatus(tabId, 'waiting', '没有点到按钮，30 秒后重试');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'installHook') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (!tabId) { sendResponse({ error: 'no tab' }); return; }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: installHook,
    }).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'getLogs') {
    const tabId = msg.tabId;
    if (!tabId) { sendResponse({ error: 'no tab' }); return; }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: getLogs,
    }).then((results) => {
      const logs = [];
      for (const r of results || []) {
        if (r.result) logs.push(...r.result);
      }
      sendResponse({ logs });
    }).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'askAI') {
    handleAskAI(msg.question).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (msg.action === 'askChoice') {
    handleAskChoice(msg.question).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (msg.action === 'fetchUnfinishedTasks') {
    fetchUnfinishedTasks(msg.origin, msg.token).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (msg.action === 'openTabs') {
    openUrls(msg.urls || [], msg.mode).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (msg.action === 'pinVideoRate') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (!tabId) { sendResponse({ error: 'no tab' }); return; }
    // 顶层框架请求时覆盖所有框架（含跨域 iframe 里的播放器）；子框架只注入自己
    const target = typeof sender.frameId === 'number' && sender.frameId !== 0
      ? { tabId, frameIds: [sender.frameId] }
      : { tabId, allFrames: true };
    chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func: pinVideoRate,
      args: [Number(msg.rate) || 4],
    }).then((res) => sendResponse({ ok: true, result: res?.[0]?.result }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'notifyVideoEnded') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (!tabId) { sendResponse({ error: 'no tab' }); return; }
    reportFinishStatus(tabId, 'waiting', '视频已播完，30 秒内自动点击');
    ensureFinishAlarm(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'stopFinishPolling') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId) stopFinishPolling(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'finishNow') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) { sendResponse({ error: 'no tab' }); return; }
    // 手动点一次的同时开启 30 秒轮询
    ensureFinishAlarm(tabId);
    runFinishTick(tabId).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(FINISH_ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(FINISH_ALARM_PREFIX.length));
  if (!Number.isFinite(tabId)) return;
  runFinishTick(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopFinishPolling(tabId);
  try { chrome.storage.local.remove('finishStatus:' + tabId); } catch (e) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 整页刷新/跳转后旧任务的轮询作废；新页面看完视频会重新通知
  if (changeInfo.status === 'loading') {
    stopFinishPolling(tabId);
    return;
  }
  const url = changeInfo.url || tab?.url || '';
  if (!MYCOURSE_URL_RE.test(url)) return;
  // SPA 内切换资源后重新计数（点击次数/未找到次数）
  if (changeInfo.url) chrome.storage.session.remove('finishState:' + tabId);
  // 页面一加载就开始轮询：即使 ended 事件没触发、或扩展重载前就打开了窗口，也能点到
  if (changeInfo.status === 'complete' || changeInfo.url) ensureFinishAlarm(tabId);
});

// 扩展安装/更新/重载后，恢复已打开课程页的轮询，并补注入 content script，
// 避免窗口是在上次重载前打开的、页面脚本已失效导致完全没反应。
async function reattachOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || !String(tab.url || '').includes('whut.ai-augmented.com')) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['content.css'] });
    } catch (e) {}
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    } catch (e) {}
    if (MYCOURSE_URL_RE.test(tab.url || '')) ensureFinishAlarm(tab.id);
  }
}

chrome.runtime.onInstalled.addListener(() => { reattachOpenTabs(); });
chrome.runtime.onStartup.addListener(() => { reattachOpenTabs(); });

// 扩展重载会清空 alarms；Service worker 每次启动时按已打开的课程页补建轮询
(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs || []) {
      if (tab.id && MYCOURSE_URL_RE.test(tab.url || '')) ensureFinishAlarm(tab.id);
    }
  } catch (e) {}
})();

// 注入页面主世界：劫持 playbackRate 并持续维持，模仿 Global Speed 的做法
function pinVideoRate(rate) {
  rate = Number(rate);
  if (!(rate > 0)) return 'bad-rate';
  if (rate > 16) rate = 16;
  window.__WHUT_AI_RATE__ = rate;

  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');

  const applyAll = () => {
    const forced = window.__WHUT_AI_RATE__;
    if (!(typeof forced === 'number' && forced > 0)) return;
    const seen = new Set();
    const walk = (root) => {
      try {
        root.querySelectorAll('video, audio').forEach((m) => seen.add(m));
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      } catch (e) {}
    };
    walk(document);
    for (const m of seen) {
      try {
        if (m.playbackRate !== forced) {
          if (desc && desc.set) desc.set.call(m, forced);
          else m.playbackRate = forced;
        }
      } catch (e) {}
    }
  };

  if (window.__WHUT_AI_RATE_PINNED__) {
    applyAll();
    return 'updated';
  }
  window.__WHUT_AI_RATE_PINNED__ = true;

  if (desc && desc.get && desc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        const forced = window.__WHUT_AI_RATE__;
        desc.set.call(this, typeof forced === 'number' && forced > 0 ? forced : value);
      },
    });
  }

  applyAll();
  setInterval(applyAll, 1000);
  return 'pinned';
}

// 倍速变化时广播到所有已打开的课程页（即使页面里的 content script 是旧版本也能生效）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.videoRate) return;
  const rate = Number(changes.videoRate.newValue);
  if (!Number.isFinite(rate) || rate <= 0) return;
  chrome.tabs.query({ url: 'https://whut.ai-augmented.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab.id) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: pinVideoRate,
        args: [rate],
      }).catch(() => {});
    }
  });
});

async function fetchUnfinishedTasks(origin, token) {
  const base = String(origin || 'https://whut.ai-augmented.com').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(`${base}/api/jx-stat/group/task/un_finish`, {
    method: 'GET',
    credentials: 'include',
    headers,
  });

  if (!resp.ok) {
    return { error: resp.status === 401 ? '登录状态已失效，请刷新页面重新登录' : `HTTP ${resp.status}` };
  }

  const data = await resp.json();
  if (data && data.code !== 0) {
    return { error: data.message || `接口返回 code=${data.code}` };
  }

  const list = data && (data.data ?? data.list);
  return { tasks: Array.isArray(list) ? list : [] };
}

async function openUrls(urls, mode) {
  const valid = urls.filter((u) => /^https?:\/\//.test(u));
  if (valid.length === 0) return { opened: 0 };

  if (mode === 'window') {
    // 视频任务：每个链接单独一个普通窗口（非全屏、非最大化），窗口不抢焦点
    let opened = 0;
    for (let i = 0; i < valid.length; i++) {
      try {
        await chrome.windows.create({
          url: valid[i],
          type: 'normal',
          state: 'normal',
          focused: false,
          width: 1280,
          height: 900,
          left: 40 + (i % 8) * 32,
          top: 30 + (i % 8) * 24,
        });
        opened++;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 300));
    }
    return { opened };
  }

  let opened = 0;
  for (const url of valid) {
    try {
      await chrome.tabs.create({ url, active: false });
      opened++;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return { opened };
}

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: '',
      model: 'gpt-4o-mini',
      systemPrompt: '你是一个专业的学术助手，擅长回答各类课程简答题。请用清晰、准确、有条理的方式回答问题。如果问题涉及计算，请给出详细步骤。回答长度适中，重点突出。',
    }, resolve);
  });
}

const CHOICE_SYSTEM_PROMPT = [
  '你是课程测验作答助手。',
  '只输出 JSON：{"answer":["A"]}；多选题输出多个字母；判断题 A=正确，B=错误。',
  '不要输出思考过程、解释或 Markdown。',
].join('');

async function chatCompletion(config, messages, temperature, maxTokens, timeoutMs = 25000) {
  if (!config.apiKey) {
    return { error: '请先在插件弹窗中配置 API Key' };
  }

  // 自动补全 API 路径：用户可能只填了域名（如 https://api.deepseek.com）
  let apiUrl = config.apiUrl.trim();
  if (!/chat\/completions\/?$/.test(apiUrl)) {
    apiUrl = apiUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  }

  const body = {
    model: config.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // 没有超时的话，慢连接会让弹窗一直停在「作答中」
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
      return { error: `API 请求超时（${Math.round(timeoutMs / 1000)} 秒）` };
    }
    return { error: `网络请求失败：${(e && e.message) || e}` };
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 404) {
      return { error: `404：API 地址不存在 (${apiUrl})，请检查地址是否正确，例如 https://api.deepseek.com/v1/chat/completions` };
    }
    return { error: `API 请求失败 (${resp.status}): ${text.slice(0, 200)}` };
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  let answer = choice?.message?.content;

  // 少数服务把 content 返回成分段数组
  if (Array.isArray(answer)) {
    answer = answer.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }

  // 推理模型的思维链可能占满 token，导致 content 为空；尽量从推理内容里捞答案
  if (!answer && choice?.message?.reasoning_content) {
    const m = String(choice.message.reasoning_content).match(/\{\s*"answer"\s*:\s*\[[^\]]*\]\s*\}/);
    if (m) answer = m[0];
  }

  if (!answer) {
    const bits = [`model=${config.model}`];
    if (choice?.finish_reason) bits.push(`finish_reason=${choice.finish_reason}`);
    if (choice?.message?.reasoning_content) bits.push('仅有推理内容');
    if (data.error?.message) bits.push(String(data.error.message).slice(0, 120));
    return { error: `AI 返回为空（${bits.join('，')}）` };
  }

  return { answer };
}

async function handleAskAI(question) {
  const config = await getConfig();
  return chatCompletion(config, [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: question },
  ], 0.7, 2000);
}

async function handleAskChoice(question) {
  const config = await getConfig();
  const res = await chatCompletion(config, [
    { role: 'system', content: CHOICE_SYSTEM_PROMPT },
    { role: 'user', content: question },
  ], 0, 2000);

  // 空回复多半是模型把 token 花在推理上，换更硬的指令重试一次
  if (res.error && /返回为空/.test(res.error)) {
    const retry = await chatCompletion(config, [
      { role: 'system', content: '只输出 JSON，例如 {"answer":["A"]}；不要输出任何思考过程或解释。' },
      { role: 'user', content: question },
    ], 0, 2000);
    if (!retry.error) return retry;
    return { error: `${res.error}；重试后：${retry.error}` };
  }

  return res;
}
