# Edge 商店发布资料（Partner Center 直接粘贴用）

> 包：`dist/SwitchID-Local-v1.1.0-edge.zip`（manifest.json 位于 zip 根目录，仅含 src/ + icons/）
> 发布入口：https://partner.microsoft.com/dashboard/microsoftedge/public/login
> 官方流程文档：https://learn.microsoft.com/microsoft-edge/extensions/publish/publish-extension

---

## 1. Properties 页

- **Category（类目）**：Productivity（生产力工具）
- **Website（网站，选填）**：`https://github.com/wlor0623/SwitchID-chrome`
- **Support contact detail（支持联系方式，选填）**：GitHub Issues 地址或邮箱

## 2. Privacy 页

### Single Purpose（单一用途声明）

```
帮助用户在同一网站保存、管理和切换多个登录账号：将登录 Cookie 保存为本机档案，一键切换账号并可彻底清空站点数据。所有数据仅存储在用户本机，不上传任何信息。
```

### Permission justification（逐条权限理由，已按源码实际用途核对）

| 权限 | 理由文字 |
|---|---|
| storage | 将用户创建的账号 Cookie 快照、指纹配置和偏好设置保存在本机（chrome.storage.local），不与任何服务器通信。 |
| cookies | 核心功能：读取并导出目标域名的 Cookie 以保存登录态；切换账号时清空该域名 Cookie 并写入所选档案的 Cookie。 |
| browsingData | 「一键清空本站数据」功能：按用户指定的域名清除 Cookie、缓存、localStorage、IndexedDB、Service Worker 等站点数据。 |
| tabs | 切换账号后刷新受影响的标签页使新登录态生效；获取当前标签页 URL 以确定要操作的站点。 |
| contextMenus | 提供「保存当前账号 / 切换账号」的右键菜单入口。 |
| declarativeNetRequest | 按用户的独立 UA 配置修改请求头中的 User-Agent。 |
| alarms | 定时任务：每 24 小时一次 Cookie 有效期健康检查；按用户设定间隔自动轮换账号。 |
| notifications | 向用户提示账号切换结果、Cookie 即将过期等提醒。 |
| scripting | 向页面注入扩展自带的指纹配置脚本（MAIN world，本地代码，非远程代码）；切换账号后清理页面 localStorage/sessionStorage。 |
| webNavigation | 在页面导航提交（onCommitted）时尽早注入指纹脚本，确保在页面自身脚本执行之前生效。 |
| host_permissions: `<all_urls>` | 账号快照、指纹隔离、清站数据均针对用户当前访问的任意网站生效，网址由用户操作决定，无法事先枚举域名列表。 |
| content script（page-agent.js） | 扩展自带的页面代理脚本：清空站点数据后同步清理页面本地存储。仅在用户主动操作时配合执行。 |

### Are you using remote code?（是否使用远程代码）

选 **No, I am not using remote code**。（扩展全部代码随包内置，无 fetch/XHR/WebSocket/eval，可验证：`grep -rn "fetch\|XMLHttpRequest\|WebSocket\|sendBeacon\|eval(" src/`）

### Data usage（数据使用申报）

- 「计划收集的用户数据」：**全部不勾选**（不收集、不上传；数据仅存本机 `chrome.storage.local`）。
- 一致性：与下方隐私政策文案保持一致。

### Privacy policy URL（隐私政策链接，必需）

把本文件 §5 的隐私政策草稿存为仓库根目录 `PRIVACY.md` 并推送 GitHub 后，填：

```
https://github.com/wlor0623/SwitchID-chrome/blob/main/PRIVACY.md
```

## 3. Store listings 页（zh-CN）

- **Extension name**：来自 manifest，只读（SwitchID Local - 多账号管理助手）
- **Short description**：来自 manifest 的 description，只读
- **Extension logo（必需，≥128×128，推荐 300×300）**：目前只有 icon128.png（已达最低标准可过，建议做一张 300×300）
- **Screenshots（强烈建议传）**：尺寸必须是 **1280×800 或 640×480**，最多 6 张。
  做法：Edge 开 `edge://extensions/` → 加载本目录 → 打开弹窗页/设置页截图，再放进 1280×800 画布（背景可铺纯色）导出。
- **Description（必需，≥250 字符）**，可直接粘贴：

```
SwitchID Local 是一款多账号管理与切换工具：在同一个网站的多个账号之间一键切换，无需反复退出登录，并可为每个网站提供指纹隔离与独立身份。

【主要功能】
● 账号保存/切换：登录后一键把登录 Cookie 保存为命名档案；切换时自动清空目标域名 Cookie、写入所选档案并刷新相关标签页。
● 一键清空本站数据：按主域名连子域名彻底清除 Cookie、缓存、localStorage、IndexedDB、Service Worker 等，方便登录下一个新账号。
● 指纹防关联：为每个网站生成独立且稳定的随机指纹（Canvas/WebGL 显卡/音频/屏幕/Navigator 等），降低多个账号被平台关联识别的风险，保护浏览器隐私。
● 独立 User-Agent：全局或按账号配置 UA，基于 declarativeNetRequest 改写请求头。
● 自动轮换：2 个以上账号可按设定间隔自动轮流切换。
● 健康检查：每日检查各账号 Cookie 有效期并提醒，支持自动刷新快过期账号。
● 账号管理：颜色标记、备注、标签、分组搜索、批量删除。
● 导入/导出：JSON 格式本地备份与恢复。
● 便捷操作：快捷键 Alt+Shift+S 呼出账号面板，右键菜单即可保存/切换账号。

【隐私承诺】
纯本地运行：扩展代码中不存在任何网络请求（未使用 fetch / XMLHttpRequest / WebSocket），不加载任何远程资源，不上传任何数据；所有账号档案仅保存在本机浏览器的 chrome.storage.local 中。代码 100% 开源，欢迎审计：https://github.com/wlor0623/SwitchID-chrome

【适用场景】
管理同一平台的个人多账号（如工作号/生活号）、团队运营矩阵账号、开发测试多账号调试等。请在遵守目标网站服务条款的前提下使用。
```

- **Search terms（搜索词，选填）**：`账号切换, 多账号, 指纹, cookie, 隐私`

## 4. Notes for certification（提交给审核员的备注）

```
1. 本扩展为纯本地工具（Manifest V3）：无任何远程代码、无网络请求（无 fetch/XMLHttpRequest/WebSocket/sendBeacon）、无 eval，不登录任何服务，数据全部存于本机 chrome.storage.local。
2. 所有代码均为扩展自带（含注入页面的脚本），可通过审核员模式直接查看，亦开源在 https://github.com/wlor0623/SwitchID-chrome
3. 建议测试步骤：
   a) 打开任意需登录的网站（如 GitHub）并登录账号 A；
   b) 点击扩展图标 →「保存当前账号」，将账号 A 的 Cookie 保存为档案；
   c) 在该网站退出并登录账号 B，再次保存为档案；
   d) 从扩展弹窗列表一键切换 A/B，验证登录态变化；
   e) 「一键清空本站数据」会清除当前站点的存储以便登录新账号，属用户主动触发的功能。
4. 各权限用途已在 Privacy 页逐条说明；指纹/UA 功能均为本地随机配置注入，不涉及任何数据外发。
```

## 5. 隐私政策草稿（存为 PRIVACY.md 后推送 GitHub）

```markdown
# SwitchID Local 隐私政策

最后更新：2026-10-15

SwitchID Local 是纯本地浏览器扩展。本政策说明扩展如何处理数据。

## 我们收集什么
扩展不收集、不传输任何个人数据。它处理的数据全部来自用户在扩展内的主动操作：

- **网站 Cookie**：用户点击「保存当前账号」时，扩展读写当前网站的 Cookie，仅用于保存在本机、供用户还原登录态。
- **站点浏览数据**：扩展可能清除指定站点的 Cookie/缓存/localStorage/IndexedDB 等本地数据（仅用户主动触发）。

## 数据存在哪里
所有数据（账号档案、指纹配置、设置）仅保存在浏览器本地的 chrome.storage.local，
不会发送到任何服务器，扩展也没有任何服务器。卸载扩展即全部删除。

## 第三方网络请求
零网络请求。扩展不加载任何远程资源，不含任何统计/埋点 SDK。

## 联系方式
通过 GitHub 仓库 Issues 联系：https://github.com/wlor0623/SwitchID-chrome/issues
```

## 6. 审核相关提示

- 审核时长：官方口径最长 7 个工作日，通常 1~3 天。
- Name/description/short description 想改 → 必须改 manifest.json 后重新打 zip 上传新包。
- 审核被标记恶意软件时的申诉入口在 Support 表单（文档 bottom「Contact the Microsoft Edge extensions team」）。
- 本扩展与商店已有 `SwitchID - 多账号管理助手` 功能同名相近，是开源重写版；若被问来源，说明为独立重写、代码全部自写即可（README 已写明）。
