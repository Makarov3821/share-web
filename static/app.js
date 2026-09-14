(() => {
  const state = { items: [], maxTotalSize: 0, toastTimer: null };
  const $ = (selector) => document.querySelector(selector);

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

  async function deleteItem(id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item || !confirm(`确定删除“${item.name}”吗？`)) return;
    const response = await fetch(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '删除失败');
    showToast('已删除');
    await loadItems(true);
  }

  async function updateExpiry(id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const answer = prompt('输入过期时间：never、10m、1h、1d，或输入 Unix 时间戳。留空表示永久。', item.expiresAt ? String(item.expiresAt) : '');
    if (answer === null) return;
    let expiresAt = null;
    const value = answer.trim().toLowerCase();
    if (value && value !== 'never') {
      const match = value.match(/^(\d+)\s*(m|h|d)$/);
      if (match) {
        const multiplier = { m: 60, h: 3600, d: 86400 }[match[2]];
        expiresAt = Math.floor(Date.now() / 1000) + Number(match[1]) * multiplier;
      } else if (/^\d+$/.test(value)) {
        expiresAt = Number(value);
      } else {
        showToast('格式不正确，请使用 never、10m、1h、1d 或时间戳', true);
        return;
      }
    }
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '设置过期时间失败');
      showToast(expiresAt ? '过期时间已更新' : '已设置为永久保存');
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
  input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); }));
  dropZone.addEventListener('drop', (event) => { if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files); });

  setInterval(() => document.querySelectorAll('.expiry').forEach((element) => {
    const item = state.items.find((candidate) => candidate.id === element.closest('.item-card')?.dataset.id);
    if (item) element.textContent = expiryText(item);
  }), 1000);
  setInterval(() => loadItems(true), 30000);
  loadItems();
})();
