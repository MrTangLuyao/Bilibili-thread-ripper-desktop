(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__;
  let panel, navButton, unsubscribe, unsubscribeUpdate, scheduled = false;
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
    #btr-desktop-settings .btr-custom{margin:0 0 8px 148px;max-width:520px}#btr-desktop-settings .btr-host-title{margin:14px 0 8px;color:var(--text2,#b3bfca);font-size:13px}
    #btr-desktop-settings .btr-host-list{display:grid;grid-template-columns:repeat(2,minmax(230px,1fr));gap:9px 16px;font-size:12px}#btr-desktop-settings .btr-host-list label{overflow-wrap:anywhere;cursor:pointer}
    #btr-desktop-settings .btr-host-add{display:flex;gap:8px;margin:8px 0}#btr-desktop-settings input[type=text]{flex:1;min-width:0;border:1px solid var(--line_regular,#353638);border-radius:5px;background:var(--bg3,#252729);color:inherit;padding:7px 10px;font:inherit;font-size:12px}
    #btr-desktop-settings .btr-manual-host{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0;font-size:12px;overflow-wrap:anywhere}#btr-desktop-settings .btr-manual-host button{padding:2px 9px}
    #btr-desktop-settings .btr-host-error{color:#f77979}#btr-desktop-settings .btr-host-error:empty{display:none}
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
        <div class="btr-row"><span class="btr-label">CDN 模式</span><button type="button" data-mode="mainland">大陆 CDN</button><button type="button" data-mode="overseas">海外 CDN</button><button type="button" data-mode="custom">自定义</button></div>
        <div class="btr-custom" hidden>
          <div class="btr-note btr-custom-empty">还没选服务器，暂时按大陆 CDN 下载。</div>
          <div class="btr-host-groups"></div>
          <div class="btr-host-title">手动添加</div>
          <div class="btr-manual-hosts"></div>
          <div class="btr-host-add"><input type="text" id="btr-desktop-host" placeholder="例如 upos-sz-mirrorali.bilivideo.com" spellcheck="false" autocomplete="off" aria-label="服务器地址"><button type="button" id="btr-desktop-host-add">添加</button></div>
          <div class="btr-note btr-host-error" role="alert"></div>
          <div class="btr-note">只能填 B 站的视频服务器（bilivideo.com、akamaized.net 等），视频的下载地址不会发给别的网站。</div>
        </div>
        <div class="btr-row"><label class="btr-label" for="btr-desktop-threads">并发线程</label><input id="btr-desktop-threads" type="range" min="0" max="5" step="1"><output></output></div>
        <div class="btr-row"><label><input type="checkbox" data-setting="errorNotices">显示错误</label><label><input type="checkbox" data-setting="debugNotices">Debug 模式</label></div>
        <div class="btr-debug-wrap" hidden><div class="btr-row"><button type="button" data-select="all">全选</button><button type="button" data-select="none">全不选</button></div><div class="btr-debug-options"></div></div>
        <div class="btr-row"><label><input type="checkbox" data-setting="autoCheckUpdates">自动检查 BTR 更新</label></div>
        <div class="btr-row"><button type="button" id="btr-desktop-check-update">检查 BTR 更新</button><button type="button" id="btr-desktop-uninstall">卸载 BTR</button><button type="button" id="btr-desktop-install-update" hidden>安装更新</button></div>
        <div class="btr-note btr-update-status" role="status"></div><div class="btr-note btr-save-error" role="status"></div>`;
      for (const [key, title] of Object.entries(api.categories)) {
        const label = document.createElement("label"), input = document.createElement("input");
        input.type = "checkbox"; input.dataset.category = key; label.append(input, title); panel.querySelector(".btr-debug-options").append(label);
      }
      // The servers of the custom CDN mode: the known ones to tick, others typed in.
      const core = root.__BILI_RANGE_CORE__, cdn = root.__BILI_CDN_RESOLVER_FACTORY__, maxHosts = 32;
      const hostGroups = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
      const knownHosts = hostGroups.flatMap(([, hosts]) => hosts);
      for (const [title, hosts] of hostGroups) {
        const heading = document.createElement("div"); heading.className = "btr-host-title"; heading.textContent = title;
        const list = document.createElement("div"); list.className = "btr-host-list";
        for (const host of hosts) {
          const label = document.createElement("label"), input = document.createElement("input");
          input.type = "checkbox"; input.dataset.host = host; label.append(input, host); list.append(label);
        }
        panel.querySelector(".btr-host-groups").append(heading, list);
      }
      const hostError = panel.querySelector(".btr-host-error"), hostInput = panel.querySelector("#btr-desktop-host");
      general.before(panel);
      const threadOptions = [4, 8, 16, 32, 64, 128];
      const save = patch => {
        try { api.setSettings(patch); panel.querySelector(".btr-save-error").textContent = ""; }
        catch (_) { panel.querySelector(".btr-save-error").textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
      };
      const addHost = () => {
        const host = core.normalizeCdnHost(hostInput.value), hosts = api.getSettings().customHosts;
        if (!host) hostError.textContent = "这不是 B 站的视频服务器地址。";
        else if (hosts.includes(host)) hostError.textContent = "这个服务器已经在列表里了。";
        else if (hosts.length >= maxHosts) hostError.textContent = `最多选 ${maxHosts} 个服务器。`;
        else { hostError.textContent = ""; hostInput.value = ""; save({ customHosts: [...hosts, host] }); }
      };
      hostInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addHost(); } });
      panel.addEventListener("change", event => {
        const input = event.target;
        if (input.dataset.host) {
          const hosts = api.getSettings().customHosts.filter(host => host !== input.dataset.host);
          if (input.checked && hosts.length >= maxHosts) { input.checked = false; hostError.textContent = `最多选 ${maxHosts} 个服务器。`; return; }
          hostError.textContent = ""; save({ customHosts: input.checked ? [...hosts, input.dataset.host] : hosts });
        }
        if (input.dataset.setting) save({ [input.dataset.setting]: input.checked });
        if (input.dataset.category) save({ debugCategories: Object.fromEntries([...panel.querySelectorAll("[data-category]")].map(x => [x.dataset.category, x.checked])) });
        if (input.id === "btr-desktop-threads") save({ concurrency: threadOptions[Number(input.value)] });
      });
      panel.querySelector("input[type=range]").addEventListener("input", event => { panel.querySelector("output").textContent = String(threadOptions[Number(event.target.value)]); });
      panel.addEventListener("click", event => {
        const button = event.target.closest("button"); if (!button) return;
        if (button.id === "btr-desktop-check-update") api.checkUpdate();
        if (button.id === "btr-desktop-host-add") addHost();
        if (button.dataset.removeHost) save({ customHosts: api.getSettings().customHosts.filter(host => host !== button.dataset.removeHost) });
        if (button.dataset.mode) save({ mode: button.dataset.mode });
        if (button.dataset.select) save({ debugCategories: Object.fromEntries(Object.keys(api.categories).map(key => [key, button.dataset.select === "all"])) });
      });
      unsubscribe = api.onSettings(settings => {
        panel.querySelectorAll("[data-setting]").forEach(x => { x.checked = settings[x.dataset.setting]; });
        panel.querySelectorAll("[data-category]").forEach(x => { x.checked = settings.debugCategories[x.dataset.category] !== false; });
        panel.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === settings.mode)));
        panel.querySelector(".btr-custom").hidden = settings.mode !== "custom";
        panel.querySelector(".btr-custom-empty").hidden = settings.customHosts.length > 0;
        panel.querySelectorAll("[data-host]").forEach(x => { x.checked = settings.customHosts.includes(x.dataset.host); });
        panel.querySelector(".btr-manual-hosts").replaceChildren(...settings.customHosts.filter(host => !knownHosts.includes(host)).map(host => {
          const row = document.createElement("div"), text = document.createElement("span"), remove = document.createElement("button");
          row.className = "btr-manual-host"; text.textContent = host;
          remove.type = "button"; remove.dataset.removeHost = host; remove.textContent = "删除"; remove.setAttribute("aria-label", `删除 ${host}`);
          row.append(text, remove); return row;
        }));
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
