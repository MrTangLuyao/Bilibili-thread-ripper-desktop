(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__;
  let panel, navButton, unsubscribe, unsubscribeUpdate, checkedOnce = false, scheduled = false;
  const style = document.createElement("style");
  style.textContent = `
    #btr-desktop-settings{padding:24px 0;border-bottom:1px solid var(--line_regular,#303133);color:var(--text1,#d8dce2);font:inherit}
    #btr-desktop-settings h4{margin:0 0 20px;font-size:16px}#btr-desktop-settings .btr-version{margin-left:12px;color:var(--text3,#9499a0);font-size:12px;font-weight:400}
    #btr-desktop-settings .btr-row{display:flex;align-items:center;gap:16px;margin:16px 0;flex-wrap:wrap}
    #btr-desktop-settings .btr-label{min-width:132px;color:var(--text2,#b3bfca)}
    #btr-desktop-settings button,#btr-desktop-settings select{border:1px solid var(--line_regular,#353638);border-radius:5px;background:var(--bg3,#252729);color:inherit;padding:7px 15px;font:inherit;cursor:pointer}
    #btr-desktop-settings button[aria-pressed=true]{background:#bf4d7b;border-color:#bf4d7b;color:#fff}
    #btr-desktop-settings #btr-desktop-uninstall{background:#b93843;border-color:#d14c57;color:#fff}
    #btr-desktop-settings #btr-desktop-uninstall:hover:not(:disabled){background:#d04450}
    #btr-desktop-settings button:disabled{opacity:.55;cursor:default}
    #btr-desktop-settings input{accent-color:#d45b88}#btr-desktop-settings input[type=checkbox]{width:16px;height:16px;vertical-align:middle;margin:0 8px 0 0}
    #btr-desktop-settings input[type=range]{width:min(290px,55vw)}#btr-desktop-settings output{min-width:35px;color:#ef77a3;font-weight:600}
    #btr-desktop-settings .btr-debug-options{display:grid;grid-template-columns:repeat(2,minmax(145px,1fr));gap:12px;max-width:440px;padding:12px 0 6px}
    #btr-desktop-settings [hidden]{display:none!important}#btr-desktop-settings .btr-note{font-size:12px;color:var(--text3,#9499a0);line-height:1.7;margin:8px 0}
    #btr-desktop-settings .btr-save-error{color:#f77979} .settings_catalog.btr-current .settings_catalog--item:not(#btr-desktop-nav){color:var(--text2,#b3bfca)!important}.settings_catalog.btr-current .settings_catalog--item:not(#btr-desktop-nav):before{display:none!important}
    #btr-desktop-nav{order:-1}.settings_catalog.btr-current #btr-desktop-nav{color:#ef77a3}.settings_catalog.btr-current #btr-desktop-nav:before{display:block!important}
  `;
  (document.head || document.documentElement).append(style);
  function mount() {
    scheduled = false;
    const general = document.querySelector(".app_settings .settings_content--item.theme-item");
    const catalog = document.querySelector(".app_settings .settings_catalog");
    if (!general || !catalog) return;
    if (!panel?.isConnected) {
      unsubscribe?.(); unsubscribeUpdate?.();
      panel = document.createElement("section"); panel.id = "btr-desktop-settings"; panel.className = "settings_content--item";
      panel.innerHTML = `<h4>BTR 线程撕裂者<span class="btr-version">${api.version}</span></h4>
        <div class="btr-row"><label><input type="checkbox" data-setting="enabled">启用多线程加速</label></div>
        <div class="btr-row"><span class="btr-label">CDN 模式</span><button type="button" data-mode="mainland">大陆 CDN</button><button type="button" data-mode="overseas">海外 CDN</button></div>
        <div class="btr-row"><label class="btr-label" for="btr-desktop-threads">并发线程</label><input id="btr-desktop-threads" type="range" min="0" max="5" step="1"><output></output></div>
        <div class="btr-row"><label><input type="checkbox" data-setting="errorNotices">显示错误</label><label><input type="checkbox" data-setting="debugNotices">Debug 模式</label></div>
        <div class="btr-debug-wrap" hidden><div class="btr-row"><button type="button" data-select="all">全选</button><button type="button" data-select="none">全不选</button></div><div class="btr-debug-options"></div></div>
        <div class="btr-row"><button type="button" id="btr-desktop-check-update">检查 BTR 更新</button><button type="button" id="btr-desktop-uninstall">卸载 BTR</button><button type="button" id="btr-desktop-install-update" hidden>安装更新</button></div>
        <div class="btr-note btr-update-status" role="status"></div><div class="btr-note btr-save-error" role="status"></div>`;
      for (const [key, title] of Object.entries(api.categories)) {
        const label = document.createElement("label"), input = document.createElement("input");
        input.type = "checkbox"; input.dataset.category = key; label.append(input, title); panel.querySelector(".btr-debug-options").append(label);
      }
      general.before(panel);
      const threadOptions = [4, 8, 16, 32, 64, 128];
      const save = patch => {
        try { api.setSettings(patch); panel.querySelector(".btr-save-error").textContent = ""; }
        catch (_) { panel.querySelector(".btr-save-error").textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
      };
      panel.addEventListener("change", event => {
        const input = event.target;
        if (input.dataset.setting) save({ [input.dataset.setting]: input.checked });
        if (input.dataset.category) save({ debugCategories: Object.fromEntries([...panel.querySelectorAll("[data-category]")].map(x => [x.dataset.category, x.checked])) });
        if (input.id === "btr-desktop-threads") save({ concurrency: threadOptions[Number(input.value)] });
      });
      panel.querySelector("input[type=range]").addEventListener("input", event => { panel.querySelector("output").textContent = String(threadOptions[Number(event.target.value)]); });
      panel.addEventListener("click", event => {
        const button = event.target.closest("button"); if (!button) return;
        if (button.id === "btr-desktop-check-update") api.checkUpdate();
        if (button.dataset.mode) save({ mode: button.dataset.mode });
        if (button.dataset.select) save({ debugCategories: Object.fromEntries(Object.keys(api.categories).map(key => [key, button.dataset.select === "all"])) });
      });
      unsubscribe = api.onSettings(settings => {
        panel.querySelectorAll("[data-setting]").forEach(x => { x.checked = settings[x.dataset.setting]; });
        panel.querySelectorAll("[data-category]").forEach(x => { x.checked = settings.debugCategories[x.dataset.category] !== false; });
        panel.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === settings.mode)));
        panel.querySelector("input[type=range]").value = String(Math.max(0, threadOptions.indexOf(settings.concurrency)));
        panel.querySelector("output").textContent = String(settings.concurrency);
        panel.querySelector(".btr-debug-wrap").hidden = !settings.debugNotices;
      });
      unsubscribeUpdate = api.onUpdate(update => {
        panel.querySelector(".btr-update-status").textContent = update.message;
        const busy = ["confirming","installing","uninstalling"].includes(update.state);
        panel.querySelector("#btr-desktop-check-update").disabled = busy || update.state === "checking";
        panel.querySelector("#btr-desktop-uninstall").disabled = busy;
        const install = panel.querySelector("#btr-desktop-install-update");
        install.hidden = update.state !== "available";
        install.textContent = update.manifest ? `更新到 ${update.manifest.version}` : "安装更新";
      });
      if (!checkedOnce) { checkedOnce = true; api.checkUpdate(); }
    }
    if (!navButton?.isConnected) {
      navButton = document.createElement("button"); navButton.type = "button"; navButton.id = "btr-desktop-nav";
      navButton.className = "settings_catalog--item text_ellipsis"; navButton.textContent = "线程撕裂者";
      catalog.prepend(navButton);
      navButton.addEventListener("click", () => {
        const scroller = document.querySelector(".app_settings .settings_content");
        if (!scroller || !panel) return;
        scroller.scrollTo({ top: scroller.scrollTop + panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20, behavior: "smooth" });
        catalog.classList.add("btr-current"); navButton.classList.add("active");
      });
      catalog.addEventListener("click", event => { if (!navButton.contains(event.target)) { catalog.classList.remove("btr-current"); navButton.classList.remove("active"); } });
      const scroller = document.querySelector(".app_settings .settings_content");
      const updateSelection = () => {
        const top = panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const selected = scroller.scrollTop < 1 || (top <= 24 && top + panel.offsetHeight > 24);
        catalog.classList.toggle("btr-current", selected); navButton.classList.toggle("active", selected);
      };
      scroller?.addEventListener("scroll", updateSelection, { passive: true });
      if (scroller) updateSelection();
    }
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  mount();
})(globalThis);
