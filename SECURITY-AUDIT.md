# 安全审计报告:SwitchID - 多账号管理助手(商店版)

- 审计对象:Edge 扩展 `SwitchID - 多账号管理助手`
  - 扩展 ID:`eadjbapggginooenlbbpoebfjhklokni`
  - 版本:`1.0.0`(Manifest V3)
  - 源码位置:`%LOCALAPPDATA%\Microsoft\Edge\User Data\<Profile>\Extensions\eadjbapggginooenlbbpoebfjhklokni\1.0.0_0\`
- 审计日期:2026-08-23
- 审计范围:全部 12 个源文件,约 7500 行 / 370 KB(逐文件人工通读 + 模式扫描)

## 结论

**未发现后门或恶意行为。** 该插件代码未混淆、注释完整(中文),
不含任何网络请求、数据外传、远程代码加载或隐蔽收集行为。

## 详细发现

### 1. 网络请求:零

对全部 JS 文件扫描 `fetch`、`XMLHttpRequest`、`WebSocket`、`sendBeacon`、`navigator.sendBeacon`、`importScripts`:
**零命中**。全代码中唯一出现的 URL 字符串是 `http://www.w3.org`(SVG/XML 命名空间常量,无害)。

manifest 中也无任何远程资源引用(`content_security_policy` 未自定义,使用 MV3 默认策略)。

### 2. 动态代码执行:零

扫描 `eval`、`new Function`、`setTimeout(字符串)`、`document.write`、动态 `<script>` 注入:零命中。
唯一接近的是 `atob/btoa`,用于:
- 从 Cookie 值中解码用户名/邮箱(展示用)
- 凭证备忘字段的 Base64 混淆存储

均为本地数据处理,无风险。

### 3. 数据存储:全部本地

所有读写均针对 `chrome.storage.local`,键包括:
`profiles`(账号 Cookie 快照)、`settings`、`activeProfiles`、`activeFingerprints`、
`recentUsage`、`autoRotateConfig`、`healthWarnings`。

无 `chrome.storage.sync`(不会随账号云同步),无任何外部上报。

### 4. 权限使用逐项核对

声明的权限:`storage, cookies, activeTab, tabs, contextMenus, declarativeNetRequest, alarms, notifications, scripting, webNavigation` + `<all_urls>`:

| 权限 | 用途(已核实) | 合理性 |
|---|---|---|
| `cookies` + `<all_urls>` | 读取/写入任意网站的登录 Cookie(核心功能) | ✅ 此类工具必需 |
| `declarativeNetRequest` | UA 伪装(修改 User-Agent 请求头) | ✅ 已核实仅此用途 |
| `scripting` + `webNavigation` | 向页面注入指纹伪装脚本(MAIN world) | ✅ 已核实注入的是扩展自带指纹代码 |
| `tabs` | 切换后刷新/关闭同域名标签页 | ✅ |
| `alarms` | 健康检查(每日)、自动轮换 | ✅ |
| `notifications` | 健康提醒、轮换通知 | ✅ |
| `contextMenus` | 右键快速切换菜单 | ✅ |

注意:`declarativeNetRequest` 和 `scripting` + `<all_urls>` 理论上具备中间人能力
(改写任意请求头、向任意页面注入脚本),**当前代码没有滥用**,但这是此类插件的固有权限面。

### 5. 内容脚本行为

- `user-detector.js`:读取页面 DOM 识别当前登录用户名(用于自动命名),结果只回传给扩展自身
- `fingerprint.js` / `fingerprint-main.js`:实现指纹伪装(Canvas/WebGL/Audio/Navigator/Screen 等属性覆写),不发数据
- 指纹注入在页面 `document_idle` 或导航提交时进行,与描述功能一致

### 6. 其他观察

- 凭证备忘字段自称"加密存储",实际只是 Base64 编码(原代码注释也承认"不是真正的加密,只是混淆")——措辞夸大但无恶意
- 代理功能 UI 存在,但 manifest 缺 `proxy` 权限,`chrome.proxy` 为 undefined,该功能是死代码
- 更新源为 Edge 官方商店 `update_url`,代码带商店签名(`_metadata/verified_contents.json`),未被篡改

## 残余风险(为什么仍建议本地版)

1. **权限面大**:插件能读所有网站的 Cookie。当前版本无害,**但商店版会自动更新**——若作者后续版本加入恶意代码,已保存的全部账号 Cookie 可被静默外传,用户无从察觉。
2. **Cookie 明文存储**:任何能读本机扩展存储的软件/人都能拿到全部登录态。这是此类工具的固有问题,不是该插件特有。
3. 凭证备忘"加密"名不副实。

因此,重写一个可自主审计、可固定版本、不自动更新的本地版(本仓库)是合理的防御措施。

## 审计方法(可复现)

```bash
# 提取全部 URL
grep -rn -E "https?://[a-zA-Z0-9.-]+" src/ --include="*.js" -o | sort | uniq -c
# 网络原语与动态执行
grep -rn -E "\beval\b|new Function|WebSocket|sendBeacon|XMLHttpRequest|importScripts|fetch\(" src/ --include="*.js"
# 混淆特征
grep -rn -E "atob|btoa|String\.fromCharCode|fromCharCode|unescape\(" src/ --include="*.js"
# 非常规 Unicode(隐藏载荷)
grep -rnP "[^\x00-\x7F]" src/background.js | grep -v "//" | head
```

以上命令在原版源码上的输出均已在报告中体现。
