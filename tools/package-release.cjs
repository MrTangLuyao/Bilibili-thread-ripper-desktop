"use strict";
const fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {sha}=require("./asar.cjs"),{RAW,VERSION}=require("./update-provider.cjs");
const root=path.resolve(__dirname,".."),config=JSON.parse(fs.readFileSync(path.join(root,"desktop.json")));
if(!VERSION.test(config.version))throw Error("Invalid desktop version");
const files=["BTR_Desktop.exe","BTR_Guard.exe","desktop.json","install.ps1","force-update.ps1","README.md","LICENSE","docs/update-interface.md","docs/verification.md","docs/images/system-settings.png","docs/images/player-settings.png","dist/desktop.js","dist/payload.json","src/bootstrap.cjs","src/update-main.cjs","tools/asar.cjs","tools/client-package.cjs","tools/update-provider.cjs","tools/https-json.cjs"];
const staging=fs.mkdtempSync(path.join(root,"release-stage-")),directory=path.join(staging,"BTR_Desktop");
try {
  for(const file of files){const dest=path.join(directory,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest);}
  const temporary=path.join(staging,"package.zip");
  const result=spawnSync("C:/Program Files/7-Zip/7z.exe",["a","-tzip",temporary,"BTR_Desktop"],{cwd:staging,windowsHide:true,encoding:"utf8"});
  if(result.status!==0)throw Error(result.stderr||result.stdout||"7-Zip unavailable");
  const bytes=fs.readFileSync(temporary),packages=path.join(root,"packages");fs.mkdirSync(packages,{recursive:true});
  const name=`BTR_Desktop-${config.version}.zip`,archive=path.join(packages,name);
  fs.writeFileSync(archive,bytes);
  // d5 accepts any client structure it recognizes. The list only lets d1-d4 updaters reach d5.
  const manifest={schema:1,version:config.version,downloadUrl:RAW+"packages/"+name,sha256:sha(bytes),supportedClientVersions:config.legacyClientVersions};
  fs.writeFileSync(path.join(root,"latest.json"),JSON.stringify(manifest,null,2)+"\n");
  console.log(JSON.stringify({archive,files:files.length,...manifest},null,2));
} finally { fs.rmSync(staging,{recursive:true,force:true}); }
