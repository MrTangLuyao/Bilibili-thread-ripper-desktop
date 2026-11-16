(function (root) {
  "use strict";
  if (root.__BTR_DESKTOP__) return;
  const KEY = "BTR_Desktop.settings.v1";
  const listeners = new Set();
  // 0.9.1.2 moves everyone once to mainland CDN and 8 threads.
  const REVISION = 2, UPGRADE = { mode: "mainland", concurrency: 8 };
  const normalize = value => {
    const s = root.__BILI_RANGE_CORE__.normalizeSettings(value || {});
    // mode "custom" uses only the servers in customHosts; the shared core keeps Bilibili's
    // video servers and drops anything else.
    // 自动线程数 is on unless switched off, as in the browser version; concurrency is then only
    // the manual choice, used again when it is switched off.
    // The client only has the browser version's compatibility mode (src/page-hook.js): the
    // panel shows 接管方式 with it chosen and greyed out.
    return { enabled: s.enabled, takeover: "compat", autoConcurrency: value?.autoConcurrency !== false, concurrency: s.concurrency, mode: s.mode, customHosts: s.customHosts, theme: s.theme, floatingButton: s.floatingButton, floatingButtonLeft: s.floatingButtonLeft, floatingButtonTop: s.floatingButtonTop, guideDone: s.guideDone, autoCheckUpdates: value?.autoCheckUpdates !== false, revision: REVISION };
  };
  let current;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    const outdated = !!saved && saved.revision !== REVISION;
    current = normalize(outdated ? { ...saved, ...UPGRADE } : saved);
    if (outdated) localStorage.setItem(KEY, JSON.stringify(current));
  } catch (_) { current = normalize({}); }
  const emit = () => listeners.forEach(fn => { try { fn({ ...current, customHosts: current.customHosts.slice() }); } catch (error) { console.error("BTR settings listener", error); } });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("BTR_Desktop.settings.v1") : null;
  const store = next => {
    localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
    current = next; emit(); channel?.postMessage(current);
    return api.getSettings();
  };
  const api = {
    version: root.__BTR_DESKTOP_RELEASE__?.version || "2026.11.15.1-d1",
    adapterRevision: root.__BTR_DESKTOP_RELEASE__?.adapterRevision || 1,
    getSettings: () => ({ ...current, customHosts: current.customHosts.slice() }),
    setSettings(patch) { return store(normalize({ ...current, ...patch })); },
    resetSettings() { return store(normalize({})); },
    onSettings(fn) { listeners.add(fn); fn(api.getSettings()); return () => listeners.delete(fn); },
    update: Object.freeze({ state: "idle", message: "从 GitHub 检查 BTR 更新" })
  };
  root.addEventListener("storage", event => {
    if (event.key !== KEY) return;
    try { current = normalize(JSON.parse(event.newValue || "{}")); emit(); } catch (_) {}
  });
  if (channel) channel.onmessage = event => { current = normalize(event.data); emit(); };
  Object.defineProperty(root, "__BTR_DESKTOP__", { value: api });
})(globalThis);
