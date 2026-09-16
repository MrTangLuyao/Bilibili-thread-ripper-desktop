# BTR Desktop

把 Bilibili 线程撕裂者带到官方 Windows 客户端里，原本的播放器、字幕、弹幕和快捷键都保留。

当前版本 **0.9.1.1-d4**，至少保证支持官方客户端 **1.18.0**

## 安装

1 先安装好官方哔哩哔哩 Windows 客户端
2 右键左下角Windows徽标 选择终端 (Windows11) 或 Powershell (Windows11以前或无终端版版) **不要用管理员身份运行**
3 运行下面的脚本

```powershell
irm https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/install.ps1 | iex
```

这会执行这个仓库中的安装脚本，脚本可直接查看 [install.ps1](install.ps1)

## 强制更新（如遇到更新异常使用脚本更新）：

**部分旧版本会遇到更新问题，请务必使用这个脚本来强制更新**

打开普通 PowerShell，复制这一行运行：

```powershell
irm https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/force-update.ps1 | iex
```

## 设置和更新

系统设置第一项就是线程撕裂者，可以调整 CDN、线程数、错误提示和 Debug。播放器的“齿轮 → 更多播放设置”里也保留 CDN 和线程数，两边同步。

系统设置：

![BTR 桌面版系统设置](docs/images/system-settings.png)

播放器设置：

![播放器中的 BTR CDN 和并发线程设置](docs/images/player-settings.png)

自动和手动检查都读取本仓库的 [latest.json](latest.json)。只要完整版本号和仓库不同，就会提示更新。确认后安装，成功后重新打开客户端，不创建 BTR 快捷方式。也可以直接再执行上面那条命令。

如果 d1 或 d2 卡在“正在下载并安装”，请运行上面的强制更新命令。旧版的更新程序可能根本没启动，单纯等待或重复点击不能修好；装上 d3 后才会使用新的进度窗口。更新日志保存在 `%LOCALAPPDATA%\BTR_Desktop\logs`，失败时也可以在窗口里直接打开。

更新不要求保留旧配置格式，但不会清空你的 Bilibili 账号和官方客户端数据。如果官方客户端更新覆盖了 BTR，重新运行上面的安装命令恢复接入；暂未适配的客户端版本不强行注入。

## 还原

在系统设置的线程撕裂者区域，点击“检查 BTR 更新”右侧红色的 **卸载 BTR**，再确认即可。独立卸载窗口会先检查备份，随后关闭客户端、恢复官方资源并重新打开，不删除账号、缓存和个人设置。卸载不需要连接 GitHub，对应的 BTR 桌面快捷方式也会移除。遇到失败可以点击“查看卸载日志”，日志保存在 `%LOCALAPPDATA%\BTR_Desktop\logs`。

如果无法进入设置，也可以完全退出客户端后，在安装文件夹运行 `BTR_Desktop.exe remove`。安装文件夹位置记录在 `%LOCALAPPDATA%\BTR_Desktop\current.json`。原始备份和本地安装包会保留，不删除仓库代码。

## 开发和发版

修改 `desktop.json` 和 `package.json` 的版本信息，然后运行 `npm run release`。把源码、`dist`、`packages` 和 `latest.json` 一起 commit、push 就行，不需要手工上传 GitHub Release。

下载器仍复用浏览器版代码，桌面差异放在 `src`。不会换掉原生播放器，不接管字幕、登录接口和离线下载。网络和 CDN 状态仍会影响缓冲，不承诺所有视频永不卡顿。

[更新文件说明](docs/update-interface.md) | [验证记录](docs/verification.md)
