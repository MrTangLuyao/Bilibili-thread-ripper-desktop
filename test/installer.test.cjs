"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {Asar}=require("../tools/asar.cjs");
test("Windows PowerShell IEX installer completes against an isolated client",{skip:process.platform!=="win32",timeout:90000},()=>{
  const root=path.resolve(__dirname,".."),dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-iex-test-"));
  try {
    const client=path.join(dir,"client");fs.mkdirSync(path.join(client,"resources"),{recursive:true});
    const json=Buffer.from('{"files":{}}'),padded=Math.ceil((json.length+4)/4)*4,bytes=Buffer.alloc(padded+12);
    bytes.writeUInt32LE(4);bytes.writeUInt32LE(padded+4,4);bytes.writeUInt32LE(padded,8);bytes.writeUInt32LE(json.length,12);json.copy(bytes,16);
    const a=new Asar(bytes);a.set("package.json",'{"name":"bilibili","version":"1.18.0"}');a.set("index.js","original();");a.set("render/player.html","<html>original</html>");fs.writeFileSync(path.join(client,"resources","app.asar"),a.pack());
    const file=path.join(__dirname,"Fixture.cs");
    const compile=spawnSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",["/nologo","/target:exe",`/out:${path.join(client,"哔哩哔哩.exe")}`,file],{encoding:"utf8",windowsHide:true});assert.equal(compile.status,0,compile.stdout+compile.stderr);
    const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText('${path.join(__dirname,"installer-harness.ps1").replace(/'/g,"''")}'))) -Project '${root.replace(/'/g,"''")}' -Fixture '${dir.replace(/'/g,"''")}'`;
    const run=spawnSync("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(command,"utf16le").toString("base64")],{encoding:"utf8",windowsHide:true,timeout:75000,env:{...process.env,BTR_TEST_NODE:process.execPath,BTR_TEST_LAUNCH_MARKER:path.join(dir,"official-launch.txt")}});
    assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/PASS Windows PowerShell/);console.log(run.stdout.trim());
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
