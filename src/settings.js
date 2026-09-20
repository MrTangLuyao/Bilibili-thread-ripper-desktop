(function (root) {
  "use strict";
  if (root.__BTR_DESKTOP__) return;
  const KEY = "BTR_Desktop.settings.v1";
  const categories = { takeover: "接管与切换", playback: "播放与暂停", download: "下载线程", buffer: "缓冲与跳转", settings: "设置变化", other: "其他日志" };
  const listeners = new Set();
  // 0.9.1.2 moves everyone once to mainland CDN, 8 threads and hidden error notices.
  const REVISION = 2, UPGRADE = { mode: "mainland", concurrency: 8, errorNotices: false };
  const normalize = value => {
    const s = root.__BILI_RANGE_CORE__.normalizeSettings(value || {});
    // mode "custom" uses only the servers in customHosts; the shared core keeps Bilibili's
    // video servers and drops anything else.
    return { enabled: s.enabled, concurrency: s.concurrency, mode: s.mode, customHosts: s.customHosts, debugNotices: s.debugNotices, errorNotices: s.errorNotices, debugCategories: s.debugCategories, autoCheckUpdates: value?.autoCheckUpdates !== false, revision: REVISION };
  };
  let current;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    const outdated = !!saved && saved.revision !== REVISION;
    current = normalize(outdated ? { ...saved, ...UPGRADE } : saved);
    if (outdated) localStorage.setItem(KEY, JSON.stringify(current));
  } catch (_) { current = normalize({}); }
  const emit = () => listeners.forEach(fn => { try { fn({ ...current, customHosts: current.customHosts.slice(), debugCategories: { ...current.debugCategories } }); } catch (error) { console.error("BTR settings listener", error); } });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("BTR_Desktop.settings.v1") : null;
  const api = {
    version: root.__BTR_DESKTOP_RELEASE__?.version || "0.9.2.3-d1",
    adapterRevision: root.__BTR_DESKTOP_RELEASE__?.adapterRevision || 1,
    categories,
    getSettings: () => ({ ...current, customHosts: current.customHosts.slice(), debugCategories: { ...current.debugCategories } }),
    setSettings(patch) {
      const next = normalize({ ...current, ...patch });
      localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
      current = next; emit(); channel?.postMessage(current);
      return api.getSettings();
    },
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
