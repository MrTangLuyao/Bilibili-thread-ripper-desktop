"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn}=require("node:child_process");
const {Asar,sha}=require("../tools/asar.cjs");
const root=path.resolve(__dirname,".."),ps="C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
function execute(exe,args,env,timeout=45000,ignore=false){return new Promise((resolve,reject)=>{
 const p=spawn(exe,args,{env,windowsHide:true,detached:false,stdio:ignore?"ignore":["ignore","pipe","pipe"]});let stdout="",stderr="";
 p.stdout?.on("data",d=>stdout+=d);p.stderr?.on("data",d=>stderr+=d);
 const timer=setTimeout(()=>{p.kill();reject(Error("Worker timed out: "+stdout+stderr));},timeout);
 p.on("error",e=>{clearTimeout(timer);reject(e);});p.on("close",code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
});}
test("non-detached Windows PowerShell actually executes the maintenance command",{skip:process.platform!=="win32"},async()=>{
 const result=await execute(ps,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from("[Console]::WriteLine('BTR_EXECUTED')","utf16le").toString("base64")],process.env);
 assert.equal(result.code,0);assert.match(result.stdout,/BTR_EXECUTED/);
});
test("independent native windows update then uninstall offline with hidden ignored stdio",{skip:process.platform!=="win32",timeout:90000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-progress-test-"));
  const actualClient=path.join(process.env.ProgramFiles,"bilibili/resources/app.asar"),actualHash=fs.existsSync(actualClient)?sha(fs.readFileSync(actualClient)):null;
 try{
  const client=path.join(dir,"client"),bridge=path.join(dir,"updater");fs.mkdirSync(path.join(client,"resources"),{recursive:true});fs.mkdirSync(bridge);
  const json=Buffer.from('{"files":{}}'),padded=Math.ceil((json.length+4)/4)*4,bytes=Buffer.alloc(padded+12);bytes.writeUInt32LE(4);bytes.writeUInt32LE(padded+4,4);bytes.writeUInt32LE(padded,8);bytes.writeUInt32LE(json.length,12);json.copy(bytes,16);
  const a=new Asar(bytes);a.set("package.json",'{"name":"bilibili","version":"1.18.0"}');a.set("index.js","original();");a.set("render/player.html","<html>original</html>");const original=a.pack();fs.writeFileSync(path.join(client,"resources/app.asar"),original);
  const compile=await execute("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",["/nologo","/target:exe",`/out:${path.join(client,"哔哩哔哩.exe")}`,path.join(__dirname,"Fixture.cs")],process.env);assert.equal(compile.code,0,compile.stdout+compile.stderr);
  fs.copyFileSync(path.join(root,"BTR_Desktop.exe"),path.join(bridge,"BTR_Desktop.exe"));fs.copyFileSync(path.join(__dirname,"local-release-installer.ps1"),path.join(bridge,"install.ps1"));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,"latest.json"))),localData=path.join(dir,"local-data"),marker=path.join(dir,"restarted.txt");
  const env={...process.env,LOCALAPPDATA:localData,BTR_LOCAL_RELEASE_PROJECT:root,BTR_TEST_NODE:process.execPath,BTR_TEST_LAUNCH_MARKER:marker};
  const result=await execute(path.join(bridge,"BTR_Desktop.exe"),["update","--client",client,"--version",manifest.version,"--sha256",manifest.sha256],env,45000,true);
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.ok(fs.existsSync(marker),"Official fixture did not restart");
  assert.equal(JSON.parse(fs.readFileSync(path.join(localData,"BTR_Desktop/current.json"))).version,manifest.version);
  const logs=path.join(localData,"BTR_Desktop/logs"),log=fs.readFileSync(path.join(logs,fs.readdirSync(logs)[0]),"utf8");
  let previous=-1;for(const phase of["closing","manifest","download","verify","extract","compatibility","install","validate","restart","complete"]){const at=log.indexOf(`"phase":"${phase}"`);assert.ok(at>previous,"Missing or out-of-order phase "+phase);previous=at;}
  assert.match(log,/Worker exit 0/);console.log("PASS native update window: worker executed, phase order logged, installed files verified, official fixture restarted");
  const pointer=path.join(localData,"BTR_Desktop/current.json"),installed=JSON.parse(fs.readFileSync(pointer));
  const sentinel=path.join(localData,"account.json");fs.writeFileSync(sentinel,"keep-account");fs.unlinkSync(marker);
  // Uninstall the actual extracted release, not a mock of Remove-BtrDesktop.
  const removed=await execute(path.join(installed.installPath,"BTR_Desktop.exe"),["uninstall","--client",client],env,45000,true);
  assert.equal(removed.code,0,removed.stdout+removed.stderr);
  assert.deepEqual(fs.readFileSync(path.join(client,"resources/app.asar")),original);
  assert.ok(fs.existsSync(marker),"Uninstall did not restart the official EXE");
  assert.ok(!fs.existsSync(pointer),"Uninstall pointer survived");
  assert.equal(fs.readFileSync(sentinel,"utf8"),"keep-account");
  assert.deepEqual(fs.readFileSync(path.join(client,"resources/btr-desktop-backups",sha(original)+".asar")),original);
  const removeLog=fs.readFileSync(path.join(logs,fs.readdirSync(logs).find(x=>x.startsWith("uninstall-"))),"utf8");
  previous=-1;for(const phase of["backup","closing","restore","validate","cleanup","restart","complete"]){const at=removeLog.indexOf(`"phase":"${phase}"`);assert.ok(at>previous,"Missing uninstall phase "+phase);previous=at;}
  assert.doesNotMatch(removeLog,/"phase":"(manifest|download)"/);assert.match(removeLog,/Worker exit 0/);
  console.log("PASS native uninstall: exact original bytes restored, account and backup retained, official client restarted, phases logged");
 }finally{
  if(actualHash!==null)assert.equal(sha(fs.readFileSync(actualClient)),actualHash,"Fixture test must never alter the real client");
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
