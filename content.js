(() => {
  'use strict';

  // 扩展重载后 popup 可能用 scripting 再次注入，避免重复注册监听。
  // 标记写死在这里而不是用 manifest.version：没重载扩展时 manifest 还是旧版本号，
  // 会导致补注入的新脚本被旧页面的标记挡住。
  const CONTENT_BUILD = '2026-11-01-choice-10';
  if (window.__whutAiAnswerInjected === CONTENT_BUILD) return;
  window.__whutAiAnswerInjected = CONTENT_BUILD;

  // document_start 阶段就安装控制台钩子，确保不漏掉页面早期打印的题目
  try {
    chrome.runtime.sendMessage({ action: 'installHook' });
  } catch (e) {}

  const S = { working: false, watchWorking: false };

  // 运行日志：popup 的「查看原始日志」会展示这些记录，便于定位失败原因
  const OPLOG = [];
  function opLog(msg) {
    try {
      const hms = new Date().toTimeString().slice(0, 8);
      OPLOG.push(`[${hms}] ${msg}`);
      if (OPLOG.length > 200) OPLOG.splice(0, OPLOG.length - 200);
    } catch (e) {}
  }
  function takeLogs() {
    return OPLOG.slice(-60);
  }
  // 视频日志同时进页面控制台：弹窗的「页面控制台」里也能看到点击落点
  function videoLog(msg) {
    opLog(msg);
    try { console.log(`[WHUT AI] ${msg}`); } catch (e) {}
  }

  const ANSWER_SEL = [
    'textarea',
    'input[type="text"]',
    'input:not([type])',
    '[contenteditable="true"]',
    '[role="textbox"]',
  ].join(', ');

  function findAnswerInputs() {
    const els = Array.from(document.querySelectorAll(ANSWER_SEL));
    return els.filter((el) => {
      try {
        if (el.disabled || el.readOnly) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 18) return false;
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        if (/search|搜索/.test(ph)) return false;
        return true;
      } catch (e) {
        return false;
      }
    });
  }

  function clearContentEditable(el) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }

  function firePaste(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const evt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      return el.dispatchEvent(evt);
    } catch (e) {
      return false;
    }
  }

  function setAnswer(el, text) {
    const tag = el.tagName.toLowerCase();

    if (tag === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (tag === 'input') {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el.contentEditable === 'true' || el.getAttribute('role') === 'textbox') {
      // Draft.js 等富文本编辑器靠监听 paste/beforeinput 更新内部状态，
      // 直接改 DOM (insertText) 不会被它感知，重渲染后会和占位符叠在一起显示。
      clearContentEditable(el);
      const pasted = firePaste(el, text);

      const applied = (el.innerText || el.textContent || '').trim().length > 0;
      if (!pasted || !applied) {
        document.execCommand('insertText', false, text);
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return true;
    }

    return false;
  }

  function highlight(el, color) {
    try {
      const orig = el.style.cssText;
      el.style.outline = `3px solid ${color}`;
      el.style.outlineOffset = '2px';
      setTimeout(() => { el.style.cssText = orig; }, 2500);
    } catch (e) {}
  }

  function overlay(msg) {
    let el = document.getElementById('whut-ai-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'whut-ai-overlay';
      document.documentElement.appendChild(el);
    }
    if (msg === null) {
      el.style.display = 'none';
      return;
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function callAI(question) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'askAI', question }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { error: '无响应' });
      });
    });
  }

  async function processFill(items) {
    if (S.working) return { error: '正在处理中，请稍候' };
    S.working = true;

    const inputs = findAnswerInputs();
    const results = [];
    opLog(`[简答题] 开始作答 ${items.length} 题，页面输入框 ${inputs.length} 个`);

    for (let i = 0; i < items.length; i++) {
      const { index, question } = items[i];
      overlay(`AI 作答中：第 ${i + 1} / ${items.length} 题...`);

      const target = inputs[index] || null;
      if (!target) {
        opLog(`[简答题] 第 ${index + 1} 题：未找到对应输入框`);
        results.push({ index, ok: false, error: '未找到对应输入框' });
        continue;
      }

      highlight(target, '#ffaa00');
      const r = await callAI(question);
      if (r.error) {
        opLog(`[简答题] 第 ${index + 1} 题：AI 失败 - ${r.error}`);
        results.push({ index, ok: false, error: r.error });
        highlight(target, '#ff4444');
        continue;
      }

      const ok = setAnswer(target, r.answer);
      opLog(`[简答题] 第 ${index + 1} 题：${ok ? '已填入' : '填入失败'}，AI 回复 ${String(r.answer || '').length} 字：${String(r.answer || '').slice(0, 80).replace(/\s+/g, ' ')}`);
      highlight(target, ok ? '#00cc44' : '#ff4444');
      results.push({ index, ok, answerPreview: (r.answer || '').slice(0, 60) });

      await new Promise((rs) => setTimeout(rs, 300));
    }

    const filled = results.filter((r) => r.ok).length;
    opLog(`[简答题] 完成：成功 ${filled} / ${items.length} 题`);
    overlay(`完成：成功 ${filled} / ${items.length} 题`);
    setTimeout(() => overlay(null), 5000);

    S.working = false;
    return { total: items.length, filled, results, inputCount: inputs.length, logs: takeLogs() };
  }

  // ---- 客观题（单选/多选/判断）：抓取题干与选项，AI 给出答案后自动勾选 ----
  // 站点可能用原生 input，也可能用 role=radio/checkbox 的自定义控件
  const CHOICE_SEL = [
    'input[type="radio"]',
    'input[type="checkbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
  ].join(', ');
  // 纯 div 渲染的选项（没有原生控件、也没有 role）
  const OPTION_DIV_SEL = [
    '[class*="option"]',
    '[class*="choice"]',
    '[class*="opt-"]',
    '[class*="opt_"]',
    '[class*="answer-item"]',
  ].join(', ');
  const TYPE_LABEL_RE = /\[(单选题?|多选题?|判断题?|填空题?|简答题?|附件题?|投票题?|编程题?|量表题?|排序题?|匹配题?)[^\]]*\]/g;

  function isRoleOption(el) {
    const role = el.getAttribute('role');
    return role === 'radio' || role === 'checkbox';
  }

  function isNativeOption(el) {
    return el.tagName === 'INPUT';
  }

  function hasSelectedClass(node) {
    const cls = typeof node.className === 'string' ? node.className : '';
    if (/(?:^|[\s_-])(checked|selected|is-checked|active|choosed|choose|on)(?:$|[\s_-])/.test(cls)) return true;
    return !!node.querySelector('[class*="checked"], [class*="selected"], [class*="is-checked"]');
  }

  // 选项外层容器（只包住当前这一项），选中状态常挂在它身上
  function optionWrapper(el) {
    const parent = el.parentElement;
    if (!parent) return null;
    if (parent.querySelectorAll(CHOICE_SEL).length > 1) return null;
    if (parent.querySelectorAll(OPTION_DIV_SEL).length > 1) return null;
    return parent;
  }

  function isOptionChecked(el) {
    if (isNativeOption(el)) return !!el.checked;
    const aria = el.getAttribute('aria-checked');
    if (aria != null) return aria === 'true';
    if (hasSelectedClass(el)) return true;
    const wrapper = optionWrapper(el);
    return wrapper ? hasSelectedClass(wrapper) : false;
  }

  // antd 等组件的 radio 输入框透明度为 0，不能用 isVisible 过滤
  function isChoiceUsable(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    let node = el;
    while (node && node !== document.body) {
      try {
        const st = getComputedStyle(node);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
      } catch (e) {}
      node = node.parentElement;
    }
    return true;
  }

  function choiceScope() {
    let best = null;
    let bestCount = 0;
    for (const form of document.querySelectorAll('form')) {
      let count = 0;
      for (const el of deepQueryAll(form, CHOICE_SEL)) {
        if (isChoiceUsable(el)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        best = form;
      }
    }
    if (best && bestCount >= 2) return best;
    return document.querySelector('main') || document.body;
  }

  function optionContainer(el) {
    return el.closest('label') || el.parentElement || el;
  }

  // 递归穿透 open shadow root（题目组件可能封装在 Web Component 里）
  function deepQueryAll(root, selector, out) {
    const acc = out || [];
    try {
      acc.push(...root.querySelectorAll(selector));
    } catch (e) {}
    let all = [];
    try {
      all = root.querySelectorAll('*');
    } catch (e) {}
    for (const el of all) {
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, acc);
    }
    return acc;
  }

  function readOptionText(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const wrap = el.closest('label');
    if (wrap) return (wrap.innerText || '').trim();
    // 自定义控件/div 选项本身就是选项容器，文字在自己的子树里，不能取父节点的整段文本
    if (!isNativeOption(el)) {
      const own = (el.innerText || '').trim();
      if (own) return own;
    }
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return (label.innerText || '').trim();
      } catch (e) {}
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    const parent = el.parentElement;
    // 控件和选项文字是兄弟节点时，取紧跟在控件后面的兄弟文本
    if (parent && parent.querySelectorAll(CHOICE_SEL).length > 1) {
      let sib = el.nextSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.matches && sib.matches(CHOICE_SEL)) break;
        const t = (sib.textContent || '').trim();
        if (t) return t;
        sib = sib.nextSibling;
      }
    }
    return parent ? (parent.innerText || '').trim() : '';
  }

  // 有 name 按 name 分组；没有时向上找第一个包住至少两个选项容器的祖先，
  // 兼容 <ul><li><label> 这类选项容器彼此不是兄弟节点的结构
  function groupChoiceElements(scope) {
    const elements = deepQueryAll(scope, CHOICE_SEL).filter(isChoiceUsable);
    if (!elements.length) return [];

    const containers = new Map(elements.map((el) => [el, optionContainer(el)]));
    const buckets = new Map();

    const add = (key, el) => {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { elements: [] };
        buckets.set(key, bucket);
      }
      bucket.elements.push(el);
    };

    for (const el of elements) {
      const name = el.getAttribute('name');
      if (name) {
        add(`name:${name}`, el);
        continue;
      }
      if (isRoleOption(el)) {
        const group = el.closest('[role="radiogroup"], [role="group"]');
        if (group) {
          add(group, el);
          continue;
        }
      }
      const self = containers.get(el);
      let node = self;
      let anchor = null;
      let guard = 0;
      while (node && node !== document.body && guard++ < 20) {
        if (node !== self) {
          let count = 0;
          for (const c of containers.values()) {
            if (node.contains(c) && ++count >= 2) break;
          }
          if (count >= 2) {
            anchor = node;
            break;
          }
        }
        node = node.parentElement;
      }
      add(anchor || self, el);
    }

    return Array.from(buckets.values()).filter((b) => b.elements.length >= 2);
  }

  function lookLikeOptionDiv(el) {
    if (isNativeOption(el) || isRoleOption(el)) return false;
    if (el.querySelector(CHOICE_SEL)) return false;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300) return false;
    // 选项通常以 "A." / "A、" 开头
    return /^[A-Ha-h]\s*[.、．)）:：]/.test(text);
  }

  function divOptionLeaves(root) {
    const all = deepQueryAll(root, OPTION_DIV_SEL)
      .filter((el) => lookLikeOptionDiv(el) && isChoiceUsable(el));
    // 外层容器本身也可能以 "A." 开头，只保留最内层的选项节点
    return all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
  }

  // 没有原生/role 控件时，把 ≥2 个 A./B. 开头的 div（同一祖先下）当作一组选项
  function divOptionGroups(scope) {
    const leaves = divOptionLeaves(scope);
    if (leaves.length < 2) return [];

    const groups = [];
    const used = new Set();
    for (const leaf of leaves) {
      if (used.has(leaf)) continue;
      let node = leaf.parentElement;
      let found = null;
      let guard = 0;
      while (node && node !== document.body && guard++ < 20) {
        const members = leaves.filter((c) => node.contains(c));
        if (members.length >= 2) {
          found = { node, members };
          break;
        }
        node = node.parentElement;
      }
      if (!found) continue;
      found.members.forEach((m) => used.add(m));
      if (!groups.some((g) => g.root === found.node)) {
        groups.push({ elements: found.members, root: found.node });
      }
    }
    return groups;
  }

  function optionElements(root) {
    const native = deepQueryAll(root, CHOICE_SEL);
    if (native.length) return native;
    return divOptionLeaves(root);
  }

  function commonAncestor(els) {
    if (!els.length) return null;
    let node = els[0];
    for (const el of els.slice(1)) {
      while (node && !node.contains(el)) node = node.parentElement;
    }
    return node;
  }

  function findQuestionRoot(group, groups) {
    const root = commonAncestor(group.elements);
    if (!root) return null;
    const foreign = [];
    for (const other of groups) {
      if (other === group) continue;
      foreign.push(...other.elements);
    }
    let node = root;
    while (node.parentElement && node.parentElement.tagName !== 'FORM'
      && node.parentElement.tagName !== 'MAIN' && node.parentElement !== document.body) {
      const parent = node.parentElement;
      if (foreign.some((el) => parent.contains(el))) break;
      node = parent;
    }
    return node;
  }

  function stripQuestionNoise(text) {
    return String(text || '')
      .replace(TYPE_LABEL_RE, ' ')
      .replace(/^\s*\d+\s*[.、．)）]\s*/, ' ')
      .replace(/^\s*[(（]\s*\d+\s*分\s*[)）]\s*/, ' ')
      .replace(/\d+(\.\d+)?\s*分/g, ' ')
      .replace(/\s*笔记\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractStem(root) {
    let text = '';
    try {
      const clone = root.cloneNode(true);
      clone.querySelectorAll(CHOICE_SEL).forEach((el) => {
        const label = el.closest('label');
        const box = label || el.parentElement;
        // 只移除包住这一项选项的容器；共享容器只摘掉控件，避免误删题干
        const boxHasOthers = box ? box.querySelectorAll(CHOICE_SEL).length > 1 : true;
        if (box && box !== clone && !boxHasOthers) box.remove();
        else el.remove();
      });
      text = stripQuestionNoise(clone.innerText || clone.textContent || '');
    } catch (e) {
      text = stripQuestionNoise(root.innerText || '');
    }

    // 选项和题干共用容器时 clone 方式删不干净，再按选项文字剔除一遍
    for (const el of optionElements(root)) {
      const optionText = readOptionText(el).replace(/\s+/g, ' ').trim();
      if (optionText.length >= 2 && text.includes(optionText)) {
        text = text.split(optionText).join(' ');
      }
    }
    text = stripQuestionNoise(text);

    if (text.length < 2) {
      let fallback = root.innerText || '';
      for (const el of optionElements(root)) {
        const optionText = readOptionText(el);
        if (optionText) fallback = fallback.split(optionText).join(' ');
      }
      text = stripQuestionNoise(fallback);
    }
    return text;
  }

  function splitOptionText(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    const m = text.match(/^([A-Ha-h])\s*[.、．)）:：]\s*(.*)$/);
    if (m) return { letter: m[1].toUpperCase(), text: m[2].trim() };
    return { letter: '', text };
  }

  function detectChoiceType(root, elements) {
    const text = root.innerText || '';
    if (/多选题/.test(text)) return 'multiple';
    if (/判断题/.test(text)) return 'judge';
    if (/单选题/.test(text)) return 'single';
    const multiple = elements.some((el) => el.getAttribute('type') === 'checkbox'
      || el.getAttribute('role') === 'checkbox');
    return multiple ? 'multiple' : 'single';
  }

  function scanChoiceQuestions() {
    const scope = choiceScope();
    let groups = groupChoiceElements(scope);
    if (!groups.length) groups = divOptionGroups(scope);
    const items = [];

    for (const group of groups) {
      const root = findQuestionRoot(group, groups);
      if (!root) continue;
      const type = detectChoiceType(root, group.elements);
      const options = group.elements.map((el, i) => {
        const parsed = splitOptionText(readOptionText(el));
        return {
          index: i,
          letter: parsed.letter || String.fromCharCode(65 + i),
          text: parsed.text || `选项 ${i + 1}`,
          el,
          checked: isOptionChecked(el),
        };
      });
      const stem = extractStem(root);
      if (!stem || stem.length < 2) continue;
      items.push({ type, stem, options, root });
    }

    items.sort((a, b) => {
      const ra = a.root.getBoundingClientRect();
      const rb = b.root.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
    items.forEach((item, index) => { item.index = index; });
    return items;
  }

  function choiceDiagnostics() {
    const scope = choiceScope();
    const all = deepQueryAll(scope, CHOICE_SEL);
    let usable = 0;
    for (const el of all) {
      if (isChoiceUsable(el)) usable++;
    }
    let shadowRoots = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) shadowRoots++;
    }
    let divOptions = 0;
    for (const el of deepQueryAll(document, OPTION_DIV_SEL)) {
      if (lookLikeOptionDiv(el)) divOptions++;
    }
    return {
      scope: scope.tagName,
      controls: all.length,
      usable,
      groups: groupChoiceElements(scope).length,
      divOptions,
      iframes: document.querySelectorAll('iframe').length,
      shadowRoots,
    };
  }

  function publicChoiceQuestions(items) {
    return items.map((q) => ({
      index: q.index,
      type: q.type,
      stem: q.stem,
      options: q.options.map((o) => ({ letter: o.letter, text: o.text, checked: isOptionChecked(o.el) })),
    }));
  }

  function buildChoicePrompt(q) {
    const typeName = q.type === 'multiple' ? '多选题' : q.type === 'judge' ? '判断题' : '单选题';
    const lines = [
      `${typeName}，只输出 JSON，如 {"answer":["A"]}。`,
      `题目：${q.stem}`,
      ...q.options.map((o) => `${o.letter}. ${o.text}`),
    ];
    if (q.type === 'multiple') lines.push('选出全部正确项。');
    else if (q.type === 'judge') lines.push('A 代表「正确」，B 代表「错误」，选出唯一正确项。');
    else lines.push('选出唯一正确项。');
    return lines.join('\n');
  }

  function collectAnswerLetters(value, q, letters) {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => collectAnswerLetters(v, q, letters));
      return;
    }
    if (typeof value === 'object') {
      collectAnswerLetters(value.answer ?? value.value ?? value.option ?? value.label, q, letters);
      return;
    }
    const str = String(value).trim();
    if (/^[A-Ha-h]$/.test(str)) {
      letters.add(str.toUpperCase());
      return;
    }
    const hit = q.options.find((o) => o.text && str && (o.text === str || str.includes(o.text)));
    if (hit) {
      letters.add(hit.letter);
      return;
    }
    (str.toUpperCase().match(/[A-H]/g) || []).forEach((l) => letters.add(l));
  }

  function parseChoiceAnswer(answer, q) {
    const text = String(answer || '');
    const valid = new Set(q.options.map((o) => o.letter));
    const letters = new Set();

    const jsonText = (text.match(/\{[\s\S]*\}/) || [])[0];
    if (jsonText) {
      try {
        const obj = JSON.parse(jsonText);
        collectAnswerLetters(
          obj.answer ?? obj.answers ?? obj.result ?? obj.choice ?? obj.choices,
          q,
          letters
        );
      } catch (e) {}
    }

    if (!letters.size) {
      const m = text.match(/(?:答案|正确选项|应选|选择|answer)\s*(?:是|为|[:：])?\s*([A-Ha-h](?:\s*[,，、/或和\s]*[A-Ha-h])*)/i);
      if (m) (m[1].toUpperCase().match(/[A-H]/g) || []).forEach((l) => letters.add(l));
    }

    if (!letters.size && q.type === 'judge') {
      const compact = text.replace(/\s/g, '');
      if (/正确|对的|true|√|是/.test(compact)) {
        const hit = q.options.find((o) => /正确|对|true|√|是/.test(o.text));
        if (hit) letters.add(hit.letter);
      } else if (/错误|错的|false|×|否/.test(compact)) {
        const hit = q.options.find((o) => /错误|错|false|×|否/.test(o.text));
        if (hit) letters.add(hit.letter);
      }
    }

    if (!letters.size) {
      const bare = text.trim().toUpperCase();
      if (/^[A-H](?:\s*[,，、/]?\s*[A-H])*$/.test(bare)) {
        (bare.match(/[A-H]/g) || []).forEach((l) => letters.add(l));
      }
    }

    const picked = Array.from(letters)
      .filter((l) => valid.has(l))
      .sort()
      .map((l) => l.toUpperCase());

    if (q.type !== 'multiple') return picked.slice(0, 1);
    return picked;
  }

  function callChoiceAI(question) {
    const send = (q) => new Promise((resolve) => {
      const askGeneric = (reason) => {
        // 扩展还没重新加载时后台没有 askChoice，退回通用 askAI，把 JSON 要求写进问题里
        const prompt = `${q}\n\n只输出 JSON，不要解释，例如 {"answer":["A"]}；多选题输出多个字母。`;
        chrome.runtime.sendMessage({ action: 'askAI', question: prompt }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message || reason });
            return;
          }
          resolve(resp || { error: reason || '无响应' });
        });
      };

      chrome.runtime.sendMessage({ action: 'askChoice', question: q }, (resp) => {
        const err = chrome.runtime.lastError?.message || '';
        if (err || !resp) {
          askGeneric(err || 'askChoice 无响应');
          return;
        }
        resolve(resp);
      });
    });

    return (async () => {
      const first = await send(question);
      if (first && !first.error) return first;
      if (first && /返回为空/.test(first.error)) {
        opLog(`[客观题] AI 返回为空，精简提示词重试（${first.error}）`);
        const retry = await send(`${question}\n\n只输出 JSON，例如 {"answer":["A"]}，不要输出思考过程。`);
        if (retry && !retry.error) {
          opLog('[客观题] 重试成功');
          return retry;
        }
        return { error: `${(retry && retry.error) || first.error}（已重试）` };
      }
      return first;
    })();
  }

  function clickChoice(el) {
    try {
      el.click();
    } catch (e) {
      clickNode(el);
    }
  }

  function forceClick(el) {
    if (!el) return false;
    try {
      const view = el.ownerDocument.defaultView || window;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const opts = {
        bubbles: true,
        cancelable: true,
        view,
        button: 0,
        clientX: rect ? rect.left + rect.width / 2 : 0,
        clientY: rect ? rect.top + rect.height / 2 : 0,
      };
      if (view.PointerEvent) {
        el.dispatchEvent(new view.PointerEvent('pointerdown', opts));
        el.dispatchEvent(new view.PointerEvent('pointerup', opts));
      }
      el.dispatchEvent(new view.MouseEvent('mousedown', opts));
      el.dispatchEvent(new view.MouseEvent('mouseup', opts));
      el.dispatchEvent(new view.MouseEvent('click', opts));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function applyChoiceAnswer(q, letters) {
    const wanted = new Set(letters);
    for (const opt of q.options) {
      const should = wanted.has(opt.letter);
      if (isOptionChecked(opt.el) === should) continue;

      clickChoice(opt.el);
      await sleep(150);

      if (isOptionChecked(opt.el) !== should) {
        const label = opt.el.closest('label');
        if (label && label !== opt.el) {
          clickNode(label);
          await sleep(150);
        }
      }
      if (isOptionChecked(opt.el) !== should) {
        const wrapper = optionWrapper(opt.el);
        if (wrapper) {
          clickNode(wrapper);
          await sleep(150);
        }
      }
      if (isOptionChecked(opt.el) !== should) {
        // 自定义控件可能只有内部的圆点/方框元素响应点击
        const inner = opt.el.querySelector('[class*="check"], [class*="radio"], [class*="box"], [class*="inner"]');
        if (inner) {
          clickNode(inner);
          await sleep(150);
        }
      }
      if (isOptionChecked(opt.el) !== should) {
        forceClick(optionWrapper(opt.el) || opt.el);
        await sleep(150);
      }
      opt.checked = isOptionChecked(opt.el);
      if (isOptionChecked(opt.el) !== should) {
        const cls = typeof opt.el.className === 'string' ? opt.el.className.slice(0, 60) : '';
        opLog(`[客观题] 选项 ${opt.letter} 点击后状态未变（期望${should ? '选中' : '取消'}）：${opt.el.tagName.toLowerCase()} ${cls}`);
      }
    }
    return q.options.filter((o) => isOptionChecked(o.el)).map((o) => o.letter).sort();
  }

  async function processChoiceFill(items) {
    if (S.working) return { error: '正在处理中，请稍候' };
    S.working = true;

    try {
      const scans = scanChoiceQuestions();
      opLog(`[客观题] 作答开始：待答 ${items.length} 题，页面扫描到 ${scans.length} 题`);
      if (!scans.length) {
        overlay('没有找到客观题');
        setTimeout(() => overlay(null), 4000);
        opLog('[客观题] 作答失败：当前框架扫描不到题目');
        return { error: '没有找到客观题，请确认已进入作业/测试页面' };
      }
      const byIndex = new Map(scans.map((q) => [q.index, q]));
      const tasks = items.map((it) => ({ index: Number(it.index), q: byIndex.get(Number(it.index)) }));

      // 先并发请求 AI（并发 2），避免逐题串行 + 重试把总时长拖到一分钟以上
      overlay(`AI 作答客观题：共 ${tasks.length} 题，请求中...`);
      const replies = new Array(tasks.length);
      const CONCURRENCY = Math.min(2, tasks.length);
      const workers = [];
      for (let w = 0; w < CONCURRENCY; w++) {
        workers.push((async () => {
          for (let k = w; k < tasks.length; k += CONCURRENCY) {
            const task = tasks[k];
            if (!task.q) {
              replies[k] = { error: '题目已变化，请重新扫描' };
              opLog(`[客观题] 序号 ${task.index + 1} 已不存在，请重新扫描`);
              continue;
            }
            const started = Date.now();
            const resp = await callChoiceAI(buildChoicePrompt(task.q));
            const cost = ((Date.now() - started) / 1000).toFixed(1);
            replies[k] = resp;
            opLog(`[客观题] 第 ${task.q.index + 1} 题[${task.q.type}] AI 用时 ${cost}s${resp.error ? `：${resp.error}` : ''}`);
          }
        })());
      }
      await Promise.all(workers);

      const results = [];

      for (let i = 0; i < tasks.length; i++) {
        const { index, q } = tasks[i];
        const resp = replies[i] || { error: '无响应' };
        overlay(`勾选客观题：第 ${i + 1} / ${tasks.length} 题...`);

        if (!q) {
          results.push({ index, ok: false, error: '题目已变化，请重新扫描' });
          continue;
        }

        if (resp.error) {
          results.push({ index: q.index, ok: false, error: resp.error });
          continue;
        }

        const letters = parseChoiceAnswer(resp.answer, q);
        if (!letters.length) {
          opLog(`[客观题] 第 ${q.index + 1} 题[${q.type}]：解析不出选项，AI 原始回复：${String(resp.answer || '').slice(0, 120).replace(/\s+/g, ' ')}`);
          results.push({
            index: q.index,
            ok: false,
            error: `AI 未给出有效选项：${String(resp.answer || '').slice(0, 60)}`,
          });
          continue;
        }

        const clicked = await applyChoiceAnswer(q, letters);
        // 组件点击后可能整体重渲染，旧节点已脱离文档；重新扫描一次读取真实勾选状态
        const fresh = scanChoiceQuestions().find((s) => s.stem === q.stem);
        const applied = fresh
          ? fresh.options.filter((o) => isOptionChecked(o.el)).map((o) => o.letter).sort()
          : clicked;
        const ok = applied.join(',') === letters.join(',');
        for (const opt of (fresh ? fresh.options : q.options)) {
          if (letters.includes(opt.letter)) {
            highlight(opt.el.closest('label') || opt.el, ok ? '#00cc44' : '#ffaa00');
          }
        }
        const err = ok ? undefined : `点击后未选中：期望 ${letters.join('')}，实际 ${applied.join('') || '无'}`;
        opLog(`[客观题] 第 ${q.index + 1} 题[${q.type}] 题干：${q.stem.slice(0, 60)}`);
        opLog(`[客观题] 第 ${q.index + 1} 题 AI 原始回复：${String(resp.answer || '').slice(0, 120).replace(/\s+/g, ' ')}`);
        opLog(`[客观题] 第 ${q.index + 1} 题 解析 ${letters.join('')} / 点击后 ${applied.join('') || '无'}${ok ? ' ✔' : ' ✘ ' + err}`);
        results.push({
          index: q.index,
          ok,
          letters,
          applied,
          error: err,
          preview: `${letters.join('')} ${q.options.filter((o) => letters.includes(o.letter)).map((o) => o.text).join(' / ')}`.slice(0, 80),
        });

        await sleep(250);
      }

      const answered = results.filter((r) => r.ok).length;
      opLog(`[客观题] 完成：成功 ${answered} / ${items.length} 题`);
      overlay(`客观题完成：成功 ${answered} / ${items.length} 题`);
      setTimeout(() => overlay(null), 5000);
      return { total: items.length, answered, results, logs: takeLogs() };
    } finally {
      S.working = false;
    }
  }

  // ---- 待完成任务：点击日历红点，找出「自主观看」任务并在新标签页打开 ----

  const WATCH_TASK_TYPE = 1;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(predicate, timeout = 5000, step = 150) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const hit = predicate();
        if (hit) return hit;
      } catch (e) {}
      await sleep(step);
    }
    return null;
  }

  function clickNode(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function callBackground(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { error: '无响应' });
      });
    });
  }

  function findUnstudyEntry() {
    const byAttr = document.querySelector('[data-xy-click-pt="unstudy-task"]');
    if (byAttr) return byAttr;

    const nodes = Array.from(document.querySelectorAll('span, div, a, button'));
    const hit = nodes.find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === '待完成任务'
    );
    if (!hit) return null;
    return hit.closest('[data-xy-click-pt]') || hit.parentElement || hit;
  }

  async function openUnstudyModal(timeout = 15000) {
    const entry = findUnstudyEntry();
    if (!entry) return null;

    clickNode(entry);

    return waitFor(() => {
      const modal = document.querySelector('.aia_to_mission');
      if (modal) return modal;
      const cal = document.querySelector('.ta_Calender');
      return cal ? (cal.closest('.ant-modal') || cal.parentElement) : null;
    }, timeout, 200);
  }

  // 日历按周切换，同一行（同一周）只需点一个有红点的日期
  async function clickRedDotWeeks(modal, onWeek) {
    const processedRows = new Set();
    let clicked = 0;

    // 点击后日历会重渲染，每轮都重新查询，避免使用失效节点
    for (;;) {
      const calendar = modal.querySelector('.ta_Calender') || modal;
      const rows = Array.from(calendar.querySelectorAll('tr'));
      const cells = Array.from(calendar.querySelectorAll('.rc-calendar-cell')).filter(
        (td) => td.querySelector('.ant-badge-count')
          && !td.classList.contains('rc-calendar-last-month-cell')
          && !td.classList.contains('rc-calendar-next-month-btn-day')
      );

      let target = null;
      let rowIndex = -1;
      for (const td of cells) {
        const idx = rows.indexOf(td.closest('tr'));
        if (idx !== -1 && !processedRows.has(idx)) {
          target = td;
          rowIndex = idx;
          break;
        }
      }
      if (!target) break;

      processedRows.add(rowIndex);
      clickNode(target);
      clicked++;
      await sleep(700);
      if (onWeek) onWeek();
    }

    return clicked;
  }

  function collectWatchCards(modal) {
    const panel = modal.querySelector('.ta_rightBox') || modal;
    const out = [];
    for (const card of panel.querySelectorAll('.ta_watch')) {
      const name = (card.querySelector('.group-resource-link')?.textContent || '').trim();
      if (!name) continue;
      const group = (card.querySelector('.group_link')?.textContent || '').trim();
      out.push({ name, group });
    }
    return out;
  }

  // ---- 任务资源页：等待加载后自动点播放键开始播放 ----
  const PLAY_BTN_SELECTORS = [
    '.vjs-big-play-button',
    '.prism-big-play-btn',
    '.prism-play-btn',
    '.dplayer-play-icon',
    '.xgplayer-start',
    '.xgplayer-play',
    '.jw-display-icon-container',
    '.plyr__control--overlaid',
    '.anticon-play-circle',
    '[class*="play-icon"]',
    '[class*="playIcon"]',
    '.play-btn',
    '.btn-play',
    '[aria-label*="播放"]',
    '[title*="播放"]',
  ];

  const PLAYER_ROOT_SEL = 'video, .prism-player, .vjs-big-play-button, .dplayer, .xgplayer, .jwplayer, .plyr';

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function findVideo() {
    // 取面积最大的可见 video，避免误操作广告/预览小窗
    let best = null;
    let bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      if (!isVisible(video)) continue;
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area >= bestArea) {
        bestArea = area;
        best = video;
      }
    }
    return best;
  }

  function findPlayButton() {
    // 优先「播放」入口，跳过显示为「暂停」的切换键
    for (const sel of PLAY_BTN_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el) && !looksLikePauseControl(el)) return el;
      }
    }
    for (const el of document.querySelectorAll('button, [role="button"], a, span')) {
      if ((el.textContent || '').trim() === '播放' && isVisible(el) && !looksLikePauseControl(el)) return el;
    }
    // 没有更明确的入口时退回第一个可见控件（有些播放器的暂停图标是懒切换的）
    for (const sel of PLAY_BTN_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // 播放器上的按钮通常是「播放/暂停」切换键，已经在播时点它会把视频暂停
  function looksLikePauseControl(el) {
    if (!el) return false;
    const text = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-title'),
      typeof el.className === 'string' ? el.className : '',
    ].filter(Boolean).join(' ');
    return /暂停|pause/i.test(text);
  }

  // 播放区域点击的全局节流：自动起播循环和 15 秒看门狗共用，避免 1 秒内点两次把播放切回暂停
  let lastVideoClickAt = 0;

  // 日志里描述点击目标：标签/class/提示文字/位置，方便确认点到了哪个元素
  function describeClickTarget(el) {
    if (!el) return '';
    try {
      const tag = el.tagName ? el.tagName.toLowerCase() : '?';
      const cls = typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
        : '';
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-title'),
      ].filter(Boolean).join('/');
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const pos = rect && (rect.width || rect.height)
        ? `@${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
        : '';
      return [
        tag + (cls ? `.${cls}` : ''),
        label ? `[${label}]` : '',
        text ? `"${text}"` : '',
        pos,
      ].filter(Boolean).join(' ');
    } catch (e) {
      return '';
    }
  }

  // 只在实际暂停时调用；在播时点切换键会切成暂停。返回点击目标的描述，没点返回空
  function clickPlayControl() {
    const btn = findPlayButton();
    if (btn) {
      clickNode(btn);
      lastVideoClickAt = Date.now();
      return describeClickTarget(btn);
    }
    // 找不到按钮时点播放画面，多数播放器点画面即可起播
    const video = findVideo();
    if (video) {
      clickNode(video);
      lastVideoClickAt = Date.now();
      return describeClickTarget(video);
    }
    return '';
  }

  async function tryStartPlayback(state) {
    if (!document.querySelector(PLAYER_ROOT_SEL)) return false;

    const video = findVideo();
    const now = Date.now();

    // 播放器还没渲染出 video：低频点一次播放键（有些播放器点一下才创建 video）
    if (!video) {
      if (now - state.lastActionAt >= 10000) {
        state.lastActionAt = now;
        const target = clickPlayControl();
        if (target) videoLog(`[视频] 页面暂无视频元素，已点击：${target}`);
      }
      return false;
    }

    // 已经播完的视频不要再点重播，视为本轮结束
    if (video.ended) return true;
    if (Number.isFinite(video.duration) && video.currentTime > 0
      && video.currentTime >= video.duration - 1) return true;

    // 只要不是暂停就当作已起播：缓冲阶段 currentTime 可能还是 0，不能据此反复操作
    if (!video.paused) return true;

    // 暂停中：冷却期内不重复操作，避免和播放器初始化互相打断
    if (now - state.lastActionAt < 4000) return false;
    state.lastActionAt = now;
    state.attempts++;
    videoLog(`[视频] 视频处于暂停，尝试起播（第 ${state.attempts} 次）`);

    try { await video.play(); } catch (e) {}
    if (video.paused) {
      // 浏览器自动播放策略可能要求先静音
      try {
        video.muted = true;
        await video.play();
        video.muted = false;
      } catch (e) {}
    }
    // play() 被拦时模拟一次点击（播放键找不到就点画面）
    // 点击后留更长的冷却：播放器可能过几秒才响应，紧接着再点会把刚起的播放切成暂停
    if (video.paused && Date.now() - lastVideoClickAt >= 6000) {
      const target = clickPlayControl();
      if (target) videoLog(`[视频] 第 ${state.attempts} 次起播未生效，已点击：${target}`);
    }
    if (video.paused) videoLog(`[视频] 第 ${state.attempts} 次起播未生效，稍后重试`);

    return !video.paused;
  }

  let videoRate = 4;

  function clampRate(rate) {
    // Chrome 的 playbackRate 上限就是 16x
    return Math.min(16, Math.max(0.25, rate));
  }

  function applyRateToVideos() {
    for (const video of document.querySelectorAll('video')) {
      try {
        if (video.playbackRate !== videoRate) video.playbackRate = videoRate;
      } catch (e) {}
    }
  }

  // 每个框架各自请求后台注入主世界脚本，劫持 playbackRate 防止播放器改回原速
  function pushRateToPage() {
    try {
      chrome.runtime.sendMessage({ action: 'pinVideoRate', rate: videoRate });
    } catch (e) {}
  }

  function find2xItem() {
    const items = document.querySelectorAll(
      '.prism-speed-selector .selector-list li, .prism-setting-selector .selector-list li, .prism-speed-selector li'
    );
    for (const li of items) {
      if (/^2(\.0)?x$/i.test((li.textContent || '').trim())) return li;
    }
    return null;
  }

  function findSpeedEntry() {
    const btn = document.querySelector('.prism-setting-btn');
    if (btn) return btn;
    for (const el of document.querySelectorAll('button, a, span, div')) {
      const text = (el.textContent || '').trim();
      if ((text === '倍速' || text === '播放速度') && el.children.length === 0 && isVisible(el)) return el;
    }
    return null;
  }

  // 高速率直接改 playbackRate（Aliplayer 菜单最高只有 2X）；2x 时顺带同步播放器菜单
  async function applyRate(video) {
    if (video) {
      try {
        if (video.playbackRate !== videoRate) video.playbackRate = videoRate;
      } catch (e) {}
    }
    applyRateToVideos();
    if (videoRate !== 2) return;

    let item = find2xItem();
    if (!item) {
      const entry = findSpeedEntry();
      if (entry) {
        clickNode(entry);
        await sleep(300);
        const speedItem = document.querySelector('.prism-setting-item.prism-setting-speed');
        if (speedItem) {
          clickNode(speedItem);
          await sleep(300);
        }
      }
      item = find2xItem();
    }
    if (item) {
      clickNode(item);
      applyRateToVideos();
    }
  }

  chrome.storage.local.get({ videoRate: 4 }, (cfg) => {
    const rate = Number(cfg.videoRate);
    if (Number.isFinite(rate) && rate > 0) videoRate = clampRate(rate);
    applyRateToVideos();
    pushRateToPage();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.videoRate) return;
    const rate = Number(changes.videoRate.newValue);
    if (!Number.isFinite(rate) || rate <= 0) return;
    videoRate = clampRate(rate);
    applyRateToVideos();
    pushRateToPage();
  });

  // 播放器切清晰度等操作可能把速率重置，自动设回来
  document.addEventListener('ratechange', (e) => {
    const video = e.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.playbackRate === videoRate) return;
    setTimeout(() => {
      try { video.playbackRate = videoRate; } catch (err) {}
    }, 0);
  }, true);

  function startVideoAutoPlay() {
    if (!/\/mycourse\//.test(location.pathname)) return;

    // 每次起播分配一个代号，切换小节/重新注入后旧轮询自动失效，避免两个轮询同时点播放键
    const gen = (window.__whutAiVideoGen = (window.__whutAiVideoGen || 0) + 1);
    // 等播放器出来 → 起播 → 确认在播放后停止轮询，之后不再碰播放/暂停
    const state = { lastActionAt: 0, attempts: 0, startedAt: Date.now() };
    let timer = null;
    const tick = async () => {
      if (window.__whutAiVideoGen !== gen) return;
      let done = false;
      try {
        done = await tryStartPlayback(state);
      } catch (e) {}
      if (window.__whutAiVideoGen !== gen) return;
      if (done) {
        const nowVideo = findVideo();
        if (nowVideo && !nowVideo.paused) {
          videoLog(`[视频] 已开始播放，应用 ${videoRate}x 倍速（尝试 ${state.attempts} 次）`);
        } else if (nowVideo && nowVideo.ended) {
          videoLog(`[视频] 视频已播放结束（尝试 ${state.attempts} 次）`);
        } else {
          videoLog(`[视频] 未自动播放，停止尝试（尝试 ${state.attempts} 次）`);
        }
        try {
          await applyRate(nowVideo);
        } catch (e) {}
        // 播放器初始化可能重置速率，稍后再兜底设置一次
        setTimeout(() => {
          const video = findVideo();
          if (video) {
            try {
              if (video.playbackRate !== videoRate) video.playbackRate = videoRate;
            } catch (e) {}
          }
        }, 3000);
        return;
      }
      // 只在实际暂停时才点播放键，不会反复切播放/暂停；但不能无限尝试，留个总时限
      if (Date.now() - state.startedAt > 300000) {
        videoLog(`[视频] 5 分钟内未能自动起播，停止尝试（已试 ${state.attempts} 次，可手动点一次播放）`);
        return;
      }
      timer = setTimeout(tick, 2000);
    };

    // 等页面和播放器先渲染出来
    setTimeout(tick, 1500);
    window.addEventListener('pagehide', () => clearTimeout(timer));
  }

  // 课程页是 SPA：切换小节时路径会变，但页面不会重载，需要为新视频重新起播
  function watchVideoRoute() {
    let lastUrl = location.pathname + location.search;
    const check = () => {
      const url = location.pathname + location.search;
      if (url === lastUrl) return;
      lastUrl = url;
      if (!/\/mycourse\//.test(location.pathname)) return;
      // 作废旧轮询（代号自增），再为新视频重新走一次起播流程
      window.__whutAiVideoGen = (window.__whutAiVideoGen || 0) + 1;
      startVideoAutoPlay();
      startVideoClickWatch();
    };
    setInterval(check, 1000);
    window.addEventListener('popstate', check);
  }

  // 实践表明点播放区域即可起播：每 15 秒兜底检查一次，只在暂停时点（播放中点会切成暂停）
  function startVideoClickWatch() {
    if (!/\/mycourse\//.test(location.pathname)) return;
    if (window.__whutAiVideoClickWatch) return;
    window.__whutAiVideoClickWatch = true;

    setInterval(() => {
      if (!/\/mycourse\//.test(location.pathname)) return;
      const video = findVideo();
      if (!video || video.ended) return;
      if (!video.paused) return;
      if (Number.isFinite(video.duration) && video.currentTime > 0
        && video.currentTime >= video.duration - 1) return;
      if (Date.now() - lastVideoClickAt < 8000) return;

      const target = clickPlayControl();
      const progress = `已播 ${Math.floor(video.currentTime)}s，readyState ${video.readyState}`;
      videoLog(`[视频] 15 秒检查：暂停中（${progress}）→ ${target ? `点击 ${target}` : '没找到可点击的播放区域'}`);
    }, 15000);
  }

  // ---- 视频看完后通知后台每 30 秒点击右上角「点我完成任务」 ----
  // 真正的点击在后台用 alarms + scripting.executeScript 完成（见 background.js），
  // 不依赖页面脚本：隐藏窗口、扩展重载前就打开的窗口也能点到。
  let finishEndSignaled = false;

  // 页面里真正的播放器视频：取面积最大的可见 video，过滤广告/预览小窗
  function findMainVideo() {
    let best = null;
    let bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      if (!isVisible(video)) continue;
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area >= bestArea) {
        bestArea = area;
        best = video;
      }
    }
    return best;
  }

  function isMainVideoDone(video) {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (video.ended) return true;
    const ratio = video.currentTime / duration;
    return ratio >= 0.98 || (ratio >= 0.95 && video.paused);
  }

  function signalVideoEnded() {
    if (finishEndSignaled) return;
    finishEndSignaled = true;
    console.log('[WHUT AI] 视频已播完，后台开始每 30 秒点击「点我完成任务」');
    try { chrome.runtime.sendMessage({ action: 'notifyVideoEnded' }); } catch (e) {}
  }

  document.addEventListener('ended', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    const rect = e.target.getBoundingClientRect();
    // 过滤广告/预览等小窗视频
    if (rect.width * rect.height < 60000) return;
    signalVideoEnded();
  }, true);

  // 同一页面里换视频时重置，允许再次触发
  document.addEventListener('play', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    const video = e.target;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    if (video.currentTime < video.duration - 3) finishEndSignaled = false;
  }, true);

  if (/\/mycourse\//.test(location.pathname)) {
    // ended 事件偶尔不触发（播放器提前停下/被节流），每秒按播放状态兜底判断
    const stateWatch = setInterval(() => {
      try {
        const video = findMainVideo();
        if (!video || video.currentTime <= 0) return;
        if (isMainVideoDone(video)) signalVideoEnded();
      } catch (e) {}
    }, 1000);
    window.addEventListener('pagehide', () => clearInterval(stateWatch));
  }

  // 平台把登录态存在名称以 access-token 结尾的 cookie 里
  function getAccessTokenCookie() {
    for (const part of document.cookie.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (/access-token$/.test(name)) {
        const raw = part.slice(idx + 1).trim();
        try {
          return decodeURIComponent(raw);
        } catch (e) {
          return raw;
        }
      }
    }
    return '';
  }

  function parseTime(str) {
    if (!str) return NaN;
    const s = String(str);
    if (s.includes('T')) return Date.parse(s);
    return new Date(s.replace(/-/g, '/')).getTime();
  }

  function getAppBase() {
    const parts = location.pathname.split('/');
    return parts[1] === 'app' && parts[2] ? `/app/${parts[2]}` : '/app/jx-web';
  }

  function buildTaskUrl(task) {
    const groupId = task.group_id;
    const nodeId = task.node_id;
    if (!groupId || !nodeId) return null;
    const parentId = task.parent_id || task.parent_node_id || '_';
    return `${location.origin}${getAppBase()}/mycourse/${groupId}/resource/${parentId}/${nodeId}`;
  }

  async function runAutoOpenWatch() {
    if (S.watchWorking) return { error: '正在执行中，请稍候' };
    S.watchWorking = true;

    try {
      overlay('正在打开「待完成任务」...');
      const modal = await openUnstudyModal();

      let weekClicks = 0;
      const scannedMap = new Map();
      if (modal) {
        await waitFor(() => modal.querySelector('.rc-calendar-cell'));
        overlay('正在点击日历中的红点日期...');
        const merge = () => {
          for (const c of collectWatchCards(modal)) {
            scannedMap.set(`${c.group}|${c.name}`, c);
          }
        };
        weekClicks = await clickRedDotWeeks(modal, merge);
        merge();
      }

      overlay('正在读取待完成任务数据...');
      const resp = await callBackground({
        action: 'fetchUnfinishedTasks',
        origin: location.origin,
        token: getAccessTokenCookie(),
      });

      if (resp?.error) {
        overlay('读取任务失败');
        return {
          error: `读取待完成任务失败：${resp.error}`,
          modalOpened: !!modal,
          weekClicks,
          scanned: scannedMap.size,
          watchUrls: 0,
          opened: 0,
        };
      }

      const now = Date.now();
      const mp4Urls = [];
      const otherUrls = [];
      const seenUrl = new Set();
      for (const task of resp.tasks || []) {
        if (Number(task.task_type) !== WATCH_TASK_TYPE) continue;
        const startAt = parseTime(task.start_time);
        if (Number.isFinite(startAt) && startAt > now) continue;
        const endAt = parseTime(task.end_time);
        const allowAfter = task.is_allow_after_submitted === true
          || task.is_allow_after_submitted === 1;
        if (!allowAfter && Number.isFinite(endAt) && endAt <= now) continue;
        const url = buildTaskUrl(task);
        if (!url || seenUrl.has(url)) continue;
        seenUrl.add(url);
        // 任务名里带 mp4 的视为视频任务，放到新窗口并自动播放
        const taskName = String(task.name || task.node_name || task.resource_name || '');
        if (/mp4/i.test(taskName)) mp4Urls.push(url);
        else otherUrls.push(url);
      }

      const watchUrls = mp4Urls.length + otherUrls.length;
      if (watchUrls === 0) {
        overlay('没有找到「自主观看」任务');
        return { ok: true, modalOpened: !!modal, weekClicks, scanned: scannedMap.size, watchUrls: 0, opened: 0, windowOpened: 0, tabOpened: 0 };
      }

      overlay(`找到 ${watchUrls} 个「自主观看」任务，正在打开...`);
      const [win, tabs] = await Promise.all([
        mp4Urls.length ? callBackground({ action: 'openTabs', urls: mp4Urls, mode: 'window' }) : { opened: 0 },
        otherUrls.length ? callBackground({ action: 'openTabs', urls: otherUrls, mode: 'tabs' }) : { opened: 0 },
      ]);

      const windowOpened = win?.opened ?? 0;
      const tabOpened = tabs?.opened ?? 0;
      overlay(`完成：新窗口 ${windowOpened} 个，标签页 ${tabOpened} 个`);
      return {
        ok: true,
        modalOpened: !!modal,
        weekClicks,
        scanned: scannedMap.size,
        watchUrls,
        opened: windowOpened + tabOpened,
        windowOpened,
        tabOpened,
      };
    } catch (e) {
      overlay('执行出错');
      return { error: e.message };
    } finally {
      S.watchWorking = false;
      setTimeout(() => overlay(null), 6000);
    }
  }

  startVideoAutoPlay();
  startVideoClickWatch();
  watchVideoRoute();

  // 客观题页加载后打印一次扫描结果，方便确认题干/选项是否抓对
  if (/\/course_paper\/|\/exam\/|\/test\//.test(location.pathname)) {
    let scanned = false;
    let tries = 0;
    const scanTick = () => {
      tries++;
      try {
        const items = scanChoiceQuestions();
        if (items.length) {
          scanned = true;
          console.log('[WHUT AI] 客观题扫描', JSON.stringify(publicChoiceQuestions(items).map((q) => ({
            type: q.type,
            stem: q.stem.slice(0, 60),
            options: q.options.map((o) => `${o.letter}. ${o.text.slice(0, 30)}`),
          }))));
        }
      } catch (e) {}
      if (!scanned && tries < 15) setTimeout(scanTick, 2000);
    };
    setTimeout(scanTick, 1500);
  }

  // 补注入不会移除旧实例的监听；统一走全局分发器，让最新注入的实例接管消息。
  // 因此新版本使用 scanObjectiveV2/fillObjectiveV2，旧实例不认识这些 action 就不会抢先应答。
  if (!window.__whutAiDispatch) {
    window.__whutAiDispatch = { handler: null };
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      const handler = window.__whutAiDispatch && window.__whutAiDispatch.handler;
      return handler ? handler(msg, sender, sendResponse) : undefined;
    });
  }

  window.__whutAiDispatch.handler = (msg, _sender, sendResponse) => {
    if (msg.action === 'countInputs') {
      sendResponse({ count: findAnswerInputs().length });
      return;
    }
    if (msg.action === 'fill') {
      processFill(msg.items || []).then(sendResponse, (e) => sendResponse({ error: e?.message || String(e) }));
      return true;
    }
    if (msg.action === 'scanObjectiveV2') {
      const items = scanChoiceQuestions();
      const diag = choiceDiagnostics();
      if (items.length) {
        opLog(`[客观题] 扫描到 ${items.length} 题（控件 ${diag.controls}，可用 ${diag.usable}，div 选项 ${diag.divOptions}，分组 ${diag.groups}）`);
      }
      sendResponse({
        questions: publicChoiceQuestions(items),
        diag,
        logs: takeLogs(),
      });
      return;
    }
    if (msg.action === 'fillObjectiveV2') {
      processChoiceFill(msg.items || []).then(sendResponse, (e) => sendResponse({ error: e?.message || String(e) }));
      return true;
    }
    if (msg.action === 'autoOpenWatch') {
      // 任务面板可能位于同源 iframe 中：能看到任务界面的框架才响应，顶层框架始终响应兜底
      const hasTaskUi = !!document.querySelector(
        '[data-xy-click-pt="unstudy-task"], .aia_to_mission, .ta_Calender, .ta_rightBox'
      );
      if (window.top !== window && !hasTaskUi) return;
      runAutoOpenWatch().then(sendResponse, (e) => sendResponse({ error: e?.message || String(e) }));
      return true;
    }
  };

  console.log('[WHUT AI 答题助手] content script 已加载');
})();
