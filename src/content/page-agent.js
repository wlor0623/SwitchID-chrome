// page-agent.js - 内容脚本(ISOLATED world)
// 职责:1) 从页面 DOM 检测当前登录用户名,用于保存账号时自动命名;
//       2) 切换账号时清空页面的 localStorage/sessionStorage。
// 不做任何网络请求。

(function () {
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'detectUser') {
      sendResponse({ success: true, userInfo: detectUserInfo() });
    } else if (request.action === 'clearStorage') {
      try {
        localStorage.clear();
        sessionStorage.clear();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    }
    return true;
  });

  // ==================== 用户信息检测 ====================

  // 主流网站专用选择器(取值优先级从上到下)
  const siteSelectors = {
    'bing.com': ['#id_n', '#id_l', '.b_profile .b_text'],
    'microsoft.com': ['#mectrl_currentAccount_primary', '.mectrl_truncate'],
    'live.com': ['#mectrl_currentAccount_primary'],
    'google.com': ['[data-email]', '.gb_lb', '.gb_mb'],
    'youtube.com': ['#account-name', 'yt-formatted-string#account-name'],
    'amazon.com': ['#nav-link-accountList-nav-line-1', '.nav-line-1-container .nav-line-1'],
    'ebay.com': ['#gh-ug > a > span', '.gh-identity__greeting'],
    'shopee.sg': ['.navbar__username'],
    'shopee.com.my': ['.navbar__username'],
    'shopee.tw': ['.navbar__username'],
    'lazada.sg': ['.my-account-name', '.lzd-header-account-name'],
    'aliexpress.com': ['.user-account-info .user-name', '[data-role="user-name"]'],
    'tiktok.com': ['[data-e2e="profile-username"]', '.user-username'],
    'instagram.com': ['header section span', '[data-testid="user-avatar"]'],
    'linkedin.com': ['.feed-identity-module__actor-meta', '.global-nav__me-photo'],
    'twitter.com': ['[data-testid="UserName"]', '[data-testid="UserCell"] span'],
    'x.com': ['[data-testid="UserName"]', '[data-testid="UserCell"] span'],
    'facebook.com': ['[aria-label*="profile"] span', 'span[dir="auto"]'],
    'taobao.com': ['.site-nav-login-info-nick', '#J_SiteNavLogin .s-name'],
    'tmall.com': ['.sn-login .sn-user-name', '.member-nick'],
    'jd.com': ['.nickname', '#ttbar-login .link-user'],
    'pinduoduo.com': ['.user-name'],
    'weibo.com': ['.gn_name', '[node-type="username"]'],
    'douyin.com': ['.account-name', '[data-e2e="user-info-nickname"]'],
    'bilibili.com': ['.nickname-text', '.header-entry-mini .nickname'],
    'zhihu.com': ['.AppHeader-profile .Popover div', '.ProfileHeader-name'],
    'xiaohongshu.com': ['.user-name', '.nickname'],
    'github.com': ['.AppHeader-user button img[alt]', '[data-login]'],
    'reddit.com': ['#USER_DROPDOWN_ID span'],
    'douban.com': ['.nav-user-account span']
  };

  // 通用选择器(按优先级)
  const genericSelectors = [
    '[data-username]', '[data-user-name]', '[data-email]', '[data-nickname]', '[data-account]',
    '.user-name', '.username', '.nickname', '.account-name', '.display-name', '.profile-name',
    '#username', '#userName', '#nickname', '#accountName',
    '.avatar + span', '.user-avatar + *',
    '.nav-user .name', '.header-user .name'
  ];

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

  function detectUserInfo() {
    const result = { username: null, email: null, displayName: null, source: null };
    const hostname = window.location.hostname;

    // 1. 网站专用选择器
    for (const [domain, selectors] of Object.entries(siteSelectors)) {
      if (hostname.includes(domain)) {
        for (const selector of selectors) {
          const found = trySelector(selector);
          if (found) {
            Object.assign(result, found);
            result.source = 'site';
            if (result.email || result.username) return result;
          }
        }
      }
    }

    // 2. 通用选择器
    for (const selector of genericSelectors) {
      const found = trySelector(selector);
      if (found && (found.email || found.username)) {
        Object.assign(result, found);
        result.source = 'generic';
        return result;
      }
    }

    // 3. meta 标签
    for (const name of ['user-name', 'username', 'author']) {
      const el = document.querySelector(`meta[name="${name}"]`);
      if (el?.content) {
        result.username = el.content;
        result.source = 'meta';
        break;
      }
    }

    return result;
  }

  function trySelector(selector) {
    try {
      for (const el of document.querySelectorAll(selector)) {
        if (!isVisible(el)) continue;

        let text = '';
        for (const attr of ['data-username', 'data-email', 'data-nickname', 'data-login', 'data-account']) {
          if (el.hasAttribute(attr)) { text = el.getAttribute(attr); break; }
        }
        if (!text && el.hasAttribute('aria-label')) text = el.getAttribute('aria-label');
        if (!text && el.tagName === 'IMG' && el.alt) text = el.alt;
        if (!text) text = el.textContent || '';
        text = text.trim();

        if (!text || text.length < 2 || text.length > 50) continue;
        if (/^(登录|注册|login|sign in|sign up|log in|退出|logout|账户|account)$/i.test(text)) continue;

        if (emailRegex.test(text)) {
          return { email: text, displayName: text.split('@')[0] };
        }
        return { username: text, displayName: text };
      }
    } catch (e) { /* 非法选择器,跳过 */ }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch (e) {
      return true;
    }
  }
})();
