# 浏览器版和桌面版的区别

记录时间：2026-09-21。对比的是浏览器版主分支（提交 `1bc0f89`）和桌面版 0.9.3.0-d1。写这份记录时桌面版 0.9.3.0-d1 刚在本机构建好，随这个版本一起提交；在那之前桌面版主分支还是 0.9.2.3-d1。

| | 浏览器版 | 桌面版 |
|---|---|---|
| 仓库 | [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper) | [Bilibili-thread-ripper-desktop](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop) |
| 版本 | 0.9.3.0 | 0.9.3.0-d1 |
| 运行在哪里 | Chrome / Edge 扩展，以及油猴脚本，作用于 B 站网页 | 官方哔哩哔哩 Windows 客户端（Electron）里 |

每次同步共用文件、发新版本时，请顺手更新这个文件。

## 一句话

两边共用同一套下载内核（怎么拆分、怎么选节点、怎么重试）。不同的是“怎么接到播放器上”：浏览器版可以换掉 B 站的播放内核自己放视频，也可以只接管下载；桌面版只接管下载，播放一直由客户端自己负责。桌面版另外多出一整套安装、更新、卸载和守护程序，浏览器版没有这些。

## 共用的部分

桌面版 `shared/` 里的 5 个文件与浏览器版 `src/` 里的同名文件逐字相同，改动只在浏览器版做，桌面版原样复制：

| 文件 | 作用 |
|---|---|
| `range-core.js` | Range 解析与拆分、设置的规范化、哪些地址算 B 站的视频服务器 |
| `cdn-resolver.js` | CDN 节点列表、节点测速和轮换、停用节点和被拒绝的地址、自定义服务器 |
| `idm-downloader.js` | 多线程下载：子块分配、断点续传、备份副本、重试、线程名额 |
| `runtime-notices.js` | Debug 和错误提示的产生与分类 |
| `notification-view.js` | 提示气泡的显示 |

两边各有一份相同的测试守着这部分：浏览器版的 `dev/shared-core-test.js`、`dev/optimization-test.js`，对应桌面版的 `test/shared.test.cjs`（只有第二行注释不同）、`test/optimization.test.cjs`。

检查是否一致（在桌面版仓库里运行，两个仓库放在同一个文件夹下）：

```bash
for f in shared/*.js; do [ "$(git hash-object $f)" = "$(git -C ../Bilibili-thread-ripper rev-parse HEAD:src/$(basename $f))" ] && echo "same $f" || echo "DIFFERENT $f"; done
```

## 只有浏览器版有的

| 文件 | 作用 | 桌面版为什么没有 |
|---|---|---|
| `native-mse-player.js` | “全接管”模式的播放内核：自己建 MediaSource、读分段索引、管缓冲、拖动、换清晰度和编码，界面仍是 B 站的 | 桌面版不换客户端的播放内核 |
| `sidx.js` | 解析分段索引，全接管用 | 同上 |
| `page-hook.js` | 识别当前视频和分 P、读取 playinfo、接管的开始与结束、合集切换、清晰度和编码跟随、视频统计信息面板、地址过期前换新 | 这些由客户端自己处理，桌面版只需要知道“换视频了”和“客户端拿到了哪些地址” |
| `native-range-transport.js` | “兼容模式”：B 站自己的播放器继续放视频，只把它的媒体请求拿来多线程下载 | 桌面版的 `src/transport.js` 做的是同一件事，但各写各的，见下一节 |
| `settings-panel.js` | 页面里的设置面板、播放器齿轮菜单里的入口 | 桌面版的设置放在客户端的系统设置页里，另写了 `settings-view.js`、`player-settings.js` |
| `bridge.js`、`service-worker.js` | 扩展的隔离环境与页面之间传设置，设置存在 `chrome.storage.sync`，旧设置迁移，首次使用引导 | 桌面版没有扩展环境，设置存在客户端页面的 `localStorage` |
| `user_scripts/`、`scripts/build-userscript.ps1` | 油猴版 | 桌面版没有油猴版 |

因此下面这些功能只在浏览器版存在，桌面版“没有移植”不是遗漏：全接管 / 兼容模式开关，编码跟随 B 站的播放策略，“视频统计信息”里的 Player Type 和下载速度，单集循环、自动开播、连续拖进度条相关的修复，浏览器缓冲区满（QuotaExceededError）时的处理，下载地址过期前自动换新，`/list/`、稍后再看、收藏夹页面的支持，页面级诊断报告（`__biliThreadRipperDebug.report()`）。它们都依赖浏览器版自己的播放内核或页面接管代码；在客户端里，对应的事情由客户端的播放器完成。

## 只有桌面版有的

| 文件 | 作用 |
|---|---|
| `src/transport.js` | 接管客户端播放窗口里的 `fetch` 和 `XMLHttpRequest`，把带明确 Range 的媒体请求交给共用下载器 |
| `src/client.js` | 挂到客户端的播放器对象（`biliPlayer`、`nano.createPlayer`）上：拿到播放地址、发现换了视频、显示状态提示 |
| `src/settings.js` | 设置的保存（`localStorage`）、多窗口同步、旧设置迁移 |
| `src/settings-view.js`、`src/player-settings.js` | 系统设置页里的线程撕裂者区域；播放器“更多播放设置”里的 CDN 和线程数 |
| `src/updates.js`、`src/update-main.cjs` | 检查更新（读 `latest.json`）、确认后安装、卸载 |
| `src/bootstrap.cjs` | 写进客户端的入口：给客户端加一个普通的 preload，不改官方的更新缓存，不关安全检查 |
| `launcher/`（`BTR_Desktop.exe`、`BTR_Guard.exe`） | 安装、更新、卸载的独立窗口；监视程序在客户端被官方安装包覆盖后询问是否重新接入 |
| `install.ps1`、`force-update.ps1` | 一键安装和强制更新 |
| `latest.json`、`packages/` | 更新清单和安装包。客户端只比较版本字符串是否相同：不同就提示更新（清单里的版本更旧也会提示），相同就不提示（同一个版本号换了安装包，用户收不到）。清单要配上对应的 ZIP 和校验值；关掉自动检查的用户不会自动看到提示，安装前都要用户确认。所以推送 `latest.json` 基本等于给所有用户发更新 |

## 同一件事，两边各自的写法

浏览器版的兼容模式（`native-range-transport.js`）和桌面版（`src/transport.js`）都是“不换播放内核，只接管媒体下载”，但代码不共用，修一边不会自动修到另一边。有一个例外：浏览器版选了兼容模式后，如果等了大约 3 秒 B 站播放器的内部接口仍然用不了，会改用全接管的播放内核；桌面版没有这条路，接不上就保持客户端原样。

| | 浏览器版兼容模式 | 桌面版 |
|---|---|---|
| 什么时候接管请求 | 只有选了兼容模式、并且建立了这种播放器之后才装上拦截 | 在客户端的播放窗口里一直生效（设置里关掉加速时放行） |
| 依赖播放器的哪些内部接口 | `window.player.__core().getCorePlayer()` 和它的调度器，用来在换清晰度时重新打开调度（Safari 需要） | `biliPlayer` 的事件（`Player_PlayUrl_Done` 等）和 `getManifest()`，不碰调度器 |
| 换清晰度 | 有专门的保护逻辑 | 完全交给客户端 |
| 哪些请求会被接管 | 带明确 Range 的媒体 GET，地址必须对得上已经登记的音视频轨，并且通过对 B 站播放内核状态的检查；带登录信息的、带 Range 和 Accept 以外请求头的、同步 XHR 都放行 | 带明确 Range 的媒体 GET，单个请求不超过 64 MiB；不要求地址事先登记过，没登记的地址直接按请求地址建立节点记录；XHR 还要求是异步、`arraybuffer`、没有请求体 |
| 登记哪些音视频轨 | 视频、普通音频、杜比音频、FLAC | 只登记 playinfo 里 `dash.video` 和 `dash.audio`；杜比和 FLAC 的地址仍可能被接管，但走“没登记的地址”那条路，提示里按画面归类。这不影响客户端播放这些音频 |
| 给播放器报的下载进度 | 按已经完成、并且前后连得上的子块累计 | 按实时收到的字节计算：把各线程收到的区间合并去重，没下完的子块也算进度 |
| 一次加速失败 | 把这个请求按失败还给 B 站的加载器，由 B 站播放器自己重试和恢复；只有发现播放器的内部接口变了，才整体停止加速、交回原生播放 | 这一个请求由适配层按原样重发给客户端原本要访问的地址；连续 6 次失败后，这个播放窗口暂停加速 |
| 节点记录怎么建 | 按带签名的地址建立（路径加签名），最多 64 份 | 按完整的带签名地址建立，最多 64 份，换视频时清空 |
| 换了签名地址之后 | 和桌面版一样重新测速。全接管模式不同：一个播放会话固定一份节点记录，换签名时只更新地址，测速保留 | 新地址新建节点记录，测速从头开始 |
| 怎么调用下载器 | 每个请求都按“首段”的方式下载：先发 64 KiB 让各节点竞速，其余部分再拆块交给已经验证过的节点 | 只有从 0 字节开始的请求，以及这个播放窗口里成功完成的加速请求还不到两个时发起的请求这样做（同时发起的可能不止两个；这个计数按播放窗口算，换视频不清零），其余按普通分段下载；不超过 64 KiB 的请求整块竞速，不拆分 |
| 64 到 128 KiB 的小请求 | 和别的请求一样 | 大于 64 KiB、小于 128 KiB（两头都不含）且不属于上一行“首段”方式的请求，限制为一个子块，由适配层轮流指定首选节点（0.9.3.0-d1 加入），否则客户端取声音的一连串小请求会全排在最快的那个节点上 |
| 请求结尾超过文件长度 | 没有这一步 | 记住文件总长，把请求的结尾收回到文件末尾 |

## 设置

两边的设置项都由共用的 `range-core.js` 规范化，默认值相同：大陆 CDN、8 线程、不显示红色错误提示；都支持自定义 CDN（最多 32 个，只接受 B 站自己的视频服务器）。区别：

| | 浏览器版 | 桌面版 |
|---|---|---|
| 存在哪里 | 扩展存在 `chrome.storage.sync`；油猴版存在 B 站页面的 `localStorage` | 客户端页面的 `localStorage`，键 `BTR_Desktop.settings.v1` |
| 多出来的设置 | 全接管 / 兼容模式 | 自动检查 BTR 更新 |
| 设置入口 | 点扩展图标或播放器齿轮菜单，打开页面里的设置面板 | 客户端系统设置的第一项，播放器“更多播放设置”里也有 CDN 和线程数 |

## 版本和发版

| | 浏览器版 | 桌面版 |
|---|---|---|
| 版本号 | `0.9.3.0` | `0.9.3.0-d1`：浏览器版的版本号加 `-d` 和适配层的序号；换到新的浏览器版本时从 d1 重新数 |
| 版本写在哪里 | `manifest.json`，以及各源码文件和测试页里的版本字符串 | `desktop.json`（`version` 必须等于 `baseVersion` 加 `-d` 加 `adapterRevision`）、`package.json`、`README.md`、`docs/update-interface.md`、`src/settings.js` |
| 更新记录 | `updates.md` | `docs/verification.md`（每个版本写清楚移植了什么、没移植什么和原因、测试结果、本机安装记录） |
| 打包 | `scripts/build.ps1` 生成扩展 ZIP、源码 ZIP 和 CRX；`scripts/build-userscript.ps1` 生成油猴脚本 | `npm run release` 生成 `dist/`、两个 EXE、`packages/BTR_Desktop-<版本>.zip` 和 `latest.json` |
| 用户怎么收到更新 | 油猴按生成脚本里的 `@version` 和 `@updateURL` 检查更新，`manifest.json` 只是构建时提供版本号，所以改了版本还要重新生成油猴脚本一起提交；扩展是“加载已解压的扩展程序”，用户自己下载新的 ZIP 替换 | 客户端里自动或手动检查更新，读主分支的 `latest.json`；也可以重新运行安装命令 |

## 测试

| | 浏览器版（`dev/`） | 桌面版（`test/`） |
|---|---|---|
| 共用下载内核 | `shared-core-test.js` 10 项、`optimization-test.js` 13 项 | 同样的两个文件，`shared.test.cjs`、`optimization.test.cjs` |
| 接到播放器上的那一层 | 浏览器回归 15 个测试页（`regression-smoke-test.js`），包括缓冲区配额和地址刷新；油猴和提示气泡的测试 | `transport.test.cjs` 6 项（不需要浏览器，节点的快慢、停传、不回应由测试决定）；`browser.cjs` 16 项（真实浏览器里跑打包好的 `dist/desktop.js`） |
| 真实 B 站媒体 | `native-mse-end-test.js`（需要 `BTR_TEST_BVID`、`BTR_TEST_CID`） | 没有，由维护者在真实客户端里测 |
| 模拟网络基准 | `download-benchmark.js`，按浏览器版播放器取分段的方式 | 没有，客户端的请求方式不同 |
| 安装、更新、卸载、监视程序 | 没有 | `installer`、`update-main`、`force-update`、`guard`、`progress`、`package` 各测试 |

## 同步共用文件时要做的事

1. 把浏览器版改过的共用文件原样复制到 `shared/`，用上面的命令确认 5 个文件逐字相同；同步 `test/shared.test.cjs` 和 `test/optimization.test.cjs`。
2. 重新读一遍 `src/transport.js` 调用下载器的地方。客户端发请求的方式和浏览器版的播放器不一样：很多请求很小、只有一个子块，节点记录按带签名的地址建立，请求经常被取消。浏览器版的测试和基准覆盖不到这些。0.9.3.0 的下载内核原样搬过来时，小请求就全挤到了一个节点上，是靠 `test/transport.test.cjs` 这类测试发现并在适配层修掉的，共用文件没有为桌面版改动。
3. 改版本号，写 `docs/verification.md`，运行 `npm run release`、`npm test` 和 `node test/browser.cjs`。
4. 先只装到本机，在真实客户端里测过，再提交推送。
