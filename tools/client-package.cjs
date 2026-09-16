"use strict";
let fs;
try { fs = require("original-fs"); } catch (_) { fs = require("node:fs"); }
const path = require("node:path");
const { Asar, sha } = require("./asar.cjs");
const project = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(project, "desktop.json")));
const BUNDLE_FILE = "btr-desktop/desktop.js", BOOTSTRAP_FILE = "btr-desktop/bootstrap.cjs";
// BTR must never stop the official client from starting, whatever its version.
function bootstrapPrefix(entry) {
  const relative = path.posix.relative(path.posix.dirname(entry), BOOTSTRAP_FILE);
  return `try{require(${JSON.stringify(relative.startsWith(".") ? relative : "./" + relative)})}catch(error){console.error("BTR bootstrap:",error&&error.message)}\n`;
}
// A BOM and a leading "use strict" directive must stay first, or the official file changes meaning.
function splitHead(text) {
  const head = /^﻿?(?:\s*(["'])use strict\1[ \t]*;?[ \t]*(?:\r?\n)?)?/.exec(text)[0];
  return [head, text.slice(head.length)];
}
function withBootstrap(entry, text) { const [head, body] = splitHead(text); return head + bootstrapPrefix(entry) + body; }
function hasBootstrap(entry, text) { return splitHead(text)[1].startsWith(bootstrapPrefix(entry)); }
function hooks(bundle) {
  const bootstrap = fs.readFileSync(path.join(project, "src", "bootstrap.cjs"));
  const preload = Buffer.from(`"use strict";\n(() => {\n` +
    `if (!process.isMainFrame || location.origin !== "https://bilipc.bilibili.com" || !/^\\/(index|player)\\.html$/.test(location.pathname)) return;\n` +
    `const {ipcRenderer}=require("electron"),channel="__BTR_DESKTOP_UPDATE__";\n` +
    `let checking=false,acting=false,epoch=0,configEpoch=0; const send=result=>window.postMessage({channel,type:"result",result},location.origin);\n` +
    `ipcRenderer.on("btr-desktop:maintenance-result",(_event,result)=>send(result));\n` +
    `window.addEventListener("message",async event=>{if(event.source!==window||event.data?.channel!==channel||event.data.type!=="configure-auto"||typeof event.data.enabled!=="boolean")return;const ticket=++configEpoch;try{const result=await ipcRenderer.invoke("btr-desktop:auto-config",{enabled:event.data.enabled,changed:event.data.changed===true});if(ticket===configEpoch)window.postMessage({channel,type:"auto-config",enabled:result.enabled},location.origin);}catch(_){}});\n` +
    `window.addEventListener("message",async event=>{if(event.source!==window||event.data?.channel!==channel||event.data.type!=="check"||checking||acting)return;checking=true;const ticket=epoch;try{const result=await ipcRenderer.invoke("btr-desktop:update-check");if(ticket===epoch)send(result);}catch(_){if(ticket===epoch)send({state:"error",message:"更新检查失败，请稍后重试"});}finally{checking=false;}});\n` +
    `document.addEventListener("click",async event=>{if(!event.isTrusted||acting||!event.target.closest?.("#btr-desktop-settings"))return;const button=event.target.closest?.("#btr-desktop-install-update,#btr-desktop-uninstall");if(!button||button.disabled)return;const remove=button.id==="btr-desktop-uninstall";acting=true;epoch++;send({state:"confirming",message:remove?"请确认是否卸载 BTR":"请确认是否安装更新"});try{send(await ipcRenderer.invoke(remove?"btr-desktop:uninstall":"btr-desktop:update-install"));}catch(_){send({state:"error",message:remove?"无法启动卸载，请稍后重试":"无法启动更新，请重新运行安装命令"});}finally{acting=false;}},true);\n` +
    `const code = ${JSON.stringify(bundle.toString("utf8"))};\n` +
    `let injected = false;\nfunction inject() { if (injected || !document.documentElement) return; injected = true; observer.disconnect(); const script = document.createElement("script"); script.textContent = code; (document.head || document.documentElement).appendChild(script); script.remove(); }\n` +
    `const observer = new MutationObserver(inject); observer.observe(document, {childList:true,subtree:true}); inject();\n})();\n`);
  return { bootstrap, preload,
    "update-main":fs.readFileSync(path.join(project,"src","update-main.cjs")),
    "update-provider":fs.readFileSync(path.join(project,"tools","update-provider.cjs")),
    "https-json":fs.readFileSync(path.join(project,"tools","https-json.cjs")),
    "update-config":Buffer.from(JSON.stringify({...config,installerSha256:sha(fs.readFileSync(path.join(project,"install.ps1"))),launcherSha256:sha(fs.readFileSync(path.join(project,"BTR_Desktop.exe"))),guardSha256:sha(fs.readFileSync(path.join(project,"BTR_Guard.exe")))}))
  };
}
const hookFile = key => `btr-desktop/${key}.${key === "update-config" ? "json" : "cjs"}`;
function sameHooks(archive, expected) {return Object.entries(expected).every(([key,value]) => archive.entry(hookFile(key)) && sha(archive.read(hookFile(key))) === sha(value));}
// Electron starts package.json "main" (index.js by default). Only a plain JavaScript entry
// stored inside the archive can take the BTR prefix; anything else is left untouched.
function mainEntry(archive, app) {
  const main = typeof app.main === "string" && app.main.trim() ? app.main.trim().replace(/^\.\//, "") : "index.js";
  for (const name of [main, `${main}.js`, `${main}/index.js`]) {
    try {
      const entry = archive.entry(name);
      if (/\.c?js$/.test(name) && entry && !entry.files && !entry.unpacked && !entry.link) return name;
    } catch (_) { return null; }
  }
  return null;
}
function inspect(archive) {
  let app;
  try { app = JSON.parse(archive.text("package.json")); } catch (_) { app = null; }
  if (app?.name !== "bilibili") throw Error("目标不是官方 Bilibili 客户端");
  let installed = null;
  if (archive.entry("btr-desktop/installed.json")) installed = JSON.parse(archive.text("btr-desktop/installed.json"));
  return { clientVersion: String(app.version || "unknown"), installed, entry: mainEntry(archive, app) };
}
function patch(original, bundle, metadata) {
  const info = inspect(original);
  if (info.installed) throw Error("只能在已验证的原始备份上制作补丁");
  if (!info.entry) throw Error(`无法识别客户端 ${info.clientVersion} 的入口结构，没有修改官方文件`);
  const entry = original.text(info.entry);
  if (entry.includes(BOOTSTRAP_FILE)) throw Error("客户端已经包含 BTR 入口");
  original.set(info.entry, withBootstrap(info.entry, entry));
  for (const [key,value] of Object.entries(hooks(bundle))) original.set(hookFile(key),value);
  original.set(BUNDLE_FILE, bundle);
  original.set("btr-desktop/installed.json", JSON.stringify(metadata));
  return original.pack();
}
function run(action, clientPath) {
  if (!clientPath || !path.isAbsolute(clientPath)) throw Error("需要客户端绝对路径");
  const client = fs.realpathSync(clientPath);
  const target = fs.statSync(client).isDirectory() ? path.join(client, "resources", "app.asar") : client;
  if (path.extname(target) !== ".asar") throw Error("目标必须是客户端 ASAR 资源");
  if (fs.lstatSync(target).isSymbolicLink()) throw Error("不处理链接形式的客户端资源");
  const bytes = fs.readFileSync(target), hash = sha(bytes), archive = new Asar(bytes), info = inspect(archive);
  if (action === "status") {
    const bundle = fs.readFileSync(path.join(project, "dist", "desktop.js")), expected = hooks(bundle);
    return { ...info, path: client, sha256: hash, current: isCurrent(archive, info, sha(bundle), expected), supported: !!info.entry };
  }
  const statePath = path.join(path.dirname(target), "btr-desktop-backups");
  const stateFile = path.join(statePath, path.basename(target) === "app.asar" ? "deployment.json" : `${path.basename(target)}.deployment.json`);
  const deployment = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
  if (action === "remove" || action === "check-remove") {
    if (!info.installed) return { state: "not-installed" };
    if (!deployment || deployment.patchedSha256 !== hash || deployment.clientVersion !== info.clientVersion) throw Error("当前客户端与安装记录不匹配，拒绝覆盖。请重新安装官方客户端。");
    if (!/^[a-f0-9]{64}$/.test(deployment.originalSha256) || deployment.originalSha256 !== info.installed.originalSha256) throw Error("原始备份记录不匹配");
    const backup = path.join(statePath, `${deployment.originalSha256}.asar`);
    const original = fs.readFileSync(backup);
    const originalInfo = inspect(new Asar(original));
    if (sha(original) !== deployment.originalSha256 || originalInfo.installed || originalInfo.clientVersion !== info.clientVersion) throw Error("备份校验失败");
    if (action === "check-remove") return { state:"ready-to-remove", originalSha256:deployment.originalSha256 };
    replace(target, original);
    return { state: "removed", clientVersion: info.clientVersion, message: "已恢复官方资源，备份和用户设置保留" };
  }
  if (!["install", "repair"].includes(action)) throw Error("未知操作");
  if (!info.entry) return { state: "unsupported-client", clientVersion: info.clientVersion, message: "无法识别客户端入口结构，保持官方程序不变" };
  const bundle = fs.readFileSync(path.join(project, "dist", "desktop.js"));
  const payload = JSON.parse(fs.readFileSync(path.join(project, "dist", "payload.json")));
  if (sha(bundle) !== payload.sha256) throw Error("BTR 文件校验失败");
  const expected = hooks(bundle);
  if (isCurrent(archive, info, payload.sha256, expected)) return { state: "current", clientVersion: info.clientVersion };
  let originalBytes = bytes;
  if (info.installed) {
    const backupHash = info.installed.originalSha256;
    if (!/^[a-f0-9]{64}$/.test(backupHash)) throw Error("Invalid original backup hash");
    originalBytes = fs.readFileSync(path.join(statePath, `${backupHash}.asar`));
    if (sha(originalBytes) !== backupHash || inspect(new Asar(originalBytes)).clientVersion !== info.clientVersion) throw Error("原始备份不匹配");
  }
  const originalHash = sha(originalBytes);
  const metadata = { schema: 1, version: config.version, adapterRevision: config.adapterRevision, clientVersion: info.clientVersion, originalSha256: originalHash, payloadSha256: payload.sha256, installRoot:project };
  const patched = patch(new Asar(originalBytes), bundle, metadata);
  const verify = new Asar(patched);
  if (sha(verify.read(BUNDLE_FILE)) !== payload.sha256) throw Error("补丁自检失败");
  fs.mkdirSync(statePath, { recursive: true });
  const backupPath = path.join(statePath, `${originalHash}.asar`);
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, originalBytes, { flag: "wx" });
  if (sha(fs.readFileSync(backupPath)) !== originalHash) throw Error("备份内容校验失败");
  replace(target, patched);
  fs.writeFileSync(stateFile, JSON.stringify({ ...metadata, patchedSha256: sha(patched) }, null, 2));
  return { state: "installed", clientVersion: info.clientVersion, version: config.version, backupPath, removedBackups: pruneBackups(statePath) };
}
function isCurrent(archive, info, bundleHash, expected) {
  return !!(info.installed && info.entry && info.installed.payloadSha256 === bundleHash && archive.entry(BUNDLE_FILE) && sha(archive.read(BUNDLE_FILE)) === bundleHash
    && hasBootstrap(info.entry, archive.text(info.entry)) && sameHooks(archive, expected) && info.installed.installRoot === project);
}
// After an official full reinstall the old original can never be restored onto the new build.
// Keep only originals that a deployment record still refers to.
function pruneBackups(statePath) {
  const kept = new Set(), removed = [];
  try {
    for (const name of fs.readdirSync(statePath)) if (name.endsWith("deployment.json")) kept.add(JSON.parse(fs.readFileSync(path.join(statePath, name))).originalSha256);
    for (const name of fs.readdirSync(statePath)) {
      const match = /^([a-f0-9]{64})\.asar$/.exec(name);
      if (match && !kept.has(match[1])) { fs.unlinkSync(path.join(statePath, name)); removed.push(name); }
    }
  } catch (_) { /* Installation already succeeded; a leftover backup is harmless. */ }
  return removed;
}
function replace(target, bytes) {
  const temporary = `${target}.btr-${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  try {
    if (sha(fs.readFileSync(temporary)) !== sha(bytes)) throw Error("写入校验失败");
    fs.renameSync(temporary, target);
  } catch (error) { try { fs.unlinkSync(temporary); } catch (_) {} throw error; }
}
if (require.main === module) {
  const report = value => { if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(value, null, 2)); };
  Promise.resolve().then(() => process.argv[2] === "check-update" ? require("./update-provider.cjs").check(config.update, config) : run(process.argv[2] || "status", process.argv[3]))
    .then(result => { report(result); console.log(JSON.stringify(result, null, 2)); })
    .catch(error => { report({ state: "error", message: error.message }); console.error(error.message); process.exitCode = 1; });
}
module.exports = { inspect, patch, run };
