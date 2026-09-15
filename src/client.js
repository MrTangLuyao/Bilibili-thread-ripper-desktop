(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__, notices = root.__BTR_RUNTIME_NOTICES__, view = root.__BTR_NOTIFICATION_VIEW__;
  const attached = new WeakSet(); let player = null, video = null, identity = "";
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
    next.on("Player_Dispose", () => { if (player === next) { api.transport.switchRoute(""); notices.detach(); player = video = null; identity = ""; } });
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
    }
    bind(next);
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
    return { version: api.version, adapterRevision: api.adapterRevision, transport: api.transport.snapshot(), playback: media ? { currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : 0, paused: media.paused, readyState: media.readyState, width: media.videoWidth, height: media.videoHeight, buffered: Array.from({length:media.buffered.length}, (_,i) => [media.buffered.start(i), media.buffered.end(i)]), decodedFrames: media.getVideoPlaybackQuality?.().totalVideoFrames || 0, error: media.error?.code || null } : null };
  };
})(globalThis);
