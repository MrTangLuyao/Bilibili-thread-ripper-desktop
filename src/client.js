(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__, notices = root.__BTR_RUNTIME_NOTICES__, view = root.__BTR_NOTIFICATION_VIEW__;
  const attached = new WeakSet(); let player = null, video = null, identity = "";
  // 自动线程数 (the controller lives in the shared idm-downloader.js). The client's own video
  // element tells it what the browser version's player tells it there: a stall once playback
  // had started, and a low buffer that stops growing while bytes arrive. A new video or a
  // seek starts the buffer watch afresh.
  const auto = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency;
  const autoOn = () => { const settings = api.getSettings(); return settings.enabled && settings.autoConcurrency; };
  let watched = null, watchEvents = null;
  function watch(element) {
    if (!auto || element === watched) return;
    watchEvents?.abort(); watchEvents = null; watched = element; auto.newSession();
    if (!element) return;
    const events = watchEvents = new AbortController();
    const on = (name, handler) => element.addEventListener(name, handler, { signal: events.signal });
    let started = false; // playing since the last load or seek
    on("emptied", () => { started = false; auto.newSession(); });
    on("seeking", () => { started = false; auto.newSession(); });
    on("playing", () => { started = true; });
    on("waiting", () => { if (started && autoOn() && !element.seeking && !element.paused) auto.stall("播放卡了一下"); });
    on("timeupdate", () => {
      if (!started || !autoOn()) return;
      const now = element.currentTime, ranges = element.buffered;
      let ahead = 0;
      for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= now + 0.25 && ranges.end(i) >= now - 0.25) ahead = ranges.end(i) - now;
      auto.buffer(Math.max(0, ahead), !element.paused && !element.seeking);
    });
  }
  auto?.subscribe(({ threads, previous, reason }) => {
    if (autoOn()) notices.log(threads > previous ? `线程数加到 ${threads}` : `线程数退回 ${threads}`, `${previous} → ${threads}：${reason}。`, "info", "", identity, "download");
  });
  function bind(next) {
    if (!next?.on || attached.has(next)) return;
    attached.add(next);
    next.on("Player_PlayUrl_Done", event => {
      if (root.biliPlayer !== next) return;
      scan();
      const raw = event?.detail?.raw;
      api.transport.register(raw?.result || raw?.data || raw || event?.detail);
      notices.log("已收到客户端播放地址", "视频界面和字幕仍由客户端负责。", "success", "", identity, "takeover");
    });
    next.on("Player_Initialized", scan);
    next.on("Player_Dispose", () => { if (player === next) { api.transport.switchRoute(""); notices.detach(); watch(null); player = video = null; identity = ""; } });
  }
  function hookFactory() {
    const factory = root.nano?.createPlayer;
    if (typeof factory !== "function" || factory.__btrWrapped) return;
    function createPlayer(...args) { const next = Reflect.apply(factory, this, args); bind(next); return next; }
    Object.defineProperty(createPlayer, "__btrWrapped", { value: true });
    try { root.nano.createPlayer = createPlayer; } catch (_) {}
  }
  api.onSettings(settings => { notices.configure(settings); view.configure(settings); });
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== "__BILI_RANGE_ACCELERATOR_V1__") return;
    if (event.data.type === "debug-notices") view.logs(event.data.payload);
    if (event.data.type === "playback-notice") view.playback(event.data.payload);
  });
  function scan() {
    hookFactory();
    const next = root.biliPlayer;
    if (!next?.getManifest || !next.mediaElement) return;
    let info, element;
    try { info = next.getManifest(); element = next.mediaElement(); } catch (_) { return; }
    const key = Number(info?.cid) > 0 ? `${info.bvid || info.aid || ""}:${info.cid}` : "";
    if (next !== player || key !== identity) {
      notices.detach(); player = next; identity = key; video = null;
      api.transport.switchRoute(key);
      auto?.newSession();
    }
    bind(next);
    watch(element?.isConnected ? element : null);
    if (element?.isConnected && element !== video && key && api.transport.snapshot().routeAcceleratedRequests > 0) {
      video = element;
      // The persistent status says takeover only once a real accelerated request completes.
      notices.attach(element, key, api.transport.snapshot().generation, () => root.biliPlayer === next && identity === key && api.transport.snapshot().routeAcceleratedRequests > 0);
    }
  }
  const timer = setInterval(scan, 150);
  api.synchronizePlayer = scan;
  root.addEventListener("pagehide", () => { clearInterval(timer); notices.detach(); api.transport.restore(); }, { once: true });
  api.getStatus = () => {
    const media = root.biliPlayer?.mediaElement?.();
    return { version: api.version, adapterRevision: api.adapterRevision, transport: api.transport.snapshot(), autoThreads: auto?.status() || null, playback: media ? { currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : 0, paused: media.paused, readyState: media.readyState, width: media.videoWidth, height: media.videoHeight, buffered: Array.from({length:media.buffered.length}, (_,i) => [media.buffered.start(i), media.buffered.end(i)]), decodedFrames: media.getVideoPlaybackQuality?.().totalVideoFrames || 0, error: media.error?.code || null } : null };
  };
})(globalThis);
