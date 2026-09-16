(function (root) {
  "use strict";
  const api = root.__BTR_DESKTOP__;
  if (!api || api.transport) return;
  const core = root.__BILI_RANGE_CORE__, resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const nativeFetch = root.fetch.bind(root), NativeXHR = root.XMLHttpRequest;
  const pending = new Set(), operations = new Set(), resolvers = new Map(), representations = new Map(), active = new Map(), totals = new Map();
  const KIND_LABELS = { video: "画面", audio: "声音", meta: "视频信息" };
  const hostOf = value => { try { return new URL(value).hostname; } catch (_) { return ""; } };
  let generation = 0, route = "", transferSequence = 0, latestTransfer = 0, failureStreak = 0;
  // BTR loads on every client version. If a future player stops matching what this adapter
  // expects, stop accelerating in this window instead of adding a failed attempt to every request.
  const FAILURE_LIMIT = 6;
  const stats = { suspended: false, acceleratedRequests: 0, routeAcceleratedRequests: 0, acceleratedBytes: 0, networkBytes: 0, maxThreads: 0, fallbackRequests: 0, abortedRequests: 0, timedOutRequests: 0, activeThreads: 0, lastError: "", route: "", xhrRequests: 0, fetchRequests: 0 };
  function wireProgress(operation, start, end) {
    if (operation.controller.signal.aborted || operation.generation !== generation || end < start) return;
    const merged = [];
    for (const span of [...operation.coverage, [start, end]].sort((a,b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]); else merged.push(span.slice());
    }
    operation.coverage = merged;
    const loaded = Math.min(operation.range.length, merged.reduce((sum, span) => sum + span[1] - span[0] + 1, 0));
    const now = performance.now();
    if (operation.reported && now - operation.reported < 50 && loaded < operation.range.length) return;
    operation.reported = now;
    operation.progress?.(loaded, totals.get(operation.key), operation.type);
  }
  function log(title, detail, level = "info", category = "download", group = "") {
    root.__BTR_RUNTIME_NOTICES__?.log(title, detail, level, group, route, category);
  }
  function onTransfer(event) {
    if (event.phase === "start") {
      const id = ++transferSequence; latestTransfer = id; active.set(id, { ...event, id, received: 0, bytes: 0 }); stats.activeThreads = active.size;
      stats.maxThreads = Math.max(stats.maxThreads, active.size); return id;
    }
    if (event.phase === "progress") {
      stats.networkBytes += Number(event.bytes) || 0;
      const transfer = active.get(event.id);
      if (transfer) transfer.bytes += Number(event.bytes) || 0;
      if (transfer?.range) {
        transfer.received += Number(event.bytes) || 0;
        for (const operation of transfer.operations) wireProgress(operation, transfer.range.start, Math.min(transfer.range.end, transfer.range.start + transfer.received - 1));
      }
    }
    const ended = active.get(event.id);
    // Same wording as the browser version, so a node that sent 0 KiB is easy to recognise.
    if (event.phase === "error" && ended) log("这一小段没能下载下来", `第 ${ended.id} 条线程已收到 ${Math.round(ended.bytes / 1024)} KiB ${KIND_LABELS[ended.kind] || "视频"}数据。\n下载节点：${hostOf(ended.url)}\n原因：${event.error?.message || event.error || "未知"}`, "error", "download", `range-error-${ended.kind}`);
    if (["done", "error", "cancel"].includes(event.phase)) active.delete(event.id);
    stats.activeThreads = active.size;
  }
  // A node that twice sends nothing is skipped until the video changes.
  const bans = resolverFactory.createBanList({
    onBan: host => log("已停用这个 CDN 节点", `${host} 两次没有返回任何数据，这个视频接下来不再使用它。`, "error", "download")
  });
  // This is the shared browser downloader. The adapter changes only its host environment.
  const downloader = root.__BILI_IDM_DOWNLOADER_FACTORY__.createDownloader({
    getSettings: api.getSettings, onTransfer,
    nativeFetch: (url, init) => {
      // The official client uses local HTML. Do not pass its file:// path as an HTTP referrer.
      const next = { ...init }; delete next.referrer;
      const ticket = generation;
      const transfer = active.get(latestTransfer);
      const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range") || "");
      if (transfer && match) {
        transfer.range = { start: Number(match[1]), end: Number(match[2]) };
        transfer.operations = [...operations].filter(operation => operation.key === mediaKey(url) && operation.generation === ticket && transfer.range.start >= operation.range.start && transfer.range.end <= operation.range.end);
      }
      return nativeFetch(url, next).then(response => {
        const parsed = core.parseContentRange(response.headers.get("content-range"));
        if (ticket === generation && parsed?.total) totals.set(mediaKey(url), parsed.total);
        return response;
      });
    }
  });
  const mediaKey = value => { try { const u = new URL(value, location.href); return u.pathname; } catch (_) { return ""; } };
  function eligible(url, method, headers) {
    if (location.origin === "https://bilipc.bilibili.com" && location.pathname !== "/player.html") return null;
    if (stats.suspended || !api.getSettings().enabled || String(method || "GET").toUpperCase() !== "GET" || !core.isBilibiliMediaUrl(url)) return null;
    api.synchronizePlayer?.();
    let match;
    try { match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range") || ""); } catch (_) { return null; }
    if (!match) return null; // Never guess file size or accelerate API, licence, subtitle, or login requests.
    const start = Number(match[1]); let end = Number(match[2]);
    const total = totals.get(mediaKey(url));
    if (total && start < total) end = Math.min(end, total - 1);
    const length = end - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || length > 64 * 1024 * 1024) return null;
    if (!resolverFor(url).startupCandidates().length) return null;
    return { start, end, length };
  }
  function resolverFor(url) {
    const key = String(url); // Signed query is part of the cache identity, not only the path.
    if (!resolvers.has(key)) {
      const rep = representations.get(mediaKey(url));
      const exact = rep && [rep.baseUrl, rep.base_url, ...(rep.backupUrl || rep.backup_url || [])].includes(url);
      const resolver = resolverFactory.createResolver(exact ? rep : { baseUrl: url }, () => api.getSettings().mode, bans);
      // Some client responses contain only a signed Akamai URL. Preserve it;
      // never invent a mainland hostname for an Akamai-specific signature.
      resolvers.set(key, Object.freeze({ ...resolver,
        urls: () => { const urls = resolver.urls(); return urls.length ? urls : resolver.startupCandidates(); },
        rangeCandidates: () => { const urls = resolver.rangeCandidates(); return urls.length ? urls : resolver.startupCandidates(); },
        ordered: (index, exclude) => { const urls = resolver.ordered(index, exclude); return urls.length ? urls : resolver.startupCandidates().filter(url => !exclude?.has(url)); }
      }));
      if (resolvers.size > 64) resolvers.delete(resolvers.keys().next().value);
    }
    return resolvers.get(key);
  }
  async function download(url, range, signal, progress) {
    const ticket = generation, controller = new AbortController();
    const abort = () => controller.abort(signal.reason || new DOMException("请求已取消", "AbortError"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    const rep = representations.get(mediaKey(url));
    const type = rep?._btrKind === "audio" ? "audio/mp4" : "video/mp4";
    const operation = { controller, generation: ticket, range, key: mediaKey(url), type, progress, coverage: [], reported: 0 };
    operations.add(operation);
    let loaded = 0;
    const chunks = [];
    try {
      const result = await downloader.downloadRange(range, resolverFor(url), {
        // Small audio/index requests must not lower the shared semaphore to 1.
        // Use the original downloader's metadata race for tiny ranges instead.
        signal: controller.signal, parallel: true,
        maxConcurrency: range.length < 128 * 1024 ? 1 : api.getSettings().concurrency,
        kind: range.length <= 64 * 1024 ? "meta" : rep?._btrKind || "video", startup: range.start === 0 || stats.acceleratedRequests < 2,
        onOrderedChunk(bytes) {
          if (controller.signal.aborted || ticket !== generation) throw new DOMException("视频已切换", "AbortError");
          chunks.push(bytes); loaded += bytes.byteLength;
        }
      });
      if (controller.signal.aborted || ticket !== generation) throw new DOMException("视频已切换", "AbortError");
      const bytes = result.bytes || core.concatChunks(chunks, range.length);
      stats.acceleratedRequests++; stats.routeAcceleratedRequests++; stats.acceleratedBytes += bytes.byteLength; failureStreak = 0;
      log("视频数据已交给客户端", `${Math.round(bytes.byteLength / 1024)} KiB，由 ${result.pieceCount || 1} 个子块下载完成。`, "success", "buffer", "segments");
      return { bytes, total: result.total, type: rep?._btrKind === "audio" ? "audio/mp4" : "video/mp4" };
    } finally { pending.delete(controller); operations.delete(operation); signal?.removeEventListener("abort", abort); }
  }
  function fallback(error) {
    stats.fallbackRequests++;
    stats.lastError = String(error?.message || error).replace(/https?:\/\/\S+/g, "[CDN]").slice(0, 160);
    log("加速请求失败，已交回客户端重试", stats.lastError, "error");
    if (++failureStreak < FAILURE_LIMIT || stats.suspended) return;
    // Requests already running finish or fall back on their own; aborting them would fail the player.
    stats.suspended = true;
    log("BTR 加速已暂停", `连续 ${FAILURE_LIMIT} 次加速失败，这个播放窗口改用客户端原生下载。重新打开播放窗口会再次尝试。`, "error");
  }
  root.fetch = function (input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    const method = init?.method || input?.method || "GET";
    const headers = init?.headers || input?.headers;
    const range = eligible(url, method, headers);
    if (!range) return nativeFetch(input, init);
    const ticket = generation, signal = init?.signal || input?.signal;
    stats.fetchRequests++;
    return download(url, range, signal).then(result => { const response = new Response(result.bytes, {
      status: 206, statusText: "Partial Content",
      headers: { "Content-Type": result.type, "Content-Length": String(range.length), "Accept-Ranges": "bytes", "Content-Range": `bytes ${range.start}-${range.end}/${result.total || "*"}` }
    }); Object.defineProperty(response, "url", { value: url }); return response; }).catch(error => {
      if (signal?.aborted || ticket !== generation || error?.name === "AbortError") throw error;
      fallback(error); return nativeFetch(input, init);
    });
  };
  class DesktopXHR extends NativeXHR {
    open(method, url, async = true, ...rest) {
      if (this._btr) { this._btr.canceled = true; this._btr.controller.abort(); }
      this._btr = null;
      this._btrRequest = { method, url: new URL(String(url), location.href).href, async: async !== false, headers: new Headers(), token: {} };
      return super.open(method, url, async, ...rest);
    }
    setRequestHeader(name, value) { super.setRequestHeader(name, value); this._btrRequest?.headers.append(name, value); }
    get readyState() { return this._btr?.state ?? super.readyState; }
    get status() { return this._btr?.status ?? super.status; }
    get statusText() { return this._btr ? (this._btr.status === 206 ? "Partial Content" : "") : super.statusText; }
    get responseURL() { return this._btr ? this._btrRequest.url : super.responseURL; }
    get response() { return this._btr ? this._btr.response : super.response; }
    get responseText() { if (this._btr) throw new DOMException("Response is an ArrayBuffer", "InvalidStateError"); return super.responseText; }
    getAllResponseHeaders() { return this._btr ? [...this._btr.headers].map(([k,v]) => `${k}: ${v}\r\n`).join("") : super.getAllResponseHeaders(); }
    getResponseHeader(name) { return this._btr ? this._btr.headers.get(name) : super.getResponseHeader(name); }
    abort() {
      const task = this._btr;
      if (!task) return super.abort();
      if (task.canceled) return;
      stats.abortedRequests++;
      task.canceled = true; task.controller.abort(); clearTimeout(task.timer);
      task.status = 0; task.state = 4; task.response = null;
      this.dispatchEvent(new Event("readystatechange")); this.dispatchEvent(new ProgressEvent("abort")); this.dispatchEvent(new ProgressEvent("loadend"));
      task.state = 0;
    }
    send(body) {
      const request = this._btrRequest;
      const range = request?.async && !body && this.responseType === "arraybuffer" && eligible(request.url, request.method, request.headers);
      if (!range) return super.send(body);
      if (this._btr) throw new DOMException("Request already sent", "InvalidStateError");
      stats.xhrRequests++;
      const task = this._btr = { state: 1, status: 0, response: null, headers: new Headers(), controller: new AbortController(), canceled: false, timer: null };
      const valid = () => !task.canceled && this._btr === task && this._btrRequest === request;
      const state = value => { task.state = value; this.dispatchEvent(new Event("readystatechange")); };
      this.dispatchEvent(new ProgressEvent("loadstart"));
      if (this.timeout > 0) task.timer = setTimeout(() => {
        if (!valid()) return; stats.timedOutRequests++; task.canceled = true; task.controller.abort(); task.status = 0; state(4);
        this.dispatchEvent(new ProgressEvent("timeout")); this.dispatchEvent(new ProgressEvent("loadend"));
      }, this.timeout);
      const ticket = generation;
      download(request.url, range, task.controller.signal, (loaded, total, type) => {
        if (!valid()) return;
        task.headers = new Headers({ "Content-Type": type, "Content-Length": String(range.length), "Content-Range": `bytes ${range.start}-${range.end}/${total || "*"}`, "Accept-Ranges": "bytes" });
        if (task.state < 3) { task.status = 206; state(2); state(3); }
        this.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded, total: range.length }));
      }).then(result => {
        if (!valid()) return;
        clearTimeout(task.timer); task.status = 206;
        task.headers = new Headers({ "Content-Type": result.type, "Content-Length": String(range.length), "Content-Range": `bytes ${range.start}-${range.end}/${result.total || "*"}`, "Accept-Ranges": "bytes" });
        task.response = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength);
        if (task.state < 2) state(2);
        state(4);
        this.dispatchEvent(new ProgressEvent("load", { lengthComputable: true, loaded: range.length, total: range.length }));
        this.dispatchEvent(new ProgressEvent("loadend", { lengthComputable: true, loaded: range.length, total: range.length }));
      }).catch(error => {
        if (!valid()) return;
        clearTimeout(task.timer);
        if (ticket !== generation || error?.name === "AbortError") { this.abort(); return; }
        fallback(error); this._btr = null; super.send(body);
      });
    }
  }
  root.XMLHttpRequest = DesktopXHR;
  api.transport = Object.freeze({
    eligible,
    register(playinfo) {
      const dash = playinfo?.dash || playinfo?.data?.dash || playinfo?.result?.dash;
      if (!dash) return;
      for (const kind of ["video", "audio"]) for (const rep of dash[kind] || []) {
        for (const url of [rep.baseUrl, rep.base_url, ...(rep.backupUrl || rep.backup_url || [])].filter(Boolean)) representations.set(mediaKey(url), { ...rep, _btrKind: kind });
      }
    },
    switchRoute(next) {
      if (next === route) return;
      generation++; route = String(next || ""); stats.route = route; stats.routeAcceleratedRequests = 0;
      for (const controller of pending) controller.abort(new DOMException("视频已切换", "AbortError"));
      resolvers.clear(); representations.clear(); totals.clear(); bans.reset();
      log("已切换视频", "旧视频的下载任务已取消。", "info", "takeover");
    },
    snapshot: () => ({ ...stats, generation, pending: pending.size, bannedHosts: bans.hosts() }),
    restore() {
      for (const controller of pending) controller.abort(new DOMException("加速已停止", "AbortError"));
      root.fetch = nativeFetch; root.XMLHttpRequest = NativeXHR;
    }
  });
})(globalThis);
