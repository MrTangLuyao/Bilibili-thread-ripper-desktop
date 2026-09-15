"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Asar, sha } = require("../tools/asar.cjs");
const { patch, inspect, run } = require("../tools/client-package.cjs");
const { check, validateManifest, RAW } = require("../tools/update-provider.cjs");
const vm = require("node:vm");
function emptyArchive() {
  const json = Buffer.from('{"files":{}}'), padded = Math.ceil((json.length + 4) / 4) * 4;
  const bytes = Buffer.alloc(padded + 12); bytes.writeUInt32LE(4); bytes.writeUInt32LE(padded + 4, 4); bytes.writeUInt32LE(padded, 8); bytes.writeUInt32LE(json.length, 12); json.copy(bytes, 16);
  return new Asar(bytes);
}
test("ASAR preserves existing bytes and embeds new resources with integrity", () => {
  const a = emptyArchive(); a.set("package.json", '{"name":"bilibili","version":"1.18.0"}');
  a.set("index.js", "originalEntry();");
  a.set("render/index.html", "<html><head></head><body>INDEX</body></html>");
  a.set("render/player.html", "<html><head></head><body>PLAYER</body></html>");
  const binary = crypto.randomBytes(513); a.set("original.bin", binary);
  const original = new Asar(a.pack());
  const result = new Asar(patch(original, Buffer.from("window.BTR=true"), { version: "0.9.1.1-d1" }));
  assert.deepEqual(result.read("original.bin"), binary);
  assert.equal(result.entry("btr-desktop/desktop.js").integrity.hash, sha("window.BTR=true"));
  assert.equal(result.text("render/player.html"), "<html><head></head><body>PLAYER</body></html>");
  assert.equal(result.text("index.js"), 'require("./btr-desktop/bootstrap.cjs");\noriginalEntry();');
  assert.match(result.text("btr-desktop/preload.cjs"), /bilipc/);
  assert.equal(inspect(result).installed.version, "0.9.1.1-d1");
  assert.match(result.text("btr-desktop/preload.cjs"), /event.isTrusted/);
  assert.match(result.text("btr-desktop/update-config.json"), /installerSha256/);
  assert.throws(() => result.set("../escape", "x"), /Unsafe/);
  assert.throws(() => result.set("C:/escape", "x"), /Unsafe/);
});
test("unknown client builds fail closed", () => {
  const a = emptyArchive(); a.set("package.json", '{"name":"bilibili","version":"99.0.0"}');
  assert.throws(() => patch(new Asar(a.pack()), Buffer.from("x"), {}), /暂未适配/);
});

test("isolated preload bridges checks but only real user clicks can request installation", async () => {
  const a=emptyArchive();a.set("package.json",'{"name":"bilibili","version":"1.18.0"}');a.set("index.js","original();");a.set("render/player.html","<html></html>");
  const archive=new Asar(patch(new Asar(a.pack()),Buffer.from("window.BTR=true"),{})),code=archive.text("btr-desktop/preload.cjs");
  function runPreload(isMainFrame=true,origin="https://bilipc.bilibili.com") {
    const events={},calls=[],messages=[],scripts=[],window={addEventListener:(type,fn)=>events[type]=fn,postMessage:value=>messages.push(value)};
    const document={documentElement:{},head:{appendChild:script=>scripts.push(script.textContent)},addEventListener:(type,fn)=>events[type]=fn,createElement:()=>({remove(){}})};
    vm.runInNewContext(code,{process:{isMainFrame},location:{origin,pathname:"/index.html"},window,document,MutationObserver:class{observe(){}disconnect(){}},require:()=>({ipcRenderer:{invoke:async name=>{calls.push(name);return {state:"current"};}}})});
    return {events,calls,messages,scripts,window};
  }
  const s=runPreload();assert.deepEqual(s.scripts,["window.BTR=true"]);
  await s.events.message({source:s.window,data:{channel:"__BTR_DESKTOP_UPDATE__",type:"check"}});
  const target={closest:()=>true};await s.events.click({isTrusted:false,target});assert.deepEqual(s.calls,["btr-desktop:update-check"]);
  await s.events.click({isTrusted:true,target});assert.deepEqual(s.calls,["btr-desktop:update-check","btr-desktop:update-install"]);
  assert.equal(s.messages.length,2);assert.equal(runPreload(false).scripts.length,0);assert.equal(runPreload(true,"https://evil.test").scripts.length,0);
});
test("installation repair survives an official overwrite and removal restores exact bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-install-test-"));
  const target = path.join(dir, "resources", "app.asar");
  fs.mkdirSync(path.dirname(target));
  const a = emptyArchive();
  a.set("package.json", '{"name":"bilibili","version":"1.18.0"}');
  a.set("index.js", "originalEntry();"); a.set("render/player.html", "<html>PLAYER</html>");
  const original = a.pack();
  fs.writeFileSync(target, original);
  try {
    assert.equal(run("install", dir).state, "installed");
    assert.equal(run("status", dir).current, true);
    const installed = fs.readFileSync(target);
    assert.equal(run("install", dir).state, "current");
    assert.deepEqual(fs.readFileSync(target), installed);
    fs.writeFileSync(target, original); // The official updater replaces the supported build.
    assert.equal(run("status", dir).current, false);
    assert.equal(run("repair", dir).state, "installed");
    assert.equal(run("remove", dir).state, "removed");
    assert.deepEqual(fs.readFileSync(target), original);
    const unknown = new Asar(original); unknown.set("package.json", '{"name":"bilibili","version":"99.0.0"}');
    const updated = unknown.pack(); fs.writeFileSync(target, updated);
    assert.equal(run("repair", dir).state, "unsupported-client");
    assert.deepEqual(fs.readFileSync(target), updated);
    assert.equal(run("remove", dir).state, "not-installed");
    assert.deepEqual(fs.readFileSync(target), updated);
  } finally { fs.rmSync(dir, {recursive:true}); }
});
test("repository updates use exact version inequality including rollback", async () => {
  let calls = 0;
  assert.equal((await check({ enabled: false }, {}, () => { calls++; })).state, "not-configured"); assert.equal(calls, 0);
  const manifest = {schema:1,version:"0.9.1.1-d1",sha256:"a".repeat(64),downloadUrl:RAW+"packages/BTR_Desktop-0.9.1.1-d1.zip",supportedClientVersions:["1.18.0"]};
  const options={enabled:true,manifestUrl:RAW+"latest.json"};
  const fakeFetch=async(url,init)=>{assert.ok(url.startsWith(RAW+"latest.json?t="));assert.equal(init.redirect,"error");assert.equal(init.credentials,"omit");return{ok:true,text:async()=>JSON.stringify(manifest)}};
  assert.equal((await check(options,{version:"0.9.1.1-d1"},fakeFetch)).state,"current");
  for(const version of ["0.9.1.1", "0.9.1.1-d2", "0.9.2.0-d1"]) assert.equal((await check(options,{version},fakeFetch)).state,"available");
  assert.throws(()=>validateManifest({...manifest,downloadUrl:"https://evil.example/pkg.zip"}),/repository/);
  assert.throws(()=>validateManifest({...manifest,version:"../escape"}),/version/);
  await assert.rejects(check(options,{},async()=>({ok:false,status:404})),/404/);
  await assert.rejects(check(options,{},async()=>({ok:true,text:async()=>"x".repeat(65537)})),/too large/);
  await assert.rejects(check(options,{},async()=>{throw Error("offline")}),/offline/);
});
