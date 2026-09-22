"use strict";
// Shared temporary Bilibili client for the Windows maintenance tests. Never touches the real client.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn,spawnSync}=require("node:child_process");
const {Asar,sha}=require("../tools/asar.cjs");
const root=path.resolve(__dirname,".."),ps="C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const actualClient=path.join(process.env.ProgramFiles||"C:/Program Files","bilibili/resources/app.asar");
function execute(exe,args,env,timeout=45000,ignore=false){return new Promise((resolve,reject)=>{
 const p=spawn(exe,args,{env,windowsHide:true,detached:false,stdio:ignore?"ignore":["ignore","pipe","pipe"]});let stdout="",stderr="";
 p.stdout?.on("data",d=>stdout+=d);p.stderr?.on("data",d=>stderr+=d);
 const timer=setTimeout(()=>{p.kill();reject(Error("Worker timed out: "+stdout+stderr));},timeout);
 p.on("error",e=>{clearTimeout(timer);reject(e);});p.on("close",code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
});}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function clientAsar(version="1.18.0",extra={}){
  const json=Buffer.from('{"files":{}}'),padded=Math.ceil((json.length+4)/4)*4,bytes=Buffer.alloc(padded+12);bytes.writeUInt32LE(4);bytes.writeUInt32LE(padded+4,4);bytes.writeUInt32LE(padded,8);bytes.writeUInt32LE(json.length,12);json.copy(bytes,16);
  const a=new Asar(bytes);a.set("package.json",JSON.stringify({name:"bilibili",version,...extra}));a.set("index.js","original();");a.set("render/player.html","<html>original</html>");
  return a.pack();
}
async function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-progress-test-"));
  const client=path.join(dir,"client"),bridge=path.join(dir,"updater");fs.mkdirSync(path.join(client,"resources"),{recursive:true});fs.mkdirSync(bridge);
  const original=clientAsar();fs.writeFileSync(path.join(client,"resources/app.asar"),original);
  const exe=path.join(client,"哔哩哔哩.exe");
  const compile=await execute("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",["/nologo","/target:winexe",`/out:${exe}`,path.join(__dirname,"Fixture.cs")],process.env);assert.equal(compile.code,0,compile.stdout+compile.stderr);
  for(const file of ["BTR_Desktop.exe","BTR_Guard.exe"])fs.copyFileSync(path.join(root,file),path.join(bridge,file));
  fs.copyFileSync(path.join(__dirname,"local-release-installer.ps1"),path.join(bridge,"install.ps1"));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,"latest.json"))),localData=path.join(dir,"local-data"),marker=path.join(dir,"restarted.txt");
  const env={...process.env,LOCALAPPDATA:localData,BTR_LOCAL_RELEASE_PROJECT:root,BTR_TEST_NODE:process.execPath,BTR_TEST_LAUNCH_MARKER:marker};
  return {dir,client,bridge,exe,original,manifest,localData,marker,env,asar:path.join(client,"resources/app.asar"),logs:path.join(localData,"BTR_Desktop/logs"),pointer:path.join(localData,"BTR_Desktop/current.json")};
}
function powershell(script,timeout=20000){
  return spawnSync(ps,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,timeout,encoding:"utf8"});
}
const psText=value=>"'"+String(value).replace(/'/g,"''")+"'";
function stopProcessesUnder(dir){
  // A failed test can leave a maintenance window, its PowerShell worker or a guard open.
  // Close programs started from this temp folder and everything they started, nothing else.
  powershell(`$d=${psText(dir)}; $all=@(Get-CimInstance Win32_Process); $ids=New-Object 'Collections.Generic.HashSet[uint32]'
foreach($p in $all){ if($p.ExecutablePath -and $p.ExecutablePath.StartsWith($d,[StringComparison]::OrdinalIgnoreCase)){ [void]$ids.Add($p.ProcessId) } }
do { $added=$false; foreach($p in $all){ if($ids.Contains($p.ParentProcessId) -and $ids.Add($p.ProcessId)){ $added=$true } } } while($added)
foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`);
}
const actualHash=()=>fs.existsSync(actualClient)?sha(fs.readFileSync(actualClient)):null;
function cleanup(f,before){
  stopProcessesUnder(f.dir);
  if(before!==null)assert.equal(sha(fs.readFileSync(actualClient)),before,"Fixture test must never alter the real client");
  // A leftover temp folder must not hide the real test failure.
  try { fs.rmSync(f.dir,{recursive:true,force:true,maxRetries:10,retryDelay:300}); }
  catch (error) { console.error("Could not remove test folder", f.dir, error.code); }
}
function readLog(f,prefix){if(!fs.existsSync(f.logs))return "";const name=fs.readdirSync(f.logs).filter(x=>x.startsWith(prefix)).sort().at(-1);return name?fs.readFileSync(path.join(f.logs,name),"utf8"):"";}
async function waitForWorker(f,prefix,timeout=60000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const log=readLog(f,prefix);if(/Worker exit/.test(log))return log;await sleep(250);}
  // Diagnose the old failure: the hidden worker may have finished while the visible window was killed.
  throw Error(`${prefix} window never recorded the worker result. background restart=${fs.existsSync(f.marker)} pointer=${fs.existsSync(f.pointer)}\n${readLog(f,prefix)}`);
}
// The worker only starts the official program; the fixture writes its marker a moment later.
async function waitForFile(file,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(fs.existsSync(file))return true;await sleep(100);}return false;}
function assertPhases(log,phases){let previous=-1;for(const phase of phases){const at=log.indexOf(`"phase":"${phase}"`);assert.ok(at>previous,"Missing or out-of-order phase "+phase+"\n"+log);previous=at;}}
// Maintenance runs (update, uninstall, reconnect) pass -silence, so a test run opens no
// windows. BTR_TEST_WINDOWS=1 runs them with their real windows, and also runs the test that
// clicks the guard's prompt.
const WINDOWS=process.env.BTR_TEST_WINDOWS==="1";
const maintenance=args=>WINDOWS?args:[...args,"-silence"];
const assertWindowMode=log=>WINDOWS?assert.doesNotMatch(log,/Silent: no window/):assert.match(log,/Silent: no window/);
module.exports={WINDOWS,maintenance,assertWindowMode,root,ps,execute,sleep,clientAsar,setup,powershell,psText,cleanup,actualHash,readLog,waitForWorker,waitForFile,assertPhases};
