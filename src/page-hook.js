(function (root) {
  "use strict";
  // The browser version's page-hook.js, for the client. It finds the client's player and puts
  // the browser version's compatibility mode on it: shared/native-range-transport.js, as it
  // is. The client goes on playing the video and BTR downloads it. Where that mode cannot
  // reach the player, the client downloads the video by itself, as Bilibili's own page does
  // in the browser. biliPlayer is what the browser version calls window.player, so this file
  // gives the shared code what page-hook.js gives it there.
  const api = root.__BTR_DESKTOP__, factory = root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__;
  if (!api || !factory || api.getStatus) return;
  const notices = root.__BTR_RUNTIME_NOTICES__;
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const ARCHITECTURE = "native-player-range-transport";
  // The client plays videos in its player window only.
  const inPlayer = location.origin !== "https://bilipc.bilibili.com" || location.pathname === "/player.html";
  if (inPlayer && root.player === undefined) Object.defineProperty(root, "player", {
    configurable: true, get: () => root.biliPlayer,
    set(value) { Object.defineProperty(root, "player", { configurable: true, enumerable: true, writable: true, value }); }
  });

  let settings = api.getSettings();
  let player = null, route = "", playinfo = null;
  // The compatibility mode on the player, the video element and the video it holds.
  let transport = null, transportVideo = null, transportRoute = "", refusedRoute = "", lifecycle = 0;
  const attached = new WeakSet();

  // What happened on this page, in English for the diagnostic copy (diagnostic-report.js
  // lays it out), as in the browser version: each kind keeps its newest 30, a full list gives
  // up its oldest debug and info entries first, and a repeat within two seconds only counts up.
  const pageEvents = [];
  const PAGE_EVENT_LIMIT = 200, PAGE_EVENTS_PER_KIND = 30;
  const currentVideo = () => { try { return transport?.video || root.biliPlayer?.mediaElement?.() || null; } catch (_) { return null; } };
  function remember(what, detail = "", level = "info") {
    const at = Math.round(performance.now());
    detail = withoutQuery(detail).slice(0, 200);
    const last = pageEvents.at(-1);
    if (last && last.what === what && last.detail === detail && at - last.at < 2000) { last.count = (last.count || 1) + 1; return; }
    pageEvents.push({ at, time: Math.round((Number(currentVideo()?.currentTime) || 0) * 10) / 10, what, detail, level });
    const sameKind = pageEvents.filter(event => event.what === what);
    if (sameKind.length > PAGE_EVENTS_PER_KIND) pageEvents.splice(pageEvents.indexOf(sameKind[0]), 1);
    if (pageEvents.length > PAGE_EVENT_LIMIT) {
      const index = ["debug", "info"].map(minor => pageEvents.findIndex(event => event.level === minor)).find(found => found >= 0);
      pageEvents.splice(index ?? 0, 1);
    }
  }
  // An address keeps its host and path: its query holds the signature and the expiry.
  function withoutQuery(text) { return String(text ?? "").replace(/((?:https?:)?\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1"); }
  function errorText(error) { return withoutQuery(error?.message || error?.name || error || "").slice(0, 180); }

  // A CDN node that twice sends nothing, and a download address the nodes keep refusing, is
  // skipped until the client moves to another video.
  let bans = [];
  const cdnBans = root.__BILI_CDN_RESOLVER_FACTORY__.createBanList({
    onBan(host, count, error, kind) {
      const address = kind === "address";
      bans.push({ at: Math.round(performance.now()), kind: address ? "address" : "node", host: String(host || ""), count: Number(count) || 0, error: errorText(error) });
      if (bans.length > 40) bans.shift();
      // The ban is decided while the failed range is still being reported.
      queueMicrotask(() => remember(address ? "address banned" : "node banned", address ? "refused by the nodes" : `${host}, ${Number(count) || 0} failures with no data`, "warn"));
    }
  });

  const stats = {
    version: api.version, architecture: ARCHITECTURE, mode: settings.mode, playerState: "waiting", quality: "", bufferedAhead: 0,
    acceleratedRequests: 0, acceleratedBytes: 0, parallelSubrequests: 0, activeThreads: 0, autoThreads: 0, totalSpeedBps: 0,
    threadSpeeds: [], discoveredCdns: 0, healthyCdns: 0, blockedCdns: 0, cdnHosts: [], lastHost: "", lastError: "", takeoverError: null
  };

  // Every download since the window opened: the threads at work for the panel's 运行状态, and
  // per kind and per node for the diagnostic copy.
  let transferSequence = 1;
  const transfers = new Map();
  const downloads = {
    byKind: Object.fromEntries(["video", "audio", "meta"].map(kind => [kind, { started: 0, ok: 0, failed: 0, cancelled: 0, bytes: 0 }])),
    cancelReasons: {}, hosts: {}, lastBytesAt: null
  };
  function downloadHost(host) {
    const key = host || "unknown";
    if (!downloads.hosts[key] && Object.keys(downloads.hosts).length >= 64) return null;
    downloads.hosts[key] ||= { ok: 0, failed: 0, cancelled: 0, bytes: 0, lastError: "", lastErrorAt: null };
    return downloads.hosts[key];
  }
  function countTransfer(item, event) {
    const now = Math.round(performance.now());
    if (event.phase === "progress") { if (Number(event.bytes) > 0) downloads.lastBytesAt = now; return; }
    const kind = downloads.byKind[item.kind] || downloads.byKind.video, host = downloadHost(item.host);
    if (event.phase === "done") {
      kind.ok += 1; kind.bytes += item.loaded;
      if (host) { host.ok += 1; host.bytes += item.loaded; }
    } else if (event.phase === "cancel") {
      kind.cancelled += 1;
      if (host) host.cancelled += 1;
      let reason = errorText(event.error) || "unknown";
      if (!(reason in downloads.cancelReasons) && Object.keys(downloads.cancelReasons).length >= 20) reason = "other";
      downloads.cancelReasons[reason] = (downloads.cancelReasons[reason] || 0) + 1;
    } else if (event.phase === "error") {
      kind.failed += 1;
      const message = errorText(event.error);
      if (host) { host.failed += 1; host.lastError = message; host.lastErrorAt = now; }
      remember("range failed", `${item.kind} ${item.host || "unknown"} after ${Math.round(item.loaded / 1024)} KiB: ${message}`, "warn");
    }
  }
  function onTransfer(event) {
    if (event?.phase === "start") {
      const id = transferSequence++, now = Date.now();
      let host = "";
      try { host = new URL(event.url).hostname; } catch (_) {}
      const kind = ["video", "audio", "meta"].includes(event.kind) ? event.kind : "video";
      downloads.byKind[kind].started += 1;
      transfers.set(id, { id, kind, host, loaded: 0, totalBytes: Math.max(0, Number(event.totalBytes) || 0), startedAt: now, sampleAt: now, sampleBytes: 0, lastByteAt: 0, bps: 0, finalBps: 0, state: "active", expiresAt: Infinity });
      stats.lastHost = host;
      return id;
    }
    const item = transfers.get(Number(event?.id));
    if (!item || item.state !== "active") return event?.id;
    const now = Date.now();
    countTransfer(item, event);
    if (event.phase === "progress") {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      item.loaded += bytes; item.sampleBytes += bytes; item.lastByteAt = now;
      const elapsed = Math.max(1, now - item.sampleAt);
      if (elapsed >= 200) { item.bps = item.sampleBytes * 1000 / elapsed; item.sampleAt = now; item.sampleBytes = 0; }
      else item.bps = item.loaded * 1000 / Math.max(1, now - item.startedAt);
    } else if (event.phase === "cancel") {
      transfers.delete(item.id);
    } else {
      item.state = event.phase === "done" ? "done" : "error";
      item.finalBps = event.phase === "done" ? item.loaded * 1000 / Math.max(1, now - item.startedAt) : 0;
      item.expiresAt = now + 3500;
      // Finished threads stay listed a moment, then go, with or without the panel open.
      pruneTimer ||= setTimeout(() => { pruneTimer = null; updateTransferStats(); }, 4000);
    }
    return event.id;
  }
  let pruneTimer = null;
  function transferSpeed(item, now) {
    if (item.state !== "active" || !item.lastByteAt || now - item.lastByteAt > 1800) return 0;
    return item.bps || 0;
  }
  function updateTransferStats() {
    const now = Date.now();
    for (const [id, item] of transfers) if (item.state !== "active" && item.expiresAt <= now) transfers.delete(id);
    const all = [...transfers.values()], active = all.filter(item => item.state === "active");
    const recent = all.filter(item => item.state !== "active").sort((a, b) => b.id - a.id).slice(0, 24);
    stats.activeThreads = active.length;
    stats.totalSpeedBps = Math.round(active.reduce((sum, item) => sum + transferSpeed(item, now), 0));
    stats.threadSpeeds = active.concat(recent).sort((a, b) => a.id - b.id).slice(-512).map(item => ({
      id: item.id, label: `${item.kind === "video" ? "V" : item.kind === "audio" ? "A" : "M"}${String(item.id).padStart(2, "0")}`, kind: item.kind,
      loaded: item.loaded, totalBytes: item.totalBytes, bps: Math.round(transferSpeed(item, now) || item.finalBps || 0), state: item.state, host: item.host
    }));
  }
  const getStats = () => {
    updateTransferStats();
    return { ...stats, takeoverError: null, threadSpeeds: stats.threadSpeeds.map(item => ({ ...item })), cdnHosts: stats.cdnHosts.map(item => ({ ...item })) };
  };
  // The panel's 运行状态 asks for these while it is open.
  const publish = () => root.postMessage({ channel: CHANNEL, type: "stats", payload: getStats() }, "*");

  // 自动线程数 (the controller lives in the shared idm-downloader.js). The client's own video
  // element tells it what the browser version's full takeover tells it there: a stall once
  // playback had started, and a low buffer that stops growing while bytes arrive. A new video
  // or a seek starts the buffer watch afresh, and opens with more threads; switched off, the
  // controller is left alone.
  const auto = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency;
  const autoOn = () => settings.enabled && settings.autoConcurrency;
  const newSession = () => { if (autoOn()) auto?.newSession(); };
  auto?.subscribe(({ threads, previous, reason }) => {
    if (!settings.autoConcurrency) return;
    stats.autoThreads = threads;
    remember("threads changed", `${previous} -> ${threads} (${reason})`);
  });
  let watched = null, watchEvents = null;
  function watch(element) {
    if (!auto || element === watched) return;
    watchEvents?.abort(); watchEvents = null; watched = element; newSession();
    if (!element) return;
    const events = watchEvents = new AbortController();
    const on = (name, handler) => element.addEventListener(name, handler, { signal: events.signal });
    let started = false; // playing since the last load or seek
    on("emptied", () => { started = false; newSession(); });
    on("seeking", () => { started = false; newSession(); });
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

  // The timeline of the transport stopped last, for the diagnostic copy.
  let previousTimeline = null;
  const keepTimeline = (from, key) => { try { previousTimeline = { route: key, timeline: (from.getDebug?.()?.timeline || []).slice(-60) }; } catch (_) {} };
  function stop(reason) {
    const current = transport, key = transportRoute;
    transport = transportVideo = null; transportRoute = "";
    lifecycle++;
    if (!current) return;
    keepTimeline(current, key);
    current.destroy();
    notices?.detach();
    remember("player stopped", reason);
  }
  function takeOver(video) {
    if (!inPlayer || !settings.enabled || !video) {
      stop(settings.enabled ? "no video" : "BTR switched off");
      stats.playerState = settings.enabled ? "waiting" : "disabled";
      if (!settings.enabled) stats.lastError = "";
      return;
    }
    if (transport && (video !== transportVideo || route !== transportRoute)) stop("video changed");
    if (transport || !route || !playinfo || refusedRoute === route) return;
    const container = { querySelector: () => video };
    // The client's playback core appears a moment after its player.
    if (!factory.supports(container)) { stats.playerState = "waiting"; return; }
    const session = ++lifecycle, key = route;
    let next = null;
    try {
      next = factory.createNativePlayer({
        container, playinfo, getSettings: () => settings, cdnBans, onTransfer,
        onSegment(event) {
          if (session !== lifecycle) return;
          stats.acceleratedRequests += 1;
          stats.acceleratedBytes += Number(event.bytes) || 0;
          stats.parallelSubrequests += Number(event.pieces) || 0;
          stats.lastError = "";
        },
        onState(state) {
          if (session !== lifecycle) return;
          stats.mode = state.mode || settings.mode;
          stats.playerState = state.playerState || stats.playerState;
          stats.quality = state.quality || stats.quality;
          stats.bufferedAhead = Number(state.bufferedAhead) || 0;
          if (typeof state.lastError === "string") stats.lastError = state.lastError.slice(0, 180);
          const byHost = new Map();
          for (const item of state.cdnHosts || []) {
            const known = byHost.get(item.host);
            if (!known || known.state === "untested" || ["blocked", "banned"].includes(item.state)) byHost.set(item.host, item);
          }
          stats.cdnHosts = [...byHost.values()].slice(0, 32);
          stats.discoveredCdns = stats.cdnHosts.length;
          stats.healthyCdns = stats.cdnHosts.filter(item => item.state === "healthy").length;
          stats.blockedCdns = stats.cdnHosts.filter(item => ["blocked", "banned"].includes(item.state)).length;
          // It gives a video back to the client only when the player no longer has what it
          // needs; that video stays with the client until another one is opened.
          if (state.playerState === "native-fallback" && transport === next) {
            keepTimeline(next, key);
            transport = transportVideo = null; transportRoute = ""; refusedRoute = key; lifecycle++;
            notices?.detach();
            remember("handed back to the client", state.lastError || "", "warn");
          }
        }
      });
    } catch (error) {
      refusedRoute = key; stats.playerState = "native-fallback"; stats.lastError = errorText(error);
      remember("takeover failed", `create: ${errorText(error) || "unknown error"}`, "error");
      return;
    }
    transport = next; transportVideo = video; transportRoute = key;
    remember("took over", `${key} (compat)`);
    notices?.attach(video, key, session, () => session === lifecycle && transport === next && !["error", "native-fallback", "disabled"].includes(stats.playerState));
  }

  // The addresses as the client gives them: a video's playurl answer, or an episode's
  // playview answer with the addresses under video_info (normalizePlayinfo in the browser
  // version's page-hook.js does the same).
  function normalizePlayinfo(raw) {
    const body = raw?.data || raw?.result;
    if (body?.video_info) return { code: raw.code, data: body.video_info, arc: body.arc || null };
    return raw?.result || raw?.data || raw;
  }
  function unsupportedEpisode(data) {
    const info = data?.data || data;
    if (info?.is_drm) return "DRM protected";
    if (info?.is_preview) return "preview only";
    return "";
  }
  function bind(next) {
    if (!next?.on || attached.has(next)) return;
    attached.add(next);
    next.on("Player_PlayUrl_Done", event => {
      if (root.biliPlayer !== next) return;
      scan();
      const data = normalizePlayinfo(event?.detail?.raw || event?.detail);
      if (!(data?.dash || data?.data?.dash || data?.result?.dash)) return;
      // As in the browser version, a protected or preview-only episode stays with the client.
      const unsupported = unsupportedEpisode(data);
      if (unsupported) {
        if (route) refusedRoute = route;
        stop("episode not taken over");
        remember("episode not taken over", unsupported);
        return;
      }
      playinfo = data;
      transport?.updatePlayinfo(data);
      remember("playinfo received", "", "debug");
      scan();
    });
    next.on("Player_Initialized", scan);
    next.on("Player_Dispose", () => {
      if (player !== next) return;
      stop("player closed"); watch(null);
      player = null; route = ""; refusedRoute = "";
      stats.playerState = "waiting"; stats.lastError = "";
    });
  }
  function hookFactory() {
    const create = root.nano?.createPlayer;
    if (typeof create !== "function" || create.__btrWrapped) return;
    function createPlayer(...args) { const next = Reflect.apply(create, this, args); bind(next); return next; }
    Object.defineProperty(createPlayer, "__btrWrapped", { value: true });
    try { root.nano.createPlayer = createPlayer; } catch (_) {}
  }
  function scan() {
    hookFactory();
    const next = root.biliPlayer;
    if (!next?.getManifest || !next.mediaElement) return;
    let info, element;
    try { info = next.getManifest(); element = next.mediaElement(); } catch (_) { return; }
    const key = Number(info?.cid) > 0 ? `${info.bvid || info.aid || ""}:${info.cid}` : "";
    if (next !== player || key !== route) {
      stop("video changed");
      player = next; route = key; refusedRoute = "";
      cdnBans.reset(); bans = [];
      stats.quality = ""; stats.bufferedAhead = 0; stats.cdnHosts = []; stats.discoveredCdns = stats.healthyCdns = stats.blockedCdns = 0;
      stats.playerState = "waiting"; stats.lastError = "";
      newSession();
    }
    bind(next);
    const video = element?.isConnected ? element : null;
    watch(video);
    takeOver(video);
  }

  let settingsSeen = false;
  api.onSettings(next => {
    const previous = settings, first = !settingsSeen;
    settings = next; settingsSeen = true;
    notices?.configure(settings);
    stats.mode = settings.mode;
    stats.autoThreads = settings.autoConcurrency ? auto?.threads?.() || 0 : 0;
    const serversChanged = settings.mode === "custom" && previous.customHosts.join(",") !== settings.customHosts.join(",");
    if (first || previous.enabled !== settings.enabled || previous.mode !== settings.mode || previous.concurrency !== settings.concurrency || previous.autoConcurrency !== settings.autoConcurrency || serversChanged) {
      remember("settings applied", `compat, ${settings.mode === "overseas" ? "overseas" : settings.mode === "custom" ? `custom ${settings.customHosts.length}` : "mainland"}, threads ${settings.autoConcurrency ? "auto" : settings.concurrency}`);
    }
    // The download lists read the CDN mode and servers for every request, and the downloads
    // the thread count for every range.
    if (!settings.enabled) { stop("BTR switched off"); stats.playerState = "disabled"; stats.lastError = ""; refusedRoute = ""; }
    else transport?.applySettings();
  });
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "get-stats") publish();
  });
  const timer = setInterval(scan, 150);
  root.addEventListener("pagehide", () => { clearInterval(timer); stop("window closed"); watch(null); }, { once: true });

  // The element as the browser has it, for the diagnostic copy.
  function elementState(video) {
    const read = (value, fallback = null) => { try { return value(); } catch (_) { return fallback; } };
    const tenths = value => Math.round((Number(value) || 0) * 10) / 10;
    return {
      elementPaused: read(() => video.paused), networkState: read(() => video.networkState),
      mediaError: read(() => (video.error ? { code: Number(video.error.code) || 0, message: String(video.error.message || "") } : null)),
      buffered: read(() => Array.from({ length: Math.min(8, Number(video.buffered?.length) || 0) }, (_item, index) => [tenths(video.buffered.start(index)), tenths(video.buffered.end(index))]), [])
    };
  }
  // The same report as the browser version's, which the settings panel's 复制诊断信息 reads.
  // Playback state and node names only: no download address or account data.
  function report() {
    let debug = {};
    try { debug = transport?.getDebug?.() || {}; } catch (_) {}
    const { timeline = [], ...rest } = debug;
    const video = currentVideo();
    let frames = null;
    try { const quality = video?.getVideoPlaybackQuality?.(); if (quality) frames = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames }; } catch (_) {}
    let nativeQuality = null;
    try { const quality = root.biliPlayer?.getQuality?.(); if (quality) nativeQuality = { nowQ: quality.nowQ, newQ: quality.newQ, realQ: quality.realQ }; } catch (_) {}
    updateTransferStats();
    return JSON.stringify({
      version: api.version, channel: "stable", scriptManager: "", at: Math.round(performance.now()),
      settings: { takeover: "compat", mode: settings.mode, customHosts: settings.customHosts.slice(), concurrency: settings.concurrency, codec: "default" },
      actualTakeover: transport ? "compat" : "native",
      videoPage: Boolean(route), nativeQuality,
      playback: video ? { currentTime: video.currentTime, duration: video.duration, ended: video.ended, paused: video.paused, seeking: video.seeking,
        readyState: video.readyState, playbackRate: video.playbackRate, width: video.videoWidth, height: video.videoHeight,
        visibility: document.visibilityState, frames, lastPresentedFrame: null, ...elementState(video) } : null,
      state: stats.playerState, lastError: stats.lastError, player: rest, nodes: stats.cdnHosts.map(item => ({ ...item })), bannedNodes: cdnBans.hosts?.() || [],
      page: pageEvents.map(event => ({ ...event })), timeline, previousPlayer: previousTimeline,
      timeOrigin: performance.timeOrigin, route: transportRoute || route,
      downloads: {
        byKind: Object.fromEntries(Object.entries(downloads.byKind).map(([kind, counts]) => [kind, { ...counts }])),
        cancelReasons: { ...downloads.cancelReasons },
        hosts: Object.fromEntries(Object.entries(downloads.hosts).map(([host, counts]) => [host, { ...counts }])),
        active: [...transfers.values()].filter(item => item.state === "active").length,
        lastBytesAt: downloads.lastBytesAt
      },
      bans: bans.map(ban => ({ ...ban }))
    }, null, 1);
  }
  Object.defineProperty(root, "__biliThreadRipperDebug", { configurable: false, value: Object.freeze({ getStats, report, version: api.version }) });

  // For the tools that read a running client (tools/sample-client.cjs and others).
  api.getStatus = () => {
    const media = currentVideo();
    return {
      version: api.version, adapterRevision: api.adapterRevision, route, takeover: transport ? "compat" : "native", stats: getStats(),
      bannedHosts: cdnBans.hosts?.() || [], autoThreads: auto?.status() || null,
      playback: media ? { currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : 0, paused: media.paused, readyState: media.readyState, width: media.videoWidth, height: media.videoHeight, buffered: Array.from({ length: media.buffered.length }, (_, i) => [media.buffered.start(i), media.buffered.end(i)]), decodedFrames: media.getVideoPlaybackQuality?.().totalVideoFrames || 0, error: media.error?.code || null } : null
    };
  };
})(globalThis);
