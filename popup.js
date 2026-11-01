const $ = (sel) => document.querySelector(sel);

const els = {
  statusDot: $('#statusDot'),
  statsBar: $('#statsBar'),
  statLogs: $('#statLogs'),
  statQuestions: $('#statQuestions'),
  statInputs: $('#statInputs'),
  btnGrab: $('#btnGrab'),
  btnFill: $('#btnFill'),
  btnWatch: $('#btnWatch'),
  watchHint: $('#watchHint'),
  btnScanObjective: $('#btnScanObjective'),
  btnAnswerObjective: $('#btnAnswerObjective'),
  objectiveHint: $('#objectiveHint'),
  objectiveSelectAllRow: $('#objectiveSelectAllRow'),
  chkAllObjective: $('#chkAllObjective'),
  objectiveMatchHint: $('#objectiveMatchHint'),
  objectiveSection: $('#objectiveSection'),
  objectiveList: $('#objectiveList'),
  btnFinish: $('#btnFinish'),
  finishHint: $('#finishHint'),
  speedRange: $('#speedRange'),
  speedValue: $('#speedValue'),
  selectAllRow: $('#selectAllRow'),
  chkAll: $('#chkAll'),
  matchHint: $('#matchHint'),
  resultSection: $('#resultSection'),
  questionList: $('#questionList'),
  btnToggleRaw: $('#btnToggleRaw'),
  rawLog: $('#rawLog'),
  btnToggleConfig: $('#btnToggleConfig'),
  configSection: $('#configSection'),
  apiUrl: $('#apiUrl'),
  apiKey: $('#apiKey'),
  model: $('#model'),
  systemPrompt: $('#systemPrompt'),
  btnSave: $('#btnSave'),
  toast: $('#toast'),
};

let grabbed = { logs: [], questions: [], inputCount: 0 };
let objective = { questions: [] };

const CHOICE_TYPE_TEXT = { single: '单选', multiple: '多选', judge: '判断' };

function showToast(msg, duration = 2500) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  setTimeout(() => els.toast.classList.remove('show'), duration);
}

function setWorking(working) {
  els.statusDot.classList.toggle('active', working);
  els.btnGrab.disabled = working;
  els.btnFill.disabled = working || grabbed.questions.length === 0;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp);
    });
  });
}

function sendToTab(tabId, msg, frameId) {
  return new Promise((resolve) => {
    const done = (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp);
    };
    if (typeof frameId === 'number') chrome.tabs.sendMessage(tabId, msg, { frameId }, done);
    else chrome.tabs.sendMessage(tabId, msg, done);
  });
}

const NO_RECEIVER_RE = /Receiving end does not exist|message port closed|Could not establish connection/i;

// 扩展重载后旧页面不会自动注入新 content script，这里注入一次再重试
async function sendToTabWithRetry(tabId, msg, frameId) {
  let res = await sendToTab(tabId, msg, frameId);
  if (res?.error && NO_RECEIVER_RE.test(res.error)) {
    const target = { tabId };
    if (typeof frameId === 'number') target.frameIds = [frameId];
    try {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
    } catch (e) {}
    try {
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 150));
      res = await sendToTab(tabId, msg, frameId);
    } catch (e) {
      return { error: `无法注入脚本：${e.message}` };
    }
  }
  return res;
}

// 题目可能渲染在 iframe 里：先列出所有 frame，再逐帧注入 content.js
async function listFrameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    const ids = (results || []).map((r) => r.frameId).filter((id) => typeof id === 'number');
    return ids.length ? ids : [0];
  } catch (e) {
    return [0];
  }
}

async function injectFrames(tabId, frameIds) {
  for (const frameId of frameIds) {
    const target = { tabId, frameIds: [frameId] };
    try {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
    } catch (e) {}
    try {
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
    } catch (e) {
      // 跨域/沙箱 iframe 注入失败时保留该帧，发送消息会自然报错
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}

async function collectObjective(tabId, frameIds) {
  const questions = [];
  const diag = { frames: frameIds.length, controls: 0, usable: 0, groups: 0, divOptions: 0, iframes: 0, shadowRoots: 0, frameErrors: 0 };
  const details = [];

  for (const frameId of frameIds) {
    const res = await sendToTab(tabId, { action: 'scanObjectiveV2' }, frameId);
    if (!res || res.error) {
      diag.frameErrors++;
      details.push({ frameId, error: (res && res.error) || '无响应' });
      logOp('客观题', `框架 #${frameId} 扫描失败：${(res && res.error) || '无响应'}`);
      continue;
    }
    mergeLogs(`框架 #${frameId}`, res.logs);
    const d = res.diag || {};
    for (const key of ['controls', 'usable', 'groups', 'divOptions', 'iframes', 'shadowRoots']) {
      diag[key] += Number(d[key]) || 0;
    }
    for (const q of res.questions || []) {
      questions.push({ ...q, frameId, localIndex: q.index, index: questions.length });
    }
    if (d.controls || d.divOptions) details.push({ frameId, ...d });
  }

  return { questions, diag, details };
}

async function scanObjectiveAllFrames(tabId) {
  // 题目可能渲染在 iframe 里：先列出所有 frame，再逐帧注入 content.js
  let last = { questions: [], diag: {}, details: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const frameIds = await listFrameIds(tabId);
    await injectFrames(tabId, frameIds);
    last = await collectObjective(tabId, frameIds);
    if (last.questions.length) break;
    // iframe 或题目列表可能还在渲染，稍等再试一次
    if (attempt < 2) await new Promise((r) => setTimeout(r, 900));
  }
  return last;
}

// ---- 从控制台日志中解析题目 ----

function extractQuestions(logs) {
  const seen = new Set();
  const out = [];

  // 模式1（该平台实际格式）: strToEditorState {"blocks":[{"text":"题目..."}...}
  // Draft.js 编辑器初始化时打印，question 文本在 blocks[].text 里
  for (const entry of logs) {
    const text = entry?.t || entry?.text || '';
    if (!text) continue;

    const idx = text.indexOf('strToEditorState {');
    if (idx === -1) continue;

    const jsonStr = text.slice(idx + 'strToEditorState '.length);
    try {
      const data = JSON.parse(jsonStr);
      const q = (data.blocks || [])
        .map((b) => (b.text || '').trim())
        .filter(Boolean)
        .join('\n');
      if (q.length >= 5 && !seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    } catch (e) {
      // JSON 不完整则跳过
    }
  }

  if (out.length > 0) return out;

  // 模式2（通用兜底）: JSON 中的题目字段 / 整行问句
  const KEY_RE = /["']?(?:question|stem|title|topic|problem|qtext|questionTitle)["']?\s*[:：]\s*["'`]([^"'`]{8,1000})["'`]/gi;
  const Q_PREFIX = /^(?:题目|问题|简答题?|问答|【[^】]*】|第\s*[0-9一二三四五六七八九十百]+\s*[题、.):：])/;

  for (const entry of logs) {
    const text = entry?.t || entry?.text || '';
    if (!text) continue;

    KEY_RE.lastIndex = 0;
    let m;
    while ((m = KEY_RE.exec(text)) !== null) {
      const q = m[1].trim();
      if (q.length >= 8 && !seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }

    const t = text.trim();
    const looksLikeQuestion =
      (t.length >= 12 && /[？?]\s*$/.test(t)) || Q_PREFIX.test(t);
    if (looksLikeQuestion && t.length <= 2000 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }

  return out;
}

let opLogs = [];
const OP_LOG_KEY = 'opLogs';

function saveOpLogs() {
  try {
    const p = chrome.storage.session.set({ [OP_LOG_KEY]: opLogs });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

function logOp(source, msg) {
  const hms = new Date().toTimeString().slice(0, 8);
  opLogs.push(`[${hms}] [${source}] ${msg}`);
  if (opLogs.length > 300) opLogs.splice(0, opLogs.length - 300);
  renderRawLog();
  saveOpLogs();
}

// 弹窗重新打开时恢复上一轮日志（storage.session 只在本次浏览器会话内保留）
(async () => {
  try {
    const data = await chrome.storage.session.get(OP_LOG_KEY);
    const saved = data && data[OP_LOG_KEY];
    if (Array.isArray(saved) && saved.length) {
      opLogs = saved;
      renderRawLog();
    }
  } catch (e) {}
})();

// content.js 返回的日志自带 [HH:MM:SS] 前缀，这里只补上来源框架
function mergeLogs(source, logs) {
  if (!Array.isArray(logs) || !logs.length) return;
  for (const line of logs) {
    const text = String(line);
    const m = text.match(/^(\[[^\]]+\])\s*(.*)$/);
    opLogs.push(`[${source}] ${m ? `${m[1]} ${m[2]}` : text}`);
  }
  if (opLogs.length > 300) opLogs.splice(0, opLogs.length - 300);
  renderRawLog();
  saveOpLogs();
}

function buildRawLogText() {
  const parts = [];
  const pageLogs = grabbed.logs.slice(-50);
  if (pageLogs.length) {
    parts.push(`==== 页面控制台（最近 ${pageLogs.length} 条） ====`);
    for (const e of pageLogs) parts.push(`[${e.m || 'log'}] ${(e.t || '').slice(0, 300)}`);
  }
  if (opLogs.length) {
    if (parts.length) parts.push('');
    parts.push(`==== 插件操作日志（最近 ${opLogs.length} 条） ====`);
    parts.push(...opLogs.slice(-150));
  }
  return parts.join('\n') || '（暂无日志：先点「抓取题目」或「扫描客观题」）';
}

function renderRawLog() {
  els.rawLog.textContent = buildRawLogText();
}

function renderQuestions() {
  const { questions, inputCount } = grabbed;

  els.statsBar.style.display = 'flex';
  els.statLogs.textContent = grabbed.logs.length;
  els.statQuestions.textContent = questions.length;
  els.statInputs.textContent = inputCount;

  renderRawLog();

  if (questions.length === 0) {
    els.resultSection.style.display = 'block';
    els.selectAllRow.style.display = 'none';
    els.questionList.innerHTML =
      '<div class="empty">未从日志解析到题目。<br>请打开 F12 控制台确认题目已打印，<br>再点下方「查看原始日志」看抓取到的内容。</div>';
    return;
  }

  els.resultSection.style.display = 'block';
  els.selectAllRow.style.display = 'flex';

  if (inputCount === questions.length) {
    els.matchHint.textContent = '✅ 题目数与输入框数一致，按顺序填入';
    els.matchHint.style.color = '#00cc44';
  } else {
    els.matchHint.textContent = `⚠️ ${questions.length} 题 vs ${inputCount} 个输入框，按顺序填入前 ${Math.min(questions.length, inputCount)} 题`;
    els.matchHint.style.color = '#ffaa00';
  }

  els.questionList.innerHTML = questions.map((q, i) => `
    <div class="question-item">
      <input type="checkbox" class="q-chk" data-index="${i}" checked>
      <span class="q-num">${i + 1}</span>
      <span class="q-text" title="${escapeHtml(q)}">${escapeHtml(q.slice(0, 90))}${q.length > 90 ? '…' : ''}</span>
    </div>
  `).join('');

  els.btnFill.disabled = false;
  updateChkAll();
}

function updateChkAll() {
  const chks = document.querySelectorAll('.q-chk');
  const checked = document.querySelectorAll('.q-chk:checked');
  els.chkAll.checked = chks.length > 0 && chks.length === checked.length;
}

els.btnGrab.addEventListener('click', async () => {
  setWorking(true);
  els.btnGrab.textContent = '抓取中...';

  const tab = await getActiveTab();
  if (!tab?.url?.includes('whut.ai-augmented.com')) {
    showToast('请先打开 WHUT 课程页面');
    setWorking(false);
    els.btnGrab.textContent = '📋 抓取题目';
    return;
  }

  // 先确保钩子已安装（刷新页面后 content script 会自动装，这里兜底）
  await sendToBackground({ action: 'installHook', tabId: tab.id });

  const [logResp, inputResp] = await Promise.all([
    sendToBackground({ action: 'getLogs', tabId: tab.id }),
    sendToTab(tab.id, { action: 'countInputs' }),
  ]);

  if (logResp?.error) {
    logOp('简答题', `抓取日志失败：${logResp.error}`);
    showToast('获取日志失败: ' + logResp.error);
    setWorking(false);
    els.btnGrab.textContent = '📋 抓取题目';
    return;
  }

  grabbed.logs = logResp.logs || [];
  grabbed.questions = extractQuestions(grabbed.logs);
  grabbed.inputCount = inputResp?.count ?? 0;

  logOp('简答题', `抓取完成：页面日志 ${grabbed.logs.length} 条，解析出题目 ${grabbed.questions.length} 道，输入框 ${grabbed.inputCount} 个${inputResp?.error ? `（content 响应：${inputResp.error}）` : ''}`);

  renderQuestions();
  showToast(`抓到 ${grabbed.logs.length} 条日志，解析出 ${grabbed.questions.length} 道题目`);

  els.btnGrab.textContent = '📋 抓取题目';
  setWorking(false);
});

els.chkAll.addEventListener('change', () => {
  document.querySelectorAll('.q-chk').forEach((c) => {
    c.checked = els.chkAll.checked;
  });
});

els.questionList.addEventListener('change', (e) => {
  if (e.target.classList.contains('q-chk')) updateChkAll();
});

els.btnFill.addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('.q-chk:checked'))
    .map((c) => ({
      index: Number(c.dataset.index),
      question: grabbed.questions[Number(c.dataset.index)],
    }));

  if (selected.length === 0) {
    showToast('请先勾选要作答的题目');
    return;
  }

  setWorking(true);
  els.btnFill.textContent = '作答中...';

  const tab = await getActiveTab();
  logOp('简答题', `开始填入 ${selected.length} 题，页面：${tab?.url || '未知'}`);
  const result = await sendToTab(tab.id, { action: 'fill', items: selected });

  mergeLogs('简答题', result && result.logs);

  if (result?.error) {
    logOp('简答题', `作答失败：${result.error}`);
    showToast('错误: ' + result.error);
  } else {
    const failed = result.results.filter((r) => !r.ok);
    logOp('简答题', `本轮完成 ${result.filled}/${result.total} 题${failed.length ? `，失败 ${failed.length} 题` : ''}`);
    for (const f of failed) {
      logOp('简答题', `第 ${Number(f.index) + 1} 题失败：${f.error || '输入框未写入'}`);
    }
    if (failed.length === 0) {
      showToast(`✅ 全部成功！共填入 ${result.filled} 题`);
    } else {
      const firstErr = failed[0].error || '填入失败';
      showToast(`完成 ${result.filled}/${result.total}，首个失败: ${firstErr}`, 4000);
    }
  }

  els.btnFill.textContent = '🚀 生成并填入';
  setWorking(false);
});

// ---- 客观题：扫描 → AI 判断 → 自动勾选 ----

function renderObjective() {
  const { questions } = objective;

  if (questions.length === 0) {
    els.objectiveSection.style.display = 'none';
    els.objectiveSelectAllRow.style.display = 'none';
    els.btnAnswerObjective.disabled = true;
    return;
  }

  els.objectiveSection.style.display = 'block';
  els.objectiveSelectAllRow.style.display = 'flex';
  els.objectiveMatchHint.textContent = `共 ${questions.length} 题`;
  els.objectiveMatchHint.style.color = '#888';

  els.objectiveList.innerHTML = questions.map((q, i) => {
    const typeText = CHOICE_TYPE_TEXT[q.type] || '客观';
    const opts = q.options.map((o) => `${o.letter}. ${o.text}`).join('  ');
    return `
      <div class="question-item">
        <input type="checkbox" class="q-chk o-chk" data-index="${q.index}" checked>
        <span class="q-num">${i + 1}</span>
        <span class="q-type ${q.type}">${typeText}</span>
        <span class="q-text" title="${escapeHtml(q.stem)}">${escapeHtml(q.stem.slice(0, 70))}${q.stem.length > 70 ? '…' : ''}<br><span class="hint">${escapeHtml(opts.slice(0, 90))}</span></span>
      </div>
    `;
  }).join('');

  els.btnAnswerObjective.disabled = false;
  updateChkAllObjective();
}

function updateChkAllObjective() {
  const chks = document.querySelectorAll('.o-chk');
  const checked = document.querySelectorAll('.o-chk:checked');
  els.chkAllObjective.checked = chks.length > 0 && chks.length === checked.length;
  els.btnAnswerObjective.disabled = chks.length === 0 || checked.length === 0;
}

els.btnScanObjective.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.url?.includes('whut.ai-augmented.com')) {
    showToast('请先打开 WHUT 作业/测试页面');
    return;
  }

  els.btnScanObjective.disabled = true;
  els.btnScanObjective.textContent = '扫描中...';

  const res = await scanObjectiveAllFrames(tab.id);

  els.btnScanObjective.disabled = false;
  els.btnScanObjective.textContent = '🎯 扫描客观题';

  const d0 = res.diag || {};
  logOp('客观题', `扫描完成：检查 ${d0.frames ?? 1} 个框架，控件 ${d0.controls ?? 0}（可用 ${d0.usable ?? 0}），div 选项 ${d0.divOptions ?? 0}，分组 ${d0.groups ?? 0}，题目 ${(res.questions || []).length} 道`);
  logOp('客观题', `页面：${tab.url || '未知'}`);

  objective.questions = res.questions || [];
  renderObjective();

  if (objective.questions.length === 0) {
    const d = res.diag || {};
    els.objectiveHint.textContent = [
      `未找到客观题：已检查 ${d.frames ?? 1} 个框架`,
      `控件 ${d.controls ?? 0} 个（可用 ${d.usable ?? 0}）`,
      `div 选项 ${d.divOptions ?? 0} 个`,
      `分组 ${d.groups ?? 0} 个`,
      d.iframes ? `子 iframe ${d.iframes} 个` : '',
      d.frameErrors ? `无法读取的框架 ${d.frameErrors} 个` : '',
    ].filter(Boolean).join('，');
    showToast('未找到客观题', 4000);
    return;
  }

  const counts = objective.questions.reduce((acc, q) => {
    acc[q.type] = (acc[q.type] || 0) + 1;
    return acc;
  }, {});
  els.objectiveHint.textContent = [
    `共 ${objective.questions.length} 题`,
    counts.single ? `单选 ${counts.single}` : '',
    counts.multiple ? `多选 ${counts.multiple}` : '',
    counts.judge ? `判断 ${counts.judge}` : '',
  ].filter(Boolean).join(' · ');

  showToast(`扫描到 ${objective.questions.length} 道客观题`);
});

els.chkAllObjective.addEventListener('change', () => {
  document.querySelectorAll('.o-chk').forEach((c) => {
    c.checked = els.chkAllObjective.checked;
  });
  updateChkAllObjective();
});

els.objectiveList.addEventListener('change', (e) => {
  if (e.target.classList.contains('o-chk')) updateChkAllObjective();
});

els.btnAnswerObjective.addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('.o-chk:checked'))
    .map((c) => objective.questions[Number(c.dataset.index)])
    .filter(Boolean);

  if (selected.length === 0) {
    showToast('请先勾选要作答的题目');
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.url?.includes('whut.ai-augmented.com')) {
    showToast('请先打开 WHUT 作业/测试页面');
    return;
  }

  els.btnAnswerObjective.disabled = true;
  els.btnAnswerObjective.textContent = '作答中...';
  els.objectiveHint.textContent = `AI 请求中（${selected.length} 题并发，单次最长约 25 秒，超时会记入日志）...`;

  // 题目可能分布在多个 iframe 里，按 frame 分组分别作答
  const byFrame = new Map();
  for (const q of selected) {
    const frameId = typeof q.frameId === 'number' ? q.frameId : 0;
    if (!byFrame.has(frameId)) byFrame.set(frameId, []);
    byFrame.get(frameId).push({ index: typeof q.localIndex === 'number' ? q.localIndex : q.index });
  }

  const results = [];
  let frameError = '';
  for (const [frameId, items] of byFrame) {
    logOp('客观题', `框架 #${frameId} 开始作答 ${items.length} 题（序号 ${items.map((i) => i.index + 1).join(',')}）`);
    let res = await sendToTabWithRetry(tab.id, { action: 'fillObjectiveV2', items }, frameId);
    if (res?.error && NO_RECEIVER_RE.test(res.error)) {
      logOp('客观题', `框架 #${frameId} 无响应，补注入后重试`);
      await injectFrames(tab.id, [frameId]);
      res = await sendToTab(tab.id, { action: 'fillObjectiveV2', items }, frameId);
    }
    if (!res || res.error) {
      const err = (res && res.error) || '页面无响应';
      frameError = frameError || err;
      logOp('客观题', `框架 #${frameId} 作答失败：${err}`);
      for (const it of items) results.push({ index: it.index, ok: false, error: err });
      continue;
    }
    mergeLogs(`框架 #${frameId}`, res.logs);
    logOp('客观题', `框架 #${frameId} 完成：成功 ${res.answered ?? 0}/${res.total ?? items.length} 题`);
    for (const r of res.results || []) {
      results.push({ index: r.index, ok: r.ok, error: r.error });
      if (!r.ok) logOp('客观题', `第 ${Number(r.index) + 1} 题失败：${r.error || '点击未生效'}`);
    }
  }

  els.btnAnswerObjective.textContent = '🤖 AI 作答并勾选';
  els.btnAnswerObjective.disabled = false;

  const answered = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  logOp('客观题', `本轮完成：成功 ${answered}/${selected.length} 题${failed.length ? `，失败 ${failed.length} 题` : ''}`);

  if (failed.length === 0) {
    els.objectiveHint.textContent = `全部完成：${answered}/${selected.length} 题已勾选`;
    showToast(`✅ 已完成 ${answered} 道客观题`);
  } else {
    els.objectiveHint.textContent = `完成 ${answered}/${selected.length}，失败 ${failed.length} 题：${failed[0].error || '点击未生效'}`;
    showToast(`完成 ${answered}/${selected.length}，首个失败：${failed[0].error || frameError || '未勾选成功'}`, 4500);
  }
});

els.btnWatch.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.url?.includes('whut.ai-augmented.com')) {
    showToast('请先打开 WHUT 课程页面');
    return;
  }

  els.btnWatch.disabled = true;
  els.btnWatch.textContent = '执行中...';
  els.watchHint.textContent = '正在打开「待完成任务」，点击日历红点并读取任务数据，请保持页面在前台...';

  const res = await sendToTabWithRetry(tab.id, { action: 'autoOpenWatch' });

  els.btnWatch.disabled = false;
  els.btnWatch.textContent = '📺 扫描并打开「自主观看」任务';

  if (!res) {
    els.watchHint.textContent = '';
    showToast('页面无响应，请刷新课程页面后重试', 4000);
    return;
  }

  if (res.error) {
    els.watchHint.textContent = '';
    const msg = NO_RECEIVER_RE.test(res.error)
      ? '页面脚本未就绪，请按 F5 刷新课程页面后重试'
      : res.error;
    showToast(msg, 4000);
    return;
  }

  els.watchHint.textContent = [
    res.modalOpened ? '已打开任务面板' : '未找到任务面板，已改用接口数据',
    `日历红点周 ${res.weekClicks} 个`,
    `界面识别 ${res.scanned} 条`,
    `新窗口 ${res.windowOpened ?? 0} 个 · 标签页 ${res.tabOpened ?? 0} 个`,
  ].join(' · ');

  if (res.watchUrls > 0) {
    showToast(`已打开 ${res.opened} 个任务：视频 ${res.windowOpened ?? 0} 个在新窗口自动播放`, 4500);
  } else {
    showToast('没有找到「自主观看」任务');
  }
});

// ---- 「点我完成任务」轮询状态 / 手动点击 ----

const FINISH_ACTION_TEXT = {
  waiting: '等待轮询',
  playing: '视频还在播放',
  loading: '视频加载中',
  clicked: '已点击「点我完成任务」',
  finishing: '任务已完成，已停止轮询',
  'no-button': '没找到「点我完成任务」按钮',
  'no-video': '没检测到视频',
  disabled: '按钮当前不可点',
  giveup: '多次点击仍未完成，已停止轮询',
  error: '执行出错',
};

let finishTabId = null;

function renderFinishStatus(status) {
  if (!status) {
    els.finishHint.textContent = '轮询状态：视频播完后每 30 秒自动点击一次';
    return;
  }
  const time = new Date(status.at).toLocaleTimeString('zh-CN', { hour12: false });
  const text = status.detail || FINISH_ACTION_TEXT[status.action] || status.action;
  els.finishHint.textContent = `轮询 ${time}：${text}`;
}

async function loadFinishStatus(tabId) {
  if (!tabId) return;
  const key = 'finishStatus:' + tabId;
  const data = await new Promise((resolve) => chrome.storage.local.get(key, resolve));
  renderFinishStatus(data[key]);
}

async function initFinishSection() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  finishTabId = tab.id;
  await loadFinishStatus(tab.id);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !finishTabId) return;
  const change = changes['finishStatus:' + finishTabId];
  if (change) renderFinishStatus(change.newValue);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  finishTabId = tabId;
  loadFinishStatus(tabId);
});

els.btnFinish.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.url?.includes('whut.ai-augmented.com')) {
    showToast('请先切换到 WHUT 课程视频页面');
    return;
  }

  els.btnFinish.disabled = true;
  els.btnFinish.textContent = '检查并点击中...';

  const res = await sendToBackground({ action: 'finishNow', tabId: tab.id });

  els.btnFinish.disabled = false;
  els.btnFinish.textContent = '✅ 立即点击「点我完成任务」';

  if (res?.error) {
    showToast('执行失败: ' + res.error, 4000);
  }
  finishTabId = tab.id;
  loadFinishStatus(tab.id);
});

initFinishSection();

els.btnToggleRaw.addEventListener('click', () => {
  const visible = els.rawLog.style.display !== 'none';
  els.rawLog.style.display = visible ? 'none' : 'block';
  if (!visible) renderRawLog();
});

els.btnToggleConfig.addEventListener('click', () => {
  const visible = els.configSection.style.display !== 'none';
  els.configSection.style.display = visible ? 'none' : 'block';
});

els.btnSave.addEventListener('click', async () => {
  const config = {
    apiUrl: els.apiUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    systemPrompt: els.systemPrompt.value.trim(),
  };
  if (!config.apiKey) {
    showToast('请填写 API Key');
    return;
  }
  await new Promise((resolve) => chrome.storage.local.set(config, resolve));
  showToast('设置已保存');
});

const SPEED_STOPS = [4, 8, 12, 16];

function renderSpeed(rate) {
  els.speedValue.textContent = `${rate}x`;
}

els.speedRange.addEventListener('input', () => {
  renderSpeed(Number(els.speedRange.value));
});

els.speedRange.addEventListener('change', async () => {
  const rate = Number(els.speedRange.value);
  if (!SPEED_STOPS.includes(rate)) return;
  renderSpeed(rate);
  await new Promise((resolve) => chrome.storage.local.set({ videoRate: rate }, resolve));
  showToast(`视频倍速已设为 ${rate}x，已同步到打开的视频页`);
});

(async () => {
  const speed = await new Promise((resolve) => {
    chrome.storage.local.get({ videoRate: 4 }, resolve);
  });
  const rate = SPEED_STOPS.includes(Number(speed.videoRate)) ? Number(speed.videoRate) : 4;
  els.speedRange.value = String(rate);
  renderSpeed(rate);
})();

(async () => {
  const config = await new Promise((resolve) => {
    chrome.storage.local.get({
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: '',
      model: 'gpt-4o-mini',
      systemPrompt: '你是一个专业的学术助手，擅长回答各类课程简答题。请用清晰、准确、有条理的方式回答问题。如果问题涉及计算，请给出详细步骤。回答长度适中，重点突出。',
    }, resolve);
  });

  els.apiUrl.value = config.apiUrl;
  els.apiKey.value = config.apiKey;
  els.model.value = config.model;
  els.systemPrompt.value = config.systemPrompt;
})();
