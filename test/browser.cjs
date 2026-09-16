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
    let requestCount = 0, failure = false;
    await context.route(/https:\/\/.*\.bilivideo\.com\//, async route => {
      requestCount++;
      const match = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range || "");
      if (!match) return route.fulfill({ status: 200, body: "native" });
      if (failure && !route.request().headers()["x-btr-native-fallback"]) return route.fulfill({ status: 503, body: "failed" });
      const start = Number(match[1]), end = Number(match[2]), bytes = Buffer.alloc(end - start + 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
      if (route.request().url().includes("slow")) await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ status: 206, headers: { "Content-Range": `bytes ${start}-${end}/8388608`, "Content-Length": String(bytes.length), "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range,Content-Length", "Content-Type": "video/mp4" }, body: bytes });
    });
    await page.goto(origin); await page.locator("#btr-desktop-settings").waitFor();
    assert.equal(await page.locator(".settings_catalog button").first().textContent(), "线程撕裂者");
    assert.equal(await page.locator("#btr-desktop-settings + .theme-item").count(), 1);
    assert.equal(await page.locator("#btr-desktop-check-update + #btr-desktop-uninstall").textContent(), "卸载 BTR");
    const buttons = await page.evaluate(() => {
      const check=document.querySelector('#btr-desktop-check-update'),remove=document.querySelector('#btr-desktop-uninstall');
      const a=check.getBoundingClientRect(),b=remove.getBoundingClientRect();
      return {after:b.left>a.right,sameRow:Math.abs(a.top-b.top)<1,color:getComputedStyle(remove).backgroundColor};
    });
    assert.deepEqual(buttons,{after:true,sameRow:true,color:"rgb(185, 56, 67)"});
    assert.equal(await page.locator("[data-setting=errorNotices]").isChecked(), true);
    await page.locator("[data-setting=debugNotices]").check();
    assert.equal(await page.locator("[data-category]:checked").count(), 6);
    await page.locator("[data-category=download]").uncheck();
    await page.reload();
    assert.equal(await page.locator("[data-category=download]").isChecked(), false);
    const second = await context.newPage(); await second.goto(origin);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ concurrency: 16 }));
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().concurrency === 16);
    console.log("PASS settings first entry, defaults, category persistence and cross-window synchronization");
    await page.evaluate(() => {
      const menu = document.createElement("div"); menu.className = "bpx-player-ctrl-setting-menu-right";
      menu.innerHTML = '<div class="bpx-player-ctrl-setting-others">其他设置</div>'; document.body.append(menu);
    });
    await page.locator("#btr-desktop-player-settings").waitFor();
    assert.equal(await page.locator("#btr-desktop-player-settings + .bpx-player-ctrl-setting-others").count(), 1);
    await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().concurrency === 64);
    assert.equal(await page.locator("#btr-desktop-settings output").textContent(), "64");
    await page.locator('[name="btr-desktop-player-mode"][value="overseas"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().mode === "overseas");
    await page.evaluate(() => { const old=document.querySelector('.bpx-player-ctrl-setting-menu-right'); const next=old.cloneNode(false); next.innerHTML='<div class="bpx-player-ctrl-setting-others">其他设置</div>'; old.replaceWith(next); });
    await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').waitFor();
    assert.equal(await page.locator('[name="btr-desktop-player-concurrency"][value="64"]').isChecked(), true);
    assert.equal(await page.locator('[name="btr-desktop-player-mode"][value="overseas"]').isChecked(), true);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({concurrency:16,mode:"mainland"}));
    console.log("PASS native player CDN/thread settings persist, synchronize and remount after switching");
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
    await page.locator("#btr-desktop-settings").screenshot({path:path.join(images,"d2-settings.png")});
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
    failure = true;
    const fallback = await page.evaluate(async () => {
      const response = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/fallback.m4s", { headers: { Range: "bytes=0-4095", "X-Btr-Native-Fallback": "yes" } });
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, fallback: __BTR_DESKTOP__.transport.snapshot().fallbackRequests };
    }); assert.equal(fallback.status, 206); assert.equal(fallback.bytes, 4096); assert.ok(fallback.fallback > 0);
    console.log("PASS failed acceleration returns to original client request without rewriting video source");
    assert.deepEqual(errors, []);
    console.log("PASS no browser script errors; CDN requests", requestCount);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
