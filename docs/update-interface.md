# 版本和更新文件

对外完整版本是 `主版本-d桌面修订`，例如 `0.9.1.1-d1`、`0.9.1.1-d2`。主版本升级后从 `d1` 开始，例如 `0.9.1.2-d1`。下文单独写的 d1 到 d5 都是 0.9.1.1 的桌面修订，“d5 起”包括之后的所有版本。`desktop.json` 的 `baseVersion` 与 `adapterRevision` 是构建检查依据，`version` 必须等于两者拼接的完整版本。

`latest.json` 是客户端和一键安装命令唯一读取的更新入口，固定在本仓库 main 分支。不使用 GitHub Release，也不需要额外服务器或密钥。

```json
{
  "schema": 1,
  "version": "0.9.1.5-d1",
  "downloadUrl": "https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/packages/BTR_Desktop-0.9.1.5-d1.zip",
  "sha256": "构建时自动生成的64位SHA-256",
  "supportedClientVersions": ["1.18.0"]
}
```

`supportedClientVersions` 只给 d1 到 d4 的旧更新器使用：它们要求这个列表存在且包含本机客户端版本，才肯升级。d5 不再读取它，内容来自 `desktop.json` 的 `legacyClientVersions`。以后也要保留这一项，否则还在用旧版的人无法从客户端内升级，只能运行一键安装命令。

完整版本号相同就是最新版，不同就是有更新，包括仓库主动回退版本的情况。默认在启动后检查一次，随后每 30 分钟检查，由主进程统一调度，多窗口不重复弹出。发现更新直接弹原生确认窗口，取消后等下次检查。设置中的“自动检查 BTR 更新”关闭后停止自动请求，手动检查仍可使用。进入设置本身不再另发自动检查。

确认后启动独立的 BTR 更新窗口，立即关闭指定客户端，然后读取清单、下载、校验、解压、安装、检查结果并重启。下载显示已接收字节和服务端提供的总字节数；没有总大小时显示活动进度条，其他阶段不伪造下载百分比。确认时锁定版本与包哈希，仓库在下载前变化会要求重新检查，不悄悄安装另一个版本。

主进程校验本地维护脚本和启动器的 SHA-256。更新窗口通过非 detached 的隐藏 PowerShell 子进程执行安装，读取 stdout 阶段消息和 stderr，将结果写入 `%LOCALAPPDATA%\BTR_Desktop\logs`。只有安装验证和重启成功才关闭进度窗口；失败停留显示错误。原始备份保留，账号和缓存不清理。

## 维护窗口为什么不会跟着客户端消失

Electron 里的 Node 会把非 detached 子进程放进一个 Windows 作业对象，客户端一退出，系统就结束作业里的所有进程。d3 和 d4 的更新、卸载窗口正是这样被启动的，所以脚本一关闭客户端，窗口就被系统一起结束，日志停在 closing。子进程再启动的程序会自动离开这个作业，因此 d4 的后台 PowerShell 仍然装完了更新，只是窗口没了；d3 的卸载直接由客户端启动 PowerShell，会被一起结束，所以卸载没有效果。

d5 起，`BTR_Desktop.exe update|uninstall|reconnect` 先作为客户端的子进程启动，再由它启动带 `--window` 的第二个自己，第二个才显示窗口并运行 PowerShell。第一个进程等待第二个结束并返回同样的退出码，所以没有关闭客户端的失败（例如备份校验失败）仍会通知设置页面。回归测试用一个模拟客户端创建与 Electron 相同标志的作业对象，再让维护脚本真的把它关掉，检查窗口仍然记录到完成。

旧版 d1/d2 使用 detached 标志启动 PowerShell，在已复现的 Windows 环境中会返回 0 却不执行命令。旧版没有执行到安装脚本时无法靠发布新 ZIP 自行修复，需重新运行最新的一键安装命令。首次安装的一键命令仍在下载校验完成后再关闭客户端；从客户端内点击更新才使用先关闭客户端的独立进度窗口。

`force-update.ps1` 与 `install.ps1` 放在仓库和安装包的同一级目录，用于客户端内更新异常时恢复。它不调用旧更新器，每次从固定官方仓库重新读取安装脚本，即使版本相同也重新安装，不跳过包哈希、客户端结构检查和原始备份检查。支持 `-ClientPath` 指定客户端和 `-NoLaunch` 安装后不启动；不修改执行策略，不接受自定义下载地址。

## 找客户端

没传 `-ClientPath` 时，`install.ps1` 按顺序找同时有 `哔哩哔哩.exe` 和 `resources\app.asar` 的文件夹：`Program Files\bilibili`，`current.json` 里上次安装记下的客户端，`%LOCALAPPDATA%\Programs\bilibili`，`Program Files (x86)\bilibili`，最后是名字含 bilibili 或哔哩哔哩的卸载注册表项。官方安装程序不写 `InstallLocation`，所以也用 `DisplayIcon` 和 `UninstallString` 所在的文件夹。

都找不到时（0.9.1.2-d2 起），脚本在 PowerShell 里请用户输入安装文件夹，可以粘贴路径，也可以把 `哔哩哔哩.exe` 拖进窗口，带不带引号、结尾有没有反斜杠都行。输错会再问，直接回车就取消，什么都不改。这一步在拿维护锁之前，用户慢慢输入不会让后台监视程序一直等。客户端里的更新、卸载和重新接入窗口总是传 `-ClientPath`，不会停下来问；传了 `-ClientPath` 但不对，或者 PowerShell 没法输入时，照旧报 `Bilibili client not found`。

安装脚本内的中文提示写成 `\u` 转义，文件保持纯 ASCII，Windows PowerShell 5.1 直接运行本地文件时不会按 GBK 读错。`BTR_Desktop.exe` 不带 `--client` 时，使用 `current.json` 里属于这个安装目录的客户端，没有记录才用 `Program Files\bilibili`，所以装在别处的客户端也能直接在安装文件夹运行 `BTR_Desktop.exe remove`。

下载仅允许本仓库的 HTTPS raw 地址，拒绝跳转和任意外部地址。清单限制 64 KiB，安装包限制 16 MiB，解压后限制 24 MiB。校验包 SHA-256、版本和内部播放器脚本哈希，拒绝越界解压路径。SHA-256 用于检测损坏和文件不一致，不是独立签名；更新信任 GitHub HTTPS 和仓库维护者，因此不要执行陌生人提供的同名安装命令。

更新不依赖配置迁移。不主动清理 Bilibili 账号或官方客户端数据，现有 BTR 设置能继续读取时会保留，但更新不承诺迁移任何旧格式。

d2 起不再创建 BTR 桌面快捷方式，安装后正常启动官方客户端即可。安装和卸载时仅清理属于该客户端的旧 BTR 快捷方式，不改其他快捷方式。

## 客户端版本和官方更新

官方客户端有两种更新方式：

1. 平时的自动更新（客户端日志里的 Patch info 和 Use main cache）：新程序放在 `%APPDATA%\bilibili\resource\<哈希>.asar`，带官方完整性校验，改动它会让客户端报 `Start error, code: 012`。`Program Files\bilibili\resources\app.asar` 作为入口不变，每次启动先运行它再转去缓存里的程序。BTR 只在这个入口前面加一行，所以这种更新不会去掉 BTR。
2. 重新下载官方安装包覆盖安装：会整份替换 `app.asar`，BTR 一定被覆盖，需要重新写入。

d4 之前 BTR 只认 1.18.0，发现缓存版本号不同就主动不加载。d5 起不看版本号，只检查程序结构：`package.json` 的 `name` 是 `bilibili`，`main`（默认 `index.js`）指向档案内的普通 JavaScript 文件。认不出来就不改官方文件。写入的前缀是：

```js
try{require("./btr-desktop/bootstrap.cjs")}catch(error){console.error("BTR bootstrap:",error&&error.message)}
```

BTR 出错只记录错误，官方程序照常启动。入口开头的 BOM 和 `"use strict"` 保持在最前面。页面脚本仍只在 `https://bilipc.bilibili.com` 的 `index.html`、`player.html` 顶层窗口注入，设置界面找不到对应元素就不挂载。同一个播放窗口里加速连续失败 6 次，这个窗口就暂停加速，之后的请求直接交给客户端，重新打开播放窗口会再次尝试。

d4 的入口前缀没有 try/catch，d5 检查时会视为需要修复，并从原始备份重新生成补丁。

## 默认设置和 CDN 停用

从 0.9.1.2 起，默认是大陆 CDN、8 线程，“显示错误”默认关闭。设置保存在 `localStorage` 的 `BTR_Desktop.settings.v1`，其中 `revision` 为 2。读到没有 `revision` 或旧 `revision` 的设置时，只把 CDN、线程数和显示错误改成新的默认值并写回一次，Debug、分类筛选、自动检查更新等其余设置保留。没有保存过设置的新安装直接使用默认值。

共用的 `cdn-resolver.js` 提供 `createBanList`。下载器每次失败都把这次实际收到的字节数交给它：被取消的请求不算；收到过数据后才中断的不算；同一个节点累计两次一个字节都没收到，就停用这个节点。桌面版每个视频（BV 号加 CID）一份记录，切换视频时清空；浏览器版按页面路由保存，同一视频重新接管也不会清空。停用后，选节点、补块和起播候选都跳过它，已经排队等待的子块在下一次尝试前也会跳过。所有候选都被停用时仍使用原来的节点，避免整个视频没有下载地址。停用时显示一条红色的“已停用这个 CDN 节点”；每次子块失败显示“这一小段没能下载下来”，包含已收到的 KiB 和节点，两者都受“显示错误”控制。桌面版的状态快照 `__BTR_DESKTOP__.getStatus().transport.bannedHosts` 列出当前视频停用的节点。

## 后台监视和重新接入

安装成功后启动 `BTR_Guard.exe guard --register`，并在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写入 `BTR Desktop`。客户端每次启动时，主进程在校验 `BTR_Guard.exe` 的 SHA-256 后也会启动它一次，这样从 d4 在客户端内升级上来的人也会有监视程序。监视程序没有控制台窗口，同一安装只会运行一个。

- 它只在 `current.json` 指向自己的安装目录时工作，否则直接退出；卸载删掉这条记录后，它会自己退出。
- 任务管理器里把“BTR Desktop”启动项关掉后，它启动即退出。
- 它监视客户端的 `resources\app.asar`，文件变化后安静 8 秒，再读档案头判断 BTR 是否还在；另外每 10 分钟检查一次。
- BTR 维护脚本运行期间持有 `%LOCALAPPDATA%\BTR_Desktop\maintenance.lock`，监视程序看到它被占用就稍后再查，不会在安装或卸载中途弹窗。官方安装程序进程还在时也会等待。
- 确认 BTR 不在后，调用维护程序读取完整状态。结构能识别就弹窗询问“重新接入 BTR”或“这次不用”；认不出来就提示一次，不改文件。
- 选择“这次不用”后记住这个文件（大小、修改和创建时间），写入 `%LOCALAPPDATA%\BTR_Desktop\guard.json`，同一个文件不再询问。重新接入失败或授权被取消，只在本次登录内不再询问。
- 选择重新接入后打开 `BTR_Desktop.exe reconnect --client <客户端目录>` 窗口，运行本地 `install.ps1 -Reconnect`，不访问 GitHub：检查结构、关闭客户端、写入 BTR（需要管理员授权）、验证、重新打开客户端。

新客户端接入成功后，`btr-desktop-backups` 里不再被任何部署记录引用的旧原始备份会被删除，只保留当前客户端的原始备份。卸载仍然保留备份。

## 本地卸载

从 d2 起，“检查 BTR 更新”右侧有红色“卸载 BTR”按钮。只有真实点击能触发预加载入口的卸载请求，主进程再次确认，默认选中取消。更新和卸载共用操作锁，不能同时执行。

确认后同时校验本地维护脚本和启动器，启动 `BTR_Desktop.exe uninstall --client <客户端目录>` 独立窗口。它用带输出捕获的 PowerShell 执行本地 install.ps1，使用固定的 `-Uninstall`、`-PackageRoot` 和 `-ClientPath` 参数，不读取远程清单。独立进程先验证部署记录和原始备份，再关闭客户端并还原。还原后的哈希与备份一致才算成功，之后移除属于本次安装的快捷方式、current.json 和监视程序启动项，用正常窗口直接启动官方 EXE，不通过会自动修复 BTR 的启动器。保留原始备份、本地安装文件和账号数据。

卸载窗口显示各阶段进度，只有脚本发出完成消息且退出码为 0 才显示成功；失败停留并提供 `uninstall-*.log`。主进程在维护程序退出后通知所有仍打开的设置窗口恢复按钮，即使程序返回 0 也不会遗留忙碌状态。

手动运行 `BTR_Desktop.exe remove` 成功后，同样会清除属于这个安装的 current.json 和启动项。维护脚本内部调用时加 `--keep-record`，等验证通过后再用 `forget` 清除。

## 发下一版

1. 修改 `desktop.json` 中的 `version`、`baseVersion`、`adapterRevision`，同步 `package.json` 的 `version` 和 `src/settings.js` 里的备用版本号。`legacyClientVersions` 保持不变。
2. 执行 `npm run release`，自动重建播放器脚本、`BTR_Desktop.exe`、`BTR_Guard.exe`、ZIP 和 `latest.json`。
3. 一起 commit 和 push 源码、`dist`、`packages`、`install.ps1`、`force-update.ps1`、`latest.json`。不要只改版本文件而漏传 ZIP。

源码和发布包一起存在同一次 commit 中，安装器可检测短暂缓存不一致并安全失败，稍后重试即可。不修改官方更新校验和官方缓存。
