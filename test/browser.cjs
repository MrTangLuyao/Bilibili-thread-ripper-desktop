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
    // The client restores its cookies when it starts; a leftover one must not answer the guide.
    await context.addCookies([{ name: "BTR.guideDone", value: "1", url: origin }]);
    await page.goto(origin);
    // The settings are the browser version's panel, opened from the same floating button.
    const panelSelector = "#__bilibili_thread_ripper_settings__ .btr-popup";
    const openPanel = async (tab, name) => {
      await tab.evaluate(() => { if (!__BTR_SETTINGS_PANEL__.isOpen()) __BTR_SETTINGS_PANEL__.open({ advanced: true }); });
      await tab.locator(panelSelector).waitFor(); if (await tab.locator("#advanced summary").isVisible()) await tab.locator("#advanced summary").click();
      await tab.locator(`#__bilibili_thread_ripper_settings__ [data-tab="${name}"]`).click();
    };
    const closePanel = tab => tab.evaluate(() => __BTR_SETTINGS_PANEL__.close());
    await page.locator("#__bilibili_thread_ripper_launcher__ .btr-launcher").waitFor();
    // First use: the guide points at the button until it is answered, then never again.
    await page.locator("#__bilibili_thread_ripper_guide__ p").waitFor();
    assert.equal(await page.locator("#__bilibili_thread_ripper_guide__ p").textContent(), "点这里打开全新 线程撕裂者 设置");
    // The client's settings page keeps a short section, also the way back to the button.
    const section = page.locator("#btr-desktop-settings");
    await section.waitFor();
    assert.equal(await page.locator("#btr-desktop-nav").textContent(), "线程撕裂者");
    assert.deepEqual(await section.locator("label, button:visible").allTextContents(), ["BTR 悬浮窗", "打开 BTR 设置", "自动检查 BTR 更新", "检查 BTR 更新", "卸载 BTR"]);
    const fresh = await page.evaluate(() => __BTR_DESKTOP__.getSettings());
    assert.deepEqual([fresh.mode, fresh.concurrency, fresh.autoConcurrency, fresh.takeover, "debugNotices" in fresh, "errorNotices" in fresh], ["mainland", 8, true, "compat", false, false]);
    await page.locator("#__bilibili_thread_ripper_launcher__ .btr-launcher").evaluate(node => node.click());
    await page.locator(panelSelector).waitFor();
    assert.equal(await page.locator("#__bilibili_thread_ripper_guide__").count(), 0);
    await page.waitForFunction(() => __BTR_DESKTOP__.getSettings().guideDone === true);
    assert.match(await page.locator(`${panelSelector} .version`).textContent(), /d\d+/);
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ #btr-desktop-uninstall").isVisible(), true);
    // The client cannot open links: the GitHub button copies the address.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.locator("#github-link").click();
    await page.locator('.btr-update-status:has-text("已复制项目地址")').waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop");
    assert.equal(context.pages().length, 1);
    // 接管方式 is the browser version's, greyed out: the client only has the compatibility mode.
    const takeover = page.locator("#__bilibili_thread_ripper_settings__ .takeover-select");
    assert.equal(await takeover.isVisible(), true);
    assert.deepEqual(await takeover.locator("span").allTextContents(), ["全接管", "兼容模式"]);
    assert.deepEqual(await takeover.locator("input").evaluateAll(inputs => inputs.map(input => [input.value, input.checked, input.disabled])), [["full", false, true], ["compat", true, true]]);
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ .takeover-note").textContent(), "桌面版仅支持兼容模式。");
    assert.equal(await takeover.evaluate(node => getComputedStyle(node).filter), "grayscale(1)");
    await takeover.locator('input[value="full"]').evaluate(node => node.click());
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getSettings().takeover), "compat");
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ .btr-mode").count(), 0);
    // What belongs to the browser version's player is left out.
    assert.equal(await page.locator("#advanced summary").isVisible(), true);
    await page.locator("#advanced summary").click();
    assert.deepEqual(await page.locator('#__bilibili_thread_ripper_settings__ [role="tab"]:visible').allTextContents(), ["网络", "功能", "界面"]);
    assert.equal(await page.locator("#auto-concurrency").isChecked(), true);
    await page.locator('#__bilibili_thread_ripper_settings__ [data-tab="features"]').click();
    assert.equal(await page.locator("#live-enabled").isVisible(), false);
    assert.equal(await page.locator("#block-international").isVisible(), false);
    assert.equal(await page.locator("#btr-desktop-auto-update").isChecked(), true);
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ #btr-desktop-uninstall").textContent(), "卸载 BTR");
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ #btr-desktop-uninstall").isVisible(), false);
    assert.equal(await page.evaluate(()=>__BTR_DESKTOP__.getUpdate().state),"idle");
    await page.locator("#btr-desktop-auto-update").evaluate(node => node.click());
    await page.waitForFunction(() => __BTR_DESKTOP__.getSettings().autoCheckUpdates === false);
    // 调试 only holds 复制诊断信息, as in the browser version (tested below with a video).
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ #debug-notices").count(), 0);
    assert.equal(await page.locator("#__bilibili_thread_ripper_settings__ #debug-copy").isVisible(), true);
    await closePanel(page);
    // The floating button switched off in the panel comes back from the client's settings.
    await page.evaluate(() => __BTR_SETTINGS_PANEL__.open());
    await page.locator("#floating-button").evaluate(node => node.click());
    await page.waitForFunction(() => __BTR_DESKTOP__.getSettings().floatingButton === false);
    await closePanel(page);
    await page.locator("#__bilibili_thread_ripper_launcher__").waitFor({ state: "detached" });
    assert.equal(await page.locator('[data-setting="floatingButton"]').isChecked(), false);
    assert.equal(await page.locator('[data-setting="autoCheckUpdates"]').isChecked(), false);
    await page.locator("#btr-desktop-open-panel").click();
    await page.locator(panelSelector).waitFor();
    assert.equal(await page.locator("#advanced").evaluate(node => node.open), false);
    await closePanel(page);
    await page.locator('[data-setting="floatingButton"]').check();
    await page.locator("#__bilibili_thread_ripper_launcher__ .btr-launcher").waitFor();
    await page.reload();
    await page.locator("#__bilibili_thread_ripper_launcher__ .btr-launcher").waitFor();
    assert.equal(await page.locator("#__bilibili_thread_ripper_guide__").count(), 0);
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getSettings().autoCheckUpdates), false);
    // 主题 and the floating button's switch and place are kept by the desktop settings.
    const kept = await page.evaluate(() => { const s = __BTR_DESKTOP__.setSettings({ theme: "dark", floatingButtonLeft: 0, floatingButtonTop: 0.5 }); return [s.theme, s.floatingButton, s.floatingButtonLeft, s.floatingButtonTop]; });
    assert.deepEqual(kept, ["dark", true, 0, 0.5]);
    const second = await context.newPage(); await second.goto(origin);
    assert.equal(await second.evaluate(() => __BTR_DESKTOP__.getSettings().autoCheckUpdates), false);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ autoCheckUpdates: true }));
    // 恢复默认设置 asks once, in place, and goes back to first use, the guide included.
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ concurrency: 32, autoConcurrency: false, mode: "overseas", theme: "dark", floatingButtonLeft: 0, floatingButtonTop: 0.5, autoCheckUpdates: false }));
    await openPanel(page, "features");
    const reset = page.locator("#reset-settings");
    assert.equal(await reset.textContent(), "恢复默认设置");
    await reset.click();
    assert.equal(await reset.textContent(), "确认？");
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getSettings().concurrency), 32);
    await reset.click();
    await page.locator("#__bilibili_thread_ripper_guide__ p").waitFor();
    assert.equal(await page.locator(panelSelector).count(), 0);
    assert.deepEqual(await page.evaluate(() => { const s = __BTR_DESKTOP__.getSettings(); return [s.concurrency, s.autoConcurrency, s.mode, s.theme, s.floatingButtonLeft, s.floatingButtonTop, s.autoCheckUpdates, s.guideDone]; }), [8, true, "mainland", "auto", null, null, true, false]);
    await page.reload();
    await page.locator("#__bilibili_thread_ripper_guide__ p").waitFor();
    await page.evaluate(() => { __BTR_SETTINGS_PANEL__.open(); __BTR_SETTINGS_PANEL__.close(); });
    await page.waitForFunction(() => __BTR_DESKTOP__.getSettings().guideDone === true);
    await page.locator("#__bilibili_thread_ripper_launcher__ .btr-launcher").waitFor();
    assert.equal(await page.locator("#__bilibili_thread_ripper_guide__").count(), 0);
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

    await page.locator('[name="btr-desktop-player-concurrency"][value="auto"]').check();
    await second.waitForFunction(() => __BTR_DESKTOP__.getSettings().autoConcurrency === true && __BTR_DESKTOP__.getSettings().concurrency === 64);
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
    // 自动线程数 in the client: a new video or a seek opens with 16 threads, its own video
    // element stalls once playing has started, and the count goes up (the shared downloader
    // reads it for every range). Off, nothing changes the controller; a stall before the first
    // frame is startup, not a stall.
    const autoSignals = await page.evaluate(async () => {
      const auto = __BILI_IDM_DOWNLOADER_FACTORY__.autoConcurrency;
      auto.reset();
      __BTR_DESKTOP__.setSettings({ autoConcurrency: false, concurrency: 16 });
      const video = document.createElement("video"); document.body.append(video);
      let paused = false; Object.defineProperty(video, "paused", { get: () => paused });
      const listeners = {};
      window.biliPlayer = { getManifest: () => ({ bvid: "BVauto", cid: 7 }), mediaElement: () => video, on: (name, fn) => { listeners[name] = fn; } };
      // src/page-hook.js looks for the player every 150 ms.
      while (!listeners.Player_Dispose) await new Promise(r => setTimeout(r, 50));
      const threads = () => __BTR_DESKTOP__.getSettings().autoConcurrency ? __BTR_DESKTOP__.getStatus().stats.autoThreads : __BTR_DESKTOP__.getSettings().concurrency;
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
      const stepped = await until(() => auto.threads() > 16, 4000);
      const result = { whenOff, beforeFirstFrame, stepped, level: auto.threads(), transport: threads(), status: __BTR_DESKTOP__.getStatus().autoThreads?.threads };
      window.biliPlayer = undefined; listeners.Player_Dispose?.(); video.remove();
      __BTR_DESKTOP__.setSettings({ autoConcurrency: false, concurrency: 16 });
      return result;
    });
    assert.deepEqual(autoSignals.whenOff, { level: 8, transport: 16 }, "switched off, a stall must not change anything");
    assert.equal(autoSignals.beforeFirstFrame, 16, "a seek opens with 16 threads, and waiting before the first frame is startup, not a stall");
    assert.equal(autoSignals.stepped, true);
    assert.equal(autoSignals.transport, autoSignals.level, "the status shows the controller's count");
    assert.equal(autoSignals.status, autoSignals.level);
    console.log("PASS automatic threads: a seek opens with 16, the client's video element stalls, the count steps up to", autoSignals.level, "; off or before the first frame nothing changes");
    // Custom CDN: known servers are ticked, others typed in; only Bilibili's video servers are accepted.
    // Custom CDN: the panel is the browser version's and has its own tests; here, that its
    // choices reach the desktop settings and the player menu's hint.
    await openPanel(page, "network");
    assert.equal(await page.locator("#custom-hosts").isVisible(), false);
    await page.locator('input[name="mode"][value="custom"]').evaluate(node => node.click());
    assert.equal(await page.locator("#custom-hosts").isVisible(), true);
    await page.waitForFunction(() => __BTR_DESKTOP__.getSettings().mode === "custom");
    assert.equal(await page.locator('[name="btr-desktop-player-mode"][value="custom"]').isChecked(), true);
    assert.match(await page.locator("#btr-desktop-player-settings .btr-custom-hint").textContent(), /还没选服务器.*悬浮球/);
    await page.locator("#host-input").fill("https://example.com/a.m4s"); await page.locator("#host-input").press("Enter");
    assert.equal(await page.locator("#host-error").textContent(), "这不是 B 站的视频服务器地址。");
    await page.locator("#host-input").fill("https://CN-gdfs-ct-01-01.bilivideo.com/upgcxcode/x.m4s?sign=1"); await page.locator("#host-input").press("Enter");
    await second.waitForFunction(() => JSON.stringify(__BTR_DESKTOP__.getSettings().customHosts) === '["cn-gdfs-ct-01-01.bilivideo.com"]');
    assert.match(await page.locator("#btr-desktop-player-settings .btr-custom-hint").textContent(), /已选 1 个服务器/);
    await closePanel(page);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ customHosts: Array.from({ length: 40 }, (_, i) => `upos-sz-test${i}.bilivideo.com`).concat("evil.example.com") }));
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getSettings().customHosts.length), 32);
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ mode: "mainland", customHosts: [] }));
    console.log("PASS custom CDN: the panel saves to the desktop settings, the player menu follows, other sites are refused, limit of 32");
    console.log("PASS custom CDN: known and typed servers, refusal of other sites, limit of 32, persistence and synchronization");
    await page.evaluate(() => __BTR_SETTINGS_PANEL__.open());
    await page.locator(panelSelector).waitFor();
    if (await page.locator("#advanced-back").isVisible()) await page.locator("#advanced-back").click();
    const inPanel = id => page.locator(`#__bilibili_thread_ripper_settings__ ${id}`);
    await inPanel("#btr-desktop-check-update").waitFor();
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"available",message:"发现 0.9.1.1-d2",manifest:{version:"0.9.1.1-d2"}}},location.origin));
    await inPanel("#btr-desktop-install-update").waitFor({state:"visible"});
    assert.equal(await inPanel("#btr-desktop-install-update").textContent(), "更新到 0.9.1.1-d2");
    assert.equal(await page.locator("#btr-desktop-settings #btr-desktop-install-update").textContent(), "更新到 0.9.1.1-d2");
    await inPanel("#btr-desktop-check-update").click();
    assert.equal(await inPanel("#btr-desktop-check-update").isDisabled(),true);
    assert.equal(await page.locator("#btr-desktop-settings #btr-desktop-check-update").isDisabled(),true);
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"error",message:"测试网络失败"}},location.origin));
    await inPanel("#btr-desktop-check-update:not(:disabled)").waitFor();
    assert.equal(await inPanel("#btr-desktop-install-update").isVisible(),false);
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"current",message:"当前已是最新版本"}},location.origin));
    await inPanel('.btr-update-status:has-text("当前已是最新版本")').waitFor();
    assert.equal(await page.locator("#btr-desktop-settings .btr-update-status").textContent(), "当前已是最新版本");
    console.log("PASS update states: available, checking, error retry and current version");
    for (const state of ["confirming","uninstalling"]) {
      await page.evaluate(state => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state,message:"卸载测试"}},location.origin),state);
      await inPanel("#btr-desktop-uninstall:disabled").waitFor();
      assert.equal(await inPanel("#btr-desktop-check-update").isDisabled(),true);
      assert.equal(await inPanel("#btr-desktop-install-update").isVisible(),false);
      assert.equal(await page.locator("#btr-desktop-settings #btr-desktop-uninstall").isDisabled(),true);
    }
    await page.evaluate(() => window.postMessage({channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"idle",message:"已取消卸载 BTR"}},location.origin));
    await inPanel("#btr-desktop-uninstall:not(:disabled)").waitFor();
    assert.equal(await inPanel("#btr-desktop-check-update").isDisabled(),false);
    const images=path.join(root,"test-output");fs.mkdirSync(images,{recursive:true});
    await page.locator("#__bilibili_thread_ripper_settings__ .btr-popup").screenshot({path:path.join(images,"panel-update.png")});
    await closePanel(page);
    console.log("PASS confirmation and uninstall lock the controls in the panel, cancellation restores them");
    // The compatibility mode (src/page-hook.js and the shared native-range-transport.js): the
    // client's player, biliPlayer, with the playback core the browser version reads from
    // window.player, and the addresses the client gives it.
    const address = name => `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/${name}.m4s`;
    // episode: the client's playview answer for an episode, the addresses under video_info;
    // "drm" marks it protected.
    const setPlayer = (tab, key, names, withCore = true, episode = "") => tab.evaluate(async ({ key, names, withCore, episode }) => {
      window.__closePlayer?.();
      const [bvid, cid] = key.split(":");
      const video = document.createElement("video"); document.body.append(video);
      const dash = { getVideoElement: () => video, on() {}, off() {}, getQualityFor: () => 0 };
      const wrapper = { getCorePlayer: () => dash, fire() {}, getQualityChangedData: () => ({}) };
      const listeners = {}; let core = withCore;
      const player = window.biliPlayer = { getManifest: () => ({ bvid, cid: Number(cid) }), mediaElement: () => video, on: (name, fn) => { listeners[name] = fn; }, __core: () => (core ? wrapper : null), getQuality: () => ({ nowQ: 80, newQ: 80, realQ: 80 }) };
      const url = name => `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/${name}.m4s`;
      window.__setCore = on => { core = on; };
      window.__closePlayer = () => { if (window.biliPlayer === player) window.biliPlayer = undefined; listeners.Player_Dispose?.(); video.remove(); window.__closePlayer = null; };
      // src/page-hook.js finds the player within 150 ms; then the client gives it the addresses.
      while (!listeners.Player_PlayUrl_Done) await new Promise(r => setTimeout(r, 30));
      const files = {
        video: names.filter(name => !name.startsWith("a-")).map(name => ({ id: 80, baseUrl: url(name), backupUrl: [url(name).replace("mirrorali", "mirrorcos")] })),
        audio: names.filter(name => name.startsWith("a-")).map(name => ({ id: 30280, baseUrl: url(name) })) };
      const raw = episode ? { code: 0, result: { arc: { cid: Number(cid) }, play_video_type: "ogv", video_info: { dash: files, is_drm: episode === "drm", is_preview: false } } } : { data: { dash: files } };
      listeners.Player_PlayUrl_Done({ detail: { raw } });
    }, { key, names, withCore, episode });
    const accelerated = tab => tab.evaluate(() => __BTR_DESKTOP__.getStatus().stats.acceleratedRequests);
    await setPlayer(page, "BVcompat:1", ["a", "b", "slow", "reused", "a-sound"]);
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    const fetchResult = await page.evaluate(async () => {
      const response = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/a.m4s", { headers: { Range: "bytes=0-1048575" } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { ok: bytes.every((n, i) => n === i % 251), length: bytes.length, status: response.status, range: response.headers.get("content-range"), url: response.url, stats: __BTR_DESKTOP__.getStatus().stats };
    });
    assert.deepEqual([fetchResult.ok, fetchResult.length, fetchResult.status, fetchResult.range, fetchResult.url], [true, 1048576, 206, "bytes 0-1048575/8388608", address("a")]);
    assert.equal(fetchResult.stats.acceleratedRequests, 1); assert.ok(fetchResult.stats.parallelSubrequests > 1);
    console.log("PASS compatibility mode takes the client's player; the shared downloader splits and recombines 1 MiB byte-exactly in", fetchResult.stats.parallelSubrequests, "pieces");
    const xhr = await page.evaluate(() => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); const states = [], events = [];
      x.open("GET", "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/b.m4s"); x.responseType = "arraybuffer"; x.setRequestHeader("Range", "bytes=1000-525287");
      x.onreadystatechange = () => { states.push(x.readyState); if (x.readyState === 2) events.push(x.getResponseHeader("content-range")); };
      x.onerror = reject; x.onload = () => resolve({ bytes: new Uint8Array(x.response).every((v,i) => v === (i + 1000) % 251), status: x.status, states, events, url: x.responseURL }); x.send();
    }));
    assert.equal(xhr.bytes, true); assert.equal(xhr.status, 206); assert.equal(xhr.url, address("b"));
    assert.deepEqual(xhr.states.filter((state, i, all) => state !== all[i - 1]), [2, 3, 4]); assert.equal(xhr.events[0], "bytes 1000-525287/8388608");
    const reuse = await page.evaluate(() => new Promise((resolve,reject) => {
      const x = new XMLHttpRequest(); let loads = 0;
      x.open("GET", "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow.m4s"); x.responseType="arraybuffer"; x.setRequestHeader("Range", "bytes=0-1048575"); x.send();
      x.open("GET", "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/reused.m4s"); x.responseType="arraybuffer"; x.setRequestHeader("Range", "bytes=0-1023");
      x.onerror=reject; x.onload=()=>{loads++;setTimeout(()=>resolve({loads,length:x.response.byteLength}),250)}; x.send();
    })); assert.deepEqual(reuse,{loads:1,length:1024});
    // An address the client was not given for this video is left to the client.
    const other = await page.evaluate(async () => {
      const before = __BTR_DESKTOP__.getStatus().stats.acceleratedRequests;
      const response = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/not-this-video.m4s", { headers: { Range: "bytes=0-1023" } });
      await response.arrayBuffer();
      return { status: response.status, accelerated: __BTR_DESKTOP__.getStatus().stats.acceleratedRequests - before };
    });
    assert.deepEqual(other, { status: 206, accelerated: 0 });
    console.log("PASS XHR events, headers, status and data; a reused XHR never delivers the old request; another video's address goes to the client untouched");
    // The panel's 运行状态 and 复制诊断信息 read src/page-hook.js, as in the browser version.
    const published = await page.evaluate(() => new Promise(resolve => {
      addEventListener("message", function listen(event) {
        if (event.data?.channel !== "__BILI_RANGE_ACCELERATOR_V1__" || event.data.type !== "stats") return;
        removeEventListener("message", listen); resolve(event.data.payload);
      });
      postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "get-stats" }, "*");
    }));
    assert.equal(published.architecture, "native-player-range-transport"); assert.equal(published.acceleratedRequests, 3); assert.equal(typeof published.activeThreads, "number"); assert.equal(typeof published.totalSpeedBps, "number");
    await openPanel(page, "features");
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.locator("#__bilibili_thread_ripper_settings__ #debug-copy").click();
    let copied = "";
    for (let i = 0; i < 50 && !copied; i++) { copied = await page.evaluate(() => navigator.clipboard.readText()); if (!copied) await page.waitForTimeout(100); }
    await closePanel(page);
    const version = JSON.parse(fs.readFileSync(path.join(root, "desktop.json"))).version;
    assert.ok(copied.startsWith(`BTR diagnostics (format 1) | BTR ${version} stable | `), copied.slice(0, 200));
    for (const part of ["== Summary ==", "== Environment ==", "== Settings ==", "== Downloads ==", "== Events ==", "== End =="]) assert.ok(copied.includes(part), `the copy lacks ${part}`);
    assert.match(copied, new RegExp(`^btr +${version.replace(/\./g, "\\.")} stable \\(desktop\\)`, "m"));
    assert.match(copied, /^engine +compat \(setting compat\)/m);
    assert.match(copied, /^manager +none/m);
    assert.match(copied, /^ *\d+\.\d{3} +INFO +page +.*took over: BVcompat:1 \(compat\)/m);
    assert.match(copied, /^video +\d+ started, \d+ ok\b/m);
    const notAscii = copied.split("\n").find(line => /[^\x00-\x7f]/.test(line));
    assert.equal(notAscii, undefined, `the copy is not plain English text: ${notAscii}`);
    console.log("PASS 运行状态 and 复制诊断信息: the browser version's report, in English, engine compat, host desktop");
    // Another video cancels what the old one was still downloading, without a stale delivery.
    const abort = await page.evaluate(async () => {
      const promise = fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow.m4s", { headers: { Range: "bytes=0-1048575" } }).then(() => "stale", e => e.name);
      await new Promise(r => setTimeout(r, 20));
      window.__closePlayer();
      return promise;
    }); assert.equal(abort, "AbortError");
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getStatus().takeover), "native");
    // The stopped player's timeline stays in the diagnostic copy, in the browser version's shape.
    const previous = await page.evaluate(() => JSON.parse(__biliThreadRipperDebug.report()).previousPlayer);
    assert.equal(previous.route, "BVcompat:1"); assert.ok(previous.timeline.some(event => event.what === "native transport attached"));
    console.log("PASS closing or switching the video cancels old requests without stale delivery");
    // Two empty replies ban a node for this video; the next video starts clean.
    // Good nodes answer a little later, so the dead reply is not cancelled by a faster copy.
    deadHost = "upos-sz-mirrorhw.bilivideo.com";
    await setPlayer(page, "BVban:1", [...Array.from({ length: 10 }, (_, i) => `slow-ban-${i}`), ...Array.from({ length: 3 }, (_, i) => `slow-after-ban-${i}`)]);
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    const banned = await page.evaluate(async () => {
      for (let i = 0; i < 10 && !__BTR_DESKTOP__.getStatus().bannedHosts.length; i++) {
        const response = await fetch(`https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow-ban-${i}.m4s`, { headers: { Range: "bytes=0-1048575" } });
        if ((await response.arrayBuffer()).byteLength !== 1048576) throw Error("wrong length");
      }
      return __BTR_DESKTOP__.getStatus().bannedHosts;
    });
    assert.deepEqual(banned, [deadHost]);
    await page.waitForTimeout(300);
    const deadBefore = hostHits.get(deadHost), acceleratedBefore = await accelerated(page);
    const afterBan = await page.evaluate(async () => {
      let bytes = 0;
      for (let i = 0; i < 3; i++) bytes += (await (await fetch(`https://upos-sz-mirrorali.bilivideo.com/upgcxcode/slow-after-ban-${i}.m4s`, { headers: { Range: "bytes=0-1048575" } })).arrayBuffer()).byteLength;
      return bytes;
    });
    assert.equal(afterBan, 3 * 1048576); assert.equal(await accelerated(page) - acceleratedBefore, 3);
    assert.equal(hostHits.get(deadHost), deadBefore, "a banned node must not be asked again in the same video");
    await setPlayer(page, "BVban:2", ["slow-ban-next"]);
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().route === "BVban:2");
    assert.deepEqual(await page.evaluate(() => __BTR_DESKTOP__.getStatus().bannedHosts), []);
    deadHost = "";
    console.log("PASS a node with two 0 KiB replies is banned for the current video, skipped afterwards and restored on the next video");
    // Custom mode asks only the picked servers, not even the one the client named. Going back
    // to another mode applies to the next request of the same video.
    const picked = ["upos-sz-mirrorcos.bilivideo.com", "cn-gdfs-ct-01-01.bilivideo.com"];
    await setPlayer(page, "BVcustom:1", ["custom", "custom-empty"]);
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    await page.waitForTimeout(300);
    const hitsSince = before => [...hostHits].filter(([host, count]) => count > (before.get(host) || 0)).map(([host]) => host).sort();
    let before = new Map(hostHits), acceleratedCustom = await accelerated(page);
    const custom = await page.evaluate(async hosts => {
      __BTR_DESKTOP__.setSettings({ mode: "custom", customHosts: hosts });
      let bytes = 0;
      for (const range of ["0-1048575", "1048576-2097151", "2097152-3145727"]) bytes += (await (await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/custom.m4s", { headers: { Range: `bytes=${range}` } })).arrayBuffer()).byteLength;
      return bytes;
    }, picked);
    assert.equal(custom, 3 * 1048576); assert.equal(await accelerated(page) - acceleratedCustom, 3);
    await page.waitForTimeout(300);
    assert.deepEqual(hitsSince(before), [...picked].sort());
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
    before = new Map(hostHits); acceleratedCustom = await accelerated(page);
    const empty = await page.evaluate(async () => {
      __BTR_DESKTOP__.setSettings({ mode: "custom", customHosts: [] });
      const length = (await (await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/custom-empty.m4s", { headers: { Range: "bytes=0-1048575" } })).arrayBuffer()).byteLength;
      __BTR_DESKTOP__.setSettings({ mode: "mainland" });
      return length;
    });
    assert.equal(empty, 1048576); assert.equal(await accelerated(page) - acceleratedCustom, 1);
    await page.waitForTimeout(300);
    assert.ok(hitsSince(before).length > 1);
    console.log("PASS custom CDN asks only the picked servers; a mode change applies to the next request; no server picked works like mainland");
    // A range that fails goes back to the client's player, which asks for it again by itself,
    // as Bilibili's player does in the browser.
    failure = true;
    const refused = await page.evaluate(async () => {
      const result = await fetch("https://upos-sz-mirrorali.bilivideo.com/upgcxcode/custom.m4s", { headers: { Range: "bytes=4194304-4198399" } }).then(() => "delivered", error => error.name || "error");
      return { result, status: __BTR_DESKTOP__.getStatus() };
    });
    failure = false;
    assert.notEqual(refused.result, "delivered"); assert.equal(refused.status.takeover, "compat"); assert.ok(refused.status.stats.lastError);
    console.log("PASS a failed range is refused to the client's player, which retries it; the takeover stays");
    // Without the playback core nothing is taken over and the client downloads by itself; the
    // core showing up later is enough. Switched off, BTR leaves the client alone.
    const untouched = async (name, range = "bytes=0-1023") => {
      const count = await accelerated(page);
      const status = await page.evaluate(async ({ url, range }) => { const response = await fetch(url, { headers: { Range: range } }); await response.arrayBuffer(); return response.status; }, { url: address(name), range });
      return { status, accelerated: await accelerated(page) - count };
    };
    await setPlayer(page, "BVnocore:1", ["nocore"], false);
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => { const s = __BTR_DESKTOP__.getStatus(); return [s.route, s.takeover, s.stats.playerState]; }), ["BVnocore:1", "native", "waiting"]);
    assert.deepEqual(await untouched("nocore"), { status: 206, accelerated: 0 });
    await page.evaluate(() => window.__setCore(true));
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    assert.deepEqual(await untouched("nocore", "bytes=1024-2047"), { status: 206, accelerated: 1 });
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ enabled: false }));
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "native" && __BTR_DESKTOP__.getStatus().stats.playerState === "disabled");
    assert.deepEqual(await untouched("nocore", "bytes=2048-3071"), { status: 206, accelerated: 0 });
    await page.evaluate(() => __BTR_DESKTOP__.setSettings({ enabled: true }));
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    await page.evaluate(() => window.__closePlayer());
    console.log("PASS without the playback core, or switched off, the client downloads by itself; the core showing up later is taken over");
    // An episode (番剧、电影): the client gives the playview answer, the addresses under
    // video_info. A protected one stays with the client, as in the browser version.
    await setPlayer(page, "ep-1:11", ["episode", "a-episode"], true, "ok");
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    assert.deepEqual(await untouched("episode"), { status: 206, accelerated: 1 });
    await setPlayer(page, "ep-2:12", ["drm"], true, "drm");
    await page.waitForFunction(() => __BTR_DESKTOP__.getStatus().route === "ep-2:12");
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => __BTR_DESKTOP__.getStatus().takeover), "native");
    assert.deepEqual(await untouched("drm"), { status: 206, accelerated: 0 });
    assert.ok((await page.evaluate(() => JSON.parse(__biliThreadRipperDebug.report()).page)).some(event => event.what === "episode not taken over" && event.detail === "DRM protected"));
    await page.evaluate(() => window.__closePlayer());
    console.log("PASS an episode's addresses under video_info are taken over; a DRM episode stays with the client");
    assert.deepEqual(errors, []);
    console.log("PASS no browser script errors; CDN requests", requestCount);
    // Settings saved by 0.9.1.1 move once to the new defaults; other choices are kept. What
    // later versions no longer have (the Debug switches, the test build's transportMode) is
    // dropped: the client only has the compatibility mode.
    const legacy = await browser.newContext();
    await legacy.addInitScript(() => {
      if (sessionStorage.getItem("btr-seeded")) return;
      sessionStorage.setItem("btr-seeded", "1");
      localStorage.setItem("BTR_Desktop.settings.v1", JSON.stringify({ enabled: true, concurrency: 32, mode: "overseas", debugNotices: true, errorNotices: true, debugCategories: { download: false }, transportMode: "legacy", autoCheckUpdates: false }));
    });
    const old = await legacy.newPage(); old.on("pageerror", error => errors.push(error.message));
    await old.goto(origin);
    const migrated = await old.evaluate(() => ({ settings: __BTR_DESKTOP__.getSettings(), stored: JSON.parse(localStorage.getItem("BTR_Desktop.settings.v1")) }));
    assert.deepEqual([migrated.settings.mode, migrated.settings.concurrency, migrated.settings.takeover, migrated.settings.autoCheckUpdates, migrated.stored.revision, migrated.stored.concurrency],
      ["mainland", 8, "compat", false, 2, 8]);
    for (const key of ["debugNotices", "errorNotices", "debugCategories", "transportMode"]) assert.equal(key in migrated.settings || key in migrated.stored, false, key);
    await old.evaluate(() => __BTR_DESKTOP__.setSettings({ concurrency: 16, takeover: "full", transportMode: "semi" }));
    await old.reload();
    assert.deepEqual(await old.evaluate(() => { const next = __BTR_DESKTOP__.getSettings(); return [next.concurrency, next.mode, next.takeover, "transportMode" in next]; }), [16, "mainland", "compat", false]);
    await legacy.close();
    assert.deepEqual(errors, []);
    console.log("PASS old settings move once to mainland CDN and 8 threads; later choices are kept; retired settings are dropped and the takeover stays compat");
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
    await stalled.evaluate(() => __BTR_DESKTOP__.setSettings({ autoConcurrency: false, concurrency: 32 }));
    // Three ranges in a row of one file, as the client asks for a video: the first is a start
    // (the head is raced on every node), the next two are ordinary downloads. Each carries
    // another signature, as after Bilibili renews the addresses, so the node list starts
    // without a speed record and the stalling node gets ordinary pieces too.
    await setPlayer(stalled, "BVstall:1", ["stall"]);
    await stalled.waitForFunction(() => __BTR_DESKTOP__.getStatus().takeover === "compat");
    const resumed = await stalled.evaluate(() => new Promise((resolve, reject) => {
      const started = performance.now();
      const run = (index, results) => {
        const x = new XMLHttpRequest(), loaded = [];
        x.open("GET", `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/stall.m4s?upsig=${index}`); x.responseType = "arraybuffer";
        const first = index * 2097152; x.setRequestHeader("Range", `bytes=${first}-${first + 2097151}`);
        x.onprogress = event => loaded.push(event.loaded);
        x.onerror = reject;
        x.onload = () => {
          results.push({ exact: new Uint8Array(x.response).every((v, i) => v === (first + i) % 251), length: x.response.byteLength, status: x.status, loaded });
          if (index < 2) run(index + 1, results);
          else resolve({ results, ms: performance.now() - started, stallRequests: window.__stallLog.length, tails: window.__tails || 0, stats: __BTR_DESKTOP__.getStatus().stats });
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
    assert.equal(resumed.stats.acceleratedRequests, 3, "every range was delivered by BTR, none given back to the client");
    assert.ok(resumed.ms < 15000, `three 2 MiB ranges with a stalling node took ${Math.round(resumed.ms)} ms`);
    await stalling.close();
    assert.deepEqual(errors, []);
    console.log("PASS a node that stalls midway: exact bytes, all delivered by BTR, XHR progress never goes backwards;", resumed.stallRequests, "stalled requests,", resumed.tails, "resumed,", Math.round(resumed.ms), "ms");
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
