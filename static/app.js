(() => {
  const state = {
    items: [],
    maxTotalSize: 0,
    toastTimer: null,
    expiryRefreshInFlight: false,
    dragDepth: 0,
    modalResolve: null,
    modalPreviousFocus: null,
    theme: 'system'
  };
  const $ = (selector) => document.querySelector(selector);
  const THEME_KEY = 'share-web-theme';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let index = -1;
    do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function formatDate(seconds) {
    return new Date(seconds * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function expiryText(item) {
    if (!item.expiresAt) return '永久';
    const remaining = item.expiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return '即将删除';
    if (remaining < 60) return `${remaining} 秒后过期`;
    if (remaining < 3600) return `${Math.ceil(remaining / 60)} 分钟后过期`;
    if (remaining < 86400) return `${Math.ceil(remaining / 3600)} 小时后过期`;
    return `${Math.ceil(remaining / 86400)} 天后过期`;
  }

  function showToast(message, error = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
  }

  function cardForId(id) {
    return [...document.querySelectorAll('.item-card')].find((card) => card.dataset.id === id);
  }

  function removalDuration() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 420;
  }

  function animateCardRemoval(id) {
    const card = cardForId(id);
    if (!card) return Promise.resolve();
    card.classList.add('is-removing');
    return new Promise((resolve) => setTimeout(resolve, removalDuration()));
  }

  function renderUsage(usedBytes, maxTotalSize) {
    state.maxTotalSize = maxTotalSize;
    const usageText = $('#usage-text');
    const fill = $('#usage-fill');
    if (!maxTotalSize) {
      usageText.textContent = `${formatBytes(usedBytes)} · 不限额`;
      fill.style.width = '8%';
      return;
    }
    const percentage = Math.min(100, (usedBytes / maxTotalSize) * 100);
    usageText.textContent = `${formatBytes(usedBytes)} / ${formatBytes(maxTotalSize)}`;
    fill.style.width = `${Math.max(percentage, usedBytes ? 2 : 0)}%`;
  }

  function cardMarkup(item) {
    const isFile = item.kind === 'file';
    const title = escapeHtml(item.name);
    const meta = `${isFile ? formatBytes(item.size) : `${item.size} 字节`} · ${formatDate(item.createdAt)}`;
    const previewText = String(item.text || '');
    const preview = isFile ? '' : `<div class="item-preview">${escapeHtml(previewText.slice(0, 4000))}${previewText.length > 4000 ? '…' : ''}</div>`;
    return `<article class="item-card ${isFile ? 'file' : 'clip'}" data-id="${escapeHtml(item.id)}" data-kind="${item.kind}">
      <div class="item-icon">${isFile ? '↧' : '✦'}</div>
      <div class="item-title">${title}</div>
      <div class="item-meta">${meta}<span class="expiry">${expiryText(item)}</span></div>
      ${preview}
      <div class="item-actions">
        <button class="icon-button settings" title="设置过期时间" aria-label="设置过期时间">⚙</button>
        <button class="icon-button delete" title="删除" aria-label="删除">×</button>
      </div>
    </article>`;
  }

  function renderItems() {
    const files = state.items.filter((item) => item.kind === 'file');
    const clips = state.items.filter((item) => item.kind === 'clip');
    $('#file-list').innerHTML = files.map(cardMarkup).join('');
    $('#clip-list').innerHTML = clips.map(cardMarkup).join('');
    $('#file-empty').hidden = files.length > 0;
    $('#clip-empty').hidden = clips.length > 0;
  }

  async function loadItems(silent = false) {
    try {
      const response = await fetch('/api/items', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取列表失败');
      state.items = payload.items || [];
      renderItems();
      renderUsage(payload.usedBytes || 0, payload.maxTotalSize || 0);
    } catch (error) {
      if (!silent) showToast(error.message, true);
    }
  }

  function uploadFile(file) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      const request = new XMLHttpRequest();
      request.open('POST', '/api/files');
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) showToast(`正在上传 ${file.name} · ${Math.round(event.loaded / event.total * 100)}%`);
      };
      request.onload = () => {
        let payload = {};
        try { payload = JSON.parse(request.responseText); } catch (_) {}
        if (request.status >= 200 && request.status < 300) resolve(payload);
        else reject(new Error(payload.error || `上传失败（${request.status}）`));
      };
      request.onerror = () => reject(new Error('网络错误，上传失败'));
      request.send(form);
    });
  }

  async function uploadFiles(fileList) {
    const files = [...fileList];
    for (const file of files) {
      try {
        await uploadFile(file);
        showToast(`${file.name} 上传完成`);
      } catch (error) {
        showToast(`${file.name}: ${error.message}`, true);
      }
    }
    await loadItems(true);
  }

  async function createClip(text) {
    const response = await fetch('/api/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '创建文字卡片失败');
    await loadItems(true);
  }

  function closeModal(result) {
    const modalRoot = $('#modal-root');
    if (modalRoot.hidden) return;
    modalRoot.hidden = true;
    document.body.classList.remove('modal-open');
    const resolve = state.modalResolve;
    const previousFocus = state.modalPreviousFocus;
    state.modalResolve = null;
    state.modalPreviousFocus = null;
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    if (resolve) resolve(result);
  }

  function openModal({ kicker, title, content, actions, focusSelector = '#modal-close' }) {
    closeModal();
    return new Promise((resolve) => {
      state.modalResolve = resolve;
      state.modalPreviousFocus = document.activeElement;
      $('#modal-kicker').textContent = kicker || '';
      $('#modal-title').textContent = title;
      $('#modal-description').innerHTML = content;
      $('#modal-actions').innerHTML = actions || '';
      $('#modal-root').hidden = false;
      document.body.classList.add('modal-open');
      requestAnimationFrame(() => $(focusSelector)?.focus());
    });
  }

  function toDateTimeLocal(seconds) {
    const date = new Date(seconds * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function expiryModal(item) {
    const customValue = item.expiresAt ? toDateTimeLocal(item.expiresAt) : '';
    const content = `<p>设置“${escapeHtml(item.name)}”的自动删除时间。快捷选项会立即生效，自定义时间点击保存后生效。</p>
      <div class="quick-options">
        <button class="quick-option" type="button" data-modal-action="expiry-quick" data-seconds="0">永久保存</button>
        <button class="quick-option" type="button" data-modal-action="expiry-quick" data-seconds="600">10 分钟</button>
        <button class="quick-option" type="button" data-modal-action="expiry-quick" data-seconds="3600">1 小时</button>
        <button class="quick-option" type="button" data-modal-action="expiry-quick" data-seconds="86400">1 天</button>
        <button class="quick-option" type="button" data-modal-action="expiry-quick" data-seconds="604800">7 天</button>
      </div>
      <label class="custom-expiry">自定义时间
        <input id="custom-expiry" type="datetime-local" value="${customValue}">
      </label>`;
    return openModal({
      kicker: 'EXPIRATION',
      title: '设置自动删除',
      content,
      actions: '<button class="button secondary" type="button" data-modal-action="cancel">取消</button><button class="button primary" type="button" data-modal-action="expiry-custom">保存设置</button>',
      focusSelector: '#custom-expiry'
    });
  }

  function confirmDeleteModal(item) {
    return openModal({
      kicker: 'DELETE ITEM',
      title: '确认删除这条内容？',
      content: `<p>“${escapeHtml(item.name)}”删除后无法恢复，文件本体也会从共享目录中移除。</p>`,
      actions: '<button class="button secondary" type="button" data-modal-action="cancel">再想想</button><button class="button danger" type="button" data-modal-action="confirm-delete">确认删除</button>'
    });
  }

  function helpModal() {
    return openModal({
      kicker: 'HOW IT WORKS',
      title: '使用说明',
      content: `<div class="help-list">
        <div class="help-row"><div class="help-row-icon">↧</div><div><strong>共享文件</strong><span>拖拽文件到上传区域，或点击“选择文件”。点击文件卡片主体即可下载。</span></div></div>
        <div class="help-row"><div class="help-row-icon">✦</div><div><strong>共享文字</strong><span>桌面端可以直接按 Ctrl/Command+V；手机端粘贴到文字输入框，点击保存或按回车。</span></div></div>
        <div class="help-row"><div class="help-row-icon">⚙</div><div><strong>卡片操作</strong><span>设置按钮可以选择自动删除时间，右上角 × 可以立即删除。点击文字卡片会复制内容。</span></div></div>
      </div>`,
      actions: '<button class="button primary" type="button" data-modal-action="cancel">知道了</button>'
    });
  }

  async function deleteItem(id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item || !(await confirmDeleteModal(item))) return;
    const card = cardForId(id);
    const removal = animateCardRemoval(id);
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '删除失败');
      await removal;
      showToast('已删除');
      await loadItems(true);
    } catch (error) {
      card?.classList.remove('is-removing');
      throw error;
    }
  }

  async function updateExpiry(id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const result = await expiryModal(item);
    if (result === undefined) return;
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt: result })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '设置过期时间失败');
      showToast(result ? '过期时间已更新' : '已设置为永久保存');
      await loadItems(true);
    } catch (error) { showToast(error.message, true); }
  }

  async function copyClip(item) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(item.text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = item.text;
        textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.appendChild(textarea); textarea.select();
        document.execCommand('copy'); textarea.remove();
      }
      showToast('文字已复制到剪切板');
    } catch (error) { showToast(`复制失败：${error.message}`, true); }
  }

  function applyTheme(preference, persist = true) {
    const value = ['system', 'dark', 'light'].includes(preference) ? preference : 'system';
    state.theme = value;
    if (persist) {
      try { localStorage.setItem(THEME_KEY, value); } catch (_) {}
    }
    const actual = value === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = actual;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', actual === 'dark' ? '#08111f' : '#edf3f8');
    $('#theme-select').value = value;
  }

  async function initializeTheme() {
    let preference = 'system';
    try { preference = localStorage.getItem(THEME_KEY) || 'system'; } catch (_) {}
    applyTheme(preference, false);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', () => { if (state.theme === 'system') applyTheme('system', false); });
    try {
      const response = await fetch('/api/preferences', { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        if (['system', 'dark', 'light'].includes(payload.theme)) applyTheme(payload.theme, false);
      }
    } catch (_) {
      // localStorage remains the fallback when the preference endpoint is unavailable.
    }
  }

  async function saveThemePreference(theme) {
    try {
      const response = await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme })
      });
      if (!response.ok) throw new Error('preference endpoint rejected the theme');
    } catch (_) {
      // The selection is already persisted locally; server persistence is best effort.
    }
  }

  const modalRoot = $('#modal-root');
  modalRoot.addEventListener('click', (event) => {
    if (event.target.closest('[data-modal-close]')) { closeModal(); return; }
    const action = event.target.closest('[data-modal-action]');
    if (!action) return;
    if (action.dataset.modalAction === 'cancel') { closeModal(); return; }
    if (action.dataset.modalAction === 'confirm-delete') { closeModal(true); return; }
    if (action.dataset.modalAction === 'expiry-quick') {
      const seconds = Number(action.dataset.seconds);
      closeModal(seconds ? Math.floor(Date.now() / 1000) + seconds : null);
      return;
    }
    if (action.dataset.modalAction === 'expiry-custom') {
      const input = $('#custom-expiry');
      const timestamp = input?.value ? Math.floor(new Date(input.value).getTime() / 1000) : NaN;
      if (!Number.isFinite(timestamp) || timestamp <= Math.floor(Date.now() / 1000)) {
        showToast('请选择一个未来的时间', true);
        input?.focus();
        return;
      }
      closeModal(timestamp);
    }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modalRoot.hidden) closeModal(); });

  document.addEventListener('click', (event) => {
    const settings = event.target.closest('.settings');
    const remove = event.target.closest('.delete');
    const card = event.target.closest('.item-card');
    if (settings) { event.stopPropagation(); updateExpiry(settings.closest('.item-card').dataset.id); return; }
    if (remove) { event.stopPropagation(); deleteItem(remove.closest('.item-card').dataset.id).catch((error) => showToast(error.message, true)); return; }
    if (!card) return;
    const item = state.items.find((candidate) => candidate.id === card.dataset.id);
    if (!item) return;
    if (item.kind === 'file') window.location.href = `/api/files/${encodeURIComponent(item.id)}/download`;
    else copyClip(item);
  });

  document.addEventListener('paste', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text || !text.trim()) return;
    event.preventDefault();
    createClip(text).then(() => showToast('已创建文字卡片')).catch((error) => showToast(error.message, true));
  });

  const input = $('#file-input');
  const dropZone = $('#drop-zone');
  const dropOverlay = $('#drop-overlay');
  const clipForm = $('#clip-form');
  const clipInput = $('#clip-input');
  input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); }));

  function hasFilePayload(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    if (types.includes('Files') || types.includes('application/x-moz-file') || types.includes('public.file-url')) return true;
    return Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file');
  }

  function setDropOverlay(visible) {
    dropOverlay.hidden = !visible;
    dropOverlay.setAttribute('aria-hidden', String(!visible));
    if (visible) dropOverlay.classList.add('is-visible');
    else dropOverlay.classList.remove('is-visible');
  }

  document.addEventListener('dragenter', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    setDropOverlay(true);
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (!dropOverlay.hidden) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) setDropOverlay(false);
  });
  document.addEventListener('drop', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    setDropOverlay(false);
    if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files);
  });
  clipForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = clipInput.value;
    if (!text.trim()) { showToast('请输入或粘贴文字', true); clipInput.focus(); return; }
    try {
      await createClip(text);
      clipInput.value = '';
      showToast('已创建文字卡片');
    } catch (error) { showToast(error.message, true); }
  });
  clipInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      clipForm.requestSubmit();
    }
  });
  $('#help-button').addEventListener('click', helpModal);
  $('#theme-select').addEventListener('change', (event) => {
    const theme = event.target.value;
    applyTheme(theme);
    saveThemePreference(theme);
  });

  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const expiredIds = [];
    document.querySelectorAll('.expiry').forEach((element) => {
      const item = state.items.find((candidate) => candidate.id === element.closest('.item-card')?.dataset.id);
      if (!item) return;
      if (item.expiresAt && item.expiresAt <= now) {
        expiredIds.push(item.id);
      } else {
        element.textContent = expiryText(item);
      }
    });
    if (expiredIds.length && !state.expiryRefreshInFlight) {
      state.expiryRefreshInFlight = true;
      Promise.all([...new Set(expiredIds)].map(animateCardRemoval))
        .then(() => loadItems(true))
        .finally(() => { state.expiryRefreshInFlight = false; });
    }
  }, 1000);
  setInterval(() => loadItems(true), 30000);
  initializeTheme();
  loadItems();
})();
