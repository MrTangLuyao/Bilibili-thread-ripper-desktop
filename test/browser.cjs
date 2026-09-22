"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const html = '<html><head><script src="/desktop.js"></script></head><body><div class="app_settings"><div class="settings_content"><div class="settings_content--item login-item">Account</div><div class="settings_content--item theme-item"><h4>常规设置</h4></div></div><nav class="settings_catalog"><button>常规设置</button></nav></div></body></html>';
const server = http.createServer((req, res) => { res.setHeader("Content-Type", req.url === "/desktop.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"); res.end(req.url === "/desktop.js" ? fs.readFileSync(path.join(root, "dist/desktop.js")) : html); });
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const context = await browser.newContext(), page = await context.newPage(); const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("PAGE ERROR", error.message); });
    let requestCount = 0, failure = false, deadHost = "";
    const hostHits = new Map();
    await context.route(/https:\/\/.*\.bilivideo\.com\//, async route => {
      requestCount++;
      const host = new URL(route.request().url()).hostname;
      hostHits.set(host, (hostHits.get(host) || 0) + 1);
      const match = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range || "");
      if (!match) return route.fulfill({ status: 200, body: "native" });
      // A dead node answers without sending a single media byte.
      if (host === deadHost) return route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
      if (failure && !route.request().headers()["x-btr-native-fallback"]) return route.fulfill({ status: 503, body: "failed" });
      const start = Number(match[1]), end = Number(match[2]), bytes = Buffer.alloc(end - start + 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
      if (route.request().url().includes("slow")) await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ status: 206, headers: { "Content-Range": `bytes ${start}-${end}/8388608`, "Content-Length": String(bytes.length), "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range,Content-Length", "Content-Type": "video/mp4" }, body: bytes });
    });
    await page.goto(origin); await page.locator("#btr-desktop-settings").waitFor();
    const fresh = await page.evaluate(() => __BTR_DESKTOP__.getSettings());
    assert.deepEqual([fresh.mode, fresh.concurrency, fresh.errorNotices, fresh.debugNotices], ["mainland", 8, false, false]);
    assert.equal(await page.locator("#btr-desktop-settings output").textContent(), "8");
    // 自动线程数 is on by default; the slider is then the manual choice, greyed out.
    assert.equal(fresh.autoConcurrency, true);
    assert.equal(await page.locator("[data-setting=autoConcurrency]").isChecked(), true);
    assert.match(await page.locator("[data-setting=autoConcurrency]").locator("xpath=../following-sibling::span").textContent(), /BTR将智能选择需要的线程数。/);
    assert.equal(await page.locator("#btr-desktop-threads").isDisabled(), true);
    // Live acceleration is not in the client yet: a grey switch that cannot be ticked, and a
    // line saying where it already works.
    assert.equal(await page.locator("#btr-desktop-live").isDisabled(), true);
    assert.equal(await page.locator("#btr-desktop-live").isChecked(), false);
    assert.equal(await page.locator(".btr-live-row label").textContent(), "直播加速（敬请期待）");
    assert.equal(await page.locator(".btr-live-row .btr-note").textContent(), "直播加速已可在网页版中使用");
    assert.equal(await page.locator('[data-mode="mainland"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-setting=autoCheckUpdates]').isChecked(),true);
    assert.equal(await page.evaluate(()=>__BTR_DESKTOP__.getUpdate().state),"idle");
    await page.locator('[data-setting=autoCheckUpdates]').uncheck();
    await page.reload();
    assert.equal(await page.locator('[data-setting=autoCheckUpdates]').isChecked(),false);
    assert.equal(await page.evaluate(()=>__BTR_DESKTOP__.getUpdate().state),"idle");
    assert.equal(await page.locator(".settings_catalog button").first().textContent(), "线程撕裂者");
    assert.equal(await page.locator("#btr-desktop-settings + .theme-item").count(), 1);
    assert.equal(await page.locator("#btr-desktop-check-update + #btr-desktop-uninstall").textContent(), "卸载 BTR");
    const buttons = await page.evaluate(() => {
      const check=document.querySelector('#btr-desktop-check-update'),remove=document.querySelector('#btr-desktop-uninstall');
      const a=check.getBoundingClientRect(),b=remove.getBoundingClientRect();
      return {after:b.left>a.right,sameRow:Math.abs(a.top-b.top)<1,color:getComputedStyle(remove).backgroundColor};
    });
    assert.deepEqual(buttons,{after:true,sameRow:true,color:"rgb(185, 56, 67)"});
    assert.equal(await page.locator("[data-setting=errorNotices]").isChecked(), false);
    await page.locator("[data-setting=debugNotices]").check();
    assert.equal(await page.locator("[data-category]:checked").count(), 6);
    await page.locator("[data-category=download]").uncheck();
    await page.reload();
    assert.equal(await page.locator("[data-category=download]").isChecked(), false);
    const second = await context.newPage(); await second.goto(origin);
    assert.equal(await second.locator('[data-setting=autoCheckUpdates]').isChecked(),false);
    await page.locator('[data-setting=autoCheckUpdates]').check();
    await second.waitForFunction(()=>__BTR_DESKTOP__.getSettings().autoCheckUpdates===true);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ concurrency: 16 }));
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().concurrency === 16);
    console.log("PASS settings first entry, defaults, category persistence and cross-window synchronization");
    await page.evaluate(() => {
      const menu = document.createElement("div"); menu.className = "bpx-player-ctrl-setting-menu-right";
      menu.innerHTML = '<div class="bpx-player-ctrl-setting-others">其他设置</div>'; document.body.append(menu);
    });
    await page.locator("#btr-desktop-player-settings").waitFor();
    assert.equal(await page.locator("#btr-desktop-player-settings + .bpx-player-ctrl-setting-others").count(), 1);
    // The player menu shows 自动 first and checked; a number switches it off.
    assert.equal(await page.locator('[name="btr-desktop-player-concurrency"]').first().getAttribute("value"), "auto");
    assert.equal(await page.locator('[name="btr-desktop-player-concurrency"][value="auto"]').isChecked(), true);
    await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().concurrency === 64 && __BTR_DESKTOP__.getSettings().autoConcurrency === false);
    assert.equal(await page.locator("#btr-desktop-settings output").textContent(), "64");
    assert.equal(await page.locator("[data-setting=autoConcurrency]").isChecked(), false);
    assert.equal(await page.locator("#btr-desktop-threads").isDisabled(), false);
    await page.locator('[name="btr-desktop-player-concurrency"][value="auto"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().autoConcurrency === true && __BTR_DESKTOP__.getSettings().concurrency === 64);
    assert.equal(await page.locator("[data-setting=autoConcurrency]").isChecked(), true);
    await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().autoConcurrency === false);
    await page.locator('[name="btr-desktop-player-mode"][value="overseas"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().mode === "overseas");
    await page.evaluate(() => { const old=document.querySelector('.bpx-player-ctrl-setting-menu-right'); const next=old.cloneNode(false); next.innerHTML='<div class="bpx-player-ctrl-setting-others">其他设置</div>'; old.replaceWith(next); });
    await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').waitFor();
    assert.equal(await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').isChecked(), true);
    assert.equal(await page.locator('[name="btr-desktop-player-mode"][value="overseas"]').isChecked(), true);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({concurrency:16,mode:"mainland"}));
    console.log("PASS native player CDN/thread settings persist, synchronize and remount after switching");
    // 自动线程数 in the client: its own video element stalls once playing has started, and the
    // thread count the transport hands the downloader goes up. Off, a stall changes nothing;
    // a stall before the first frame is startup, not a stall.
    const autoSignals = await page.evaluate(async () => {
      const auto = __BILI_IDM_DOWNLOADER_FACTORY__.autoConcurrency;
      const video = document.createElement("video"); document.body.append(video);
      let paused = false; Object.defineProperty(video, "paused", { get: () => paused });
      const listeners = {};
      window.biliPlayer = { getManifest: () => ({ bvid: "BVauto", cid: 7 }), mediaElement: () => video, on: (name, fn) => { listeners[name] = fn; } };
      __BTR_DESKTOP__.synchronizePlayer();
      const threads = () => __BTR_DESKTOP__.transport.snapshot().threads;
      const stall = () => video.dispatchEvent(new Event("waiting"));
      const until = async (condition, ms) => { const end = performance.now() + ms; while (performance.now() < end && !condition()) { stall(); await new Promise(r => setTimeout(r, 100)); } return condition(); };
      __BTR_DESKTOP__.setSettings({ autoConcurrency: false, concurrency: 16 });
      video.dispatchEvent(new Event("playing"));
      await until(() => false, 3000);
      const whenOff = { level: auto.threads(), transport: threads() };
      __BTR_DESKTOP__.setSettings({ autoConcurrency: true });
      video.dispatchEvent(new Event("seeking"));
      await until(() => false, 600);
      const beforeFirstFrame = auto.threads();
      video.dispatchEvent(new Event("playing"));
      const stepped = await until(() => auto.threads() > 8, 4000);
      const result = { whenOff, beforeFirstFrame, stepped, level: auto.threads(), transport: threads(), status: __BTR_DESKTOP__.getStatus().autoThreads?.threads };
      window.biliPlayer = undefined; listeners.Player_Dispose?.(); video.remove();
      __BTR_DESKTOP__.setSettings({ autoConcurrency: false, concurrency: 16 });
      return result;
    });
    assert.deepEqual(autoSignals.whenOff, { level: 8, transport: 16 }, "switched off, a stall must not change anything");
    assert.equal(autoSignals.beforeFirstFrame, 8, "waiting before the first frame is startup, not a stall");
    assert.equal(autoSignals.stepped, true);
    assert.equal(autoSignals.transport, autoSignals.level, "the transport hands the downloader the controller's count");
    assert.equal(autoSignals.status, autoSignals.level);
    console.log("PASS automatic threads: the client's video element stalls, the count steps up to", autoSignals.level, "and the transport uses it; off or before the first frame nothing changes");
    // Custom CDN: known servers are ticked, others typed in; only Bilibili's video servers are accepted.
    assert.equal(await page.locator(".btr-custom").isVisible(), false);
    await page.locator('#btr-desktop-settings [data-mode="custom"]').click();
    assert.equal(await page.locator('#btr-desktop-settings [data-mode="custom"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".btr-custom").isVisible(), true);
    assert.equal(await page.locator(".btr-custom-empty").isVisible(), true);
    assert.equal(await page.locator("#btr-desktop-settings [data-host]").count(), 12);
    assert.equal(await page.locator('[name="btr-desktop-player-mode"][value="custom"]').isChecked(), true);
    assert.match(await page.locator("#btr-desktop-player-settings .btr-custom-hint").textContent(), /还没选服务器/);
    await page.locator('[data-host="upos-sz-mirrorcos.bilivideo.com"]').check();
    assert.equal(await page.locator(".btr-custom-empty").isVisible(), false);
    for (const [typed, message] of [["https://example.com/a.m4s", "这不是 B 站的视频服务器地址。"], ["upos-sz-mirrorcos.bilivideo.com", "这个服务器已经在列表里了。"]]) {
      await page.locator("#btr-desktop-host").fill(typed); await page.locator("#btr-desktop-host-add").click();
      assert.equal(await page.locator(".btr-host-error").textContent(), message);
    }
    await page.locator("#btr-desktop-host").fill("https://UPOS-sz-mirrorcoso1.bilivideo.com/upgcxcode/x.m4s?sign=1"); await page.locator("#btr-desktop-host").press("Enter");
    assert.equal(await page.locator(".btr-host-error").textContent(), "");
    assert.equal(await page.locator("#btr-desktop-host").inputValue(), "");
    assert.equal(await page.locator(".btr-manual-host span").textContent(), "upos-sz-mirrorcoso1.bilivideo.com");
    await second.waitForFunction(() => JSON.stringify(__BTR_DESKTOP__.getSettings().customHosts) === '["upos-sz-mirrorcos.bilivideo.com","upos-sz-mirrorcoso1.bilivideo.com"]');
    assert.match(await page.locator("#btr-desktop-player-settings .btr-custom-hint").textContent(), /已选 2 个服务器/);
    await page.reload();
    assert.equal(await page.locator('[data-host="upos-sz-mirrorcos.bilivideo.com"]').isChecked(), true);
    assert.equal(await page.locator(".btr-manual-host").count(), 1);
    await page.locator("#btr-desktop-settings").screenshot({path:path.join(root,"test-output","custom-cdn.png")});
    await page.locator(".btr-manual-host button").click();
    assert.equal(await page.locator(".btr-manual-host").count(), 0);
    assert.deepEqual(await page.evaluate(() => __BTR_DESKTOP__.getSettings().customHosts), ["upos-sz-mirrorcos.bilivideo.com"]);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ customHosts: Array.from({ length: 40 }, (_, i) => `upos-sz-test${i}.bilivideo.com`).concat("evil.example.com") }));
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getSettings().customHosts.length), 32);
    await page.locator('[data-host="upos-sz-mirrorali.bilivideo.com"]').click();
    assert.equal(await page.locator('[data-host="upos-sz-mirrorali.bilivideo.com"]').isChecked(), false);
    assert.equal(await page.locator(".btr-host-error").textContent(), "最多选 32 个服务器。");
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ mode: "mainland", customHosts: [] }));
    assert.equal(await page.locator(".btr-custom").isVisible(), false);
    console.log("PASS custom CDN: known and typed servers, refusal of other sites, limit of 32, persistence and synchronization");
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"available",message:"发现 0.9.1.1-d2",manifest:{version:"0.9.1.1-d2"}}},location.origin));
    await page.locator("#btr-desktop-install-update").waitFor({state:"visible"});
    assert.equal(await page.locator("#btr-desktop-install-update").textContent(), "更新到 0.9.1.1-d2");
    await page.locator("#btr-desktop-check-update").click();
    assert.equal(await page.locator("#btr-desktop-check-update").isDisabled(),true);
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"error",message:"测试网络失败"}},location.origin));
    await page.waitForFunction(() => !document.querySelector('#btr-desktop-check-update').disabled);
    assert.equal(await page.locator("#btr-desktop-install-update").isVisible(),false);
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"current",message:"当前已是最新版本"}},location.origin));
    await page.waitForFunction(() => document.querySelector('.btr-update-status').textContent === '当前已是最新版本');
    console.log("PASS update states: available, checking, error retry and current version");
    for (const state of ["confirming","uninstalling"]) {
      await page.evaluate(state => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state,message:"卸载测试"}},location.origin),state);
      await page.waitForFunction(() => document.querySelector('#btr-desktop-uninstall').disabled);
      assert.equal(await page.locator("#btr-desktop-check-update").isDisabled(),true);
      assert.equal(await page.locator("#btr-desktop-install-update").isVisible(),false);
    }
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"idle",message:"已取消卸载 BTR"}},location.origin));
    await page.waitForFunction(() => !document.querySelector('#btr-desktop-uninstall').disabled);
    assert.equal(await page.locator("#btr-desktop-check-update").isDisabled(),false);
    const images=path.join(root,"test-output");fs.mkdirSync(images,{recursive:true});
    await page.locator("#btr-desktop-settings").screenshot({path:path.join(images,"d3-settings.png")});
    console.log("PASS red uninstall button is immediately right of check update; confirmation and uninstall lock controls, cancellation restores them");
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ debugNotices: false }));
    const fetchResult = await page.evaluate(async () => {
      const response = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/a.m4s", { headers: { Range: "bytes=0-1048575" } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { ok: bytes.every((n, i) => n === i % 251), length: bytes.length, status: response.status, range: response.headers.get("content-range"), stats: __BTR_DESKTOP__.transport.snapshot() };
    });
    assert.equal(fetchResult.ok, true); assert.equal(fetchResult.length, 1048576); assert.equal(fetchResult.status, 206); assert.equal(fetchResult.range, "bytes 0-1048575/8388608"); assert.ok(fetchResult.stats.maxThreads > 1);
    console.log("PASS real shared downloader splits and recombines 1 MiB byte-exactly", fetchResult.stats.maxThreads);
    const xhr = await page.evaluate(() => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); const states = [], events = [];
      x.open("GET", "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/b.m4s"); x.responseType = "arraybuffer"; x.setRequestHeader("Range", "bytes=1000-525287");
      x.onreadystatechange = () => { states.push(x.readyState); if (x.readyState === 2) events.push(x.getResponseHeader("content-range")); };
      x.onerror = reject; x.onload = () => resolve({ bytes: new Uint8Array(x.response).every((v,i) => v === (i + 1000) % 251), status: x.status, states, events }); x.send();
    }));
    assert.equal(xhr.bytes, true); assert.equal(xhr.status, 206); assert.deepEqual(xhr.states, [2,3,4]); assert.equal(xhr.events[0], "bytes 1000-525287/8388608");
    console.log("PASS native XHR events, headers, status and data");
    const savedUrl = await page.evaluate(async () => (await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/url.m4s", {headers:{Range:"bytes=0-1023"}})).url);
    assert.equal(savedUrl, "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/url.m4s");
    const reuse = await page.evaluate(() => new Promise((resolve,reject) => {
      const x = new XMLHttpRequest(); let loads = 0;
      x.open("GET", "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow.m4s"); x.responseType="arraybuffer"; x.setRequestHeader("Range", "bytes=0-1048575"); x.send();
      x.open("GET", "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/reused.m4s"); x.responseType="arraybuffer"; x.setRequestHeader("Range", "bytes=0-1023");
      x.onerror=reject; x.onload=()=>{loads++;setTimeout(()=>resolve({loads,length:x.response.byteLength}),250)}; x.send();
    })); assert.deepEqual(reuse,{loads:1,length:1024});
    console.log("PASS fetch response URL and reused XHR never deliver the old request");
    const abort = await page.evaluate(async () => {
      __BTR_DESKTOP__.transport.switchRoute("video-A:1");
      const promise = fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow.m4s", { headers: { Range: "bytes=0-1048575" } }).then(() => "stale", e => e.name);
      __BTR_DESKTOP__.transport.switchRoute("video-B:2");
      return promise;
    }); assert.equal(abort, "AbortError");
    console.log("PASS rapid video switch cancels old requests without stale delivery");
    // Two empty replies ban a node for this video; the next video starts clean.
    // Good nodes answer a little later, so the dead reply is not cancelled by a faster copy.
    deadHost = "upos-sz-mirrorhw.bilivideo.com";
    const banned = await page.evaluate(async () => {
      __BTR_DESKTOP__.transport.switchRoute("video-ban:1");
      for (let i = 0; i < 10 && !__BTR_DESKTOP__.transport.snapshot().bannedHosts.length; i++) {
        const response = await fetch(`https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow-ban-${i}.m4s`, { headers: { Range: "bytes=0-1048575" } });
        if ((await response.arrayBuffer()).byteLength !== 1048576) throw Error("wrong length");
      }
      return __BTR_DESKTOP__.transport.snapshot().bannedHosts;
    });
    assert.deepEqual(banned, [deadHost]);
    await page.waitForTimeout(300);
    const deadBefore = hostHits.get(deadHost);
    const afterBan = await page.evaluate(async () => {
      let bytes = 0;
      for (let i = 0; i < 3; i++) bytes += (await (await fetch(`https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow-after-ban-${i}.m4s`, { headers: { Range: "bytes=0-1048575" } })).arrayBuffer()).byteLength;
      return { bytes, fallbacks: __BTR_DESKTOP__.transport.snapshot().fallbackRequests };
    });
    assert.equal(afterBan.bytes, 3 * 1048576); assert.equal(afterBan.fallbacks, 0);
    assert.equal(hostHits.get(deadHost), deadBefore, "a banned node must not be asked again in the same video");
    assert.deepEqual(await page.evaluate(() => { __BTR_DESKTOP__.transport.switchRoute("video-ban:2"); return __BTR_DESKTOP__.transport.snapshot().bannedHosts; }), []);
    deadHost = "";
    console.log("PASS a node with two 0 KiB replies is banned for the current video, skipped afterwards and restored on the next video");
    // Custom mode asks only the picked servers, not even the one the client named. Going back
    // to another mode applies to the next request of the same video.
    const picked = ["upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorcoso1.bilivideo.com"];
    await page.waitForTimeout(300);
    const hitsSince = before => [...hostHits].filter(([host, count]) => count > (before.get(host) || 0)).map(([host]) => host).sort();
    let before = new Map(hostHits);
    const custom = await page.evaluate(async hosts => {
      __BTR_DESKTOP__.transport.switchRoute("video-custom:1");
      __BTR_DESKTOP__.setSettings({ mode: "custom", customHosts: hosts });
      let bytes = 0;
      for (const range of ["0-1048575", "1048576-2097151", "2097152-3145727"]) bytes += (await (await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/custom.m4s", { headers: { Range: `bytes=${range}` } })).arrayBuffer()).byteLength;
      return { bytes, fallbacks: __BTR_DESKTOP__.transport.snapshot().fallbackRequests };
    }, picked);
    assert.deepEqual(custom, { bytes: 3 * 1048576, fallbacks: 0 });
    await page.waitForTimeout(300);
    assert.deepEqual(hitsSince(before), picked);
    before = new Map(hostHits);
    const back = await page.evaluate(async () => {
      __BTR_DESKTOP__.setSettings({ mode: "mainland" });
      return (await (await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/custom.m4s", { headers: { Range: "bytes=3145728-4194303" } })).arrayBuffer()).byteLength;
    });
    assert.equal(back, 1048576);
    await page.waitForTimeout(300);
    assert.ok(hitsSince(before).some(host => !picked.includes(host)), "mainland mode must use its own nodes again");
    assert.ok(!hitsSince(before).includes(picked[1]), "a typed server must not be asked outside the custom mode");
    // Custom mode without any server works like the mainland mode.
    before = new Map(hostHits);
    const empty = await page.evaluate(async () => {
      __BTR_DESKTOP__.transport.switchRoute("video-custom:2");
      __BTR_DESKTOP__.setSettings({ mode: "custom", customHosts: [] });
      const length = (await (await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/custom-empty.m4s", { headers: { Range: "bytes=0-1048575" } })).arrayBuffer()).byteLength;
      const snapshot = __BTR_DESKTOP__.transport.snapshot();
      __BTR_DESKTOP__.setSettings({ mode: "mainland" });
      return { length, fallbacks: snapshot.fallbackRequests };
    });
    assert.deepEqual(empty, { length: 1048576, fallbacks: 0 });
    await page.waitForTimeout(300);
    assert.ok(hitsSince(before).length > 1);
    console.log("PASS custom CDN asks only the picked servers; a mode change applies to the next request; no server picked works like mainland");
    failure = true;
    const fallback = await page.evaluate(async () => {
      const response = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/fallback.m4s", { headers: { Range: "bytes=0-4095", "X-Btr-Native-Fallback": "yes" } });
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, fallback: __BTR_DESKTOP__.transport.snapshot().fallbackRequests };
    }); assert.equal(fallback.status, 206); assert.equal(fallback.bytes, 4096); assert.ok(fallback.fallback > 0);
    console.log("PASS failed acceleration returns to original client request without rewriting video source");
    // A future player that never works with BTR must not pay for a failed attempt on every request.
    const suspended = await page.evaluate(async () => {
      const first = __BTR_DESKTOP__.transport.snapshot();
      for (let i = 0; i < 6; i++) await fetch(`https://upos-sz-mirrorali.bilivideo.com/upgcxcode/fail-${i}.m4s`, { headers: { Range: "bytes=0-4095", "X-Btr-Native-Fallback": "yes" } });
      const after = __BTR_DESKTOP__.transport.snapshot();
      const response = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/native.m4s", { headers: { Range: "bytes=0-4095", "X-Btr-Native-Fallback": "yes" } });
      const last = __BTR_DESKTOP__.transport.snapshot();
      return { first: first.suspended, after: after.suspended, status: response.status, bytes: (await response.arrayBuffer()).byteLength, fallbacks: [after.fallbackRequests, last.fallbackRequests], fetches: [after.fetchRequests, last.fetchRequests] };
    });
    assert.equal(suspended.first, false); assert.equal(suspended.after, true); assert.equal(suspended.status, 206); assert.equal(suspended.bytes, 4096);
    assert.equal(suspended.fallbacks[1], suspended.fallbacks[0]); assert.equal(suspended.fetches[1], suspended.fetches[0]);
    console.log("PASS six failures in a row pause acceleration for the window; later requests go straight to the client");
    assert.deepEqual(errors, []);
    console.log("PASS no browser script errors; CDN requests", requestCount);
    // Settings saved by 0.9.1.1 move once to the new defaults; other choices are kept.
    const legacy = await browser.newContext();
    await legacy.addInitScript(() => {
      if (sessionStorage.getItem("btr-seeded")) return;
      sessionStorage.setItem("btr-seeded", "1");
      localStorage.setItem("BTR_Desktop.settings.v1", JSON.stringify({ enabled: true, concurrency: 32, mode: "overseas", debugNotices: true, errorNotices: true, debugCategories: { download: false }, autoCheckUpdates: false }));
    });
    const old = await legacy.newPage(); old.on("pageerror", error => errors.push(error.message));
    await old.goto(origin);
    const migrated = await old.evaluate(() => ({ settings: __BTR_DESKTOP__.getSettings(), stored: JSON.parse(localStorage.getItem("BTR_Desktop.settings.v1")) }));
    assert.deepEqual([migrated.settings.mode, migrated.settings.concurrency, migrated.settings.errorNotices, migrated.settings.debugNotices, migrated.settings.debugCategories.download, migrated.settings.autoCheckUpdates, migrated.stored.revision, migrated.stored.concurrency],
      ["mainland", 8, false, true, false, false, 2, 8]);
    await old.evaluate(() => __BTR_DESKTOP__.setSettings({ concurrency: 16, errorNotices: true }));
    await old.reload();
    assert.deepEqual(await old.evaluate(() => { const next = __BTR_DESKTOP__.getSettings(); return [next.concurrency, next.errorNotices, next.mode]; }), [16, true, "mainland"]);
    await legacy.close();
    assert.deepEqual(errors, []);
    console.log("PASS old settings move once to mainland CDN, 8 threads and hidden errors; later choices are kept");
    // 0.9.3.0: a piece that stops midway is finished by another node from where it stopped.
    // One node sends 70 % of every larger request and then hangs. The client's XHR must still
    // get exact bytes, and its progress must never go backwards or past the end while pieces
    // are resumed, copied and cancelled underneath.
    const stalling = await browser.newContext();
    await stalling.route(/https:\/\/.*\.bilivideo\.com\//, async route => {
      const match = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range || "");
      if (!match) return route.fulfill({ status: 200, body: "native" });
      const start = Number(match[1]), end = Number(match[2]), bytes = Buffer.alloc(end - start + 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
      await route.fulfill({ status: 206, headers: { "Content-Range": `bytes ${start}-${end}/8388608`, "Content-Length": String(bytes.length), "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range,Content-Length", "Content-Type": "video/mp4" }, body: bytes });
    });
    await stalling.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.__stallLog = [];
      window.fetch = (input, init = {}) => {
        const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
        const match = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers || {}).get("range") || "");
        if (!match) return realFetch(input, init);
        const start = Number(match[1]), end = Number(match[2]), length = end - start + 1;
        // A request for the rest of a piece the stalling node left unfinished.
        if (window.__stallLog.some(item => item.end === end && start > item.start)) window.__tails = (window.__tails || 0) + 1;
        if (new URL(url).hostname !== "upos-sz-mirrorhw.bilivideo.com" || length < 65536) return realFetch(input, init);
        window.__stallLog.push({ start, end });
        const stop = Math.floor(length * 0.7);
        let sent = 0;
        const body = new ReadableStream({
          pull(controller) {
            if (sent >= stop) return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
            const size = Math.min(16384, stop - sent), chunk = new Uint8Array(size);
            for (let i = 0; i < size; i++) chunk[i] = (start + sent + i) % 251;
            sent += size;
            controller.enqueue(chunk);
          }
        });
        return Promise.resolve(new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/8388608`, "Content-Type": "video/mp4" } }));
      };
    });
    const stalled = await stalling.newPage(); stalled.on("pageerror", error => errors.push(error.message));
    await stalled.goto(origin);
    const resumed = await stalled.evaluate(() => new Promise((resolve, reject) => {
      __BTR_DESKTOP__.setSettings({ autoConcurrency: false, concurrency: 32 });
      __BTR_DESKTOP__.transport.switchRoute("video-stall:1");
      const started = performance.now();
      const run = (index, results) => {
        const x = new XMLHttpRequest(), loaded = [];
        x.open("GET", `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/stall-${index}.m4s`); x.responseType = "arraybuffer";
        const first = index * 2097152; x.setRequestHeader("Range", `bytes=${first}-${first + 2097151}`);
        x.onprogress = event => loaded.push(event.loaded);
        x.onerror = reject;
        x.onload = () => {
          results.push({ exact: new Uint8Array(x.response).every((v, i) => v === (first + i) % 251), length: x.response.byteLength, status: x.status, loaded });
          if (index < 2) run(index + 1, results);
          else resolve({ results, ms: performance.now() - started, stallRequests: window.__stallLog.length, tails: window.__tails || 0, snapshot: __BTR_DESKTOP__.transport.snapshot() });
        };
        x.send();
      };
      run(0, []);
    }));
    for (const item of resumed.results) {
      assert.equal(item.exact, true); assert.equal(item.length, 2097152); assert.equal(item.status, 206);
      assert.ok(item.loaded.length > 1, "progress was reported while the pieces arrived");
      assert.ok(item.loaded.every((value, i) => value <= 2097152 && (i === 0 || value >= item.loaded[i - 1])), `progress only moves forward: ${item.loaded.slice(-6).join(",")}`);
    }
    assert.ok(resumed.stallRequests > 0, "the stalling node was used");
    assert.ok(resumed.tails > 0, "an unfinished piece was completed from where it stopped, not downloaded again");
    assert.equal(resumed.snapshot.fallbackRequests, 0);
    assert.ok(resumed.ms < 15000, `three 2 MiB ranges with a stalling node took ${Math.round(resumed.ms)} ms`);
    await stalling.close();
    assert.deepEqual(errors, []);
    console.log("PASS a node that stalls midway: exact bytes, no fallback, XHR progress never goes backwards;", resumed.stallRequests, "stalled requests,", resumed.tails, "resumed,", Math.round(resumed.ms), "ms");
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
