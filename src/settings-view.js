(function (root) {
  "use strict";
  // The client's own settings page keeps a short section. The floating button can be switched
  // off, so this is the way back to it and to the panel; the rest of the settings are the panel's.
  const api = root.__BTR_DESKTOP__;
  let panel, navButton, unsubscribe, unsubscribeUpdate, scheduled = false;
  const style = document.createElement("style");
  style.textContent = `
    #btr-desktop-settings{padding:24px 0;border-bottom:1px solid var(--line_regular,#303133);color:var(--text1,#d8dce2);font:inherit}
    #btr-desktop-settings h4{margin:0 0 20px;font-size:16px}#btr-desktop-settings .btr-version{margin-left:12px;color:var(--text3,#9499a0);font-size:12px;font-weight:400}
    #btr-desktop-settings .btr-row{display:flex;align-items:center;gap:16px;margin:16px 0;flex-wrap:wrap}
    #btr-desktop-settings button{border:1px solid var(--line_regular,#353638);border-radius:5px;background:var(--bg3,#252729);color:inherit;padding:7px 15px;font:inherit;cursor:pointer}
    #btr-desktop-settings #btr-desktop-uninstall{background:#b93843;border-color:#d14c57;color:#fff}
    #btr-desktop-settings #btr-desktop-uninstall:hover:not(:disabled){background:#d04450}
    #btr-desktop-settings button:disabled{opacity:.55;cursor:default}
    #btr-desktop-settings input{accent-color:#d45b88}#btr-desktop-settings input[type=checkbox]{width:16px;height:16px;vertical-align:middle;margin:0 8px 0 0}
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
        <div class="btr-row"><label><input type="checkbox" data-setting="floatingButton">BTR 悬浮窗</label></div>
        <div class="btr-row"><button type="button" id="btr-desktop-open-panel">打开 BTR 设置</button></div>
        <div class="btr-row"><label><input type="checkbox" data-setting="autoCheckUpdates">自动检查 BTR 更新</label></div>
        <div class="btr-row"><button type="button" id="btr-desktop-check-update">检查 BTR 更新</button><button type="button" id="btr-desktop-uninstall">卸载 BTR</button><button type="button" id="btr-desktop-install-update" hidden>安装更新</button></div>
        <div class="btr-note btr-update-status" role="status"></div><div class="btr-note btr-save-error" role="status"></div>`;
      general.before(panel);
      panel.addEventListener("change", event => {
        const input = event.target;
        if (!input.dataset.setting) return;
        try { api.setSettings({ [input.dataset.setting]: input.checked }); panel.querySelector(".btr-save-error").textContent = ""; }
        catch (_) { panel.querySelector(".btr-save-error").textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
      });
      panel.addEventListener("click", event => {
        const button = event.target.closest("button"); if (!button) return;
        if (button.id === "btr-desktop-open-panel") root.__BTR_SETTINGS_PANEL__.open();
        // Installing and uninstalling are started by the preload, which only trusts real clicks.
        if (button.id === "btr-desktop-check-update") api.checkUpdate();
      });
      unsubscribe = api.onSettings(settings => {
        panel.querySelectorAll("[data-setting]").forEach(x => { x.checked = settings[x.dataset.setting]; });
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
