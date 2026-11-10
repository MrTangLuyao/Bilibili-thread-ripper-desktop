# 浏览器版和桌面版的区别

记录时间：2026-11-11。对比的是浏览器版 2026.11.10.1（提交 `129dac7`）和桌面版 2026.11.10.1-d1。

| | 浏览器版 | 桌面版 |
|---|---|---|
| 仓库 | [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper) | [Bilibili-thread-ripper-desktop](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop) |
| 版本 | 2026.11.10.1 | 2026.11.10.1-d1 |
| 运行在哪里 | 油猴脚本（Tampermonkey 等），作用于 B 站网页；2026.9.27.1 起不再发布 Chrome / Edge 扩展 | 官方哔哩哔哩 Windows 客户端（Electron）里 |

两边共用同一套下载内核（怎么拆分、怎么选节点、怎么重试），也共用“兼容模式”的代码（`native-range-transport.js`）。不同的是“怎么接到播放器上”：浏览器版可以换掉 B 站的播放内核自己放视频（全接管），也可以用兼容模式只接管下载；桌面版只有兼容模式，播放一直由客户端自己负责。桌面版另外多出一整套安装、更新、卸载和守护程序，浏览器版没有这些。

2026.11.10.1-d1 起，桌面版不再有自己的一套下载接管（原来的 `src/transport.js`）。现在接到客户端播放器上的是 `src/page-hook.js`，名字和作用都对应浏览器版的 `page-hook.js`：找到客户端的播放器，把浏览器版的兼容模式原样装上去。兼容模式接不上的视频，由客户端自己下载。

## 共用的部分

桌面版 `shared/` 里的 7 个文件与浏览器版 `src/` 里的同名文件逐字相同，改动只在浏览器版做，桌面版原样复制：

| 文件 | 作用 |
|---|---|
| `range-core.js` | Range 解析与拆分、设置的规范化（包括直播加速、自动线程数这两个开关，网页版悬浮按钮的开关和位置，以及网页版设置面板的主题，2026.10.7.2 加入，桌面版不用；网页版的剧集加速开关，2026.10.8.1 加入，桌面版不用；直播加速的开关从 2026.10.8.1 起默认关闭，桌面版不读这个开关）、哪些地址算 B 站的视频服务器 |
| `cdn-resolver.js` | CDN 节点列表、节点测速和轮换、停用节点和被拒绝的地址、自定义服务器；大陆节点加上 `upos-sz-mirrorcoso1`（2026.10.17.1，#44）；P2P 和边缘缓存的中继地址（mcdn、mountaintoys）只在中继节点上用，不再搬到普通节点上，一条音轨或画面只有中继地址时直接用它们（2026.10.17.1，#47，客户端拿到的地址同样适用） |
| `idm-downloader.js` | 多线程下载：子块分配、断点续传、备份副本、重试、线程名额；自动线程数的调节器（设置里打开时才起作用）；按播放截止时间决定何时开备份副本的规则（0.9.4.2，只在调用方传了截止时间时生效，客户端不传）；自动线程数每次开播先用 16 条、前方缓冲到 15 秒再逐档降回（2026.9.29.1，客户端开播、拖动、换视频时也会触发）；自动线程数最多加到 64 条，以前是 32（2026.10.7.1） |
| `native-range-transport.js` | 兼容模式：播放器继续放视频，只把它的媒体请求拿来多线程下载；地址必须对得上这个视频登记过的音视频轨；一段下载失败就按失败还给播放器，由播放器自己重试 |
| `runtime-notices.js` | 记录 `<video>` 元素的播放事件，给诊断信息用（2026.11.10.1 起只剩这个作用，屏幕上的提示和 Debug 开关都删了） |
| `diagnostic-report.js` | 把诊断信息排成英文文本（2026.11.10.1） |
| `settings-panel.js` | 设置面板和悬浮球，桌面版由 `src/panel-bridge.js` 接上 |

两边各有一份相同的测试守着这部分：浏览器版的 `dev/shared-core-test.js`、`dev/optimization-test.js`、`dev/auto-concurrency-test.js`，对应桌面版的 `test/shared.test.cjs`（只有第二行注释不同）、`test/optimization.test.cjs`、`test/auto-concurrency.test.cjs`。例外（0.9.4.0-d1）：桌面版的 `test/auto-concurrency.test.cjs` 最后一项的计时改得更稳，浏览器版这一处还没同步。

检查是否一致（在桌面版仓库里运行，两个仓库放在同一个文件夹下）：

```bash
for f in shared/*.js; do [ "$(git hash-object $f)" = "$(git -C ../Bilibili-thread-ripper rev-parse HEAD:src/$(basename $f))" ] && echo "same $f" || echo "DIFFERENT $f"; done
```

## 只有浏览器版有的

| 文件 | 作用 | 桌面版为什么没有 |
|---|---|---|
| `native-mse-player.js` | “全接管”模式的播放内核：自己建 MediaSource、读分段索引、管缓冲、拖动、换清晰度和编码，界面仍是 B 站的 | 桌面版不换客户端的播放内核 |
| `sidx.js` | 解析分段索引，全接管用 | 同上 |
| `page-hook.js` | 识别当前视频和分 P、读取 playinfo、接管的开始与结束、合集切换、清晰度和编码跟随、视频统计信息面板、地址过期前换新 | 这些由客户端自己处理。桌面版有自己的 `src/page-hook.js`，只做兼容模式用得到的那部分，见下一节 |
| `bilibili-site.js` | 阻止使用国际版 | 客户端没有国际版网页 |
| `bridge.js`（设置面板在桌面版由 `src/panel-bridge.js` 接上） | 在页面里的各个模块和设置之间传设置 | 桌面版设置存在客户端的 `localStorage`，由 `src/settings.js` 负责 |
| `bridge.js`、`user_scripts/adapter/storage-shim.js` | 在页面里的各个模块和设置之间传设置；设置存在脚本管理器里，所有 B 站子域共用一份；存储为空的脚本管理器从默认设置开始，不导入 `localStorage` 里的副本（2026.10.7.2，以前会导入） | 桌面版的设置存在客户端页面的 `localStorage` |
| `user_scripts/`、`scripts/build.mjs`、`scripts/release.mjs` | 油猴脚本本身、它的适配层、打包和发版 | 桌面版有自己的打包和发版工具 |
| `live-core.js`、`live-hook.js` | 直播加速（live.bilibili.com）：屏蔽直播 P2P、直播分片多节点竞速下载、提前缓存播放列表里的分片 | 桌面版只接管客户端的点播播放窗口，不碰客户端的直播 |

因此下面这些功能只在浏览器版存在，桌面版“没有移植”不是遗漏：全接管（桌面版的设置面板里“接管方式”是灰色的，固定为兼容模式），编码跟随 B 站的播放策略，“视频统计信息”里的 Player Type 和下载速度，单集循环、自动开播、连续拖进度条相关的修复，拖动进度条在当前播放会话内完成、挡住 B 站播放内核的回跳（0.9.4.0），接管期间停住 B 站内核的下载调度器、屏蔽它的残留报错（0.9.4.0），杜比 / Hi-Res 音轨的接管（0.9.4.0），接管前等 B 站把缓冲区建好、音轨跟随播放器里 Hi-Res / 杜比全景声的选择（0.9.4.3），浏览器缓冲区满（QuotaExceededError）时的处理，下载地址过期前自动换新，`/list/`、稍后再看、收藏夹页面的支持，在所有 bilibili.com 页面打开设置面板（0.9.4.0），剧集加速的开关和剧集页只用兼容模式（2026.10.8.1），全接管下前方缓冲快用完时先暂停、等画面和声音都备好再一起继续（2026.10.19.1，#48），直播加速（0.9.4.0），阻止使用国际版。它们都依赖浏览器版自己的播放内核或页面接管代码；在客户端里，对应的事情由客户端的播放器完成。

## 只有桌面版有的

| 文件 | 作用 |
|---|---|
| `src/page-hook.js` | 对应浏览器版的 `page-hook.js`：挂到客户端的播放器对象（`biliPlayer`、`nano.createPlayer`）上，拿到播放地址、发现换了视频，把兼容模式装到播放器上；在客户端的 `<video>` 元素上接自动线程数的卡顿和缓冲信号；给设置面板的“运行状态”和“复制诊断信息”提供数据 |
| `src/settings.js` | 设置的保存（`localStorage`）、多窗口同步、旧设置迁移；接管方式固定为兼容模式 |
| `src/panel-bridge.js`、`src/player-settings.js`、`src/settings-view.js` | 把共用的设置面板和悬浮球接到桌面版的设置上：“接管方式”显示为灰色，固定为兼容模式，下面写着“桌面版仅支持兼容模式。”；隐藏客户端用不到的项（缓冲、加速范围、网页版本），加上“更新”一栏；播放器“更多播放设置”里的 CDN 和线程数（含“自动”）；客户端系统设置里的“线程撕裂者”一栏（悬浮窗开关、打开 BTR 设置、更新和卸载） |
| `src/updates.js`、`src/update-main.cjs` | 检查更新（读 `latest.json`）、确认后安装、卸载 |
| `src/bootstrap.cjs` | 写进客户端的入口：给客户端加一个普通的 preload，不改官方的更新缓存，不关安全检查 |
| `launcher/`（`BTR_Desktop.exe`、`BTR_Guard.exe`） | 安装、更新、卸载的独立窗口；监视程序在客户端被官方安装包覆盖后询问是否重新接入。`-silence` 参数让更新、卸载、重新接入不显示窗口（开发和测试用，0.9.4.0-d1 加入）；2026.10.7.2-d1 起普通权限和管理员身份都能运行 |
| `install.ps1`、`force-update.ps1` | 一键安装和强制更新 |
| `latest.json`、`packages/` | 更新清单和安装包。客户端只比较版本字符串是否相同：不同就提示更新（清单里的版本更旧也会提示），相同就不提示（同一个版本号换了安装包，用户收不到）。清单要配上对应的 ZIP 和校验值；关掉自动检查的用户不会自动看到提示，安装前都要用户确认。所以推送 `latest.json` 基本等于给所有用户发更新 |

## 兼容模式在两边的接法

兼容模式的代码（`native-range-transport.js`）两边逐字相同，修一边就是修两边。不同的只是各自的 `page-hook.js` 怎么把它接到播放器上：

| | 浏览器版 `src/page-hook.js` | 桌面版 `src/page-hook.js` |
|---|---|---|
| 认出当前视频 | 按网址和页面数据识别视频和分 P，自己请求 playinfo | 读客户端播放器的 `getManifest()`，地址来自它的 `Player_PlayUrl_Done` 事件 |
| `window.player` | B 站网页自带 | 指到客户端的 `biliPlayer` |
| 播放内核还没准备好 | 最多等约 3 秒，等不到时普通视频改用全接管 | 一直等，等到之前由客户端自己下载 |
| 兼容模式放弃这个视频（播放器的内部接口对不上） | 交回 B 站自己的播放器 | 交回客户端自己下载，换视频后再试 |
| 自动线程数的卡顿和缓冲信号 | 兼容模式下没有，只有全接管有 | 来自客户端的 `<video>` 元素 |
| 一段下载失败 | 按失败还给播放器，由播放器自己重试 | 按失败还给播放器，由播放器自己重试 |

原来桌面版自己那套接管（`src/transport.js`，2026.11.10.1-d1 删除）为客户端的请求方式专门调过两处：只有开头的几个请求按“首段”方式竞速；64 到 128 KiB 的小请求轮流指定首选节点，免得客户端取声音的一连串小请求挤在最快的那个节点上。现在两边用同一份兼容模式代码，这两处不再单独保留：哪些请求按“首段”下载由兼容模式自己判断（每条音视频轨的第一段、拖动后的第一段），其余按普通分段下载。

## 设置

两边的设置项都由共用的 `range-core.js` 规范化：默认大陆 CDN、自动线程数（平时从 8 条起步，每次开播先用 16 条、缓冲够了再降回；播放卡顿或缓冲跟不上时逐档加到最多 64 条，没有变快或服务器限流就退回；关掉后用手动选的线程数，默认 8）；都支持自定义 CDN（最多 32 个，只接受 B 站自己的视频服务器）。自动线程数的调节器在共用的 `idm-downloader.js` 里，卡顿和缓冲信号两边各自接：浏览器版来自它自己的播放内核，桌面版来自客户端播放器的 `<video>` 元素（`src/page-hook.js`）。区别：

| | 浏览器版 | 桌面版 |
|---|---|---|
| 存在哪里 | 脚本管理器的存储，所有 B 站子域共用；脚本管理器的存储用不了时，退回 B 站页面的 `localStorage` | 客户端页面的 `localStorage`，键 `BTR_Desktop.settings.v1` |
| 多出来的设置 | 全接管 / 兼容模式，剧集加速（2026.10.8.1，默认打开），直播加速（实验性，2026.10.8.1 起默认关闭） | 自动检查 BTR 更新；直播只有一个灰色、不能勾选的“直播加速（敬请期待）”开关，写着“直播加速已可在网页版中使用” |
| 设置入口 | 在任意 bilibili.com 页面点悬浮按钮或油猴菜单里的“线程撕裂者设置”，或播放器齿轮菜单，打开页面里的设置面板 | 客户端系统设置的第一项，播放器“更多播放设置”里也有 CDN 和线程数 |

## 版本和发版

| | 浏览器版 | 桌面版 |
|---|---|---|
| 版本号 | `2026.9.29.1`：发布日期加当天第几次发布（`年.月.日.N`，墨尔本时间）；0.9.4.3 及以前是 `主版本.次版本.修订号.构建号` | `2026.9.29.1-d1`：浏览器版的版本号加 `-d` 和适配层的序号；换到新的浏览器版本时从 d1 重新数 |
| 版本写在哪里 | 源码里只有占位符 `__BTR_VERSION__`，版本号来自 git tag，发版时由 `scripts/release.mjs` 算出并写进生成的油猴脚本 | `desktop.json`（`version` 必须等于 `baseVersion` 加 `-d` 加 `adapterRevision`）、`package.json`、`README.md`、`docs/update-interface.md`、`src/settings.js` |
| 更新记录 | `CHANGELOG.md`：改动先写在 `[Unreleased]` 下面，发版时变成这个版本的条目 | `docs/verification.md`（每个版本写清楚移植了什么、没移植什么和原因、测试结果、本机安装记录） |
| 打包 | `node scripts/build.mjs` 生成开发版到 `dist/`；`node scripts/release.mjs` 算版本号、改 CHANGELOG、生成 `user_scripts/bilibili-thread-ripper.user.js`、跑测试、提交并打 tag，推送由人来做 | `npm run release` 生成 `dist/`、两个 EXE、`packages/BTR_Desktop-<版本>.zip` 和 `latest.json` |
| 用户怎么收到更新 | 脚本管理器按油猴脚本里的 `@version` 和 `@updateURL` 检查更新；平时的提交不改这个文件，只有发版提交会改 | 客户端里自动或手动检查更新，读主分支的 `latest.json`；也可以重新运行安装命令 |

## 测试

| | 浏览器版（`dev/`） | 桌面版（`test/`） |
|---|---|---|
| 共用下载内核 | `shared-core-test.js` 12 项、`optimization-test.js` 28 项、`auto-concurrency-test.js` 15 项 | 同样的三个文件，`shared.test.cjs`、`optimization.test.cjs`、`auto-concurrency.test.cjs` |
| 接到播放器上的那一层 | 浏览器回归 17 个测试页（`regression-smoke-test.js`），包括缓冲区配额、地址刷新、会话内跳转和直播模块；直播和点播选轨的单元测试；油猴脚本的测试 | `browser.cjs` 19 项（真实浏览器里跑打包好的 `dist/desktop.js`，含兼容模式接上客户端播放器、番剧的地址、节点停用、自定义服务器、自动线程数的信号和复制诊断信息） |
| 真实 B 站媒体 | `native-mse-end-test.js`（需要 `BTR_TEST_BVID`、`BTR_TEST_CID`） | 没有，由维护者在真实客户端里测 |
| 模拟网络基准 | `download-benchmark.js`，按浏览器版播放器取分段的方式 | 没有，客户端的请求方式不同 |
| 安装、更新、卸载、监视程序 | 没有 | `installer`、`update-main`、`force-update`、`guard`、`progress`、`package` 各测试；维护操作默认带 `-silence` 运行，`BTR_TEST_WINDOWS=1` 时带窗口 |

## 同步共用文件时要做的事

1. 把浏览器版改过的共用文件原样复制到 `shared/`，用上面的命令确认 7 个文件逐字相同；同步 `test/shared.test.cjs`、`test/optimization.test.cjs` 和 `test/auto-concurrency.test.cjs`。
2. 对照浏览器版 `src/page-hook.js` 里建立兼容模式播放器的那段（`createNativePlayer` 的参数、`onState`、`report()` 的字段），看桌面版的 `src/page-hook.js` 要不要跟着改。诊断信息的格式由共用的 `diagnostic-report.js` 决定，`report()` 少了哪个字段，诊断信息里对应的那一项就显示 n/a。
3. 改版本号，写 `docs/verification.md`，运行 `npm run release`、`npm test` 和 `node test/browser.cjs`。
4. 先只装到本机，在真实客户端里测过，再提交推送。
