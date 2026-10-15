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