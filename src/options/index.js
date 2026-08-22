// options/index.js - SwitchID Local 设置页逻辑

'use strict';

const UA_PRESETS = {
  'chrome-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'chrome-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'firefox-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'safari-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'mobile-android': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'mobile-ios': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let settings = {};
let whitelist = [];
let batchMode = false;
let selected = new Set();

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', async () => {
  setupNav();
  setupEventListeners();
  await loadSettings();
  await loadAllProfiles();
});

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      $(`section-${btn.dataset.section}`).classList.add('active');
    };
  });
}

// ==================== 设置加载与保存 ====================

async function loadSettings() {
  const res = await send({ action: 'getSettings' });
  settings = res.settings || {};
  whitelist = res.fingerprintWhitelist || [];

  // 主题
  if (settings.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('theme-dark').checked = true;
  }

  // 行为开关
  $('auto-refresh').checked = settings.autoRefresh !== false;
  $('close-related-tabs').checked = settings.closeRelatedTabs === true;
  $('health-check').checked = settings.healthCheckEnabled !== false;
  $('auto-refresh-expiring').checked = settings.autoRefreshExpiring === true;

  // UA
  $('ua-enabled').checked = settings.uaEnabled === true;
  toggleDisplay('ua-settings', settings.uaEnabled === true);
  await showCurrentUA();

  // 指纹
  $('fingerprint-enabled').checked = settings.fingerprintEnabled !== false;
  $('fp-canvas').checked = settings.fp_canvas !== false;
  $('fp-webgl').checked = settings.fp_webgl !== false;
  $('fp-audio').checked = settings.fp_audio !== false;
  $('fp-timezone').checked = settings.fp_timezone === true;
  $('fp-domrect').checked = settings.fp_domrect === true;
  $('fp-webrtc').checked = settings.fp_webrtc === true;
  toggleDisplay('fingerprint-options', settings.fingerprintEnabled !== false);

  renderWhitelist();
}

function toggleDisplay(id, show) {
  $(id).style.display = show ? 'block' : 'none';
}

async function updateSettings(patch) {
  const res = await send({ action: 'updateSettings', settings: patch });
  if (res.success) settings = res.settings || settings;
}

async function showCurrentUA() {
  const res = await send({ action: 'getCurrentUA' });
  const el = $('current-ua-display');
  if (res.enabled && res.userAgent) {
    el.textContent = `当前生效 UA:${res.userAgent}`;
  } else {
    el.textContent = '当前未启用 UA 伪装';
  }
}

// ==================== 账号管理 ====================

async function loadAllProfiles() {
  const res = await send({ action: 'getAllProfileStats' });
  const container = $('all-profiles');
  const emptyEl = $('empty-profiles');
  const stats = res.stats || [];

  // 统计卡片
  const data = await chrome.storage.local.get(null);
  const sizeKB = Math.round(JSON.stringify(data).length / 1024);
  $('stat-domains').textContent = stats.length;
  $('stat-profiles').textContent = stats.reduce((sum, s) => sum + s.profileCount, 0);
  $('stat-size').textContent = `${sizeKB} KB`;

  if (stats.length === 0) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  container.innerHTML = stats.map(stat => `
    <div class="domain-group">
      <div class="domain-header">
        🌐 ${escapeHtml(stat.domain)}
        <span style="font-weight:400;color:var(--text-tertiary);font-size:12px;">${stat.profileCount} 个账号</span>
      </div>
      ${stat.profiles.map(name => `
        <div class="domain-profile-item" data-domain="${escapeHtml(stat.domain)}" data-name="${escapeHtml(name)}">
          ${batchMode ? `<input type="checkbox" data-domain="${escapeHtml(stat.domain)}" data-name="${escapeHtml(name)}" ${selected.has(`${stat.domain}|${name}`) ? 'checked' : ''}>` : ''}
          <span>👤 ${escapeHtml(name)}</span>
          <span class="meta">
            <button class="btn btn-secondary btn-sm" data-delete-domain="${escapeHtml(stat.domain)}" data-delete-name="${escapeHtml(name)}">删除</button>
          </span>
        </div>
      `).join('')}
    </div>
  `).join('');

  container.querySelectorAll('[data-delete-domain]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm(`确定删除 ${btn.dataset.deleteDomain} 下的「${btn.dataset.deleteName}」吗?`)) return;
      await send({
        action: 'deleteProfile',
        domain: btn.dataset.deleteDomain,
        profileName: btn.dataset.deleteName
      });
      await loadAllProfiles();
    };
  });

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      const key = `${cb.dataset.domain}|${cb.dataset.name}`;
      if (cb.checked) selected.add(key); else selected.delete(key);
      $('selected-count').textContent = `已选 ${selected.size} 项`;
    };
  });
}

function enterBatchMode() {
  batchMode = true;
  selected.clear();
  $('btn-batch-mode').style.display = 'none';
  $('batch-actions').style.display = 'inline';
  $('selected-count').textContent = '已选 0 项';
  loadAllProfiles();
}

function exitBatchMode() {
  batchMode = false;
  selected.clear();
  $('btn-batch-mode').style.display = 'inline';
  $('batch-actions').style.display = 'none';
  loadAllProfiles();
}

async function batchDelete() {
  if (selected.size === 0) return;
  if (!confirm(`确定删除所选的 ${selected.size} 个账号吗?此操作无法撤销。`)) return;

  const byDomain = {};
  for (const key of selected) {
    const [domain, name] = key.split('|');
    (byDomain[domain] = byDomain[domain] || []).push(name);
  }
  for (const [domain, names] of Object.entries(byDomain)) {
    await send({ action: 'deleteMultipleProfiles', domain, profileNames: names });
  }
  exitBatchMode();
}

// ==================== 事件绑定 ====================

function setupEventListeners() {
  // 主题
  $('theme-dark').onchange = async (e) => {
    const theme = e.target.checked ? 'dark' : 'light';
    await updateSettings({ theme });
    document.documentElement.setAttribute('data-theme', theme);
  };

  // 行为开关
  $('auto-refresh').onchange = (e) => updateSettings({ autoRefresh: e.target.checked });
  $('close-related-tabs').onchange = (e) => updateSettings({ closeRelatedTabs: e.target.checked });
  $('health-check').onchange = (e) => updateSettings({ healthCheckEnabled: e.target.checked });
  $('auto-refresh-expiring').onchange = (e) => updateSettings({ autoRefreshExpiring: e.target.checked });

  // UA
  $('ua-enabled').onchange = async (e) => {
    toggleDisplay('ua-settings', e.target.checked);
    if (!e.target.checked) {
      await updateSettings({ uaEnabled: false });
      await showCurrentUA();
    } else {
      await updateSettings({ uaEnabled: true, customUA: settings.customUA || UA_PRESETS['chrome-win'] });
      if (settings.customUA) await send({ action: 'updateSettings', settings: { customUA: settings.customUA } });
      await showCurrentUA();
    }
  };
  $('ua-preset').onchange = (e) => {
    toggleDisplay('custom-ua', e.target.value === 'custom');
    if (e.target.value === 'custom') $('custom-ua').focus();
  };
  $('btn-apply-ua').onclick = async () => {
    let ua;
    if ($('ua-preset').value === 'custom') {
      ua = $('custom-ua').value.trim();
      if (!ua) { alert('请输入自定义 UA 字符串'); return; }
    } else {
      ua = UA_PRESETS[$('ua-preset').value];
    }
    await updateSettings({ uaEnabled: true, customUA: ua });
    await showCurrentUA();
    alert('UA 已应用');
  };

  // 指纹
  $('fingerprint-enabled').onchange = async (e) => {
    toggleDisplay('fingerprint-options', e.target.checked);
    await updateSettings({ fingerprintEnabled: e.target.checked });
  };
  for (const [id, key] of [
    ['fp-canvas', 'fp_canvas'], ['fp-webgl', 'fp_webgl'], ['fp-audio', 'fp_audio'],
    ['fp-timezone', 'fp_timezone'], ['fp-domrect', 'fp_domrect'], ['fp-webrtc', 'fp_webrtc']
  ]) {
    $(id).onchange = (e) => updateSettings({ [key]: e.target.checked });
  }

  // 白名单
  $('btn-add-whitelist').onclick = async () => {
    const input = $('whitelist-input');
    const domain = input.value.trim().toLowerCase();
    if (!domain || !/^[a-z0-9.*-]+(\.[a-z0-9*_-]+)+$/.test(domain)) {
      alert('请输入有效的域名,如 example.com');
      return;
    }
    if (!whitelist.includes(domain)) {
      whitelist.push(domain);
      await chrome.storage.local.set({ fingerprintWhitelist: whitelist });
      renderWhitelist();
    }
    input.value = '';
  };
  $('whitelist-input').onkeydown = (e) => {
    if (e.key === 'Enter') $('btn-add-whitelist').click();
  };

  // 批量操作
  $('btn-batch-mode').onclick = enterBatchMode;
  $('btn-cancel-select').onclick = exitBatchMode;
  $('btn-batch-delete').onclick = batchDelete;

  // 数据管理
  $('btn-export').onclick = async () => {
    const res = await send({ action: 'exportProfiles' });
    if (!res.success) return;
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `switchid-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  $('btn-import').onclick = () => $('file-input').click();
  $('file-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.profiles) { alert('无效的备份文件'); return; }
      const res = await send({ action: 'importProfiles', data });
      if (res.success) {
        alert(`导入成功(${res.importedCount} 个账号)`);
        await loadAllProfiles();
      } else {
        alert('导入失败: ' + res.error);
      }
    } catch (err) {
      alert('导入失败: 文件格式错误');
    }
    e.target.value = '';
  };
  $('btn-clear-all').onclick = async () => {
    if (!confirm('确定清空全部数据吗?所有已保存的账号都会被删除,此操作无法恢复!')) return;
    if (!confirm('再次确认:真的要清空全部数据吗?')) return;
    await send({ action: 'clearAllData' });
    alert('已清空全部数据');
    await loadSettings();
    await loadAllProfiles();
  };
}

function renderWhitelist() {
  const list = $('whitelist-list');
  $('empty-whitelist').style.display = whitelist.length === 0 ? 'block' : 'none';
  list.innerHTML = whitelist.map(domain => `
    <span class="whitelist-item">${escapeHtml(domain)}<button data-domain="${escapeHtml(domain)}" title="移除">×</button></span>
  `).join('');
  list.querySelectorAll('button').forEach(btn => {
    btn.onclick = async () => {
      whitelist = whitelist.filter(d => d !== btn.dataset.domain);
      await chrome.storage.local.set({ fingerprintWhitelist: whitelist });
      renderWhitelist();
    };
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
