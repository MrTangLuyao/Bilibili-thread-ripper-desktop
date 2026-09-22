"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process");
const {sha}=require("../tools/asar.cjs");
const {ps,execute,setup,cleanup,actualHash,readLog,waitForWorker,waitForFile,assertPhases,maintenance,assertWindowMode}=require("./fixture-client.cjs");
const UPDATE_PHASES=["closing","manifest","download","verify","extract","compatibility","install","validate","restart","complete"];
const REMOVE_PHASES=["backup","closing","restore","validate","cleanup","restart","complete"];

test("non-detached Windows PowerShell actually executes the maintenance command",{skip:process.platform!=="win32"},async()=>{
 const result=await execute(ps,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from("[Console]::WriteLine('BTR_EXECUTED')","utf16le").toString("base64")],process.env);
 assert.equal(result.code,0);assert.match(result.stdout,/BTR_EXECUTED/);
});
test("independent native windows update then uninstall offline with hidden ignored stdio",{skip:process.platform!=="win32",timeout:120000},async()=>{
  const before=actualHash(),f=await setup();
  try{
    const result=await execute(path.join(f.bridge,"BTR_Desktop.exe"),maintenance(["update","--client",f.client,"--version",f.manifest.version,"--sha256",f.manifest.sha256]),f.env,60000,true);
    // Its output is not captured here, so a failure shows the update log instead.
    assert.equal(result.code,0,result.stdout+result.stderr+"\nupdate log:\n"+readLog(f,"update-"));
    assert.ok(await waitForFile(f.marker),"Official fixture did not restart");
    assert.equal(JSON.parse(fs.readFileSync(f.pointer)).version,f.manifest.version);
    const log=readLog(f,"update-");assertPhases(log,UPDATE_PHASES);assert.match(log,/Worker exit 0/);assertWindowMode(log);
    console.log("PASS native update window: worker executed, phase order logged, installed files verified, official fixture restarted");
    const installed=JSON.parse(fs.readFileSync(f.pointer));
    const sentinel=path.join(f.localData,"account.json");fs.writeFileSync(sentinel,"keep-account");fs.unlinkSync(f.marker);
    // Uninstall the actual extracted release, not a mock of Remove-BtrDesktop.
    const removed=await execute(path.join(installed.installPath,"BTR_Desktop.exe"),maintenance(["uninstall","--client",f.client]),f.env,60000,true);
    assert.equal(removed.code,0,removed.stdout+removed.stderr);
    assert.deepEqual(fs.readFileSync(f.asar),f.original);
    assert.ok(await waitForFile(f.marker),"Uninstall did not restart the official EXE");
    assert.ok(!fs.existsSync(f.pointer),"Uninstall pointer survived");
    assert.equal(fs.readFileSync(sentinel,"utf8"),"keep-account");
    assert.deepEqual(fs.readFileSync(path.join(f.client,"resources/btr-desktop-backups",sha(f.original)+".asar")),f.original);
    const removeLog=readLog(f,"uninstall-");assertPhases(removeLog,REMOVE_PHASES);assertWindowMode(removeLog);
    assert.doesNotMatch(removeLog,/"phase":"(manifest|download)"/);assert.match(removeLog,/Worker exit 0/);
    console.log("PASS native uninstall: exact original bytes restored, account and backup retained, official client restarted, phases logged");
  }finally{cleanup(f,before);}
});
test("maintenance windows survive when BTR closes the client that started them",{skip:process.platform!=="win32",timeout:150000},async()=>{
  const before=actualHash(),f=await setup();
  try{
    // The fixture client plays Electron: it starts the launcher inside a kill-on-close job and waits to be closed.
    const startFromClient=args=>{const p=spawn(f.exe,["--btr-fake-electron",...args],{env:f.env,stdio:"ignore",windowsHide:true});return new Promise(resolve=>p.once("exit",resolve));};
    const updateClient=startFromClient(maintenance([path.join(f.bridge,"BTR_Desktop.exe"),"update","--client",f.client,"--version",f.manifest.version,"--sha256",f.manifest.sha256]));
    const log=await waitForWorker(f,"update-");
    await updateClient;
    assertPhases(log,UPDATE_PHASES);assert.match(log,/Worker exit 0/);assertWindowMode(log);
    assert.ok(await waitForFile(f.marker),"Official fixture did not restart");
    const installed=JSON.parse(fs.readFileSync(f.pointer));assert.equal(installed.version,f.manifest.version);
    console.log("PASS update window keeps running and records completion after the launching client is closed");
    fs.unlinkSync(f.marker);
    const removeClient=startFromClient(maintenance([path.join(installed.installPath,"BTR_Desktop.exe"),"uninstall","--client",f.client]));
    const removeLog=await waitForWorker(f,"uninstall-");
    await removeClient;
    assertPhases(removeLog,REMOVE_PHASES);assert.match(removeLog,/Worker exit 0/);assertWindowMode(removeLog);
    assert.deepEqual(fs.readFileSync(f.asar),f.original);
    assert.ok(await waitForFile(f.marker),"Uninstall did not restart the official EXE");
    assert.ok(!fs.existsSync(f.pointer),"Uninstall pointer survived");
    console.log("PASS uninstall window keeps running, restores exact bytes and restarts the client after the launching client is closed");
  }finally{cleanup(f,before);}
});
