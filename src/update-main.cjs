"use strict";
// Electron's fs reads the embedded ASAR metadata; original-fs cannot read it.
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const {spawn} = require("child_process");
const {check} = require("./update-provider.cjs");
const CHANNEL = "btr-desktop:update-check", INSTALL = "btr-desktop:update-install", REMOVE = "btr-desktop:uninstall";
function trusted(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { const url = new URL(frame.url); return url.origin === "https://bilipc.bilibili.com" && ["/index.html","/player.html"].includes(url.pathname); } catch (_) { return false; }
}
function register(electron) {
  const {ipcMain,dialog,BrowserWindow} = electron;
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "update-config.json"), "utf8"));
  const installed = JSON.parse(fs.readFileSync(path.join(__dirname, "installed.json"), "utf8"));
  let pending, latest, checkedAt = 0, operation = "";
  const busy = () => ({state:operation,message:"正在处理 BTR 操作，请稍候"});
  async function inspect() {
    if (pending) return pending;
    if (latest && Date.now() - checkedAt < 3000) return latest;
    pending = check(config.update, config).then(value => { latest=value; checkedAt=Date.now(); return value; }).finally(() => {pending=null;});
    return pending;
  }
  ipcMain.handle(CHANNEL, async event => {
    if (!trusted(event)) throw Error("Untrusted update sender");
    if (operation) return busy();
    try { const result=await inspect(); return operation ? busy() : result; }
    catch (error) { return operation ? busy() : {state:"error",message:String(error.message).slice(0,200)}; }
  });
  async function maintain(event, remove) {
    if (!trusted(event)) return {state:"error",message:"无法处理此窗口的 BTR 操作"};
    if (operation) return busy();
    operation = "confirming"; let started = false;
    try {
      // Uninstall is entirely local and must also work when GitHub is unavailable.
      const result = remove ? null : await inspect();
      if (!remove && result.state !== "available") return result;
      const options = remove
        ? {type:"warning",title:"卸载 BTR",message:"确定卸载 BTR？",detail:"将关闭哔哩哔哩、还原官方客户端并重新打开。不会卸载哔哩哔哩，也不会删除账号、缓存和个人设置。对应的 BTR 桌面快捷方式会移除。",buttons:["卸载 BTR","取消"],defaultId:1,cancelId:1,noLink:true}
        : {type:"question",title:"BTR 更新",message:`安装 ${result.manifest.version}？`,detail:"安装包校验成功后会关闭并重新打开哔哩哔哩。只从 BTR Desktop 官方仓库下载。",buttons:["安装更新","取消"],defaultId:1,cancelId:1,noLink:true};
      const parent = BrowserWindow.fromWebContents(event.sender);
      const answer = parent ? await dialog.showMessageBox(parent,options) : await dialog.showMessageBox(options);
      if (answer.response !== 0) return remove ? {...(latest || {state:"idle"}),message:"已取消卸载 BTR"} : {...result,message:"已取消更新"};
      if (!installed.installRoot || !path.isAbsolute(installed.installRoot)) throw Error("找不到 BTR 安装目录");
      const script = path.resolve(installed.installRoot, "install.ps1");
      if (!fs.existsSync(script)) throw Error("找不到维护脚本，请重新运行 README 中的一键安装命令");
      if (crypto.createHash("sha256").update(fs.readFileSync(script)).digest("hex") !== config.installerSha256) throw Error("维护脚本校验失败，请重新安装 BTR");
      const quote = value => "'" + value.replace(/'/g,"''") + "'";
      const client = path.dirname(process.execPath);
      const flags = remove ? ` -Uninstall -PackageRoot ${quote(installed.installRoot)}` : "";
      const command = `try { & ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(script)}))) -ClientPath ${quote(client)}${flags} } catch { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'BTR operation failed') | Out-Null; exit 1 }`;
      const environment = {...process.env};
      delete environment.PSModulePath;
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(path.join(process.env.SystemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(command,"utf16le").toString("base64")],{detached:true,stdio:"ignore",windowsHide:true,env:environment});
      await new Promise((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});
      started=true; operation=remove?"uninstalling":"installing";
      child.once("exit",code=>{
        operation="";
        if (code !== 0) {
          try { if (!event.sender.isDestroyed()) event.sender.send("btr-desktop:maintenance-result",{state:"error",message:remove?"卸载未完成，请查看错误提示后重试":"更新未完成，请查看错误提示后重试"}); } catch (_) {}
        }
      });
      child.unref();
      return {state:operation,message:remove?"正在卸载 BTR，完成后会重新打开官方客户端":"正在下载并安装，成功后会重新打开客户端"};
    } catch (error) { return {state:"error",message:String(error.message).slice(0,200)}; }
    finally { if(!started)operation=""; }
  }
  ipcMain.handle(INSTALL,event=>maintain(event,false));
  ipcMain.handle(REMOVE,event=>maintain(event,true));
}
module.exports = {register,trusted};
