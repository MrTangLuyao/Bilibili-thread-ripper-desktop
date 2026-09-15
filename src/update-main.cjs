"use strict";
// Electron's fs reads the embedded ASAR metadata; original-fs cannot read it.
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const {spawn} = require("child_process");
const {check} = require("./update-provider.cjs");
const CHANNEL = "btr-desktop:update-check", INSTALL = "btr-desktop:update-install";
function trusted(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { const url = new URL(frame.url); return url.origin === "https://bilipc.bilibili.com" && ["/index.html","/player.html"].includes(url.pathname); } catch (_) { return false; }
}
function register(electron) {
  const {ipcMain,dialog,BrowserWindow} = electron;
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "update-config.json"), "utf8"));
  const installed = JSON.parse(fs.readFileSync(path.join(__dirname, "installed.json"), "utf8"));
  let pending, latest, checkedAt = 0, installing = false;
  async function inspect() {
    if (pending) return pending;
    if (latest && Date.now() - checkedAt < 3000) return latest;
    pending = check(config.update, config).then(value => { latest=value; checkedAt=Date.now(); return value; }).finally(() => {pending=null;});
    return pending;
  }
  ipcMain.handle(CHANNEL, async event => {
    if (!trusted(event)) throw Error("Untrusted update sender");
    try { return await inspect(); } catch (error) { return {state:"error",message:String(error.message).slice(0,200)}; }
  });
  ipcMain.handle(INSTALL, async event => {
    if (!trusted(event) || installing) return {state:"error",message:"无法启动更新，请稍后重试"};
    installing = true; let started = false;
    try {
      const result = await inspect();
      if (result.state !== "available") return result;
      const options = {type:"question",title:"BTR 更新",message:`安装 ${result.manifest.version}？`,detail:"安装包校验成功后会关闭并重新打开哔哩哔哩。只从 BTR Desktop 官方仓库下载。",buttons:["安装更新","取消"],defaultId:1,cancelId:1,noLink:true};
      const parent = BrowserWindow.fromWebContents(event.sender);
      const answer = parent ? await dialog.showMessageBox(parent,options) : await dialog.showMessageBox(options);
      if (answer.response !== 0) return {state:"available",manifest:result.manifest,message:"已取消更新"};
      const script = path.resolve(installed.installRoot, "install.ps1");
      if (!path.isAbsolute(installed.installRoot) || !fs.existsSync(script)) throw Error("找不到安装脚本，请重新运行 README 中的一键安装命令");
      if (crypto.createHash("sha256").update(fs.readFileSync(script)).digest("hex") !== config.installerSha256) throw Error("安装脚本校验失败，请重新安装 BTR");
      const quote = value => "'" + value.replace(/'/g,"''") + "'";
      const client = path.dirname(process.execPath);
      const command = `try { & ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(script)}))) -ClientPath ${quote(client)} } catch { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'BTR update failed') | Out-Null; exit 1 }`;
      const environment = {...process.env};
      delete environment.PSModulePath;
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(path.join(process.env.SystemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(command,"utf16le").toString("base64")],{detached:true,stdio:"ignore",windowsHide:true,env:environment});
      await new Promise((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);}); started=true; child.once("exit",()=>{installing=false;}); child.unref();
      return {state:"installing",message:"正在下载并安装，成功后会重新打开客户端"};
    } catch (error) { return {state:"error",message:String(error.message).slice(0,200)}; }
    finally { if(!started)installing=false; }
  });
}
module.exports = {register,trusted};
