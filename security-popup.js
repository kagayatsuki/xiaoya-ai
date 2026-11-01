(() => {
  'use strict';

  // 从 block-security-popup 整合：屏蔽 infra.ai-augmented.com 的「账号安全提示」弹窗
  const TITLE_TEXT = '账号安全提示';
  const BODY_TEXT = '检测到当前登录账号存在以下安全问题';
  const CONTINUE_TEXT = '继续登录';
  const POPUP_SELECTOR = '.el-message-box, .el-dialog, .ant-modal, .modal, [role="dialog"]';
  const ROOT_SELECTOR = '.el-overlay, .el-message-box__wrapper, .el-dialog__wrapper, .ant-modal-root, .modal, [role="dialog"]';

  const normalize = (text) => (text || '').replace(/\s+/g, '');

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function containsSecurityText(el) {
    const text = normalize(el.innerText || el.textContent);
    return text.includes(normalize(TITLE_TEXT)) && text.includes(normalize(BODY_TEXT));
  }

  function clickContinueLogin(root) {
    for (const button of root.querySelectorAll('button, .el-button, [role="button"], a')) {
      if (normalize(button.innerText || button.textContent).includes(normalize(CONTINUE_TEXT))) {
        button.click();
        return true;
      }
    }
    return false;
  }

  // 弹窗关闭后常残留全屏遮罩并锁住滚动
  function removeLeftoverMasks() {
    document.querySelectorAll('.v-modal, .el-overlay, .ant-modal-mask, .modal-backdrop').forEach((mask) => {
      if (isVisible(mask) && !containsSecurityText(mask)) mask.remove();
    });

    document.documentElement.style.overflow = '';
    if (document.body) {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    }
  }

  function blockSecurityPopup() {
    let blocked = false;
    for (const candidate of document.querySelectorAll(POPUP_SELECTOR)) {
      if (!isVisible(candidate) || !containsSecurityText(candidate)) continue;
      const root = candidate.closest(ROOT_SELECTOR) || candidate;
      if (clickContinueLogin(root)) blocked = true;
      removeLeftoverMasks();
    }
    if (blocked) console.log('[WHUT AI] 已屏蔽账号安全提示');
  }

  let scheduled = false;
  function scheduleCheck() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      blockSecurityPopup();
    }, 50);
  }

  function start() {
    blockSecurityPopup();
    new MutationObserver(scheduleCheck).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setInterval(blockSecurityPopup, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
