(function (root) {
  "use strict";
  // The settings panel and the floating button are the browser version's own code
  // (shared/settings-panel.js), so there is one panel to maintain. This file is what stands
  // in for its bridge.js: it answers the panel's messages from the desktop settings, leaves
  // out what the client has no use for and adds the block for updates and uninstalling.
  const api = root.__BTR_DESKTOP__, transport = () => api.transport;
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");
  let saveError = () => {};

  function saved(write) {
    try { write(); saveError(""); }
    catch (_) { saveError("设置保存失败，请检查客户端的数据目录是否可写。"); }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const area = document.createElement("textarea");
    area.value = text; area.style.cssText = "position:fixed;opacity:0";
    (document.querySelector("dialog") || document.body).append(area);
    area.select();
    try { return document.execCommand("copy"); } catch (_) { return false; } finally { area.remove(); }
  }

  function mount(panel) {
    const block = document.createElement("div");
    block.className = "block btr-update";
    block.innerHTML = `<h2 class="block-title">更新</h2>
      <section class="notice-controls" aria-label="更新">
        <label class="notice-row" for="btr-desktop-auto-update"><span class="row-text">自动检查 BTR 更新</span><span class="switch"><input id="btr-desktop-auto-update" type="checkbox" aria-label="自动检查 BTR 更新"><span></span></span></label>
        <div class="btr-maintenance">
          <button id="btr-desktop-install-update" type="button" hidden>安装更新</button>
          <button id="btr-desktop-check-update" type="button">检查 BTR 更新</button>
          <button id="btr-desktop-uninstall" type="button">卸载 BTR</button>
        </div>
        <p class="btr-update-status" role="status"></p>
        <p class="btr-save-error" role="status"></p>
      </section>`;
    // On the panel's first page, not under 高级设置: this is how the app is kept up to date.
    panel.querySelector(".view-main").append(block);
    const find = selector => block.querySelector(selector);
    find("#btr-desktop-auto-update").addEventListener("change", event => saved(() => api.setSettings({ autoCheckUpdates: event.target.checked })));
    // Installing and uninstalling are started by the preload, which only trusts real clicks.
    find("#btr-desktop-check-update").addEventListener("click", () => api.checkUpdate());
    saveError = message => { find(".btr-save-error").textContent = message; };
    // The client cannot open links in a browser: the GitHub button copies the address instead.
    const link = panel.querySelector("#github-link");
    link.title = link.ariaLabel = "复制项目地址";
    link.removeAttribute("target");
    link.addEventListener("click", async event => {
      event.preventDefault();
      find(".btr-update-status").textContent = await copy(link.href) ? "已复制项目地址" : "复制失败，地址是 " + link.href;
    });
    // The panel is rebuilt on every open; a closed one stops listening. It joins the page
    // only after this runs, so "gone" means it was connected once.
    const whileOpen = (subscribe, show) => {
      let shown = false, stop = null;
      stop = subscribe(value => {
        if (block.isConnected) shown = true;
        else if (shown) { stop?.(); return; }
        show(value);
      });
    };
    whileOpen(api.onSettings, settings => { find("#btr-desktop-auto-update").checked = settings.autoCheckUpdates !== false; });
    whileOpen(api.onUpdate, update => {
      find(".btr-update-status").textContent = update.message;
      const busy = ["confirming", "installing", "uninstalling"].includes(update.state);
      find("#btr-desktop-check-update").disabled = busy || update.state === "checking";
      find("#btr-desktop-uninstall").disabled = busy;
      const install = find("#btr-desktop-install-update");
      install.hidden = update.state !== "available";
      install.textContent = update.manifest ? `更新到 ${update.manifest.version}` : "安装更新";
    });
  }

  root.__BTR_PANEL_HOST__ = Object.freeze({
    projectUrl: "https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop",
    // 接管方式, 缓冲, 加速范围 and 网页版本 are the browser version's: the client plays by itself.
    hide: [".takeover-select", ".accel-controls", ".site-controls", "#tab-buffer", "#panel-buffer"],
    css: `
      .tabs { grid-template-columns: repeat(3, 1fr); }
      .btr-maintenance { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px; margin: 6px 0 8px; padding: 3px; border-radius: 10px; background: var(--bg); }
      .btr-maintenance button { padding: 7px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
      .btr-maintenance button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
      .btr-maintenance button:disabled { opacity: .55; cursor: default; }
      .btr-maintenance button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
      #btr-desktop-install-update { grid-column: 1 / -1; background: #fb7299; color: #fff; font-weight: 600; }
      #btr-desktop-install-update[hidden] { display: none; }
      #btr-desktop-install-update:hover:not(:disabled) { background: #fb7299; color: #fff; }
      #btr-desktop-uninstall:hover:not(:disabled) { color: var(--error); }
      .btr-update-status, .btr-save-error { margin: 0 0 8px 2px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
      .btr-save-error { color: var(--error); }
      .btr-update-status:empty, .btr-save-error:empty { display: none; }
    `,
    mount
  });

  // The transport counts bytes; the panel shows a speed.
  let lastBytes = 0, lastAt = 0, speed = 0;
  function stats() {
    const snapshot = transport()?.snapshot() || {}, now = performance.now(), bytes = Number(snapshot.networkBytes) || 0;
    if (lastAt && now > lastAt) speed = Math.max(0, bytes - lastBytes) * 1000 / (now - lastAt);
    lastBytes = bytes; lastAt = now;
    return { activeThreads: Number(snapshot.activeThreads) || 0, totalSpeedBps: speed };
  }

  api.onSettings(settings => post("settings", settings));
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "get-settings") post("settings", api.getSettings());
    else if (event.data.type === "get-stats") post("stats", stats());
    else if (event.data.type === "settings-update") saved(() => api.setSettings(event.data.payload));
    else if (event.data.type === "settings-reset") saved(api.resetSettings);
  });
  // The panel's diagnostic copy.
  root.__biliThreadRipperDebug = { report: () => JSON.stringify(api.getStatus?.() || {}) };
})(globalThis);
