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

  const MENU_ID = 'codex-thread-renamer-context-menu';
  let menu = null;
  let currentTarget = null;

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.position = 'fixed';
    menu.style.zIndex = '999999';
    menu.style.display = 'none';
    menu.style.minWidth = '180px';
    menu.style.padding = '6px';
    menu.style.borderRadius = '8px';
    menu.style.border = '1px solid rgba(128,128,128,0.35)';
    menu.style.background = 'var(--vscode-menu-background, #1f1f1f)';
    menu.style.boxShadow = '0 6px 24px rgba(0,0,0,0.35)';
    menu.style.color = 'var(--vscode-menu-foreground, #fff)';

    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = 'Rename Thread';
    item.style.display = 'block';
    item.style.width = '100%';
    item.style.padding = '8px 10px';
    item.style.margin = '0';
    item.style.border = '0';
    item.style.borderRadius = '6px';
    item.style.background = 'transparent';
    item.style.color = 'inherit';
    item.style.textAlign = 'left';
    item.style.cursor = 'pointer';
    item.addEventListener('mouseenter', () => {
      item.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });
    item.addEventListener('click', () => {
      const target = currentTarget;
      hideMenu();
      if (!target) return;
      openRenamePrompt(target);
    });

    menu.appendChild(item);
    document.body.appendChild(menu);
    return menu;
  }

  function showMenu(x, y, target) {
    const m = ensureMenu();
    currentTarget = target;
    m.style.display = 'block';
    m.style.left = '0px';
    m.style.top = '0px';

    const pad = 8;
    const rect = m.getBoundingClientRect();
    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - rect.height - pad);
    m.style.left = `${Math.min(maxX, Math.max(pad, x))}px`;
    m.style.top = `${Math.min(maxY, Math.max(pad, y))}px`;
  }

  function hideMenu() {
    if (!menu) return;
    menu.style.display = 'none';
    currentTarget = null;
  }

  function closestThreadTitleNode(start) {
    if (!(start instanceof Element)) return null;
    return start.closest('[data-thread-title]');
  }

  function extractThreadInfo(titleNode) {
    const row = titleNode.closest('a,button,[role="button"],li,div');
    const link = titleNode.closest('a[href]') || (row && row.querySelector ? row.querySelector('a[href]') : null);

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

    if (!threadId && row) {
      const attrs = ['data-conversation-id', 'data-thread-id', 'data-id'];
      for (const a of attrs) {
        const v = row.getAttribute && row.getAttribute(a);
        if (v) {
          threadId = v;
          break;
        }
      }
    }

    const title = String(titleNode.textContent || '').trim();
    return { titleNode, row, link, href, threadId, kind, title };
  }

  function openRenamePrompt(target) {
    const api = getVsCodeApi();
    if (!api) return;
    const info = extractThreadInfo(target);
    if (!info.threadId) {
      console.warn('[codex-thread-renamer-patch] Could not resolve threadId from thread row', info);
      return;
    }
    const currentTitle = info.title || '';
    const next = window.prompt('Rename Codex thread', currentTitle);
    if (next == null) return;
    const name = String(next).trim();
    if (!name) return;

    api.postMessage({
      type: 'open-vscode-command',
      command: 'chatgpt.renameThread',
      args: [{ threadId: info.threadId, name }],
    });
  }

  document.addEventListener('contextmenu', (event) => {
    const titleNode = closestThreadTitleNode(event.target);
    if (!titleNode) {
      hideMenu();
      return;
    }
    const info = extractThreadInfo(titleNode);
    if (!info.threadId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showMenu(event.clientX, event.clientY, titleNode);
  }, true);

  document.addEventListener('click', (event) => {
    if (!menu || menu.style.display === 'none') return;
    if (event.target instanceof Node && menu.contains(event.target)) return;
    hideMenu();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
  }, true);

  window.addEventListener('blur', hideMenu);
  window.addEventListener('resize', hideMenu);
  window.addEventListener('scroll', hideMenu, true);
})();
