"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn}=require("node:child_process");
const {Asar}=require("../tools/asar.cjs");
const {patch}=require("../tools/client-package.cjs");
const {WINDOWS,maintenance,root,ps,execute,sleep,clientAsar,setup,cleanup,actualHash,readLog,waitForWorker,waitForFile,assertPhases}=require("./fixture-client.cjs");
const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
// Same loading style as the installer tests: no execution policy change is needed.
const run=([script,...args],env,timeout)=>execute(ps,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(script)}))) ${args.map(x=>x.startsWith("-")?x:quote(x)).join(" ")}`,"utf16le").toString("base64")],env,timeout);

test("guard decisions, startup entry ownership and argument quoting",{skip:process.platform!=="win32",timeout:90000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-guard-unit-"));
  try{
    const client=path.join(dir,"client");fs.mkdirSync(path.join(client,"resources"),{recursive:true});
    fs.writeFileSync(path.join(client,"resources/app.asar"),clientAsar("1.19.0"));
    const compile=await execute("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",["/nologo","/target:winexe",`/out:${path.join(client,"哔哩哔哩.exe")}`,path.join(__dirname,"Fixture.cs")],process.env);assert.equal(compile.code,0,compile.stdout+compile.stderr);
    fs.writeFileSync(path.join(dir,"patched.asar"),patch(new Asar(clientAsar("1.19.0")),Buffer.from("x"),{}));
    fs.writeFileSync(path.join(dir,"strange.asar"),clientAsar("2.0.0",{main:"app.jsc"}));
    const result=await run([path.join(__dirname,"guard-harness.ps1"),"-Guard",path.join(root,"BTR_Guard.exe"),"-Fixture",dir],{...process.env,BTR_TEST_NODE:process.execPath},60000);
    assert.equal(result.code,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS guard/);console.log(result.stdout.trim());
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
});

// This one is about the guard's own prompt window: it shows the prompt and clicks its buttons.
// It runs only when windows are asked for (BTR_TEST_WINDOWS=1); the guard's decisions are
// covered without windows by the test above.
test("guard notices an official reinstall, reconnects on request, remembers a refusal and retires with its installation",{skip:process.platform!=="win32"?true:!WINDOWS&&"shows the guard's prompt window; set BTR_TEST_WINDOWS=1 to run it",timeout:240000},async()=>{
  const before=actualHash(),f=await setup();
  try{
    const installed=await execute(path.join(f.bridge,"BTR_Desktop.exe"),maintenance(["update","--client",f.client,"--version",f.manifest.version,"--sha256",f.manifest.sha256]),f.env,60000,true);
    assert.equal(installed.code,0,installed.stdout+installed.stderr);
    const installPath=JSON.parse(fs.readFileSync(f.pointer)).installPath,patched=fs.readFileSync(f.asar);
    fs.unlinkSync(f.marker);
    // No --register: a test must never write the real startup entry.
    const guard=spawn(path.join(installPath,"BTR_Guard.exe"),["guard"],{env:f.env,stdio:"ignore"});
    const exited=new Promise(resolve=>guard.once("exit",code=>resolve(code)));
    const click=async label=>{const r=await run([path.join(__dirname,"click-button.ps1"),"-ProcessId",String(guard.pid),"-Button",label,"-TimeoutSeconds","60"],process.env,90000);assert.equal(r.code,0,`No guard prompt with ${label}: ${r.stdout}${r.stderr}`);return r.stdout;};
    await sleep(2500);
    // An official full installer writes an unpatched app.asar.
    fs.writeFileSync(f.asar,f.original);
    assert.match(await click("重新接入 BTR"),/BTR 提示/);
    const log=await waitForWorker(f,"reconnect-",90000);
    assertPhases(log,["compatibility","closing","install","validate","restart","complete"]);assert.match(log,/Worker exit 0/);
    assert.doesNotMatch(log,/"phase":"(manifest|download)"/);
    const status=await execute(path.join(installPath,"BTR_Desktop.exe"),["status","--client",f.client,"--noninteractive"],f.env);
    assert.equal(JSON.parse(status.stdout).current,true,status.stdout+status.stderr);
    assert.deepEqual(fs.readFileSync(f.asar),patched);
    assert.ok(await waitForFile(f.marker),"Reconnect did not reopen the client");
    console.log("PASS guard noticed the replaced client, reconnected through the maintenance window and reopened the client");
    // Declining is remembered for this exact client file, so the guard does not keep asking.
    await sleep(9000);
    fs.writeFileSync(f.asar,f.original);
    await click("这次不用");
    await sleep(1000);
    const state=JSON.parse(fs.readFileSync(path.join(f.localData,"BTR_Desktop/guard.json"),"utf8"));
    assert.ok(state.declined);assert.deepEqual(fs.readFileSync(f.asar),f.original);
    assert.equal(readLog(f,"reconnect-"),log,"Declining must not start another reconnect");
    console.log("PASS declining leaves the official client unchanged and is remembered");
    // Uninstalling removes current.json. The guard then exits by itself.
    fs.unlinkSync(f.pointer);
    const code=await Promise.race([exited,sleep(15000).then(()=>"still running")]);
    assert.equal(code,0);
    console.log("PASS guard exits once its installation record is gone");
  }finally{cleanup(f,before);}
});
