# 版本和更新文件

对外完整版本是 `主版本-d桌面修订`，例如 `0.9.1.1-d1`、`0.9.1.1-d2`。主版本升级后从 `d1` 开始。`desktop.json` 的 `baseVersion` 与 `adapterRevision` 是构建检查依据，`version` 必须等于两者拼接的完整版本。

`latest.json` 是客户端和一键安装命令唯一读取的更新入口，固定在本仓库 main 分支。不使用 GitHub Release，也不需要额外服务器或密钥。

```json
{
  "schema": 1,
  "version": "0.9.1.1-d1",
  "downloadUrl": "https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/packages/BTR_Desktop-0.9.1.1-d1.zip",
  "sha256": "构建时自动生成的64位SHA-256",
  "supportedClientVersions": ["1.18.0"]
}
```

完整版本号相同就是最新版，不同就是有更新，包括仓库主动回退版本的情况。进入 BTR 系统设置时自动检查，也可以点击“检查 BTR 更新”；发现版本不同时出现“更新到版本号”按钮。确认安装后运行本地校验过的一键安装器，重新获取最新清单和安装包，校验完成后关闭指定客户端，安装后重新打开。下载失败不会先结束视频。

下载仅允许本仓库的 HTTPS raw 地址，拒绝跳转和任意外部地址。清单限制 64 KiB，安装包限制 16 MiB，解压后限制 24 MiB。校验包 SHA-256、版本和内部播放器脚本哈希，拒绝越界解压路径。SHA-256 用于检测损坏和文件不一致，不是独立签名；更新信任 GitHub HTTPS 和仓库维护者，因此不要执行陌生人提供的同名安装命令。

更新不依赖配置迁移。不主动清理 Bilibili 账号或官方客户端数据，现有 BTR 设置能继续读取时会保留，但更新不承诺迁移任何旧格式。

## 发下一版

1. 修改 `desktop.json` 中的 `version`、`baseVersion`、`adapterRevision`，同步 `package.json` 的 `version`。
2. 执行 `npm run release`，自动重建启动器、播放器脚本、ZIP 和 `latest.json`。
3. 一起 commit 和 push 源码、`dist`、`packages`、`install.ps1`、`latest.json`。不要只改版本文件而漏传 ZIP。

源码和发布包一起存在同一次 commit 中，安装器可检测短暂缓存不一致并安全失败，稍后重试即可。不修改官方更新校验；未知客户端版本不会强行安装。
