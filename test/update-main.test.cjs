"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),crypto=require("node:crypto"),{EventEmitter}=require("node:events");
const source=fs.readFileSync(path.join(__dirname,"../src/update-main.cjs"),"utf8");
function setup({response=0,tampered=false,launcherTampered=false,guardTampered=false,noGuard=false,spawnError=false,unavailable=false,offline=false}={}) {
  const handlers={},calls=[],script=Buffer.from("# verified installer"),root=path.resolve("C:/BTR user's files");
  const digest=crypto.createHash("sha256").update(script).digest("hex");
  const config={version:"0.9.1.1-d5",update:{enabled:true},installerSha256:digest,launcherSha256:digest,...(noGuard?{}:{guardSha256:digest})};
  let now=10000, nextTimer=0; const timers=new Map();
  let requests=0;
  const event={sender:{isDestroyed:()=>false,send:(channel,result)=>calls.push({channel,result})},senderFrame:{url:"https://bilipc.bilibili.com/index.html#/settings"}};event.sender.mainFrame=event.senderFrame;
  const fakeFs={existsSync:()=>true,readFileSync:file=>file.endsWith("update-config.json")?JSON.stringify(config):file.endsWith("installed.json")?JSON.stringify({installRoot:root}):(tampered || (launcherTampered && file.endsWith("BTR_Desktop.exe")) || (guardTampered && file.endsWith("BTR_Guard.exe")))?Buffer.from("changed"):script};
  const check=async()=>{requests++;if(offline)throw Error("offline");return {state:unavailable?"current":"available",manifest:{version:"0.9.1.1-d4",sha256:"a".repeat(64)}};};
  const child=new EventEmitter();child.unref=()=>calls.push({unref:true});
  const module={exports:{}};
  vm.runInNewContext(source,{module,URL,Buffer,Date:{now:()=>now},setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),__dirname:path.resolve("C:/app.asar/btr-desktop"),process:{execPath:"C:\\Program Files\\bilibili\\client.exe",env:{SystemRoot:"C:\\Windows",PSModulePath:"foreign",ELECTRON_RUN_AS_NODE:"1"}},require:name=>{
    if(name==="fs")return fakeFs;
    if(name==="./update-provider.cjs")return {check};
    if(name==="child_process")return {spawn:(exe,args,options)=>{calls.push({exe,args,options});queueMicrotask(()=>spawnError?child.emit("error",Error("maintenance start failed")):child.emit("spawn"));return child;}};
    return require(name);
  }});
  module.exports.register({ipcMain:{handle:(name,fn)=>handlers[name]=fn},BrowserWindow:{fromWebContents:()=>null},dialog:{showMessageBox:async options=>{calls.push({dialog:options});return {response};}}});
  return {startGuard:module.exports.startGuard,check:handlers["btr-desktop:update-check"],install:handlers["btr-desktop:update-install"],remove:handlers["btr-desktop:uninstall"],configure:handlers["btr-desktop:auto-config"],event,calls,child,requests:()=>requests,advance:async ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);await t.fn();}},timers};
}
test("update IPC is restricted to the official top-level renderer",async()=>{
  const s=setup();assert.equal((await s.check(s.event)).state,"available");await s.check(s.event);assert.equal(s.requests(),1);
  for(const url of ["https://evil.test/index.html","https://bilipc.bilibili.com/other.html","https://bilipc.bilibili.com.evil.test/index.html"]){
    const frame={url},bad={sender:{mainFrame:frame},senderFrame:frame};
    await assert.rejects(s.check(bad),/Untrusted/);assert.equal((await s.install(bad)).state,"error");assert.equal((await s.remove(bad)).state,"error");
  }
  await assert.rejects(s.check({...s.event,senderFrame:{url:s.event.senderFrame.url}}),/Untrusted/);
  assert.equal(s.calls.length,0);
});
test("update installation needs confirmation and a verified local installer",async()=>{
  const cancelled=setup({response:1});assert.equal((await cancelled.install(cancelled.event)).state,"available");assert.equal(cancelled.calls.filter(x=>x.exe).length,0);
  const damaged=setup({tampered:true});assert.equal((await damaged.install(damaged.event)).state,"error");assert.equal(damaged.calls.filter(x=>x.exe).length,0);
  const current=setup({unavailable:true});assert.equal((await current.install(current.event)).state,"current");assert.equal(current.calls.length,0);
  const s=setup();assert.equal((await s.install(s.event)).state,"installing");
  const call=s.calls.find(x=>x.exe);assert.match(call.exe,/BTR_Desktop.exe$/);assert.equal(call.options.detached,false);assert.equal(call.options.windowsHide,true);assert.equal(call.options.env.PSModulePath,undefined);assert.equal(call.options.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal(call.args[0],"update");assert.equal(call.args[2],"C:\\Program Files\\bilibili");assert.equal(call.args[4],"0.9.1.1-d4");assert.equal(call.args[6],"a".repeat(64));
  const options=s.calls.find(x=>x.dialog).dialog;assert.equal(options.title,"检测到新的BTR线程撕裂者更新");assert.equal(options.message,"版本 0.9.1.1-d4");assert.match(options.detail,/将从BTR Desktop 官方仓库获取更新/);
  assert.equal((await s.install(s.event)).state,"installing");assert.equal(s.calls.filter(x=>x.exe).length,1);s.child.emit("exit",0);assert.equal((await s.install(s.event)).state,"installing");
});

test("uninstall works offline, requires confirmation and shares the update lock",async()=>{
  const cancelled=setup({response:1,offline:true});assert.equal((await cancelled.remove(cancelled.event)).state,"idle");assert.equal(cancelled.requests(),0);assert.equal(cancelled.calls.filter(x=>x.exe).length,0);
  const dialog=cancelled.calls.find(x=>x.dialog).dialog;assert.equal(dialog.title,"卸载 BTR");assert.equal(dialog.defaultId,1);assert.equal(dialog.cancelId,1);
  const damaged=setup({tampered:true});assert.equal((await damaged.remove(damaged.event)).state,"error");assert.equal(damaged.calls.filter(x=>x.exe).length,0);
  const s=setup({offline:true});assert.equal((await s.remove(s.event)).state,"uninstalling");assert.equal(s.requests(),0);
  const call=s.calls.find(x=>x.exe);assert.match(call.exe,/BTR user's files\\BTR_Desktop.exe$/);assert.deepEqual(Array.from(call.args),["uninstall","--client","C:\\Program Files\\bilibili"]);
  assert.equal((await s.install(s.event)).state,"uninstalling");assert.equal((await s.remove(s.event)).state,"uninstalling");assert.equal((await s.check(s.event)).state,"uninstalling");assert.equal(s.calls.filter(x=>x.exe).length,1);
  assert.equal(call.options.detached,false);
  s.child.emit("exit",1);assert.equal(s.calls.filter(x=>x.channel==="btr-desktop:maintenance-result").at(-1).result.state,"error");
  assert.equal((await s.remove(s.event)).state,"uninstalling");assert.equal(s.calls.filter(x=>x.exe).length,2);
  s.child.emit("exit",0);assert.equal(s.calls.filter(x=>x.channel==="btr-desktop:maintenance-result").at(-1).result.state,"idle");
});

test("one startup scheduler across windows, cancel waits 30 minutes, toggle stops checks",async()=>{
  const s=setup({response:1});
  s.configure(s.event,{enabled:true,changed:false});
  const second={sender:{isDestroyed:()=>false,send(){}},senderFrame:{url:"https://bilipc.bilibili.com/player.html"}};second.sender.mainFrame=second.senderFrame;
  s.configure(second,{enabled:true,changed:false});assert.equal(s.timers.size,1);
  await s.advance(1499);assert.equal(s.requests(),0);
  await s.advance(1);assert.equal(s.requests(),1);assert.equal(s.calls.filter(x=>x.dialog).length,1);
  s.configure(second,{enabled:true,changed:false});await s.advance(1799999);assert.equal(s.requests(),1);
  await s.advance(1);assert.equal(s.requests(),2);assert.equal(s.calls.filter(x=>x.dialog).length,2);
  s.configure(s.event,{enabled:false,changed:true});assert.equal(s.timers.size,0);
  assert.equal(s.configure(second,{enabled:true,changed:false}).enabled,false);
  await s.advance(1800000);assert.equal(s.requests(),2);
  await s.check(s.event);assert.equal(s.requests(),3);
  s.configure(s.event,{enabled:true,changed:true});await s.advance(1500);assert.equal(s.calls.filter(x=>x.dialog).length,3);
});

test("uninstall rejects a changed launcher and releases the lock when starting fails",async()=>{
  const tampered=setup({launcherTampered:true,offline:true});
  assert.equal((await tampered.remove(tampered.event)).state,"error");assert.equal(tampered.calls.filter(x=>x.exe).length,0);
  const failed=setup({spawnError:true,offline:true});
  for(let i=0;i<2;i++) {
    const result=await failed.remove(failed.event);assert.equal(result.state,"error");assert.match(result.message,/maintenance start failed/);
  }
  assert.equal(failed.calls.filter(x=>x.dialog).length,2);assert.equal(failed.requests(),0);
});

test("automatic offline checks stay quiet and retry, startup off does not fetch",async()=>{
  const s=setup({offline:true});s.configure(s.event,{enabled:false});await s.advance(1800000);assert.equal(s.requests(),0);
  s.configure(s.event,{enabled:true,changed:true});await s.advance(1500);assert.equal(s.requests(),1);assert.equal(s.calls.filter(x=>x.dialog).length,0);
  await s.advance(1800000);assert.equal(s.requests(),2);
});

test("client start keeps a verified guard running outside the client's job",()=>{
  const s=setup();assert.equal(s.startGuard(),true);
  const call=s.calls.find(x=>x.exe);assert.match(call.exe,/BTR user's files\\BTR_Guard\.exe$/);assert.deepEqual(Array.from(call.args),["guard","--register"]);
  assert.equal(call.options.detached,true);assert.equal(call.options.windowsHide,true);assert.equal(call.options.stdio,"ignore");assert.equal(call.options.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.ok(s.calls.some(x=>x.unref));
  const tampered=setup({guardTampered:true});assert.equal(tampered.startGuard(),false);assert.equal(tampered.calls.filter(x=>x.exe).length,0);
  // A deployment from a release without a guard hash never starts an unverified program.
  const legacy=setup({noGuard:true});assert.equal(legacy.startGuard(),false);assert.equal(legacy.calls.filter(x=>x.exe).length,0);
});
