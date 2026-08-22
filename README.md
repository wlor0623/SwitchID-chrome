# SwitchID Local - 多账号管理助手(纯本地版)

基于对 Edge 商店插件 `SwitchID - 多账号管理助手`(ID: `eadjbapggginooenlbbpoebfjhklokni`)的
源码审计与逆向重写。功能对等,代码全部重写、结构更精简,**可自行审计每一行代码**。

## 核心特性

- **账号保存/切换**:登录网站后一键把 Cookie 快照存为命名档案;切换 = 清空该域名 Cookie + 写入目标档案 + 自动刷新相关标签页
- **一键清空本站数据**:Cookie + Cache + Cache Storage + IndexedDB + localStorage + Service Workers(+ WebSQL/文件系统,若浏览器仍支持)按主域名连子域名一起彻底重置,方便登录下一个账号
- **重复检测**:保存时通过身份特征 Cookie 判断当前登录是否已保存过,避免重复建档
- **指纹防关联**:每个网站独立且稳定的随机指纹(Canvas/WebGL 显卡/音频/屏幕/Navigator/时区/DOMRect/WebRTC),降低多账号关联风险
- **独立 UA**:全局或按账号配置 User-Agent(declarativeNetRequest 请求头改写)
- **自动轮换**:2 个以上账号按设定间隔自动轮流切换
- **健康检查**:每日检查 Cookie 过期情况并提醒,支持自动刷新快过期账号
- **账号管理**:颜色标识、备注、标签、凭证备忘(Base64 混淆)、分组排序搜索、批量删除
- **导入/导出**:JSON 备份与恢复;兼容原版导出的数据格式
- 右键菜单快速切换、弹窗内按 `1-9` 数字键快速切换、快捷键 `Alt+Shift+S` 打开面板

## 隐私承诺

- **零网络请求**:代码中不存在 `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon`,不加载任何远程资源
- **零数据上传**:所有数据仅存于 `chrome.storage.local`
- **无远程代码**:无 `eval` / `new Function` / 动态脚本注入
- 指纹脚本由扩展自带代码注入页面(这是指纹防护的唯一手段),不做任何外传

验证方式:`grep -rn "fetch\|XMLHttpRequest\|WebSocket\|sendBeacon\|eval(" src/`

## 安装(Edge / Chrome 均可)

1. 打开 `edge://extensions/`(Chrome 为 `chrome://extensions/`)
2. 打开右上角「开发人员模式」/「开发者模式」
3. 点击「加载解压缩的扩展」,选择本仓库目录(含 manifest.json 的目录)
4. 建议同时**卸载商店版原插件**,避免两个插件同时操作 Cookie 互相干扰

## 目录结构

```
├── manifest.json            # 扩展清单
├── SECURITY-AUDIT.md        # 对原插件的完整安全审计报告
├── icons/                   # 图标
└── src/
    ├── background.js        # 核心逻辑:Cookie 引擎/档案管理/指纹注入/UA/轮换/健康检查
    ├── content/
    │   └── page-agent.js    # 内容脚本:页面用户名检测 + 清除 localStorage
    ├── popup/               # 工具栏弹窗(账号列表/切换/编辑/导入导出)
    └── options/             # 设置页(偏好/指纹/白名单/数据管理)
```

## 与原版的差异

| 项目 | 原版 | 本版本 |
|---|---|---|
| 网络请求 | 无(审计确认) | 无(结构上保证) |
| 多语言 | 5 种语言 | 仅简体中文(减少代码量便于审计) |
| 代理功能 | UI 存在但 manifest 缺 `proxy` 权限,实际不生效(死代码) | 移除 |
| 指纹细项 | 含 WebGPU/字体枚举噪声(默认关) | 移除(默认关闭的弱防护项,收益极低) |
| 数据格式 | `profiles` 等存储结构 | 完全兼容,可直接导入原版备份 |

## 数据存储说明

- 账号 Cookie 明文保存在 `chrome.storage.local`(这是此类工具的固有属性:需要能还原登录态)
- 凭证备忘字段仅做 Base64 混淆,**不是加密**,请只记录提示性信息
- 导出的备份文件包含完整登录凭证,务必妥善保管

## 免责声明

仅用于管理自己的多个账号。请遵守目标网站的服务条款;因使用本工具导致的账号限制等后果由使用者自行承担。
