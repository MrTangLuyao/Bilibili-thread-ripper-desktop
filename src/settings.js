(function (root) {
  "use strict";
  if (root.__BTR_DESKTOP__) return;
  const KEY = "BTR_Desktop.settings.v1";
  const categories = { takeover: "接管与切换", playback: "播放与暂停", download: "下载线程", buffer: "缓冲与跳转", settings: "设置变化", other: "其他日志" };
  const listeners = new Set();
  const normalize = value => {
    const s = root.__BILI_RANGE_CORE__.normalizeSettings(value || {});
    return { enabled: s.enabled, concurrency: s.concurrency, mode: s.mode, debugNotices: s.debugNotices, errorNotices: s.errorNotices, debugCategories: s.debugCategories, autoCheckUpdates: value?.autoCheckUpdates !== false };
  };
  let current;
  try { current = normalize(JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (_) { current = normalize({}); }
  const emit = () => listeners.forEach(fn => { try { fn({ ...current, debugCategories: { ...current.debugCategories } }); } catch (error) { console.error("BTR settings listener", error); } });
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("BTR_Desktop.settings.v1") : null;
  const api = {
    version: root.__BTR_DESKTOP_RELEASE__?.version || "0.9.1.1-d4",
    adapterRevision: root.__BTR_DESKTOP_RELEASE__?.adapterRevision || 4,
    categories,
    getSettings: () => ({ ...current, debugCategories: { ...current.debugCategories } }),
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
