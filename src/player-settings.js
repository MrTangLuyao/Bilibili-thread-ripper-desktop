(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__, threads = [4, 8, 16, 32, 64, 128];
  const id = "btr-desktop-player-settings";
  let panel, unsubscribe, scheduled = false;
  const style = document.createElement("style");
  style.textContent = `
    #${id}{margin:0 0 16px;color:#fff;font-size:12px;text-align:left}
    #${id} .btr-native-setting-group{margin:0 0 16px}
    #${id} .btr-native-setting-title{margin:0 0 8px;color:#fff}
    #${id} .bui-radio-group{display:flex!important;flex-wrap:wrap!important;gap:8px!important;margin:0!important}
    #${id} .bui-radio-item{margin:0!important}
    #${id} .btr-custom-hint{margin:-8px 0 16px;color:hsla(0,0%,100%,.6);line-height:1.5}
    #${id} .btr-save-error{color:#ff8585;line-height:1.5}
  `;
  (document.head || document.documentElement).append(style);
  // Keep the official player's own radio styling and secondary settings menu.
  function group(title, setting, options) {
    const section = document.createElement("div"); section.className = "btr-native-setting-group";
    const heading = document.createElement("div"); heading.className = "btr-native-setting-title"; heading.textContent = title;
    const content = document.createElement("div"); content.className = "bui bui-radio bui-dark";
    content.innerHTML = '<div class="bui-area"><div class="bui-radio-wrap bui-radio-button"><div class="bui-radio-group"></div></div></div>';
    for (const [value, text] of options) {
      const label = document.createElement("label"); label.className = "bui-radio-item";
      const input = document.createElement("input"); input.type = "radio"; input.className = "bui-radio-input";
      input.name = `btr-desktop-player-${setting}`; input.dataset.btrSetting = setting; input.value = String(value);
      const body = document.createElement("span"); body.className = "bui-radio-label";
      const caption = document.createElement("span"); caption.className = "bui-radio-text"; caption.textContent = text;
      body.append(caption); label.append(input, body); content.querySelector(".bui-radio-group").append(label);
    }
    section.append(heading, content); return section;
  }
  function mount() {
    scheduled = false;
    const target = document.querySelector(".bpx-player-ctrl-setting-menu-right");
    if (!target) { if (panel && !panel.isConnected) { unsubscribe?.(); unsubscribe = null; panel = null; } return; }
    if (panel?.parentElement === target) return;
    unsubscribe?.(); panel?.remove();
    panel = document.createElement("div"); panel.id = id;
    // The servers of the custom mode are picked in the client's settings page; this menu is too small for the list.
    const hint = document.createElement("div"); hint.className = "btr-custom-hint"; hint.hidden = true;
    panel.append(
      group("线程撕裂者 CDN", "mode", [["mainland", "大陆 CDN"], ["overseas", "海外 CDN"], ["custom", "自定义"]]),
      hint,
      group("并发线程", "concurrency", [["auto", "自动"], ...threads.map(value => [value, String(value)])])
    );
    const error = document.createElement("div"); error.className = "btr-save-error"; error.setAttribute("role", "status"); panel.append(error);
    panel.addEventListener("change", event => {
      const input = event.target; if (!(input instanceof HTMLInputElement) || !input.checked) return;
      const setting = input.dataset.btrSetting;
      if (setting !== "mode" && setting !== "concurrency") return;
      // "自动" switches 自动线程数 on; a number switches it off and sets that thread count.
      const patch = setting === "mode" ? { mode: input.value }
        : input.value === "auto" ? { autoConcurrency: true } : { autoConcurrency: false, concurrency: Number(input.value) };
      try { api.setSettings(patch); error.textContent = ""; }
      catch (_) { error.textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
    });
    target.insertBefore(panel, target.querySelector(".bpx-player-ctrl-setting-others") || target.firstChild);
    unsubscribe = api.onSettings(settings => {
      for (const input of panel.querySelectorAll("[data-btr-setting]")) {
        const shown = input.dataset.btrSetting === "concurrency" && settings.autoConcurrency ? "auto" : String(settings[input.dataset.btrSetting]);
        input.checked = input.value === shown;
      }
      hint.hidden = settings.mode !== "custom";
      hint.textContent = settings.customHosts.length
        ? `已选 ${settings.customHosts.length} 个服务器，在客户端「设置 → 线程撕裂者」里增减。`
        : "还没选服务器，暂时按大陆 CDN 下载。请到客户端「设置 → 线程撕裂者」里选择。";
    });
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, {childList:true,subtree:true});
  root.addEventListener("pagehide", () => { observer.disconnect(); unsubscribe?.(); }, {once:true});
  mount();
})(globalThis);
