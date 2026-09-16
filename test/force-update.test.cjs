"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {sha}=require("../tools/asar.cjs");
const root=path.resolve(__dirname,"..");
test("force update runs through Windows PowerShell IEX without using the installed updater",{skip:process.platform!=="win32"},()=>{
  const quote=value=>"'"+value.replace(/'/g,"''")+"'";
  const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.join(__dirname,"force-update-harness.ps1"))}))) -Project ${quote(root)}`;
  const result=spawnSync("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(command,"utf16le").toString("base64")],{encoding:"utf8",windowsHide:true,detached:false,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS force-update/);
});
test("release package includes the force-update script next to the installer",{skip:process.platform!=="win32"},()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,"latest.json"))),archive=path.join(root,"packages",`BTR_Desktop-${manifest.version}.zip`);
  assert.equal(sha(fs.readFileSync(archive)),manifest.sha256);
  for(const file of ["force-update.ps1","install.ps1"]){
    const result=spawnSync("C:/Program Files/7-Zip/7z.exe",["x","-so",archive,"BTR_Desktop/"+file],{windowsHide:true});
    assert.equal(result.status,0,result.stderr.toString());assert.deepEqual(result.stdout,fs.readFileSync(path.join(root,file)));
  }
  const readme=fs.readFileSync(path.join(root,"README.md"),"utf8");
  assert.match(readme,/## 强制更新（如遇到更新异常使用脚本更新）：/);
  assert.match(readme,/main\/force-update\.ps1 \| iex/);
});
