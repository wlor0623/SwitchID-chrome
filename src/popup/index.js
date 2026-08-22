// popup/index.js - SwitchID Local 弹窗逻辑

'use strict';

const PALETTE = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9333EA', '#EC4899', '#14B8A6', '#6B7280'];

const UA_PRESETS = {
  'chrome-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'chrome-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'firefox-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'safari-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'mobile-android': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'mobile-ios': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
};

let currentDomain = '';
let mainDomain = '';
let profiles = [];
let recentUsage = [];
let activeProfile = null;
let selectedColor = PALETTE[0];
let editSelectedColor = PALETTE[0];
let editingProfile = null;
let editTags = [];
let editFingerprint = null;
let searchQuery = '';
let sortBy = 'recent';
let pendingAction = null;
let rotateConfig = null;

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', async () => {
  buildColorPickers();
  await loadTheme();
  await init();
  setupEventListeners();
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(tab.url)) {
    showUnsupported();
    return;
  }
  try {
    currentDomain = new URL(tab.url).hostname;
  } catch (e) {
    showUnsupported();
    return;
  }
  $('current-domain').textContent = currentDomain;
  await loadProfiles();
}

async function loadTheme() {
  const data = await chrome.storage.local.get(['settings']);
  if (data.settings?.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

function showUnsupported() {
  $('unsupported').style.display = 'flex';
  $('profiles-section').style.display = 'none';
  $('empty-state').style.display = 'none';
  document.querySelector('.quick-actions').style.display = 'none';
  document.querySelector('.footer').style.display = 'none';
}

function buildColorPickers() {
  for (const [containerId, onClick] of [['color-picker', (c) => selectedColor = c], ['edit-color-picker', (c) => editSelectedColor = c]]) {
    const container = $(containerId);
    container.innerHTML = PALETTE.map((c, i) =>
      `<button class="color-btn${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`
    ).join('');
    container.onclick = (e) => {
      const btn = e.target.closest('.color-btn');
      if (!btn) return;
      container.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onClick(btn.dataset.color);
    };
  }
}

// ==================== 数据加载与渲染 ====================

async function loadProfiles() {
  $('loading').style.display = 'flex';
  $('profiles-section').style.display = 'none';
  $('empty-state').style.display = 'none';

  try {
    const [profilesRes, recentRes, activeRes] = await Promise.all([
      send({ action: 'getProfiles', domain: currentDomain }),
      send({ action: 'getRecentUsage' }),
      send({ action: 'getActiveProfile', domain: currentDomain })
    ]);

    if (profilesRes.success) {
      profiles = profilesRes.profiles || [];
      mainDomain = profilesRes.mainDomain || currentDomain;
      $('current-domain').textContent = mainDomain;
    }
    recentUsage = (recentRes.recentUsage || []).filter(r => r.domain === mainDomain);
    activeProfile = activeRes.activeProfile || null;
    updateActiveBadge();
    loadRotateStatus();

    renderRecent();
    renderProfiles();
  } catch (e) {
    showToast('加载失败', 'error');
  }

  $('loading').style.display = 'none';
}

function updateActiveBadge() {
  const badge = $('active-profile-badge');
  if (activeProfile) {
    $('active-profile-name').textContent = activeProfile;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderRecent() {
  const section = $('recent-section');
  if (recentUsage.length === 0 || searchQuery) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  $('recent-list').innerHTML = recentUsage.slice(0, 3).map(item => {
    const profile = profiles.find(p => p.name === item.profileName);
    const color = profile?.color || PALETTE[0];
    return `
      <div class="recent-item" data-name="${escapeHtml(item.profileName)}">
        <div class="recent-avatar" style="background:${color}">${escapeHtml(item.profileName.charAt(0).toUpperCase())}</div>
        <span class="recent-name">${escapeHtml(item.profileName)}</span>
      </div>`;
  }).join('');
  $('recent-list').querySelectorAll('.recent-item').forEach(el => {
    el.onclick = () => switchProfile(el.dataset.name);
  });
}

function filterAndSort() {
  let list = [...profiles];
  const query = searchQuery.toLowerCase().trim();
  if (query) {
    list = list.filter(p =>
      p.name.toLowerCase().includes(query) ||
      (p.note && p.note.toLowerCase().includes(query)) ||
      (p.tags || []).some(t => t.toLowerCase().includes(query))
    );
  }
  switch (sortBy) {
    case 'name': list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); break;
    case 'created': list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)); break;
    case 'useCount': list.sort((a, b) => (b.useCount || 0) - (a.useCount || 0)); break;
    default: list.sort((a, b) => (b.lastUsedAt || b.savedAt || 0) - (a.lastUsedAt || a.savedAt || 0));
  }
  return list;
}

function renderProfiles() {
  const list = $('profile-list');
  $('profile-count').textContent = `${profiles.length} 个`;

  if (profiles.length === 0) {
    $('profiles-section').style.display = 'none';
    $('empty-state').style.display = 'flex';
    return;
  }
  $('empty-state').style.display = 'none';
  $('profiles-section').style.display = 'block';
  $('search-box').style.display = profiles.length > 3 ? 'block' : 'none';

  const visible = filterAndSort();
  if (visible.length === 0) {
    list.innerHTML = '<div class="no-results">🔍 没有找到匹配的账号</div>';
    return;
  }

  list.innerHTML = visible.map((p, idx) => {
    const color = p.color || PALETTE[0];
    const isActive = activeProfile === p.name;
    const health = p.healthStatus || { status: 'ok' };
    const healthIcon = health.status === 'error' ? '🔴' : health.status === 'warning' ? '🟡' : '';
    const badges = [p.customUA ? '🎭' : '', p.fingerprint ? '🔐' : ''].filter(Boolean).join('');
    const info = p.userInfo?.displayName || '';
    return `
      <div class="profile-item ${isActive ? 'profile-active' : ''} ${health.status !== 'ok' ? 'health-' + health.status : ''}"
           data-name="${escapeHtml(p.name)}" style="animation-delay:${idx * 0.04}s">
        ${isActive ? '<span class="active-badge-corner">当前</span>' : ''}
        <div class="profile-avatar" style="background:${color}">${escapeHtml(p.name.charAt(0).toUpperCase())}</div>
        <div class="profile-info">
          <div class="profile-name">
            ${escapeHtml(p.name)}
            ${healthIcon ? `<span title="${escapeHtml(health.message)}">${healthIcon}</span>` : ''}
            ${badges ? `<span class="config-badges" title="已配置独立环境">${badges}</span>` : ''}
          </div>
          ${info ? `<div class="profile-user-info" title="${escapeHtml(info)}">👤 ${escapeHtml(info)}</div>` : ''}
          ${p.note ? `<div class="profile-note">📝 ${escapeHtml(p.note)}</div>` : ''}
          <div class="profile-meta">
            <span>${formatTime(p.lastUsedAt || p.savedAt)}</span>
            ${p.useCount > 0 ? `<span>使用 ${p.useCount} 次</span>` : ''}
          </div>
        </div>
        <div class="profile-actions">
          <button class="btn-switch" data-name="${escapeHtml(p.name)}">切换</button>
          <button class="btn-icon-sm" data-more="${escapeHtml(p.name)}" title="更多">⋯</button>
          <button class="btn-icon-sm" data-edit="${escapeHtml(p.name)}" title="编辑">✏️</button>
          <button class="btn-icon-sm danger" data-delete="${escapeHtml(p.name)}" title="删除">🗑</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.profile-item').forEach(item => {
    item.onclick = (e) => {
      if (e.target.closest('button')) return;
      switchProfile(item.dataset.name);
    };
  });
  list.querySelectorAll('.btn-switch').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); switchProfile(btn.dataset.name, btn); };
  });
  list.querySelectorAll('[data-more]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); showMoreActions(profiles.find(p => p.name === btn.dataset.more), btn); };
  });
  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); showEditModal(profiles.find(p => p.name === btn.dataset.edit)); };
  });
  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); confirmDelete(btn.dataset.delete); };
  });
}

function formatTime(timestamp) {
  if (!timestamp) return '未知';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

// ==================== 核心操作 ====================

async function switchProfile(name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '切换中'; }
  try {
    const res = await send({ action: 'loadProfile', domain: currentDomain, profileName: name });
    if (res.success) {
      activeProfile = name;
      updateActiveBadge();
      showToast(`已切换到「${name}」`, 'success');
      await reloadRelatedTabs(res);
      setTimeout(() => window.close(), 600);
    } else {
      showToast('切换失败: ' + (res.error || '未知错误'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = '切换'; }
    }
  } catch (e) {
    showToast('切换失败', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '切换'; }
  }
}

async function reloadRelatedTabs(res) {
  if (res.relatedTabIds?.length > 0) {
    for (const tabId of res.relatedTabIds) {
      try { await chrome.tabs.reload(tabId); } catch (e) { /* 标签页已关闭 */ }
    }
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.reload(tab.id);
  }
}

async function saveProfile() {
  const nameInput = $('profile-name-input');
  const name = nameInput.value.trim();
  if (!name) { showToast('请输入账号名称', 'error'); nameInput.focus(); return; }

  if (profiles.find(p => p.name === name)) {
    showConfirm('覆盖确认', `「${name}」已存在,是否覆盖保存?`, '⚠️', () => doSave(name));
    return;
  }
  await doSave(name);
}

async function doSave(name) {
  const btn = $('btn-save-confirm');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    const res = await send({ action: 'saveProfile', domain: currentDomain, profileName: name, color: selectedColor });
    if (res.success) {
      activeProfile = name;
      updateActiveBadge();
      showToast(`「${name}」已保存 (${res.cookieCount} cookies)`, 'success');
      hideSavePanel();
      await loadProfiles();
    } else if (res.error === 'duplicate') {
      showConfirm('账号已存在',
        `当前登录的账号已保存为「${res.duplicateName}」。\n是否更新它的数据?`, '⚠️', async () => {
          const updateRes = await send({
            action: 'refreshProfile', domain: currentDomain,
            profileName: res.duplicateName, forceRefresh: true
          });
          if (updateRes.success) {
            activeProfile = res.duplicateName;
            updateActiveBadge();
            showToast(`「${res.duplicateName}」已更新`, 'success');
            hideSavePanel();
            await loadProfiles();
          } else {
            showToast('更新失败: ' + updateRes.error, 'error');
          }
        });
    } else {
      showToast('保存失败: ' + (res.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('保存失败', 'error');
  }
  btn.disabled = false;
  btn.textContent = '✓ 确认保存';
}

async function clearCookies() {
  showConfirm('退出登录', '确定要清除当前网站的登录状态吗?', '🚪', async () => {
    try {
      const res = await send({ action: 'clearCookies', domain: currentDomain });
      if (res.success) {
        showToast(`已清除 ${res.count} 个 Cookie`, 'success');
        activeProfile = null;
        updateActiveBadge();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) chrome.tabs.reload(tab.id);
      } else {
        showToast('清除失败', 'error');
      }
    } catch (e) {
      showToast('清除失败', 'error');
    }
  });
}

function confirmDelete(name) {
  showConfirm('删除确认', `确定要删除「${name}」吗?\n此操作无法撤销。`, '🗑️', async () => {
    const res = await send({ action: 'deleteProfile', domain: currentDomain, profileName: name });
    if (res.success) {
      if (activeProfile === name) { activeProfile = null; updateActiveBadge(); }
      showToast('已删除', 'success');
      await loadProfiles();
    } else {
      showToast('删除失败', 'error');
    }
  });
}

async function refreshProfile(name) {
  showConfirm('刷新账号',
    `确定要刷新「${name}」吗?\n\n⚠️ 这会用当前浏览器的登录状态覆盖保存的数据。\n请确保你现在登录的就是这个账号!`, '🔄', async () => {
      const res = await send({ action: 'refreshProfile', domain: currentDomain, profileName: name });
      if (res.success) {
        showToast(`已刷新「${name}」(${res.cookieCount} cookies)`, 'success');
        await loadProfiles();
      } else {
        showToast(res.error, 'error');
      }
    });
}

async function duplicateProfile(name) {
  const res = await send({ action: 'duplicateProfile', domain: currentDomain, profileName: name });
  if (res.success) {
    showToast(`已复制为「${res.newName}」`, 'success');
    await loadProfiles();
  } else {
    showToast('复制失败: ' + res.error, 'error');
  }
}

async function clearAndSwitch(name) {
  await send({ action: 'clearCookies', domain: currentDomain });
  const res = await send({ action: 'loadProfile', domain: currentDomain, profileName: name });
  if (res.success) {
    showToast(`已清除并切换到「${name}」`, 'success');
    await reloadRelatedTabs(res);
    setTimeout(() => window.close(), 600);
  } else {
    showToast('切换失败: ' + res.error, 'error');
  }
}

// ==================== 保存面板 ====================

async function showSavePanel() {
  $('save-panel').style.display = 'block';
  const nameInput = $('profile-name-input');

  // 尝试从页面自动识别用户名作为默认名称
  try {
    const res = await send({ action: 'detectUser' });
    if (res?.success && res.userInfo) {
      const d = res.userInfo;
      let suggested = d.email?.split('@')[0] || d.displayName || d.username || '';
      if (suggested) {
        suggested = suggested.substring(0, 20);
        nameInput.value = suggested;
        nameInput.select();
        $('save-hint').innerHTML = `✨ 已自动识别: <strong>${escapeHtml(suggested)}</strong>`;
        $('save-hint').style.color = 'var(--success)';
      }
    }
  } catch (e) { /* 检测失败静默 */ }

  nameInput.focus();
}

function hideSavePanel() {
  $('save-panel').style.display = 'none';
  $('profile-name-input').value = '';
  $('save-hint').innerHTML = '💡 请确保已登录后再保存';
  $('save-hint').style.color = '';
}

// ==================== 编辑弹窗 ====================

function showEditModal(profile) {
  if (!profile) return;
  editingProfile = profile;
  editSelectedColor = profile.color || PALETTE[0];
  editTags = [...(profile.tags || [])];
  editFingerprint = profile.fingerprint || null;

  $('edit-name-input').value = profile.name;
  $('edit-note-input').value = profile.note || '';
  $('edit-login-hint').value = decodeHint(profile.loginHint);
  $('edit-password-hint').value = decodeHint(profile.passwordHint);

  $('edit-color-picker').querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === editSelectedColor);
  });

  // UA 预设回显
  const uaSelect = $('edit-ua-preset');
  const customUaInput = $('edit-custom-ua');
  if (profile.customUA) {
    const matched = Object.entries(UA_PRESETS).find(([, ua]) => ua === profile.customUA);
    if (matched) {
      uaSelect.value = matched[0];
      customUaInput.style.display = 'none';
    } else {
      uaSelect.value = 'custom';
      customUaInput.value = profile.customUA;
      customUaInput.style.display = 'block';
    }
  } else {
    uaSelect.value = '';
    customUaInput.value = '';
    customUaInput.style.display = 'none';
  }

  updateFingerprintStatus();
  renderEditTags();
  $('edit-modal').style.display = 'flex';
  $('edit-name-input').focus();
}

function decodeHint(encoded) {
  if (!encoded) return '';
  try { return decodeURIComponent(atob(encoded)); } catch (e) { return ''; }
}

function updateFingerprintStatus() {
  const el = $('fingerprint-status');
  if (editFingerprint) {
    const fp = editFingerprint;
    const platform = fp.navigator?.platform === 'Win32' ? 'Win' : fp.navigator?.platform === 'MacIntel' ? 'Mac' : 'Linux';
    el.textContent = `✓ ${platform} / ${fp.screen?.width}x${fp.screen?.height} / ${fp.timezone?.zone || '默认时区'}`;
    el.classList.add('configured');
  } else {
    el.textContent = '未配置(切换时使用默认随机指纹)';
    el.classList.remove('configured');
  }
}

function renderEditTags() {
  $('edit-tags-list').innerHTML = editTags.map(tag => `
    <span class="tag-item">${escapeHtml(tag)}<span class="tag-remove" data-tag="${escapeHtml(tag)}">×</span></span>
  `).join('');
  $('edit-tags-list').querySelectorAll('.tag-remove').forEach(el => {
    el.onclick = () => {
      editTags = editTags.filter(t => t !== el.dataset.tag);
      renderEditTags();
    };
  });
}

function addTag(tag) {
  if (!tag || tag.length > 10 || editTags.includes(tag)) return;
  if (editTags.length >= 5) { showToast('最多添加 5 个标签', 'warning'); return; }
  editTags.push(tag);
  renderEditTags();
}

async function saveEdit() {
  if (!editingProfile) return;
  const newName = $('edit-name-input').value.trim();
  const newNote = $('edit-note-input').value.trim();
  const loginHint = $('edit-login-hint').value.trim();
  const passwordHint = $('edit-password-hint').value.trim();

  if (!newName) { showToast('请输入账号名称', 'error'); return; }
  if (newName !== editingProfile.name && profiles.find(p => p.name === newName)) {
    showToast('该名称已存在', 'error');
    return;
  }

  // 解析 UA
  const uaSelect = $('edit-ua-preset');
  let customUA = null;
  if (uaSelect.value === 'custom') customUA = $('edit-custom-ua').value.trim() || null;
  else if (uaSelect.value) customUA = UA_PRESETS[uaSelect.value] || null;

  try {
    if (newName !== editingProfile.name) {
      const res = await send({ action: 'renameProfile', domain: currentDomain, oldName: editingProfile.name, newName });
      if (!res.success) { showToast('重命名失败: ' + res.error, 'error'); return; }
    }

    const patch = {
      color: editSelectedColor,
      note: newNote,
      tags: editTags,
      customUA,
      fingerprint: editFingerprint,
      loginHint,
      passwordHint
    };
    const res = await send({ action: 'updateProfileFields', domain: currentDomain, profileName: newName, patch });
    if (!res.success) { showToast('保存失败: ' + res.error, 'error'); return; }

    showToast('修改已保存', 'success');
    hideEditModal();
    await loadProfiles();
  } catch (e) {
    showToast('保存失败', 'error');
  }
}

function hideEditModal() {
  $('edit-modal').style.display = 'none';
  editingProfile = null;
}

// ==================== 更多操作菜单 ====================

function showMoreActions(profile, anchor) {
  document.querySelector('.more-actions-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'more-actions-menu';
  menu.innerHTML = `
    <button class="menu-item" data-action="refresh">🔄 刷新账号(重存 Cookie)</button>
    <button class="menu-item" data-action="duplicate">📋 复制账号</button>
    <button class="menu-item" data-action="clearSwitch">🧹 彻底清除并切换</button>
  `;
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = '14px';
  document.body.appendChild(menu);

  menu.querySelectorAll('.menu-item').forEach(item => {
    item.onclick = async (e) => {
      e.stopPropagation();
      menu.remove();
      switch (item.dataset.action) {
        case 'refresh': await refreshProfile(profile.name); break;
        case 'duplicate': await duplicateProfile(profile.name); break;
        case 'clearSwitch': await clearAndSwitch(profile.name); break;
      }
    };
  });
  setTimeout(() => {
    document.addEventListener('click', function close() {
      menu.remove();
      document.removeEventListener('click', close);
    }, { once: true });
  }, 0);
}

// ==================== 自动轮换 ====================

async function loadRotateStatus() {
  try {
    const res = await send({ action: 'getAutoRotateConfig', domain: currentDomain });
    if (res.success && res.config?.enabled) {
      rotateConfig = res.config;
      const m = rotateConfig.intervalMinutes;
      const text = m < 60 ? `每 ${m} 分钟` : m < 1440 ? `每 ${m / 60} 小时` : `每 ${m / 1440} 天`;
      $('rotate-info').textContent = `${text} · ${rotateConfig.profiles.length} 个账号`;
      $('auto-rotate-bar').style.display = 'flex';
      return;
    }
  } catch (e) { /* 忽略 */ }
  rotateConfig = null;
  $('auto-rotate-bar').style.display = 'none';
}

function showRotateModal() {
  if (profiles.length < 2) { showToast('至少需要 2 个账号才能轮换', 'warning'); return; }
  $('rotate-profiles-list').innerHTML = profiles.map(p => `
    <label class="rotate-profile-item">
      <input type="checkbox" value="${escapeHtml(p.name)}" ${rotateConfig?.profiles?.includes(p.name) ? 'checked' : ''}>
      <span class="profile-color" style="background:${p.color || PALETTE[0]}"></span>
      <span>${escapeHtml(p.name)}</span>
    </label>
  `).join('');
  if (rotateConfig?.intervalMinutes) $('rotate-interval').value = String(rotateConfig.intervalMinutes);
  $('rotate-modal').style.display = 'flex';
}

async function startAutoRotate() {
  const interval = parseInt($('rotate-interval').value);
  const selected = Array.from(document.querySelectorAll('#rotate-profiles-list input:checked')).map(cb => cb.value);
  if (selected.length < 2) { showToast('请至少选择 2 个账号', 'error'); return; }

  const res = await send({
    action: 'setAutoRotate', domain: currentDomain,
    config: { enabled: true, intervalMinutes: interval, profiles: selected }
  });
  if (res.success) {
    hideRotateModal();
    await loadRotateStatus();
    showToast('自动轮换已启动', 'success');
  } else {
    showToast('启动失败: ' + res.error, 'error');
  }
}

async function stopAutoRotate() {
  await send({ action: 'setAutoRotate', domain: currentDomain, config: { enabled: false } });
  await loadRotateStatus();
  showToast('自动轮换已停止', 'success');
}

function hideRotateModal() {
  $('rotate-modal').style.display = 'none';
}

// ==================== 全局菜单 / 导入导出 ====================

function toggleGlobalMenu() {
  const menu = $('global-menu');
  if (menu.style.display === 'none') {
    menu.style.display = 'block';
    menu.querySelectorAll('.menu-item').forEach(item => {
      item.onclick = async () => {
        menu.style.display = 'none';
        await handleGlobalAction(item.dataset.action);
      };
    });
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!menu.contains(e.target) && e.target.id !== 'btn-more-menu') {
          menu.style.display = 'none';
          document.removeEventListener('click', close);
        }
      });
    }, 0);
  } else {
    menu.style.display = 'none';
  }
}

async function handleGlobalAction(action) {
  switch (action) {
    case 'refresh-current':
      if (!activeProfile) { showToast('当前没有激活的账号', 'warning'); return; }
      await refreshProfile(activeProfile);
      break;
    case 'check-health': {
      showToast('正在检查账号状态...', 'info');
      await send({ action: 'checkHealthNow' });
      await loadProfiles();
      showToast('检查完成,如有异常会在列表中标注', 'success');
      break;
    }
    case 'export-domain': await exportDomain(); break;
    case 'export-all': await exportAll(); break;
  }
}

async function exportDomain() {
  if (profiles.length === 0) { showToast('当前网站没有保存的账号', 'warning'); return; }
  const res = await send({ action: 'exportDomainProfiles', domain: currentDomain });
  if (res.success) {
    downloadJSON(res.data, `switchid-${mainDomain}-${dateStr()}.json`);
    showToast('导出成功', 'success');
  }
}

async function exportAll() {
  const res = await send({ action: 'exportProfiles' });
  if (res.success) {
    downloadJSON(res.data, `switchid-backup-${dateStr()}.json`);
    showToast('导出成功', 'success');
  }
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.profiles) { showToast('无效的备份文件', 'error'); return; }
    const res = await send({ action: 'importProfiles', data });
    if (res.success) {
      showToast(`导入成功(${res.importedCount} 个账号)`, 'success');
      await loadProfiles();
    } else {
      showToast('导入失败: ' + res.error, 'error');
    }
  } catch (err) {
    showToast('导入失败: 文件格式错误', 'error');
  }
  e.target.value = '';
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function dateStr() {
  return new Date().toISOString().split('T')[0];
}

// ==================== UI 辅助 ====================

function showToast(message, type = 'info') {
  const toast = $('toast');
  $('toast-message').textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), type === 'warning' ? 4000 : 2500);
}

function showConfirm(title, message, icon, callback) {
  $('modal-title').textContent = title;
  $('modal-message').textContent = message;
  $('modal-icon').textContent = icon;
  pendingAction = callback;
  $('confirm-modal').style.display = 'flex';
}

function hideConfirm() {
  $('confirm-modal').style.display = 'none';
  pendingAction = null;
}

// ==================== 事件绑定 ====================

function setupEventListeners() {
  $('btn-save-quick').onclick = showSavePanel;
  $('btn-clear-quick').onclick = clearCookies;
  $('btn-settings').onclick = () => chrome.runtime.openOptionsPage();
  $('btn-close-save').onclick = hideSavePanel;
  $('btn-save-confirm').onclick = saveProfile;
  $('btn-more-menu').onclick = toggleGlobalMenu;

  $('profile-name-input').onkeydown = (e) => {
    if (e.key === 'Enter') saveProfile();
    else if (e.key === 'Escape') hideSavePanel();
  };

  $('search-input').oninput = (e) => {
    searchQuery = e.target.value;
    renderRecent();
    renderProfiles();
  };
  $('sort-select').onchange = (e) => { sortBy = e.target.value; renderProfiles(); };

  // 确认框
  $('modal-cancel').onclick = hideConfirm;
  document.querySelector('#confirm-modal .modal-backdrop').onclick = hideConfirm;
  $('modal-confirm').onclick = () => {
    hideConfirm();
    pendingAction?.();
    pendingAction = null;
  };

  // 编辑框
  $('edit-cancel').onclick = hideEditModal;
  document.querySelector('#edit-modal .modal-backdrop').onclick = hideEditModal;
  $('edit-save').onclick = saveEdit;
  $('edit-name-input').onkeydown = (e) => {
    if (e.key === 'Enter') saveEdit();
    else if (e.key === 'Escape') hideEditModal();
  };
  $('edit-ua-preset').onchange = (e) => {
    const customInput = $('edit-custom-ua');
    if (e.target.value === 'custom') { customInput.style.display = 'block'; customInput.focus(); }
    else { customInput.style.display = 'none'; customInput.value = ''; }
  };
  $('btn-random-fingerprint').onclick = async () => {
    const res = await send({ action: 'generateFingerprint' });
    if (res.success) {
      editFingerprint = res.fingerprint;
      updateFingerprintStatus();
      showToast('已生成随机指纹', 'success');
    }
  };
  $('btn-clear-fingerprint').onclick = () => {
    editFingerprint = null;
    updateFingerprintStatus();
    showToast('指纹配置已清除', 'success');
  };
  $('edit-tags-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(e.target.value.trim());
      e.target.value = '';
    }
  };
  document.querySelectorAll('.preset-tag').forEach(tag => {
    tag.onclick = () => addTag(tag.dataset.tag);
  });

  // 轮换
  $('btn-auto-rotate').onclick = showRotateModal;
  $('btn-stop-rotate').onclick = stopAutoRotate;
  $('rotate-cancel').onclick = hideRotateModal;
  document.querySelector('#rotate-modal .modal-backdrop').onclick = hideRotateModal;
  $('rotate-start').onclick = startAutoRotate;

  // 导入导出
  $('btn-export-quick').onclick = exportDomain;
  $('btn-import-quick').onclick = () => $('import-file-input').click();
  $('import-file-input').onchange = handleImportFile;

  // 数字键 1-9 快速切换
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if ($('confirm-modal').style.display === 'flex' || $('edit-modal').style.display === 'flex' ||
        $('rotate-modal').style.display === 'flex' || $('save-panel').style.display === 'block') return;
    const num = parseInt(e.key);
    if (num >= 1 && num <= 9) {
      const sorted = filterAndSort();
      if (num <= sorted.length) switchProfile(sorted[num - 1].name);
    }
  });
}
