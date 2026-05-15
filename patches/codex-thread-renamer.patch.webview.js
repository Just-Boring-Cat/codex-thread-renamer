(() => {
  const PATCH_FLAG = '__codexThreadRenamerWebviewPatchApplied';
  if (window[PATCH_FLAG]) return;
  window[PATCH_FLAG] = true;

  let vscodeApi = null;
  installAcquireVsCodeApiWrapper();

  function installAcquireVsCodeApiWrapper() {
    try {
      const original = window.acquireVsCodeApi;
      if (typeof original !== 'function') return;
      if (original.__codexThreadRenamerWrapped === true) return;
      let cachedApi = null;
      const wrapped = function acquireVsCodeApiWrapped() {
        if (cachedApi) return cachedApi;
        cachedApi = original();
        return cachedApi;
      };
      Object.defineProperty(wrapped, '__codexThreadRenamerWrapped', { value: true });
      Object.defineProperty(wrapped, '__codexThreadRenamerOriginal', { value: original });
      window.acquireVsCodeApi = wrapped;
    } catch {
      // ignore
    }
  }

  function getVsCodeApi() {
    if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
      return vscodeApi;
    }
    try {
      if (typeof acquireVsCodeApi === 'function') {
        const api = acquireVsCodeApi();
        if (api && typeof api.postMessage === 'function') {
          vscodeApi = api;
          return vscodeApi;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  const THREAD_TITLE_SELECTOR = '[data-thread-title], [data-app-action-sidebar-thread-title]';
  const THREAD_REF_SELECTOR = 'a[href*="/local/"], a[href*="/remote/"]';
  const THREAD_ROW_SELECTOR = `${THREAD_REF_SELECTOR}, [data-app-action-sidebar-thread-row], [data-app-action-sidebar-thread-id], [data-conversation-id], [data-thread-id], [data-id], ${THREAD_TITLE_SELECTOR}`;
  const THREAD_MARK_SELECTOR = `${THREAD_REF_SELECTOR}, [data-app-action-sidebar-thread-row], [data-app-action-sidebar-thread-id], [data-conversation-id], [data-thread-id], [data-thread-title], [data-app-action-sidebar-thread-title]`;
  const VSCODE_CONTEXT_ATTR = 'data-vscode-context';
  const VSCODE_CONTEXT_KEY = 'codexThreadRenamer';
  const VSCODE_CONTEXT_VALUE = 'thread';
  let lastKnownCurrentThread = null;
  let inlineEditor = null;

  function hideMenu() {
    // The patch uses VS Code's native webview context menu. This no-op keeps
    // existing shortcut/blur call sites simple.
  }

  function isElementVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function closestThreadRow(start) {
    if (!(start instanceof Element)) return null;

    const direct = start.closest(THREAD_ROW_SELECTOR);
    if (direct) {
      return direct;
    }

    let node = start;
    while (node && node instanceof Element && node !== document.body) {
      if (node.querySelector) {
        const link = node.querySelector(THREAD_REF_SELECTOR);
        if (link) {
          return link;
        }
        const attrNode = node.querySelector(THREAD_ROW_SELECTOR);
        if (attrNode) {
          return attrNode;
        }
      }
      node = node.parentElement;
    }

    return null;
  }

  function scoreTitleNodeCandidate(element) {
    if (!(element instanceof Element) || !isElementVisible(element)) return -1;
    const text = String(element.textContent || '').trim();
    if (!text || text.length > 160) return -1;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const fontSize = parseFloat(style.fontSize) || 0;
    return fontSize * 20 + rect.width * 0.05 - text.length;
  }

  function findTitleNodeInRow(row) {
    if (!(row instanceof Element)) return null;
    if (row.matches(THREAD_TITLE_SELECTOR)) {
      return row;
    }

    const explicit = row.querySelector(THREAD_TITLE_SELECTOR);
    if (explicit) {
      return explicit;
    }

    const candidates = Array.from(row.querySelectorAll('span, div, p, strong'));
    candidates.sort((a, b) => scoreTitleNodeCandidate(b) - scoreTitleNodeCandidate(a));
    return candidates.find((candidate) => scoreTitleNodeCandidate(candidate) >= 0) || null;
  }

  function closestThreadTitleNode(start) {
    if (start instanceof Element) {
      const explicit = start.closest(THREAD_TITLE_SELECTOR);
      if (explicit) return explicit;
    }
    const row = closestThreadRow(start);
    if (!row) return null;
    return findTitleNodeInRow(row);
  }

  function extractThreadInfo(targetNode) {
    const row =
      (targetNode instanceof Element ? targetNode.closest('[data-app-action-sidebar-thread-row]') : null) ||
      closestThreadRow(targetNode) ||
      (targetNode instanceof Element ? targetNode.closest('a,button,[role="button"],li,div') : null);
    const titleNode = findTitleNodeInRow(row) || (targetNode instanceof Element ? targetNode.closest(THREAD_TITLE_SELECTOR) : null);
    const link = (targetNode instanceof Element ? targetNode.closest('a[href]') : null) || (row && row.querySelector ? row.querySelector('a[href]') : null);

    let href = '';
    if (link && link.getAttribute) href = link.getAttribute('href') || '';

    let threadId = null;
    let kind = null;
    if (href) {
      const match = href.match(/\/(local|remote)\/([^/?#]+)/);
      if (match) {
        kind = match[1];
        threadId = match[2];
      }
    }

    if (row) {
      kind = kind || normalizeKind(row.getAttribute('data-app-action-sidebar-thread-kind'));
    }

    if (!threadId && row) {
      const attrs = ['data-app-action-sidebar-thread-id', 'data-conversation-id', 'data-thread-id', 'data-id'];
      for (const a of attrs) {
        const v = row.getAttribute && row.getAttribute(a);
        if (v) {
          threadId = v;
          break;
        }
      }
    }

    threadId = normalizeThreadId(threadId, kind);
    const title = String((titleNode && titleNode.textContent) || (row && row.textContent) || '').trim();
    return { titleNode, row, link, href, threadId, kind, title };
  }

  function normalizeKind(value) {
    const kind = String(value || '').trim();
    return kind || null;
  }

  function normalizeThreadId(value, kind) {
    if (!value) return null;
    const id = String(value).trim();
    if (!id) return null;
    if (kind === 'local' && id.startsWith('local:')) return id.slice('local:'.length);
    if (kind === 'remote' && id.startsWith('remote:')) return id.slice('remote:'.length);
    if (kind === 'pending-worktree' && id.startsWith('pending-worktree:')) return id.slice('pending-worktree:'.length);
    if (id.startsWith('local:')) return id.slice('local:'.length);
    if (id.startsWith('remote:')) return id.slice('remote:'.length);
    return id;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }

  function updateLiveThreadTitle(threadId, title) {
    const normalized = normalizeThreadId(threadId, 'local');
    if (!normalized || !title) return;

    const escaped = cssEscape(normalized);
    const selectors = [
      `[data-app-action-sidebar-thread-id="local:${escaped}"] [data-thread-title]`,
      `[data-app-action-sidebar-thread-id="local:${escaped}"] [data-app-action-sidebar-thread-title]`,
      `[data-app-action-sidebar-thread-id="${escaped}"] [data-thread-title]`,
      `[data-app-action-sidebar-thread-id="${escaped}"] [data-app-action-sidebar-thread-title]`,
      `[data-conversation-id="${escaped}"] [data-thread-title]`,
      `[data-thread-id="${escaped}"] [data-thread-title]`,
    ];

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        node.textContent = title;
      }
    }
  }

  function rememberCurrentThread(info) {
    if (!info || !info.threadId) return;
    lastKnownCurrentThread = {
      threadId: info.threadId,
      kind: info.kind || 'local',
      resource: info.href || '',
      title: info.title || '',
    };
  }

  function buildThreadPayload(info) {
    if (!info || !info.threadId) return null;
    return {
      threadId: info.threadId,
      kind: info.kind || 'local',
      resource: info.href || '',
      title: info.title || '',
    };
  }

  function rememberContextThread(info) {
    const payload = buildThreadPayload(info);
    if (payload) {
      rememberCurrentThread(info);
    }
    return payload;
  }

  function reportContextThread(info) {
    const payload = rememberContextThread(info);
    const api = getVsCodeApi();
    if (!api) return;
    api.postMessage({
      type: 'open-vscode-command',
      command: 'chatgpt.renameThreadRememberContext',
      args: payload ? [payload] : [],
    });
  }

  function clearContextThread() {
    reportContextThread(null);
  }

  function startInlineRenameForTarget(target) {
    const info = extractThreadInfo(target);
    if (!info.threadId) {
      console.warn('[codex-thread-renamer-patch] Could not resolve threadId from thread row', info);
      triggerRenameCommand();
      return;
    }
    rememberCurrentThread(info);
    createInlineRenameEditor({
      threadId: info.threadId,
      title: info.title || '',
    }, info.titleNode || target);
  }

  function submitRename(threadId, name) {
    const api = getVsCodeApi();
    if (!api) return;
    api.postMessage({
      type: 'open-vscode-command',
      command: 'chatgpt.renameThread',
      args: [{ threadId, name }],
    });
  }

  function shouldHandleRenameShortcut(event) {
    if (!event || event.defaultPrevented) return false;
    if (event.altKey || event.shiftKey) return false;
    if (!(event.metaKey || event.ctrlKey)) return false;
    const key = String(event.key || '').toLowerCase();
    const code = String(event.code || '').toLowerCase();
    if (key !== 'r' && code !== 'keyr') return false;

    const target = event.target;
    if (!(target instanceof Element)) return true;
    if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
      return false;
    }
    return true;
  }

  function triggerRenameCommand() {
    const api = getVsCodeApi();
    if (!api) return;
    api.postMessage({
      type: 'open-vscode-command',
      command: 'chatgpt.renameThreadInline',
      args: [],
    });
  }

  function findHeaderTitleCandidate(thread) {
    if (!thread || (!thread.threadId && !thread.title)) return null;

    const allElements = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], div, span, p'));
    const candidates = [];

    for (const element of allElements) {
      if (!isElementVisible(element)) continue;
      if (element.closest('a[href*="/local/"], a[href*="/remote/"]')) continue;
      const text = String(element.textContent || '').trim();
      if (!text) continue;
      if (thread.title) {
        if (text !== thread.title) continue;
      } else if (!text.includes(thread.threadId)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > Math.min(window.innerHeight * 0.45, 240)) continue;
      candidates.push({
        element,
        rect,
        score: (parseFloat(window.getComputedStyle(element).fontSize) || 0) * 10 - rect.top,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function findThreadListTitleCandidate(thread) {
    if (!thread) return null;

    const candidates = Array.from(document.querySelectorAll('[data-thread-title]'));
    for (const element of candidates) {
      if (!isElementVisible(element)) continue;
      const info = extractThreadInfo(element);
      if (!info.threadId) continue;
      if (thread.threadId && info.threadId === thread.threadId) {
        return info.titleNode || element;
      }
    }

    const rememberedTitle = String(thread.title || lastKnownCurrentThread?.title || '').trim();
    if (!rememberedTitle) {
      return null;
    }
    for (const element of candidates) {
      if (!isElementVisible(element)) continue;
      const text = String(element.textContent || '').trim();
      if (text === rememberedTitle) {
        return element;
      }
    }

    return null;
  }

  function findInlineRenameCandidate(thread) {
    return findThreadListTitleCandidate(thread) || findHeaderTitleCandidate(thread);
  }

  function getVisibleHeaderTitleText() {
    const selectors = ['h1', 'h2', 'h3', '[role="heading"]', 'div', 'span', 'p'];
    const candidates = [];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (!isElementVisible(element)) continue;
        if (element.closest('a[href*="/local/"], a[href*="/remote/"]')) continue;
        if (element.closest('button, [role="button"]')) continue;

        const text = String(element.textContent || '').trim();
        if (!text) continue;
        if (text.length > 120) continue;

        const rect = element.getBoundingClientRect();
        if (rect.top < 0 || rect.top > Math.min(window.innerHeight * 0.42, 220)) continue;
        if (rect.left > Math.min(window.innerWidth * 0.5, 420)) continue;

        const style = window.getComputedStyle(element);
        const fontSize = parseFloat(style.fontSize) || 0;
        if (fontSize < 18) continue;

        candidates.push({
          text,
          score: fontSize * 100 - rect.top - rect.left * 0.15,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.text || '';
  }

  function destroyInlineEditor({ restoreText = true, focusTarget = true } = {}) {
    if (!inlineEditor) return;
    const { container, input, anchor, originalText } = inlineEditor;
    window.removeEventListener('resize', inlineEditor.syncPosition, true);
    window.removeEventListener('scroll', inlineEditor.syncPosition, true);
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    if (restoreText && anchor) {
      anchor.style.visibility = '';
      anchor.textContent = originalText;
    } else if (anchor) {
      anchor.style.visibility = '';
    }
    if (focusTarget && anchor && typeof anchor.focus === 'function') {
      try {
        anchor.focus();
      } catch {
        // ignore
      }
    }
    inlineEditor = null;
  }

  function createInlineRenameEditor(thread, titleElement) {
    if (!thread || !thread.threadId || !titleElement) {
      return false;
    }

    destroyInlineEditor({ restoreText: false, focusTarget: false });

    const rect = titleElement.getBoundingClientRect();
    const style = window.getComputedStyle(titleElement);
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.zIndex = '999999';
    container.style.left = `${rect.left}px`;
    container.style.top = `${rect.top}px`;
    container.style.width = `${Math.max(rect.width + 24, 220)}px`;
    container.style.maxWidth = `${Math.max(window.innerWidth - rect.left - 16, 220)}px`;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = thread.title || titleElement.textContent || '';
    input.setAttribute('aria-label', 'Rename Codex thread');
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '2px 6px';
    input.style.margin = '0';
    input.style.border = '1px solid var(--vscode-focusBorder, #007fd4)';
    input.style.borderRadius = '4px';
    input.style.background = 'var(--vscode-input-background, #1f1f1f)';
    input.style.color = 'var(--vscode-input-foreground, #ffffff)';
    input.style.font = style.font;
    input.style.fontSize = style.fontSize;
    input.style.fontWeight = style.fontWeight;
    input.style.lineHeight = style.lineHeight;
    input.style.height = `${Math.max(rect.height + 4, 28)}px`;
    input.style.outline = 'none';
    input.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.15)';

    const syncPosition = () => {
      if (!inlineEditor || inlineEditor.input !== input) return;
      const nextRect = titleElement.getBoundingClientRect();
      container.style.left = `${nextRect.left}px`;
      container.style.top = `${nextRect.top}px`;
      container.style.width = `${Math.max(nextRect.width + 24, 220)}px`;
      container.style.maxWidth = `${Math.max(window.innerWidth - nextRect.left - 16, 220)}px`;
      input.style.height = `${Math.max(nextRect.height + 4, 28)}px`;
    };

    const commit = () => {
      const next = String(input.value || '').trim();
      if (!next) {
        destroyInlineEditor();
        return;
      }
      const unchanged = next === String(thread.title || titleElement.textContent || '').trim();
      destroyInlineEditor({ restoreText: true, focusTarget: false });
      if (!unchanged) {
        submitRename(thread.threadId, next);
      }
    };

    const cancel = () => {
      destroyInlineEditor();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      commit();
    });

    titleElement.style.visibility = 'hidden';
    container.appendChild(input);
    document.body.appendChild(container);
    inlineEditor = {
      container,
      input,
      anchor: titleElement,
      originalText: String(titleElement.textContent || ''),
      syncPosition,
    };
    window.addEventListener('resize', syncPosition, true);
    window.addEventListener('scroll', syncPosition, true);
    syncPosition();
    input.focus();
    input.select();
    return true;
  }

  function extractThreadRefFromValue(value) {
    if (!value) return null;
    const match = String(value).match(/\/(local|remote)\/([^/?#]+)/);
    if (!match) return null;
    return {
      kind: match[1],
      threadId: decodeURIComponent(match[2]),
      resource: String(value),
    };
  }

  function extractThreadInfoFromLink(link) {
    if (!(link instanceof Element)) return null;
    const href = link.getAttribute('href') || '';
    const ref = extractThreadRefFromValue(href);
    if (!ref) return null;
    const titleNode =
      link.querySelector('[data-thread-title]') ||
      link.querySelector('[data-app-action-sidebar-thread-title]') ||
      link.closest('[data-thread-title]') ||
      link.closest('[data-app-action-sidebar-thread-title]') ||
      null;
    return {
      threadId: ref.threadId,
      kind: ref.kind,
      href: ref.resource,
      title: titleNode ? String(titleNode.textContent || '').trim() : '',
    };
  }

  function getCurrentThreadFromDom() {
    const routeRef = extractThreadRefFromValue(window.location && window.location.href);
    if (routeRef) {
      const current = {
        threadId: routeRef.threadId,
        kind: routeRef.kind,
        resource: routeRef.resource,
        title: getVisibleHeaderTitleText(),
      };
      lastKnownCurrentThread = current;
      return current;
    }

    return null;

  }

  function getCurrentThreadPayload() {
    const current = getCurrentThreadFromDom();
    const visibleTitle = getVisibleHeaderTitleText();
    if (!current) {
      return null;
    }
    const activeTitleNode =
      document.querySelector('[data-thread-title][aria-current="page"]') ||
      document.querySelector('[data-thread-title][aria-selected="true"]') ||
      document.querySelector('[data-thread-title][data-active="true"]') ||
      document.querySelector('[data-app-action-sidebar-thread-title][aria-current="page"]') ||
      document.querySelector('[data-app-action-sidebar-thread-title][aria-selected="true"]') ||
      document.querySelector('[data-app-action-sidebar-thread-title][data-active="true"]') ||
      document.querySelector('[data-app-action-sidebar-thread-row][aria-current="page"] [data-app-action-sidebar-thread-title]') ||
      document.querySelector('[data-app-action-sidebar-thread-row][aria-selected="true"] [data-app-action-sidebar-thread-title]') ||
      document.querySelector('[data-app-action-sidebar-thread-row][data-active="true"] [data-app-action-sidebar-thread-title]') ||
      document.querySelector('[data-app-action-sidebar-thread-row][data-state="active"] [data-app-action-sidebar-thread-title]');

    return {
      threadId: current.threadId,
      kind: current.kind,
      resource: current.resource,
      title: activeTitleNode ? String(activeTitleNode.textContent || '').trim() : (current.title || visibleTitle || ''),
    };
  }

  function mergeVsCodeContext(element, patch) {
    if (!(element instanceof Element)) return;
    let context = {};
    const raw = element.getAttribute(VSCODE_CONTEXT_ATTR);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          context = parsed;
        }
      } catch {
        context = {};
      }
    }

    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (context[key] !== value) {
        context[key] = value;
        changed = true;
      }
    }
    if (changed || !raw) {
      element.setAttribute(VSCODE_CONTEXT_ATTR, JSON.stringify(context));
    }
  }

  function markSidebarContextElements() {
    const patch = { [VSCODE_CONTEXT_KEY]: VSCODE_CONTEXT_VALUE };
    mergeVsCodeContext(document.documentElement, patch);
    if (document.body) {
      mergeVsCodeContext(document.body, patch);
    }
  }

  function markThreadContextElement(element) {
    if (!(element instanceof Element)) return;
    const row = closestThreadRow(element) || element;
    const title = findTitleNodeInRow(row) || (element.matches(THREAD_TITLE_SELECTOR) ? element : null);
    const patch = { [VSCODE_CONTEXT_KEY]: VSCODE_CONTEXT_VALUE };
    mergeVsCodeContext(row, patch);
    mergeVsCodeContext(element, patch);
    if (title) {
      mergeVsCodeContext(title, patch);
    }
  }

  function markThreadContextElements(root = document) {
    markSidebarContextElements();
    if (root instanceof Element && root.matches(THREAD_MARK_SELECTOR)) {
      markThreadContextElement(root);
    }
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    for (const element of scope.querySelectorAll(THREAD_MARK_SELECTOR)) {
      markThreadContextElement(element);
    }
  }

  let markScheduled = false;
  function scheduleMarkThreadContextElements() {
    if (markScheduled) return;
    markScheduled = true;
    requestAnimationFrame(() => {
      markScheduled = false;
      markThreadContextElements();
    });
  }

  document.addEventListener('contextmenu', (event) => {
    markSidebarContextElements();
    const titleNode = closestThreadTitleNode(event.target);
    if (!titleNode) {
      clearContextThread();
      return;
    }
    markThreadContextElement(titleNode);
    const info = extractThreadInfo(titleNode);
    reportContextThread(info);
  }, true);

  document.addEventListener('click', (event) => {
    const titleNode = closestThreadTitleNode(event.target);
    if (titleNode) {
      const info = extractThreadInfo(titleNode);
      rememberCurrentThread(info);
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href*="/local/"], a[href*="/remote/"]') : null;
    if (!link) {
      return;
    }
    const info = extractThreadInfoFromLink(link);
    rememberCurrentThread(info);
  }, true);

  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && !closestThreadTitleNode(event.target)) {
      clearContextThread();
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (inlineEditor) {
        event.preventDefault();
        event.stopPropagation();
        destroyInlineEditor();
        return;
      }
      hideMenu();
      return;
    }
    if (!shouldHandleRenameShortcut(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideMenu();
    triggerRenameCommand();
  }, true);

  window.addEventListener('blur', hideMenu);
  window.addEventListener('resize', hideMenu);
  window.addEventListener('scroll', hideMenu, true);
  markThreadContextElements();
  new MutationObserver(scheduleMarkThreadContextElements).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('message', (event) => {
    const message = event && event.data;
    if (!message) {
      return;
    }
    if (message.type === 'thread-title-updated') {
      updateLiveThreadTitle(message.conversationId, message.title);
      return;
    }
    const api = getVsCodeApi();
    if (!api) {
      return;
    }
    if (message.type === 'codex-thread-renamer/get-current-thread') {
      api.postMessage({
        type: 'codex-thread-renamer/current-thread-response',
        requestId: message.requestId,
        payload: getCurrentThreadPayload(),
      });
      return;
    }
    if (message.type === 'codex-thread-renamer/start-inline-rename') {
      const thread = message.payload || getCurrentThreadPayload();
      const titleElement = findInlineRenameCandidate(thread);
      const ok = !!(thread && titleElement && createInlineRenameEditor(thread, titleElement));
      api.postMessage({
        type: 'codex-thread-renamer/inline-rename-response',
        requestId: message.requestId,
        ok,
      });
    }
  });
})();
