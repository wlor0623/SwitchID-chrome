// background.js - SwitchID Local 多账号管理助手 (Manifest V3)
//
// 【本地化承诺】本文件不包含任何网络请求代码(fetch / XMLHttpRequest /
// WebSocket / sendBeacon 一律不存在)。所有账号数据仅写入
// chrome.storage.local,不会离开你的浏览器。
//
// 核心思路:以"主域名"为单位,把当前浏览器的登录 Cookie 快照存为
// 命名的账号档案(Profile);切换账号 = 清空该域名 Cookie + 写入目标档案
// 的 Cookie + 刷新相关标签页。

'use strict';

// ==================== 运行时状态 ====================

let activeSettings = {
  autoRefresh: true,          // 切换后自动刷新相关标签页
  closeRelatedTabs: false,    // 切换后关闭其他相关标签页
  showNotification: true,
  healthCheckEnabled: true,
  autoRefreshExpiring: false, // 自动刷新快过期的当前账号
  uaEnabled: false,
  customUA: null,
  fingerprintEnabled: true,
  fingerprintWhitelist: []
};

let activeProfiles = {}; // { 'bing.com': '账号名', ... }

// ==================== 初始化 ====================

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      profiles: {},
      activeProfiles: {},
      settings: { ...activeSettings },
      autoRotateConfig: {}
    });
  }
  await clearAllDNRRules();
  await loadState();
  await rebuildContextMenu();
  chrome.alarms.create('healthCheck', { periodInMinutes: 60 * 24 });
  setTimeout(() => checkAllProfilesHealth(), 5000);
});

chrome.runtime.onStartup.addListener(async () => {
  await clearAllDNRRules();
  await loadState();
  await rebuildContextMenu();
  await restoreAutoRotateAlarms();
  setTimeout(() => checkAllProfilesHealth(), 5000);
});

async function loadState() {
  try {
    const data = await chrome.storage.local.get(['settings', 'activeProfiles']);
    if (data.settings) activeSettings = { ...activeSettings, ...data.settings };
    if (data.activeProfiles) activeProfiles = data.activeProfiles;
    if (activeSettings.uaEnabled && activeSettings.customUA) {
      await applyUserAgent(activeSettings.customUA);
    }
  } catch (e) {
    console.error('[SwitchID] 加载设置失败:', e);
  }
}

// ==================== 域名工具 ====================

const SPECIAL_TLDS = ['co.uk', 'com.cn', 'com.hk', 'co.jp', 'com.tw', 'co.kr', 'com.au', 'gov.cn', 'edu.cn'];

// www.rewards.bing.com -> bing.com
function getMainDomain(hostname) {
  if (!hostname) return '';
  hostname = hostname.toLowerCase();
  for (const tld of SPECIAL_TLDS) {
    if (hostname.endsWith('.' + tld)) {
      const parts = hostname.split('.');
      return parts.slice(-(tld.split('.').length + 1)).join('.');
    }
  }
  const parts = hostname.split('.');
  if (parts.length >= 2) return parts.slice(-2).join('.');
  return hostname;
}

function isBrowserInternalUrl(url) {
  return /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url || '');
}

// ==================== Cookie 引擎 ====================

// 取主域名(含全部子域名)下的所有 Cookie
async function getAllCookiesForMainDomain(mainDomain) {
  const result = [];
  const seen = new Set();
  try {
    const all = await chrome.cookies.getAll({});
    for (const cookie of all) {
      const bare = cookie.domain.replace(/^\./, '');
      if (getMainDomain(bare) === mainDomain) {
        const key = `${cookie.domain}|${cookie.name}|${cookie.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(cookie);
        }
      }
    }
  } catch (e) {
    console.error('[SwitchID] 获取 Cookie 失败:', e);
  }
  return result;
}

// 清空主域名(含全部子域名)的 Cookie
async function clearCookiesForDomain(domain) {
  const mainDomain = getMainDomain(domain);
  let count = 0;
  try {
    const cookies = await getAllCookiesForMainDomain(mainDomain);
    for (const cookie of cookies) {
      const bare = cookie.domain.replace(/^\./, '');
      const url = `${cookie.secure ? 'https' : 'http'}://${bare}${cookie.path || '/'}`;
      try {
        await chrome.cookies.remove({ url, name: cookie.name });
        count++;
      } catch (e) {
        try {
          await chrome.cookies.remove({ url: `https://${bare}/`, name: cookie.name });
          count++;
        } catch (e2) { /* 个别受保护 Cookie 无法删除,跳过 */ }
      }
    }
    return { success: true, count };
  } catch (error) {
    console.error('[SwitchID] 清除 Cookie 失败:', error);
    return { success: false, error: error.message };
  }
}

// 清除单个标签页的 localStorage / sessionStorage。
// 关键:必须用 world:'MAIN' 在页面主世界执行——ISOLATED world 里的 sessionStorage.clear()
// 不会被写入标签页的会话存储命名空间,页面一刷新数据就会复活。
async function clearTabStorage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* 忽略 */ }
      }
    });
    return true;
  } catch (e) {
    // 主世界注入失败的兜底:走 content script 消息通道(对 sessionStorage 可能不持久,聊胜于无)
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'clearStorage' });
      return true;
    } catch (e2) {
      return false; // 受限页面,跳过
    }
  }
}

// 一键清空本站全部数据(Cookie + Cache + 各类存储 + Service Worker)。
// 用于切换账号前彻底重置网站在本机的痕迹:
//   Cookie            -> clearCookiesForDomain(按主域名递归,含全部子域名)
//   Cache / CacheStorage / IndexedDB / localStorage /
//   ServiceWorkers / FileSystems / WebSQL -> chrome.browsingData.remove(按 origin)
async function clearAllSiteData(domain) {
  try {
    const mainDomain = getMainDomain(domain);
    const hostnames = new Set([domain, mainDomain, 'www.' + mainDomain]);

    // 把已打开的同站标签页主机名也纳入,覆盖用户实际在用的子域名
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url || isBrowserInternalUrl(tab.url)) continue;
        try {
          const url = new URL(tab.url);
          if (getMainDomain(url.hostname) === mainDomain) hostnames.add(url.hostname);
        } catch (e) { /* 无效 URL,跳过 */ }
      }
    } catch (e) { /* 忽略 */ }

    const origins = [];
    for (const h of hostnames) {
      origins.push(`https://${h}`, `http://${h}`);
    }

    // 1. Cookie(自实现按主域名清理,比 browsingData 的按 origin 更彻底)
    const cookieResult = await clearCookiesForDomain(mainDomain);

    // 2. 缓存与各类存储(browsingData 按 origin 清理)
    let storageCleared = true;
    try {
      await chrome.browsingData.remove({ origins }, {
        appcache: true,
        cache: true,
        cacheStorage: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true
      });
    } catch (e) {
      // 新版浏览器陆续移除了 appcache/fileSystems/webSQL,降级用受支持子集重试
      try {
        await chrome.browsingData.remove({ origins }, {
          cache: true,
          cacheStorage: true,
          cookies: true,
          indexedDB: true,
          localStorage: true,
          serviceWorkers: true
        });
      } catch (e2) {
        storageCleared = false;
      }
    }

    // 3. 打开中的标签页:清 sessionStorage(browsingData 不处理它,且它随标签页存活)
    const relatedTabIds = await getRelatedTabIds(mainDomain);
    for (const tabId of relatedTabIds) {
      await clearTabStorage(tabId);
    }

    return {
      success: true,
      cookieCount: cookieResult.count,
      storageCleared,
      originCount: origins.length,
      relatedTabIds
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 把档案中的 Cookie 写回浏览器。
// 过期时间统一延长到至少 1 年,避免保存的账号静静失效。
async function setCookies(cookies) {
  let successCount = 0;
  let failCount = 0;
  const now = Date.now() / 1000;
  const oneYearLater = now + 365 * 24 * 60 * 60;

  for (const cookie of cookies) {
    try {
      if (cookie.expirationDate && cookie.expirationDate < now) continue; // 已过期的跳过

      const bare = cookie.domain.replace(/^\./, '');
      const cookieData = {
        url: `https://${bare}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: Math.max(cookie.expirationDate || 0, oneYearLater)
      };
      if (cookie.domain.startsWith('.')) cookieData.domain = cookie.domain;
      if (cookie.sameSite === 'no_restriction') {
        cookieData.sameSite = 'no_restriction';
        cookieData.secure = true; // SameSite=None 必须 Secure
      } else if (cookie.sameSite === 'strict' || cookie.sameSite === 'lax') {
        cookieData.sameSite = cookie.sameSite;
      }

      await chrome.cookies.set(cookieData);
      successCount++;
    } catch (e) {
      failCount++;
    }
  }
  return { success: true, successCount, failCount };
}

// ==================== 从 Cookie 提取展示信息 ====================

function extractUserInfoFromCookies(cookies) {
  const result = { email: null, username: null, displayName: null };
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

  const decode = (s) => {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  };

  const looksLikeToken = (v) =>
    v.length > 30 || /^[0-9a-f-]{20,}$/i.test(v) || /^[A-Za-z0-9+/=]{30,}$/.test(v) || /^ey[A-Za-z0-9]/.test(v);

  // 第一轮:按 Cookie 名找线索
  for (const cookie of cookies) {
    const nameLower = cookie.name.toLowerCase();
    const value = decode(cookie.value || '');
    if (!value || value.length < 2) continue;

    if (!result.email) {
      const m = value.match(emailRegex);
      if (m && (nameLower.includes('mail') || nameLower.includes('user') || nameLower.includes('login') || nameLower.includes('account'))) {
        result.email = m[0];
        continue;
      }
    }
    if (!result.username &&
        (nameLower.includes('user') || nameLower.includes('nick') || nameLower.includes('name') || nameLower.includes('login') || nameLower.includes('pin') || nameLower.includes('account')) &&
        value.length >= 2 && value.length <= 30 && !looksLikeToken(value) && !emailRegex.test(value)) {
      result.username = value;
    }
  }

  // 第二轮:任意 Cookie 值里找邮箱(拆常见分隔符)
  if (!result.email) {
    outer:
    for (const cookie of cookies) {
      const value = decode(cookie.value || '');
      if (!value || value.length < 5 || value.length > 500) continue;
      for (const part of value.split(/[|,;:&=]/)) {
        const m = part.trim().match(emailRegex);
        if (m) { result.email = m[0]; break outer; }
      }
    }
  }

  result.displayName = result.email || result.username || null;
  return result;
}

// ==================== 重复账号检测 ====================
// 比较当前 Cookie 与已保存档案的"身份特征 Cookie",
// 匹配度 >= 70% 视为同一个账号,避免重复保存。

const IDENTITY_COOKIE_GROUPS = [
  { names: ['session-id', 'ubid-main', 'x-main', 'at-main'], weight: 10 },          // Amazon
  { names: ['SPC_U', 'SPC_EC'], weight: 10 },                                        // Shopee
  { names: ['lzd_cid', 'lzd_sid'], weight: 10 },                                     // Lazada
  { names: ['xman_us_f', 'aep_usuc_f'], weight: 10 },                                // AliExpress
  { names: ['sessionid', 'sid_tt', 'uid_tt'], weight: 10 },                          // TikTok/抖音
  { names: ['ds_user_id', 'csrftoken'], weight: 10 },                                // Instagram
  { names: ['c_user', 'xs', 'datr'], weight: 10 },                                   // Facebook
  { names: ['auth_token', 'ct0', 'twid'], weight: 10 },                              // Twitter/X
  { names: ['li_at'], weight: 10 },                                                  // LinkedIn
  { names: ['_U', 'WLID', 'ANON'], weight: 10 },                                     // 微软
  { names: ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'], weight: 10 },               // Google
  { names: ['_tb_token_', 'cookie2', 'unb'], weight: 10 },                           // 淘宝
  { names: ['pt_key', 'pt_pin'], weight: 10 },                                       // 京东
  { names: ['PDDAccessToken', 'pdd_user_id'], weight: 10 },                          // 拼多多
  { names: ['SUB', 'SUBP'], weight: 10 },                                            // 微博
  { names: ['SESSDATA', 'bili_jct', 'DedeUserID'], weight: 10 },                     // B站
  { names: ['session_id', 'session'], weight: 8 },
  { names: ['auth_token', 'access_token', 'token'], weight: 8 },
  { names: ['user_id', 'userid', 'uid'], weight: 7 },
  { names: ['login', 'logged_in'], weight: 5 }
];

function extractIdentityFromCookies(cookies) {
  const identity = {};
  for (const { names, weight } of IDENTITY_COOKIE_GROUPS) {
    for (const name of names) {
      const cookie = cookies.find(c => c.name.toLowerCase() === name);
      if (cookie && cookie.value && cookie.value.length > 5) {
        identity[name] = { value: cookie.value.substring(0, 32), weight };
      }
    }
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function isSameIdentity(a, b) {
  const common = Object.keys(a).filter(k => b[k]);
  if (common.length === 0) return false;
  let score = 0, total = 0;
  for (const k of common) {
    total += a[k].weight;
    if (a[k].value === b[k].value) score += a[k].weight;
  }
  return total > 0 && score / total >= 0.7;
}

function checkDuplicateAccount(currentCookies, domainProfiles, excludeName) {
  if (!domainProfiles) return { isDuplicate: false };
  const currentIdentity = extractIdentityFromCookies(currentCookies);
  if (!currentIdentity) return { isDuplicate: false };
  for (const [name, profile] of Object.entries(domainProfiles)) {
    if (name === excludeName || !profile.cookies?.length) continue;
    const savedIdentity = extractIdentityFromCookies(profile.cookies);
    if (savedIdentity && isSameIdentity(currentIdentity, savedIdentity)) {
      return { isDuplicate: true, existingName: name };
    }
  }
  return { isDuplicate: false };
}

// ==================== Profile 管理 ====================

async function saveProfile(domain, profileName, color = '#4285F4') {
  try {
    const mainDomain = getMainDomain(domain);
    const cookies = await getAllCookiesForMainDomain(mainDomain);
    if (cookies.length === 0) {
      return { success: false, error: '当前网站没有登录信息,请先登录后再保存' };
    }

    const data = await chrome.storage.local.get(['profiles']);
    const profiles = data.profiles || {};
    if (!profiles[mainDomain]) profiles[mainDomain] = {};

    const dup = checkDuplicateAccount(cookies, profiles[mainDomain], profileName);
    if (dup.isDuplicate) {
      return {
        success: false,
        error: 'duplicate',
        duplicateName: dup.existingName,
        message: `当前登录的账号已保存为「${dup.existingName}」,如需更新请使用刷新功能`
      };
    }

    const existing = profiles[mainDomain][profileName] || {};
    const domainStats = {};
    for (const c of cookies) domainStats[c.domain] = (domainStats[c.domain] || 0) + 1;

    profiles[mainDomain][profileName] = {
      ...existing,
      cookies,
      savedAt: Date.now(),
      cookieCount: cookies.length,
      color,
      originalDomain: domain,
      userInfo: extractUserInfoFromCookies(cookies),
      domainStats,
      note: existing.note || '',
      tags: existing.tags || [],
      customUA: existing.customUA || null,
      fingerprint: existing.fingerprint || null,
      loginHint: existing.loginHint || '',
      passwordHint: existing.passwordHint || ''
    };

    await chrome.storage.local.set({ profiles });
    await setActiveProfile(mainDomain, profileName);
    await rebuildContextMenu();
    return { success: true, cookieCount: cookies.length, domainStats };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function loadProfile(domain, profileName) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['profiles']);
    const profile = data.profiles?.[mainDomain]?.[profileName];
    if (!profile) return { success: false, error: '账号不存在' };

    // 1. 清空现有 Cookie,再写入目标档案
    await clearCookiesForDomain(mainDomain);
    await sleep(100);
    const result = await setCookies(profile.cookies);
    await sleep(100);

    // 2. 记录使用情况
    await recordRecentUsage(mainDomain, profileName);

    // 3. 应用账号独立 UA
    if (profile.customUA) {
      await applyUserAgent(profile.customUA);
    } else if (activeSettings.uaEnabled && activeSettings.customUA) {
      await applyUserAgent(activeSettings.customUA);
    } else {
      await clearAllDNRRules();
    }

    // 4. 应用账号独立指纹
    if (profile.fingerprint) {
      await saveActiveFingerprint(mainDomain, profile.fingerprint);
    } else {
      await clearActiveFingerprint(mainDomain);
    }

    // 5. 可选:关闭其他相关标签页
    if (activeSettings.closeRelatedTabs) await closeRelatedTabs(mainDomain);

    // 6. 清除相关标签页的 localStorage/sessionStorage(部分网站在本地存储缓存用户态)
    const relatedTabIds = await getRelatedTabIds(mainDomain);
    for (const tabId of relatedTabIds) {
      await clearTabStorage(tabId);
    }

    await setActiveProfile(mainDomain, profileName);
    return {
      success: true,
      ...result,
      autoRefresh: activeSettings.autoRefresh,
      relatedTabIds
    };
  } catch (error) {
    console.error('[SwitchID] 切换失败:', error);
    return { success: false, error: error.message };
  }
}

// 刷新账号:用浏览器当前的 Cookie 覆盖已保存档案。
// 安全检查:默认只允许刷新"当前激活"的档案,防止把 A 賬号的 Cookie 存到 B 档案上。
async function refreshProfile(domain, profileName, forceRefresh = false) {
  try {
    const mainDomain = getMainDomain(domain);
    if (!forceRefresh && activeProfiles[mainDomain] !== profileName) {
      return {
        success: false,
        error: `当前激活的是「${activeProfiles[mainDomain] || '无'}」,不是「${profileName}」。请先切换到该账号再刷新。`
      };
    }

    const data = await chrome.storage.local.get(['profiles']);
    const profile = data.profiles?.[mainDomain]?.[profileName];
    if (!profile) return { success: false, error: '账号不存在' };

    const currentCookies = await getAllCookiesForMainDomain(mainDomain);
    if (currentCookies.length === 0) return { success: false, error: '当前没有登录信息' };

    profile.cookies = currentCookies;
    profile.cookieCount = currentCookies.length;
    profile.savedAt = Date.now();
    profile.userInfo = extractUserInfoFromCookies(currentCookies);
    const domainStats = {};
    for (const c of currentCookies) domainStats[c.domain] = (domainStats[c.domain] || 0) + 1;
    profile.domainStats = domainStats;

    await chrome.storage.local.set({ profiles: data.profiles });
    await setActiveProfile(mainDomain, profileName);
    return { success: true, cookieCount: currentCookies.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function deleteProfiles(domain, profileNames) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['profiles']);
    const profiles = data.profiles || {};
    if (!profiles[mainDomain]) return { success: false, error: '域名不存在' };

    let deletedCount = 0;
    for (const name of (Array.isArray(profileNames) ? profileNames : [profileNames])) {
      if (profiles[mainDomain][name]) {
        delete profiles[mainDomain][name];
        deletedCount++;
      }
    }
    if (Object.keys(profiles[mainDomain]).length === 0) delete profiles[mainDomain];
    await chrome.storage.local.set({ profiles });

    // 若删除的是当前激活账号,清掉激活标记
    if (Array.isArray(profileNames) ? profileNames.includes(activeProfiles[mainDomain]) : activeProfiles[mainDomain] === profileNames) {
      delete activeProfiles[mainDomain];
      await chrome.storage.local.set({ activeProfiles });
    }
    await rebuildContextMenu();
    return { success: true, deletedCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function renameProfile(domain, oldName, newName) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['profiles']);
    const profiles = data.profiles || {};
    if (!profiles[mainDomain]?.[oldName]) return { success: false, error: '账号不存在' };
    if (profiles[mainDomain][newName]) return { success: false, error: '新名称已存在' };

    profiles[mainDomain][newName] = profiles[mainDomain][oldName];
    delete profiles[mainDomain][oldName];
    if (activeProfiles[mainDomain] === oldName) {
      activeProfiles[mainDomain] = newName;
      await chrome.storage.local.set({ activeProfiles });
    }
    await chrome.storage.local.set({ profiles });
    await rebuildContextMenu();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function duplicateProfile(domain, profileName, newName) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['profiles']);
    const profiles = data.profiles || {};
    const source = profiles[mainDomain]?.[profileName];
    if (!source) return { success: false, error: '账号不存在' };

    const target = newName || `${profileName} (副本)`;
    if (profiles[mainDomain][target]) return { success: false, error: '目标名称已存在' };

    profiles[mainDomain][target] = {
      ...source,
      savedAt: Date.now(),
      lastUsedAt: null,
      useCount: 0
    };
    await chrome.storage.local.set({ profiles });
    return { success: true, newName: target };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getProfiles(domain) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['profiles']);
    const domainProfiles = data.profiles?.[mainDomain] || {};
    return {
      success: true,
      mainDomain,
      profiles: Object.entries(domainProfiles).map(([name, p]) => ({
        name,
        savedAt: p.savedAt,
        cookieCount: p.cookieCount,
        color: p.color || '#4285F4',
        lastUsedAt: p.lastUsedAt || null,
        useCount: p.useCount || 0,
        note: p.note || '',
        originalDomain: p.originalDomain || '',
        userInfo: p.userInfo || null,
        customUA: p.customUA || null,
        fingerprint: p.fingerprint || null,
        tags: p.tags || [],
        loginHint: p.loginHint || '',
        passwordHint: p.passwordHint || '',
        healthStatus: checkProfileHealth(p)
      }))
    };
  } catch (error) {
    return { success: false, profiles: [], error: error.message };
  }
}

async function getAllProfileStats() {
  try {
    const data = await chrome.storage.local.get(['profiles']);
    const profiles = data.profiles || {};
    const stats = Object.entries(profiles).map(([domain, domainProfiles]) => ({
      domain,
      profileCount: Object.keys(domainProfiles).length,
      profiles: Object.keys(domainProfiles)
    }));
    return { success: true, stats };
  } catch (error) {
    return { success: false, stats: [], error: error.message };
  }
}

// 更新账号的可编辑字段(颜色/备注/标签/独立UA/指纹/凭证备忘)
async function updateProfileFields(domain, profileName, patch) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['profiles']);
    const profile = data.profiles?.[mainDomain]?.[profileName];
    if (!profile) return { success: false, error: '账号不存在' };

    const allowed = ['color', 'note', 'tags', 'customUA', 'fingerprint', 'groupId'];
    for (const key of allowed) {
      if (patch[key] !== undefined) profile[key] = patch[key];
    }
    // 凭证备忘:仅 Base64 混淆(不是加密),防止肉眼直接可见
    if (patch.loginHint !== undefined) {
      profile.loginHint = patch.loginHint ? btoa(encodeURIComponent(patch.loginHint)) : '';
    }
    if (patch.passwordHint !== undefined) {
      profile.passwordHint = patch.passwordHint ? btoa(encodeURIComponent(patch.passwordHint)) : '';
    }

    await chrome.storage.local.set({ profiles: data.profiles });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function setActiveProfile(mainDomain, profileName) {
  activeProfiles[mainDomain] = profileName;
  await chrome.storage.local.set({ activeProfiles });
}

// ==================== 使用记录 / 健康状态 ====================

async function recordRecentUsage(mainDomain, profileName) {
  try {
    const data = await chrome.storage.local.get(['recentUsage', 'profiles']);
    let recentUsage = data.recentUsage || [];
    recentUsage = recentUsage.filter(r => !(r.domain === mainDomain && r.profileName === profileName));
    recentUsage.unshift({ domain: mainDomain, profileName, usedAt: Date.now() });
    recentUsage = recentUsage.slice(0, 10);

    const profile = data.profiles?.[mainDomain]?.[profileName];
    if (profile) {
      profile.lastUsedAt = Date.now();
      profile.useCount = (profile.useCount || 0) + 1;
    }
    await chrome.storage.local.set({ recentUsage, profiles: data.profiles });
  } catch (e) {
    console.error('[SwitchID] 记录使用失败:', e);
  }
}

async function getRecentUsage() {
  try {
    const data = await chrome.storage.local.get(['recentUsage', 'profiles']);
    const profiles = data.profiles || {};
    const recentUsage = (data.recentUsage || []).filter(r => profiles[r.domain]?.[r.profileName]);
    return { success: true, recentUsage };
  } catch (error) {
    return { success: false, recentUsage: [] };
  }
}

function checkProfileHealth(profile) {
  if (!profile.cookies?.length) return { status: 'warning', message: '无 Cookie 数据' };

  const now = Date.now() / 1000;
  const expiredCount = profile.cookies.filter(c => c.expirationDate && c.expirationDate < now).length;
  const daysSinceSaved = (Date.now() - profile.savedAt) / 86400000;
  const daysSinceUsed = profile.lastUsedAt ? (Date.now() - profile.lastUsedAt) / 86400000 : daysSinceSaved;

  if (expiredCount > profile.cookies.length * 0.5) {
    return { status: 'error', message: '大部分 Cookie 已过期,建议重新登录并保存' };
  }
  if (daysSinceUsed > 60) return { status: 'warning', message: `${Math.floor(daysSinceUsed)} 天未使用,可能需要重新登录` };
  if (daysSinceSaved > 90) return { status: 'warning', message: '保存超过 90 天,建议重新保存' };
  if (expiredCount > 0) return { status: 'warning', message: `${expiredCount} 个 Cookie 已过期` };
  return { status: 'ok', message: '状态正常' };
}

async function checkAllProfilesHealth() {
  try {
    const data = await chrome.storage.local.get(['profiles', 'settings', 'activeProfiles']);
    const profiles = data.profiles || {};
    const settings = data.settings || {};
    if (!settings.healthCheckEnabled) return;

    const now = Date.now() / 1000;
    const warnings = [];

    // 自动刷新快过期的当前账号
    if (settings.autoRefreshExpiring) {
      const expiringThreshold = now + 7 * 86400;
      for (const [domain, name] of Object.entries(data.activeProfiles || {})) {
        const profile = profiles[domain]?.[name];
        if (!profile?.cookies?.length) continue;
        const expiring = profile.cookies.filter(c => c.expirationDate && c.expirationDate > now && c.expirationDate < expiringThreshold).length;
        if (expiring > profile.cookies.length * 0.3) {
          await refreshProfile(domain, name, true);
        }
      }
    }

    for (const [domain, domainProfiles] of Object.entries(profiles)) {
      for (const [name, profile] of Object.entries(domainProfiles)) {
        if (!profile.cookies?.length) continue;
        const expiredCount = profile.cookies.filter(c => c.expirationDate && c.expirationDate < now).length;
        const daysSinceSaved = (Date.now() - profile.savedAt) / 86400000;
        if (expiredCount > profile.cookies.length * 0.5) {
          warnings.push({ domain, name, type: 'expired', message: `「${name}」(${domain}) 大部分 Cookie 已过期` });
        } else if (daysSinceSaved > 60) {
          warnings.push({ domain, name, type: 'stale', message: `「${name}」(${domain}) 已 ${Math.floor(daysSinceSaved)} 天未更新` });
        }
      }
    }

    if (warnings.length > 0 && settings.showNotification) {
      const message = warnings.length === 1
        ? warnings[0].message
        : `${warnings.length} 个账号需要注意:${warnings.slice(0, 2).map(w => w.name).join('、')}${warnings.length > 2 ? '...' : ''}`;
      chrome.notifications.create('health-warning', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'SwitchID 账号健康提醒',
        message,
        priority: 1
      });
    }
    await chrome.storage.local.set({ healthWarnings: warnings });
  } catch (e) {
    console.error('[SwitchID] 健康检查失败:', e);
  }
}

// ==================== 标签页操作 ====================

async function getRelatedTabIds(mainDomain) {
  try {
    const tabs = await chrome.tabs.query({});
    const ids = [];
    for (const tab of tabs) {
      if (!tab.url || isBrowserInternalUrl(tab.url)) continue;
      try {
        if (getMainDomain(new URL(tab.url).hostname) === mainDomain) ids.push(tab.id);
      } catch (e) { /* 无效 URL,跳过 */ }
    }
    return ids;
  } catch (e) {
    return [];
  }
}

async function closeRelatedTabs(mainDomain) {
  try {
    const tabs = await chrome.tabs.query({});
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const tab of tabs) {
      if (tab.id === activeTab?.id || !tab.url) continue;
      try {
        if (getMainDomain(new URL(tab.url).hostname) === mainDomain) {
          await chrome.tabs.remove(tab.id);
        }
      } catch (e) { /* 忽略 */ }
    }
  } catch (e) {
    console.error('[SwitchID] 关闭标签失败:', e);
  }
}

// ==================== User-Agent 伪装 (declarativeNetRequest) ====================

const UA_RULE_ID = 1;

async function clearAllDNRRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = existing.map(r => r.id);
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: [] });
    }
  } catch (e) {
    console.error('[SwitchID] 清除 DNR 规则失败:', e);
  }
}

async function applyUserAgent(userAgent) {
  if (!userAgent) return clearAllDNRRules();
  await clearAllDNRRules();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: UA_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'User-Agent', operation: 'set', value: userAgent }]
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'image', 'stylesheet', 'font', 'media', 'other']
        }
      }]
    });
  } catch (e) {
    console.error('[SwitchID] 应用 UA 失败:', e);
  }
}

async function getCurrentUA() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const uaRule = rules.find(r => r.action?.requestHeaders?.some(h => h.header === 'User-Agent'));
  const ua = uaRule?.action?.requestHeaders?.find(h => h.header === 'User-Agent')?.value;
  return { userAgent: ua || null, enabled: !!ua };
}

// ==================== 指纹防关联 ====================

function generateRandomFingerprint() {
  const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const platforms = [
    {
      platform: 'Win32', uaPlatform: { platform: 'Windows', platformVersion: '10.0.0' },
      renderers: [
        'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'
      ]
    },
    {
      platform: 'MacIntel', uaPlatform: { platform: 'macOS', platformVersion: '14.0.0' },
      renderers: [
        'ANGLE (Apple, Apple M1, OpenGL 4.1)',
        'ANGLE (Apple, Apple M2, OpenGL 4.1)',
        'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
        'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)'
      ]
    },
    {
      platform: 'Linux x86_64', uaPlatform: { platform: 'Linux', platformVersion: '6.0.0' },
      renderers: [
        'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
        'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1080/PCIe/SSE2, OpenGL 4.6)'
      ]
    }
  ];
  const timezones = [
    { zone: 'Asia/Shanghai', offset: 480, language: 'zh-CN', languages: ['zh-CN', 'zh', 'en-US', 'en'] },
    { zone: 'Asia/Tokyo', offset: 540, language: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'] },
    { zone: 'America/New_York', offset: -300, language: 'en-US', languages: ['en-US', 'en'] },
    { zone: 'America/Los_Angeles', offset: -480, language: 'en-US', languages: ['en-US', 'en'] },
    { zone: 'Europe/London', offset: 0, language: 'en-GB', languages: ['en-GB', 'en'] },
    { zone: 'Europe/Paris', offset: 60, language: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'] },
    { zone: 'Australia/Sydney', offset: 660, language: 'en-AU', languages: ['en-AU', 'en'] }
  ];
  const resolutions = [
    { width: 1920, height: 1080, colorDepth: 24 },
    { width: 2560, height: 1440, colorDepth: 24 },
    { width: 1366, height: 768, colorDepth: 24 },
    { width: 1536, height: 864, colorDepth: 24 },
    { width: 1440, height: 900, colorDepth: 24 },
    { width: 1680, height: 1050, colorDepth: 24 },
    { width: 2560, height: 1600, colorDepth: 30 },
    { width: 3840, height: 2160, colorDepth: 30 }
  ];

  const platformCfg = pick(platforms);
  const tz = pick(timezones);
  const resolution = pick(resolutions);
  const chromeVersion = String(120 + Math.floor(Math.random() * 8));
  const renderer = pick(platformCfg.renderers);
  const vendor = renderer.startsWith('ANGLE (Apple') ? 'Apple Inc.' : renderer.startsWith('ANGLE (NVIDIA Corporation') || renderer.startsWith('ANGLE (NVIDIA,') ? 'Google Inc. (NVIDIA)' : 'Google Inc. (Intel)';

  return {
    seed,
    canvasSeed: seed,
    webglSeed: seed + 1,
    audioSeed: seed + 2,
    domRectSeed: seed + 3,
    canvas: true,
    webgl: true,
    audio: true,
    domRect: false,
    disableWebRTC: false,
    gpuInfo: { vendor, renderer },
    navigator: {
      platform: platformCfg.platform,
      language: tz.language,
      languages: tz.languages,
      hardwareConcurrency: pick([4, 6, 8, 10, 12, 16]),
      deviceMemory: pick([4, 8, 16, 32]),
      userAgentData: {
        brands: [
          { brand: 'Chromium', version: chromeVersion },
          { brand: 'Google Chrome', version: chromeVersion },
          { brand: 'Not_A Brand', version: '8' }
        ],
        mobile: false,
        platform: platformCfg.uaPlatform.platform,
        platformVersion: platformCfg.uaPlatform.platformVersion,
        architecture: 'x86',
        bitness: '64'
      }
    },
    screen: { width: resolution.width, height: resolution.height, colorDepth: resolution.colorDepth },
    timezone: { zone: tz.zone, offset: tz.offset }
  };
}

async function saveActiveFingerprint(domain, fingerprint) {
  const data = await chrome.storage.local.get(['activeFingerprints']);
  const fingerprints = data.activeFingerprints || {};
  fingerprints[getMainDomain(domain)] = fingerprint;
  await chrome.storage.local.set({ activeFingerprints: fingerprints });
}

async function clearActiveFingerprint(domain) {
  const data = await chrome.storage.local.get(['activeFingerprints']);
  const fingerprints = data.activeFingerprints || {};
  delete fingerprints[getMainDomain(domain)];
  await chrome.storage.local.set({ activeFingerprints: fingerprints });
}

function isInWhitelist(domain, whitelist) {
  if (!domain || !whitelist?.length) return false;
  domain = domain.toLowerCase();
  return whitelist.some(pattern => {
    const p = String(pattern).toLowerCase();
    if (domain === p || domain.endsWith('.' + p)) return true;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return domain === base || domain.endsWith('.' + base);
    }
    return false;
  });
}

// 根据全局设置合并出该域名实际生效的指纹配置;返回 null 表示不注入
async function getActiveFingerprint(domain) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['settings', 'fingerprintWhitelist', 'activeFingerprints']);
    const settings = data.settings || {};

    if (settings.fingerprintEnabled === false) return null;
    const whitelist = settings.fingerprintWhitelist || data.fingerprintWhitelist || [];
    if (isInWhitelist(domain, whitelist)) return null;

    let fingerprint = (data.activeFingerprints || {})[mainDomain];
    if (!fingerprint) fingerprint = generateRandomFingerprint();

    // 强指纹默认开启;弱指纹(可能影响兼容性)默认关闭
    if (settings.fp_canvas === false) fingerprint.canvas = false;
    if (settings.fp_webgl === false) fingerprint.webgl = false;
    if (settings.fp_audio === false) fingerprint.audio = false;
    if (settings.fp_domrect !== true) fingerprint.domRect = false;
    if (settings.fp_timezone === true && fingerprint.timezone) {
      // 保持
    } else {
      fingerprint.timezone = null;
    }
    if (settings.fp_webrtc === true) fingerprint.disableWebRTC = true;
    return fingerprint;
  } catch (e) {
    console.error('[SwitchID] 获取指纹失败:', e);
    return null;
  }
}

// 页面导航时把指纹配置注入到 MAIN world(在页面脚本运行前生效)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (isBrowserInternalUrl(details.url)) return;
  try {
    const url = new URL(details.url);
    const fingerprint = await getActiveFingerprint(url.hostname);
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'MAIN',
      injectImmediately: true,
      args: [fingerprint],
      func: applyFingerprintInPage
    });
  } catch (e) {
    // 受限页面无法注入,忽略
  }
});

// ==================== 右键菜单 ====================

async function rebuildContextMenu(domain) {
  try {
    await chrome.contextMenus.removeAll();
    const create = (options) => new Promise(resolve =>
      chrome.contextMenus.create(options, () => { void chrome.runtime.lastError; resolve(); })
    );

    await create({ id: 'switchid-root', title: 'SwitchID 账号切换', contexts: ['page'] });
    await create({ id: 'save-profile', parentId: 'switchid-root', title: '💾 保存当前账号', contexts: ['page'] });
    await create({ id: 'clear-cookies', parentId: 'switchid-root', title: '🚪 退出登录', contexts: ['page'] });

    if (domain) {
      const result = await getProfiles(domain);
      if (result.success && result.profiles.length > 0) {
        await create({ id: 'separator', parentId: 'switchid-root', type: 'separator', contexts: ['page'] });
        const list = result.profiles.slice(0, 9);
        for (let i = 0; i < list.length; i++) {
          await create({
            id: `switch:${list[i].name}`,
            parentId: 'switchid-root',
            title: `${i + 1}. 切换到「${list[i].name}」`,
            contexts: ['page']
          });
        }
      }
    }
  } catch (e) {
    console.error('[SwitchID] 菜单更新失败:', e);
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && !isBrowserInternalUrl(tab.url)) {
      await rebuildContextMenu(new URL(tab.url).hostname);
    }
  } catch (e) { /* 忽略 */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !isBrowserInternalUrl(tab.url)) {
    try {
      await rebuildContextMenu(new URL(tab.url).hostname);
    } catch (e) { /* 忽略 */ }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.url) return;
  try {
    const domain = new URL(tab.url).hostname;
    if (info.menuItemId === 'save-profile') {
      try { await chrome.action.openPopup(); } catch (e) { /* 某些环境不支持 */ }
    } else if (info.menuItemId === 'clear-cookies') {
      const result = await clearCookiesForDomain(domain);
      if (result.success) chrome.tabs.reload(tab.id);
    } else if (info.menuItemId.startsWith('switch:')) {
      const profileName = info.menuItemId.slice('switch:'.length);
      const result = await loadProfile(domain, profileName);
      if (result.success) chrome.tabs.reload(tab.id);
    }
  } catch (e) { /* 忽略 */ }
});

// ==================== 自动轮换 ====================

async function restoreAutoRotateAlarms() {
  try {
    const data = await chrome.storage.local.get(['autoRotateConfig']);
    for (const [domain, cfg] of Object.entries(data.autoRotateConfig || {})) {
      if (cfg.enabled && cfg.intervalMinutes > 0) {
        chrome.alarms.create(`rotate:${domain}`, { periodInMinutes: cfg.intervalMinutes });
      }
    }
  } catch (e) {
    console.error('[SwitchID] 恢复轮换失败:', e);
  }
}

async function setAutoRotate(domain, config) {
  try {
    const mainDomain = getMainDomain(domain);
    const data = await chrome.storage.local.get(['autoRotateConfig']);
    const all = data.autoRotateConfig || {};
    const alarmName = `rotate:${mainDomain}`;

    if (config.enabled && config.intervalMinutes > 0 && config.profiles?.length > 1) {
      all[mainDomain] = {
        enabled: true,
        intervalMinutes: config.intervalMinutes,
        profiles: config.profiles,
        currentIndex: all[mainDomain]?.currentIndex || 0,
        lastRotate: null
      };
      await chrome.alarms.clear(alarmName);
      chrome.alarms.create(alarmName, { periodInMinutes: config.intervalMinutes });
    } else {
      delete all[mainDomain];
      await chrome.alarms.clear(alarmName);
    }
    await chrome.storage.local.set({ autoRotateConfig: all });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function executeAutoRotate(domain) {
  try {
    const data = await chrome.storage.local.get(['autoRotateConfig', 'profiles', 'settings']);
    const config = data.autoRotateConfig?.[domain];
    if (!config?.enabled || config.profiles?.length < 2) return;
    if (!data.profiles?.[domain]?.[config.profiles[(config.currentIndex + 1) % config.profiles.length]]) return;

    const nextIndex = (config.currentIndex + 1) % config.profiles.length;
    const nextProfile = config.profiles[nextIndex];
    const result = await loadProfile(domain, nextProfile);
    if (!result.success) return;

    config.currentIndex = nextIndex;
    config.lastRotate = Date.now();
    await chrome.storage.local.set({ autoRotateConfig: data.autoRotateConfig });

    if (data.settings?.showNotification) {
      chrome.notifications.create(`rotate:${domain}:${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'SwitchID 自动轮换',
        message: `已切换到「${nextProfile}」(${domain})`,
        priority: 0
      });
    }
    if (result.relatedTabIds) {
      for (const tabId of result.relatedTabIds) {
        try { await chrome.tabs.reload(tabId); } catch (e) { /* 忽略 */ }
      }
    }
  } catch (e) {
    console.error('[SwitchID] 轮换失败:', e);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'healthCheck') {
    await checkAllProfilesHealth();
  } else if (alarm.name.startsWith('rotate:')) {
    await executeAutoRotate(alarm.name.slice('rotate:'.length));
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'health-warning') {
    chrome.action.openPopup().catch(() => {});
  }
  chrome.notifications.clear(notificationId);
});

// ==================== 快捷键 ====================

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick-switch') {
    try { await chrome.action.openPopup(); } catch (e) { /* 某些环境不支持 */ }
  }
});

// ==================== 导入 / 导出 ====================

async function exportData(domain = null) {
  const data = await chrome.storage.local.get(['profiles', 'settings', 'autoRotateConfig']);
  const payload = {
    app: 'SwitchID-Local',
    version: '1.0.0',
    exportedAt: Date.now(),
    profiles: domain ? { [getMainDomain(domain)]: data.profiles?.[getMainDomain(domain)] || {} } : data.profiles,
    autoRotateConfig: domain ? undefined : data.autoRotateConfig
  };
  return { success: true, data: payload };
}

async function importData(payload) {
  try {
    if (!payload || !payload.profiles || typeof payload.profiles !== 'object') {
      return { success: false, error: '无效的备份文件(缺少 profiles)' };
    }
    const data = await chrome.storage.local.get(['profiles']);
    const merged = { ...(data.profiles || {}) };
    let count = 0;
    for (const [domain, domainProfiles] of Object.entries(payload.profiles)) {
      merged[domain] = { ...(merged[domain] || {}), ...domainProfiles };
      count += Object.keys(domainProfiles || {}).length;
    }
    await chrome.storage.local.set({ profiles: merged });
    await rebuildContextMenu();
    return { success: true, importedCount: count };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==================== 消息路由 ====================

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    let response;
    try {
      switch (request.action) {
        case 'getProfiles':
          response = await getProfiles(request.domain);
          break;
        case 'getAllProfileStats':
          response = await getAllProfileStats();
          break;
        case 'saveProfile':
          response = await saveProfile(request.domain, request.profileName, request.color);
          break;
        case 'loadProfile':
          response = await loadProfile(request.domain, request.profileName);
          break;
        case 'refreshProfile':
          response = await refreshProfile(request.domain, request.profileName, request.forceRefresh);
          break;
        case 'deleteProfile':
          response = await deleteProfiles(request.domain, [request.profileName]);
          break;
        case 'deleteMultipleProfiles':
          response = await deleteProfiles(request.domain, request.profileNames);
          break;
        case 'renameProfile':
          response = await renameProfile(request.domain, request.oldName, request.newName);
          break;
        case 'duplicateProfile':
          response = await duplicateProfile(request.domain, request.profileName, request.newName);
          break;
        case 'updateProfileFields':
          response = await updateProfileFields(request.domain, request.profileName, request.patch);
          break;
        case 'clearCookies':
          response = await clearCookiesForDomain(request.domain);
          break;
        case 'clearSiteData':
          response = await clearAllSiteData(request.domain);
          break;
        case 'getRecentUsage':
          response = await getRecentUsage();
          break;
        case 'getActiveProfile': {
          const mainDomain = getMainDomain(request.domain);
          response = { success: true, activeProfile: activeProfiles[mainDomain] || null, domain: mainDomain };
          break;
        }
        case 'detectUser': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            response = await chrome.tabs.sendMessage(tab.id, { action: 'detectUser' });
          } else {
            response = { success: false, userInfo: null };
          }
          break;
        }
        case 'generateFingerprint':
          response = { success: true, fingerprint: generateRandomFingerprint() };
          break;
        case 'updateSettings': {
          const data = await chrome.storage.local.get(['settings']);
          const merged = { ...(data.settings || {}), ...request.settings };
          await chrome.storage.local.set({ settings: merged });
          activeSettings = { ...activeSettings, ...request.settings };

          if (request.settings.uaEnabled !== undefined || request.settings.customUA !== undefined) {
            if (activeSettings.uaEnabled && activeSettings.customUA) {
              await applyUserAgent(activeSettings.customUA);
            } else {
              await clearAllDNRRules();
            }
          }
          response = { success: true, settings: merged };
          break;
        }
        case 'getSettings': {
          const data = await chrome.storage.local.get(['settings', 'fingerprintWhitelist']);
          response = { success: true, settings: data.settings || {}, fingerprintWhitelist: data.fingerprintWhitelist || [] };
          break;
        }
        case 'getCurrentUA':
          response = { success: true, ...(await getCurrentUA()) };
          break;
        case 'setAutoRotate':
          response = await setAutoRotate(request.domain, request.config);
          break;
        case 'getAutoRotateConfig': {
          const mainDomain = getMainDomain(request.domain);
          const data = await chrome.storage.local.get(['autoRotateConfig']);
          response = { success: true, config: data.autoRotateConfig?.[mainDomain] || null };
          break;
        }
        case 'checkHealthNow':
          await checkAllProfilesHealth();
          response = { success: true };
          break;
        case 'exportProfiles':
          response = await exportData(null);
          break;
        case 'exportDomainProfiles':
          response = await exportData(request.domain);
          break;
        case 'importProfiles':
          response = await importData(request.data);
          break;
        case 'clearAllData':
          await chrome.storage.local.clear();
          await clearAllDNRRules();
          activeProfiles = {};
          activeSettings = { ...activeSettings };
          await chrome.storage.local.set({ profiles: {}, settings: activeSettings, autoRotateConfig: {} });
          await rebuildContextMenu();
          response = { success: true };
          break;
        default:
          response = { success: false, error: `未知操作: ${request.action}` };
      }
    } catch (e) {
      response = { success: false, error: e.message };
    }
    sendResponse(response);
  })();
  return true; // 异步 sendResponse
});

// ==================== 工具 ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 页面内指纹伪装(注入 MAIN world,必须自包含) ====================

function applyFingerprintInPage(config) {
  if (window.__switchid_fp__) return;
  window.__switchid_fp__ = true;
  if (!config) return;

  // ---- 可复现随机数(Mulberry32) ----
  function makeSeededRandom(seed) {
    let s = typeof seed === 'string' ? hashString(seed) : seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
  function defineGetter(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
      return true;
    } catch (e) { return false; }
  }

  // ---- Canvas 2D:在边缘像素注入确定性微噪声 ----
  if (config.canvas !== false && config.canvasSeed != null) {
    const rand = makeSeededRandom(config.canvasSeed);
    const noise = [];
    for (let i = 0; i < 10; i++) noise.push(Math.floor(rand() * 256));

    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;

    function addSmartNoise(imageData) {
      const data = imageData.data;
      const w = imageData.width, h = imageData.height;
      let idx = 0;
      const eq = (a, b) => data[a] === data[b] && data[a + 1] === data[b + 1] && data[a + 2] === data[b + 2] && data[a + 3] === data[b + 3];
      for (let row = 1; row < h - 2 && idx < noise.length; row += 2) {
        for (let col = 1; col < w - 2 && idx < noise.length; col += 2) {
          const c = (row * w + col) * 4;
          const up = ((row - 1) * w + col) * 4, down = ((row + 1) * w + col) * 4;
          const left = (row * w + col - 1) * 4, right = (row * w + col + 1) * 4;
          if (!eq(c, up) && !eq(c, down) && !eq(c, left) && !eq(c, right)) {
            data[c + 3] = noise[idx++] % 256;
          }
        }
      }
      return imageData;
    }

    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      return addSmartNoise(origGetImageData.apply(this, args));
    };
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try {
        if (this.width > 0 && this.height > 0) {
          const tmp = document.createElement('canvas');
          tmp.width = this.width; tmp.height = this.height;
          const ctx = tmp.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(this, 0, 0);
          const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
          addSmartNoise(imageData);
          ctx.putImageData(imageData, 0, 0);
          return origToDataURL.apply(tmp, args);
        }
      } catch (e) { /* 回退原实现 */ }
      return origToDataURL.apply(this, args);
    };
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      try {
        if (this.width > 0 && this.height > 0) {
          const tmp = document.createElement('canvas');
          tmp.width = this.width; tmp.height = this.height;
          const ctx = tmp.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(this, 0, 0);
          const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
          addSmartNoise(imageData);
          ctx.putImageData(imageData, 0, 0);
          return origToBlob.call(tmp, callback, ...args);
        }
      } catch (e) { /* 回退原实现 */ }
      return origToBlob.call(this, callback, ...args);
    };
  }

  // ---- WebGL:伪装显卡信息 ----
  if (config.webgl !== false && config.gpuInfo) {
    const spoof = (orig) => function (parameter) {
      const ext = this.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        if (parameter === ext.UNMASKED_VENDOR_WEBGL && config.gpuInfo.vendor) return config.gpuInfo.vendor;
        if (parameter === ext.UNMASKED_RENDERER_WEBGL && config.gpuInfo.renderer) return config.gpuInfo.renderer;
      }
      return orig.call(this, parameter);
    };
    try {
      WebGLRenderingContext.prototype.getParameter = spoof(WebGLRenderingContext.prototype.getParameter);
      if (window.WebGL2RenderingContext) {
        WebGL2RenderingContext.prototype.getParameter = spoof(WebGL2RenderingContext.prototype.getParameter);
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---- AudioContext:音频指纹注入微噪声 ----
  if (config.audio !== false && config.audioSeed != null && window.AudioBuffer) {
    const processed = new WeakSet();
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (channel) {
      const data = origGetChannelData.call(this, channel);
      if (processed.has(data)) return data;
      const rand = makeSeededRandom(config.audioSeed);
      const step = data.length > 2000 ? 100 : 20;
      for (let i = 0; i < data.length; i += step) {
        const v = data[i];
        if (v !== 0 && Math.abs(v) > 1e-7) data[i] = v + (rand() - 0.5) * 2e-7;
      }
      processed.add(data);
      return data;
    };
  }

  // ---- Navigator 属性 ----
  if (config.navigator) {
    const n = config.navigator;
    if (n.platform != null) defineGetter(navigator, 'platform', n.platform);
    if (n.language != null) defineGetter(navigator, 'language', n.language);
    if (n.languages != null) defineGetter(navigator, 'languages', Object.freeze([...n.languages]));
    if (n.hardwareConcurrency != null) defineGetter(navigator, 'hardwareConcurrency', n.hardwareConcurrency);
    if (n.deviceMemory != null && 'deviceMemory' in navigator) defineGetter(navigator, 'deviceMemory', n.deviceMemory);
    if (n.userAgentData && navigator.userAgentData) {
      try {
        const origGetHighEntropy = navigator.userAgentData.getHighEntropyValues.bind(navigator.userAgentData);
        navigator.userAgentData.getHighEntropyValues = function (hints) {
          return origGetHighEntropy(hints).then(values => ({ ...values, ...n.userAgentData }));
        };
        if (n.userAgentData.platform) defineGetter(navigator.userAgentData, 'platform', n.userAgentData.platform);
        if (n.userAgentData.brands) defineGetter(navigator.userAgentData, 'brands', Object.freeze([...n.userAgentData.brands]));
      } catch (e) { /* 忽略 */ }
    }
  }

  // ---- Screen 属性 ----
  if (config.screen) {
    const s = config.screen;
    if (s.width != null) {
      defineGetter(screen, 'width', s.width);
      defineGetter(screen, 'availWidth', s.width);
    }
    if (s.height != null) {
      defineGetter(screen, 'height', s.height);
      defineGetter(screen, 'availHeight', s.height - 40);
    }
    if (s.colorDepth != null) {
      defineGetter(screen, 'colorDepth', s.colorDepth);
      defineGetter(screen, 'pixelDepth', s.colorDepth);
    }
  }

  // ---- 时区(可能影响部分网站时间显示,默认关闭) ----
  if (config.timezone && config.timezone.offset != null) {
    try {
      const offset = config.timezone.offset;
      const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
      Date.prototype.getTimezoneOffset = function () { return -offset; };
      const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function (...args) {
        const result = origResolvedOptions.apply(this, args);
        result.timeZone = config.timezone.zone;
        return result;
      };
    } catch (e) { /* 忽略 */ }
  }

  // ---- DOMRect 微噪声(可能影响个别网站排版,默认关闭) ----
  if (config.domRect === true && config.domRectSeed != null && window.DOMRectReadOnly) {
    try {
      const rand = makeSeededRandom(config.domRectSeed);
      const props = ['x', 'y', 'width', 'height'];
      for (const prop of props) {
        const orig = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, prop);
        if (!orig || !orig.get) continue;
        Object.defineProperty(DOMRectReadOnly.prototype, prop, {
          get: function () {
            const v = orig.get.call(this);
            return typeof v === 'number' && Number.isFinite(v) ? v + (rand() - 0.5) * 0.002 : v;
          },
          configurable: true
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---- WebRTC(禁用可防内网 IP 泄露,但会破坏视频通话,默认关闭) ----
  if (config.disableWebRTC === true) {
    try {
      if (window.RTCPeerConnection) window.RTCPeerConnection = undefined;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = undefined;
    } catch (e) { /* 忽略 */ }
  }
}
