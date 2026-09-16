"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Asar, sha } = require("../tools/asar.cjs");
const { patch, inspect, run } = require("../tools/client-package.cjs");
const { check, validateManifest, RAW } = require("../tools/update-provider.cjs");
const vm = require("node:vm");
const PREFIX = 'try{require("./btr-desktop/bootstrap.cjs")}catch(error){console.error("BTR bootstrap:",error&&error.message)}\n';
function clientArchive(version, extra = {}) {
  const a = emptyArchive(); a.set("package.json", JSON.stringify({ name: "bilibili", version, ...extra }));
  return a;
}
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
  assert.equal(result.text("index.js"), PREFIX + "originalEntry();");
  assert.match(result.text("btr-desktop/preload.cjs"), /bilipc/);
  assert.equal(inspect(result).installed.version, "0.9.1.1-d1");
  assert.match(result.text("btr-desktop/preload.cjs"), /event.isTrusted/);
  assert.match(result.text("btr-desktop/update-config.json"), /installerSha256/);
  assert.throws(() => result.set("../escape", "x"), /Unsafe/);
  assert.throws(() => result.set("C:/escape", "x"), /Unsafe/);
});
test("any client version with a plain entry is patched; unknown structures fail closed", () => {
  const future = clientArchive("99.0.0"); future.set("index.js", "future();");
  const patched = new Asar(patch(new Asar(future.pack()), Buffer.from("x"), {}));
  assert.equal(patched.text("index.js"), PREFIX + "future();");
  assert.equal(inspect(patched).clientVersion, "99.0.0");
  // Electron honours package.json main; the prefix must resolve from that folder.
  const moved = clientArchive("2.0.0", { main: "./dist/main" }); moved.set("dist/main.js", "moved();");
  const movedPatch = new Asar(patch(new Asar(moved.pack()), Buffer.from("x"), {}));
  assert.equal(movedPatch.text("dist/main.js"), PREFIX.replace("./btr-desktop", "../btr-desktop") + "moved();");
  assert.equal(inspect(movedPatch).entry, "dist/main.js");
  // No entry, a compiled entry, an unsafe entry or another app: leave the official files alone.
  const missing = clientArchive("3.0.0"); missing.set("render/player.html", "<html></html>");
  const bytecode = clientArchive("3.0.0", { main: "main.jsc" }); bytecode.set("main.jsc", "binary");
  const unsafe = clientArchive("3.0.0", { main: "../escape.js" });
  for (const archive of [missing, bytecode, unsafe]) {
    assert.equal(inspect(new Asar(archive.pack())).entry, null);
    assert.throws(() => patch(new Asar(archive.pack()), Buffer.from("x"), {}), /入口结构/);
  }
  const other = emptyArchive(); other.set("package.json", '{"name":"other","version":"1.18.0"}'); other.set("index.js", "x();");
  assert.throws(() => patch(new Asar(other.pack()), Buffer.from("x"), {}), /不是官方/);
  // A BOM and a strict-mode directive stay in front of the BTR prefix.
  const strict = clientArchive("4.0.0"); strict.set("index.js", "﻿'use strict';\nstrictEntry();");
  assert.equal(new Asar(patch(new Asar(strict.pack()), Buffer.from("x"), {})).text("index.js"), "﻿'use strict';\n" + PREFIX + "strictEntry();");
  // A failing BTR bootstrap is logged and the official entry still runs.
  const errors = [], ran = [];
  vm.runInNewContext(PREFIX + "ran.push('official');", { ran, require: () => { throw Error("broken BTR"); }, console: { error: (...args) => errors.push(args.join(" ")) } });
  assert.deepEqual(ran, ["official"]); assert.match(errors[0], /broken BTR/);
});

test("isolated preload bridges checks but only real user clicks can request installation", async () => {
  const a=emptyArchive();a.set("package.json",'{"name":"bilibili","version":"1.18.0"}');a.set("index.js","original();");a.set("render/player.html","<html></html>");
  const archive=new Asar(patch(new Asar(a.pack()),Buffer.from("window.BTR=true"),{})),code=archive.text("btr-desktop/preload.cjs");
  function runPreload(isMainFrame=true,origin="https://bilipc.bilibili.com") {
    const events={},calls=[],messages=[],scripts=[],window={addEventListener:(type,fn)=>{const old=events[type];events[type]=async e=>{await old?.(e);await fn(e);};},postMessage:value=>messages.push(value)};
    const document={documentElement:{},head:{appendChild:script=>scripts.push(script.textContent)},addEventListener:(type,fn)=>events[type]=fn,createElement:()=>({remove(){}})};
    vm.runInNewContext(code,{process:{isMainFrame},location:{origin,pathname:"/index.html"},window,document,MutationObserver:class{observe(){}disconnect(){}},require:()=>({ipcRenderer:{on(){},invoke:async name=>{calls.push(name);return {state:"current"};}}})});
    return {events,calls,messages,scripts,window};
  }
  const s=runPreload();assert.deepEqual(s.scripts,["window.BTR=true"]);
  await s.events.message({source:s.window,data:{channel:"__BTR_DESKTOP_UPDATE__",type:"check"}});
  const target={closest:()=>({id:"btr-desktop-install-update"})};await s.events.click({isTrusted:false,target});assert.deepEqual(s.calls,["btr-desktop:update-check"]);
  await s.events.click({isTrusted:true,target});assert.deepEqual(s.calls,["btr-desktop:update-check","btr-desktop:update-install"]);
  const removeTarget={closest:()=>({id:"btr-desktop-uninstall"})};await s.events.click({isTrusted:false,target:removeTarget});assert.equal(s.calls.length,2);
  await s.events.click({isTrusted:true,target:removeTarget});assert.equal(s.calls.at(-1),"btr-desktop:uninstall");
  assert.equal(s.messages.length,5);assert.equal(runPreload(false).scripts.length,0);assert.equal(runPreload(true,"https://evil.test").scripts.length,0);
  await s.events.message({source:s.window,data:{channel:"__BTR_DESKTOP_UPDATE__",type:"configure-auto",enabled:true}});
  assert.equal(s.calls.at(-1),"btr-desktop:auto-config");
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
    const beforeRemoval=fs.readFileSync(target);
    assert.equal(run("check-remove", dir).state, "ready-to-remove");
    assert.deepEqual(fs.readFileSync(target),beforeRemoval);
    const record=JSON.parse(fs.readFileSync(path.join(dir,"resources/btr-desktop-backups/deployment.json")));
    const backup=path.join(dir,"resources/btr-desktop-backups",record.originalSha256+".asar");
    fs.writeFileSync(backup,Buffer.from("damaged"));
    assert.throws(()=>run("check-remove",dir));assert.throws(()=>run("remove",dir));assert.deepEqual(fs.readFileSync(target),beforeRemoval);
    fs.writeFileSync(backup,original);
    // A d4 deployment used an unguarded prefix. It is not current and repairs from the backup.
    const legacy = new Asar(fs.readFileSync(target));
    legacy.set("index.js", 'require("./btr-desktop/bootstrap.cjs");\noriginalEntry();');
    fs.writeFileSync(target, legacy.pack());
    assert.equal(run("status", dir).current, false);
    const deploymentFile = path.join(dir,"resources/btr-desktop-backups/deployment.json");
    fs.writeFileSync(deploymentFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(deploymentFile)), patchedSha256: sha(fs.readFileSync(target)) }));
    assert.equal(run("repair", dir).state, "installed");
    assert.equal(run("status", dir).current, true);
    assert.equal(new Asar(fs.readFileSync(target)).text("index.js"), PREFIX + "originalEntry();");
    assert.equal(run("remove", dir).state, "removed");
    assert.deepEqual(fs.readFileSync(target), original);
    // An official full installer brings a new build. It is patched, and only its own original is kept.
    const next = new Asar(original); next.set("package.json", '{"name":"bilibili","version":"99.0.0"}'); next.set("index.js", "nextEntry();");
    const updated = next.pack(); fs.writeFileSync(target, updated);
    assert.equal(run("status", dir).supported, true);
    const reconnected = run("repair", dir);
    assert.equal(reconnected.state, "installed"); assert.deepEqual(reconnected.removedBackups, [sha(original) + ".asar"]);
    assert.deepEqual(fs.readdirSync(path.join(dir,"resources/btr-desktop-backups")).sort(), [sha(updated) + ".asar", "deployment.json"].sort());
    assert.equal(run("status", dir).current, true);
    assert.equal(run("remove", dir).state, "removed");
    assert.deepEqual(fs.readFileSync(target), updated);
    // A build whose structure is not recognized stays exactly as the official installer left it.
    const strange = new Asar(original); strange.set("package.json", '{"name":"bilibili","version":"100.0.0","main":"app.jsc"}');
    const unknown = strange.pack(); fs.writeFileSync(target, unknown);
    assert.equal(run("status", dir).supported, false);
    assert.equal(run("repair", dir).state, "unsupported-client");
    assert.deepEqual(fs.readFileSync(target), unknown);
    assert.equal(run("remove", dir).state, "not-installed");
    assert.equal(run("check-remove", dir).state, "not-installed");
    assert.deepEqual(fs.readFileSync(target), unknown);
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
  // d5 no longer needs the client list; older updaters still get a valid one when present.
  const {supportedClientVersions,...withoutList}=manifest;
  assert.equal(validateManifest(withoutList).version,"0.9.1.1-d1");
  assert.throws(()=>validateManifest({...manifest,supportedClientVersions:["bad"]}),/legacy/);
  await assert.rejects(check(options,{},async()=>({ok:false,status:404})),/404/);
  await assert.rejects(check(options,{},async()=>({ok:true,text:async()=>"x".repeat(65537)})),/too large/);
  await assert.rejects(check(options,{},async()=>{throw Error("offline")}),/offline/);
});
