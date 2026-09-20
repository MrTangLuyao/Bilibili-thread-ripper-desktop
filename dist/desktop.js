globalThis.__BTR_DESKTOP_RELEASE__={"version":"0.9.2.3-d1","adapterRevision":1};

/* shared/range-core.js */
(function installRangeCore(root) {
  "use strict";

  const MEDIA_SUFFIX_RE = /\.(?:m4s|mp4|flv)$/i;
  const MEDIA_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|hdslb\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;

  function parseByteRange(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d+)-(\d+)$/.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    return { start, end, length: end - start + 1 };
  }

  function parseRangeHeader(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes=(\d+)-(\d+)$/i.exec(value.trim());
    return match ? parseByteRange(`${match[1]}-${match[2]}`) : null;
  }

  function parseContentRange(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total, length: end - start + 1 };
  }

  function splitRange(start, end, concurrency, minChunkBytes = 128 * 1024) {
    const length = end - start + 1;
    const limit = Math.max(1, Math.min(512, Math.trunc(concurrency) || 1));
    const minimum = Math.max(32 * 1024, Math.trunc(minChunkBytes) || 128 * 1024);
    const count = Math.max(1, Math.min(limit, Math.ceil(length / minimum)));
    const base = Math.floor(length / count);
    const remainder = length % count;
    const pieces = [];
    let cursor = start;
    for (let index = 0; index < count; index += 1) {
      const size = base + (index < remainder ? 1 : 0);
      pieces.push({ index, start: cursor, end: cursor + size - 1, length: size });
      cursor += size;
    }
    return pieces;
  }

  function concatChunks(chunks, expectedLength) {
    const output = new Uint8Array(expectedLength);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (offset + bytes.byteLength > expectedLength) throw new RangeError("子区间超出目标长度");
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== expectedLength) throw new RangeError(`子区间长度不符：${offset}/${expectedLength}`);
    return output;
  }

  function isBilibiliMediaUrl(value) {
    try {
      const url = new URL(value, root.location?.href);
      return url.protocol === "https:" && MEDIA_SUFFIX_RE.test(url.pathname) && MEDIA_HOST_RE.test(url.hostname);
    } catch (_error) {
      return false;
    }
  }

  // A server added by hand in the custom CDN mode. Only its host name is kept, and only for
  // the Bilibili video servers isBilibiliMediaUrl accepts: the signed download addresses
  // must never be sent to anyone else.
  function normalizeCdnHost(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text.length > 253) return "";
    let host = "";
    try { host = new URL(/^[a-z][a-z\d+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname; }
    catch (_error) { return ""; }
    return /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/.test(host) && MEDIA_HOST_RE.test(host) ? host : "";
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const allowed = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(source.concurrency));
    return {
      enabled: source.enabled !== false,
      // "full" replaces Bilibili's playback core; "compat" leaves it in charge and only
      // downloads its media requests.
      takeover: source.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(source.mode) ? source.mode : "mainland",
      customHosts: (Array.isArray(source.customHosts) ? source.customHosts : [])
        .map(normalizeCdnHost)
        .filter((host, index, all) => host && all.indexOf(host) === index)
        .slice(0, 32),
      debugNotices: source.debugNotices === true,
      errorNotices: source.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, source.debugCategories?.[key] !== false])),
      concurrency: allowed.includes(requested) ? requested : 8,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      bufferAheadSeconds: 45
    };
  }

  root.__BILI_RANGE_CORE__ = Object.freeze({
    concatChunks,
    isBilibiliMediaUrl,
    normalizeCdnHost,
    normalizeSettings,
    parseByteRange,
    parseContentRange,
    parseRangeHeader,
    splitRange
  });
})(globalThis);


/* shared/cdn-resolver.js */
(function installCdnResolver(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const MAINLAND_HOSTS = Object.freeze([
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  const GLOBAL_HOSTS = Object.freeze([
    ...OVERSEAS_HOSTS,
    ...MAINLAND_HOSTS
  ]);

  function isAkamaiUrl(value) {
    try { return new URL(value).hostname.toLowerCase().endsWith(".akamaized.net"); }
    catch (_error) { return false; }
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value));
      return core.isBilibiliMediaUrl(url.href) ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function swapOrdinaryHost(rawUrl, targetHost, allowAkamai = false) {
    if (!allowAkamai && isAkamaiUrl(rawUrl)) return null;
    const host = String(targetHost || "").toLowerCase();
    if (core.normalizeCdnHost(host) !== host) return null;
    try {
      const url = new URL(rawUrl);
      // Assigning url.host alone keeps a non-standard port, such as a peer CDN's :4483.
      url.hostname = host;
      url.port = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  // The custom mode uses only the servers picked in the settings. Without any, it works like
  // the mainland mode.
  function customServers(mode, customHosts) {
    return mode === "custom" && Array.isArray(customHosts) ? customHosts.map(core.normalizeCdnHost).filter(Boolean) : [];
  }

  function representationUrls(representation, mode, customHosts = []) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
      .map(safeMediaUrl)
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const custom = customServers(mode, customHosts);
    const hosts = custom.length ? custom : mode === "overseas" ? OVERSEAS_HOSTS : MAINLAND_HOSTS;
    const donor = originals.find((url) => !isAkamaiUrl(url));
    // Some overseas accounts are given nothing but akamaized.net addresses. That used to leave
    // no node at all in mainland mode and a single one in overseas mode. The nodes accept
    // those signatures too, so only in that case the akamaized.net addresses are the donors.
    // Bilibili may hand out an address that every node refuses (HTTP 403) next to one that
    // works, so each of them is tried; the ban list drops the refused one. Node-major order
    // keeps the first requests spread over several nodes.
    const synthetic = (donor
      ? hosts.map((host) => swapOrdinaryHost(donor, host))
      : hosts.flatMap((host) => originals.map((url) => swapOrdinaryHost(url, host, true))))
      .map(safeMediaUrl)
      .filter(Boolean);
    const allowedOriginals = custom.length
      ? originals.filter((url) => custom.includes(hostOf(url)))
      : mode === "overseas"
        ? originals.filter((url) => !MAINLAND_HOSTS.includes(hostOf(url)))
        : originals.filter((url) => MAINLAND_HOSTS.includes(hostOf(url)));
    return [...allowedOriginals, ...synthetic].filter((value, index, all) => all.indexOf(value) === index);
  }

  function hostOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  // The signed address without its node: the same address can be asked of any node.
  function addressOf(value) {
    try {
      const url = new URL(value);
      return url.pathname + url.search;
    } catch (_error) {
      return "";
    }
  }

  // A CDN node that twice fails without sending a single byte is skipped for the
  // rest of the current video. The owner resets the list when the video changes.
  //
  // HTTP 4xx means the node answered and refused the signed address, and either side can be
  // at fault: a node may lack the file, or Bilibili may have handed out an address that every
  // node refuses. What has delivered data decides it. Refused by a node that serves other
  // addresses, the address is dropped; refused where other nodes serve it, the node is.
  // With neither known yet, the reply counts against nobody until one of them delivers.
  function createBanList(options = {}) {
    const limit = Math.max(1, Math.trunc(Number(options.limit)) || 2);
    const emptyReplies = new Map();
    const goodNodes = new Set();
    const goodAddresses = new Set();
    const reported = new Set();
    let banned = new Set();

    function judge(url, error) {
      const strikes = new Map();
      for (const [key, count] of emptyReplies) {
        const [node, address, refused] = key.split("\n");
        // A node that serves other addresses and refuses one that other nodes serve loses only
        // that pair; it is often the fastest node for the addresses it does serve.
        const blamed = !refused ? `node:${node}`
          : goodNodes.has(node) ? (goodAddresses.has(address) ? `pair:${node} ${address}` : `address:${address}`)
            : goodAddresses.has(address) ? `node:${node}` : "";
        if (blamed) strikes.set(blamed, (strikes.get(blamed) || 0) + count);
      }
      banned = new Set([...strikes].filter(([, count]) => count >= limit).map(([key]) => key));
      let added = false;
      for (const key of banned) {
        if (reported.has(key)) continue;
        reported.add(key);
        added = true;
        const isNode = key.startsWith("node:");
        try { options.onBan?.(isNode ? key.slice(5) : hostOf(url), strikes.get(key), error, isNode ? "node" : "address"); } catch (_error) {}
      }
      return added;
    }

    return Object.freeze({
      record(url, receivedBytes, error) {
        if (error?.name === "AbortError" || Number(receivedBytes) > 0) return false;
        const node = hostOf(url);
        if (!node) return false;
        const status = Number(error?.status) || 0;
        const key = `${node}\n${addressOf(url)}\n${status >= 400 && status < 500 ? "refused" : ""}`;
        emptyReplies.set(key, (emptyReplies.get(key) || 0) + 1);
        return judge(url, error);
      },
      success(url) {
        const node = hostOf(url);
        const address = addressOf(url);
        if (!node || (goodNodes.has(node) && goodAddresses.has(address))) return;
        goodNodes.add(node);
        goodAddresses.add(address);
        judge(url, null);
      },
      allows: (url) => !banned.has(`node:${hostOf(url)}`) && !banned.has(`address:${addressOf(url)}`) && !banned.has(`pair:${hostOf(url)} ${addressOf(url)}`),
      allowsNode: (url) => !banned.has(`node:${hostOf(url)}`),
      allowsAddress: (url) => !banned.has(`address:${addressOf(url)}`),
      hosts: () => [...banned].filter((key) => key.startsWith("node:")).map((key) => key.slice(5)),
      reset() {
        emptyReplies.clear();
        goodNodes.clear();
        goodAddresses.clear();
        reported.clear();
        banned = new Set();
      }
    });
  }

  function createResolver(representation, getMode, bans = null, getCustomHosts = null) {
    const health = new Map();
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.(), getCustomHosts?.() || []);
    }

    // Banned nodes are left out. If every node is banned, keep using them rather
    // than leaving the video with no download address at all.
    function unbanned(list) {
      if (!bans) return list;
      const allowed = list.filter(bans.allows);
      return allowed.length ? allowed : list;
    }

    function urls() {
      return unbanned(allUrls());
    }

    function ordered(pieceIndex = 0, exclude = new Set()) {
      const now = Date.now();
      const candidates = urls().filter((url) => !exclude.has(url));
      const available = candidates.filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      const pool = available.length ? available : candidates;
      if (!pool.length) return [];
      const offset = (cursor + pieceIndex) % pool.length;
      const rotated = pool.slice(offset).concat(pool.slice(0, offset));
      cursor = (cursor + 1) % pool.length;
      return rotated;
    }

    function rangeCandidates() {
      const now = Date.now();
      const pool = urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort((a, b) => {
          const ah = health.get(a) || {};
          const bh = health.get(b) || {};
          return Number(Boolean(bh.lastSuccessAt)) - Number(Boolean(ah.lastSuccessAt)) ||
            (bh.bps || 0) - (ah.bps || 0);
        });
      if (!pool.length) return urls();
      const firstRange = mediaRangeCount === 0;
      const width = Math.min(firstRange ? pool.length : 3, pool.length);
      let selected;
      const warmupRanges = getMode?.() === "mainland" ? 1 : 4;
      if (mediaRangeCount < warmupRanges) {
        selected = pool.slice(0, width);
        rangeCursor = width % pool.length;
      } else {
        const offset = rangeCursor % pool.length;
        const rotated = pool.slice(offset).concat(pool.slice(0, offset));
        selected = rotated.slice(0, width);
        rangeCursor = (rangeCursor + width) % pool.length;
      }
      mediaRangeCount += 1;
      return selected;
    }

    function startupCandidates() {
      const now = Date.now();
      const primary = representation?.baseUrl || representation?.base_url;
      const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
      // The first request also races the addresses Bilibili handed out, except in the custom
      // mode, which keeps to the picked servers.
      const originals = customServers(getMode?.(), getCustomHosts?.()).length ? [] : [primary, ...(Array.isArray(backup) ? backup : [])]
        .map(safeMediaUrl)
        .filter(Boolean);
      const candidates = unbanned([...originals, ...allUrls()]
        .filter((url, index, all) => all.indexOf(url) === index))
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      return candidates.slice(0, 8);
    }

    function rescueCandidates() {
      const now = Date.now();
      return urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort((a, b) => {
          const ah = health.get(a) || {};
          const bh = health.get(b) || {};
          return Number(Boolean(bh.lastSuccessAt)) - Number(Boolean(ah.lastSuccessAt)) ||
            (bh.bps || 0) - (ah.bps || 0);
        });
    }

    function success(url, bps) {
      bans?.success?.(url);
      const old = health.get(url) || {};
      health.set(url, {
        failures: 0,
        blockedUntil: 0,
        lastSuccessAt: Date.now(),
        bps: old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    function failure(url, error, receivedBytes = 0) {
      if (error?.name === "AbortError") return;
      bans?.record(url, receivedBytes, error);
      const old = health.get(url) || {};
      const failures = (old.failures || 0) + 1;
      health.set(url, {
        ...old,
        failures,
        blockedUntil: Date.now() + Math.min(60000, 3000 * (2 ** Math.min(failures, 4)))
      });
    }

    function status() {
      const now = Date.now();
      // A refused address says nothing about its node, so it is left out of the node list.
      const all = allUrls();
      const usable = bans?.allowsAddress ? all.filter(bans.allowsAddress) : all;
      return (usable.length ? usable : all).map((url) => {
        const item = health.get(url) || {};
        const nodeBanned = bans && !(bans.allowsNode ? bans.allowsNode(url) : bans.allows(url));
        return {
          host: new URL(url).hostname,
          state: nodeBanned ? "banned" : (item.blockedUntil || 0) > now ? "blocked" : item.lastSuccessAt ? "healthy" : "untested",
          bps: item.bps || 0
        };
      });
    }

    const allows = (url) => !bans || bans.allows(url);
    return Object.freeze({ allows, failure, ordered, rangeCandidates, rescueCandidates, startupCandidates, status, success, urls });
  }

  root.__BILI_CDN_RESOLVER_FACTORY__ = Object.freeze({
    GLOBAL_HOSTS,
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createResolver,
    isAkamaiUrl,
    representationUrls,
    swapOrdinaryHost
  });
})(globalThis);


/* shared/idm-downloader.js */
(function installIdmDownloader(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const PIECE_ROUNDS = 3;
  const PIECE_RETRY_WINDOW_MS = 25000;

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
      this.sequence = 0;
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    drain() {
      while (this.active < this.limit && this.queue.length) {
        const entry = this.queue.shift();
        entry.signal?.removeEventListener("abort", entry.cancel);
        if (entry.signal?.aborted) {
          entry.reject(abortError(entry.signal.reason));
          continue;
        }
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    acquire(signal, priority = 0) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: Number(priority) || 0,
          sequence: this.sequence++
        };
        entry.cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          reject(abortError(signal.reason));
        };
        signal?.addEventListener("abort", entry.cancel, { once: true });
        this.queue.push(entry);
        this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        this.drain();
      });
    }
  }

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    const semaphore = new Semaphore(core.normalizeSettings(getSettings()).concurrency);

    async function readBody(response, controller, transferId, settings, received) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        onTransfer({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
      // Do not rely on fetch implementations to unblock read() after abort. A
      // pending reader must release its concurrency slot before a quality change.
      const cancelReader = () => { reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const chunks = [];
      let total = 0;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块停止传输", "TimeoutError")), settings.stallTimeoutMs);
      };
      armStall();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          onTransfer({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    async function attempt(piece, url, signal, kind, resolver, priority = 0) {
      const settings = core.normalizeSettings(getSettings());
      const release = await semaphore.acquire(signal, priority);
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const transferId = onTransfer({ phase: "start", kind, totalBytes: piece.length, url });
      const startedAt = performance.now();
      const received = { bytes: 0 };
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
        resolver.success(url, bytes.byteLength / seconds);
        onTransfer({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes);
        const canceled = error?.name === "AbortError";
        onTransfer({ phase: canceled ? "cancel" : "error", id: transferId, error });
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        // Invalid headers can reject before readBody obtains a reader. Stop that
        // response too, otherwise it keeps downloading after releasing the slot.
        controller.abort();
        signal?.removeEventListener("abort", cancel);
        release();
      }
    }

    function pause(delayMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        function done() {
          signal?.removeEventListener("abort", canceled);
          resolve();
        }
        function canceled() {
          clearTimeout(timer);
          reject(abortError(signal.reason));
        }
        if (signal?.aborted) canceled();
        else signal?.addEventListener("abort", canceled, { once: true });
      });
    }

    function pieceCandidates(piece, resolver, preferredUrls, round) {
      const preferred = Array.isArray(preferredUrls) ? preferredUrls : [];
      const preferredOffset = preferred.length ? (piece.index + round) % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      const candidates = [];
      const width = Math.max(rotatedPreferred.length, rescue.length);
      for (let index = 0; index < width; index += 1) {
        if (rotatedPreferred[index]) candidates.push(rotatedPreferred[index]);
        if (rescue[index]) candidates.push(rescue[index]);
      }
      for (const url of resolver.ordered(piece.index)) {
        if (!candidates.includes(url)) candidates.push(url);
      }
      return candidates;
    }

    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0) {
      const settings = core.normalizeSettings(getSettings());
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const probe = startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

      // Failing a piece ends acceleration for the whole video, and the list can be as short as
      // one working address. One slow reply must not decide that, so the list is walked again
      // after a pause; node health and bans have changed by then, so it is rebuilt each time.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), signal);
        }
        const candidates = pieceCandidates(piece, resolver, preferredUrls, round);
        const limit = Math.min(8, candidates.length);
        const batchWidth = probe ? limit : 2;
        const tried = new Set();
        while (tried.size < limit) {
          if (signal?.aborted) throw abortError(signal.reason);
          // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
          const untried = candidates.filter((url) => !tried.has(url));
          const open = untried.filter(allowed);
          const pair = (open.length ? open : untried).slice(0, batchWidth);
          if (!pair.length) break;
          pair.forEach((url) => tried.add(url));
          const controllers = pair.map(() => new AbortController());
          const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
          if (signal?.aborted) cancelAll();
          else signal?.addEventListener("abort", cancelAll, { once: true });
          // A first copy that is refused at once (HTTP 403) should not leave the piece idle
          // for the rest of the hedge delay.
          let firstFailed = () => {};
          const firstFailure = new Promise((resolve) => { firstFailed = resolve; });
          const attempts = pair.map((url, pairIndex) => (async () => {
            if (pairIndex) await new Promise((resolve, reject) => {
              const delay = probe ? 0 : startup ? Math.min(250, settings.hedgeDelayMs) : settings.hedgeDelayMs;
              const timer = setTimeout(resolve, delay);
              firstFailure.then(() => {
                clearTimeout(timer);
                resolve();
              });
              const canceled = () => {
                clearTimeout(timer);
                reject(abortError(controllers[pairIndex].signal.reason));
              };
              if (controllers[pairIndex].signal.aborted) canceled();
              else controllers[pairIndex].signal.addEventListener("abort", canceled, { once: true });
            });
            try {
              return await attempt(piece, url, controllers[pairIndex].signal, kind, resolver, priority + (pairIndex ? 20 : 0));
            } catch (error) {
              if (!pairIndex) firstFailed();
              throw error;
            }
          })());
          try {
            const winner = await Promise.any(attempts);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
            });
            return winner;
          } catch (aggregate) {
            lastError = aggregate?.errors?.at?.(-1) || aggregate;
            if (signal?.aborted) throw abortError(signal.reason);
          } finally {
            signal?.removeEventListener("abort", cancelAll);
          }
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function delayedAttempt(piece, url, delayMs, signal, kind, resolver, controller, priority = 0) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const canceled = () => {
            clearTimeout(timer);
            reject(abortError(controller.signal.reason));
          };
          if (controller.signal.aborted) canceled();
          else controller.signal.addEventListener("abort", canceled, { once: true });
        });
      }
      if (signal?.aborted) throw abortError(signal.reason);
      return attempt(piece, url, controller.signal, kind, resolver, priority);
    }

    async function startupAttempt(piece, candidates, resolver, options) {
      const controllers = candidates.map(() => new AbortController());
      const cancelAll = () => controllers.forEach((controller) => {
        if (!controller.signal.aborted) controller.abort(abortError(options.signal?.reason));
      });
      if (options.signal?.aborted) cancelAll();
      else options.signal?.addEventListener("abort", cancelAll, { once: true });
      try {
        let winner;
        try {
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? 120 : 300,
            options.signal,
            options.kind || "meta",
            resolver,
            controllers[index],
            220
          )));
        } catch (aggregate) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          throw aggregate?.errors?.at?.(-1) || aggregate;
        }
        controllers.forEach((controller) => {
          if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
        });
        return winner;
      } finally {
        options.signal?.removeEventListener("abort", cancelAll);
      }
    }

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(core.normalizeSettings(getSettings()).concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const startedAt = performance.now();
      let lastError = null;
      // The addresses that just failed are backing off by the next round, so each round
      // moves on to the next three.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), options.signal);
        }
        let candidates = (typeof resolver.startupCandidates === "function" ? resolver.startupCandidates() : resolver.urls())
          .filter((url, index, all) => all.indexOf(url) === index)
          .slice(0, 3);
        if (!candidates.length && round) candidates = resolver.ordered(round).slice(0, 3);
        if (!candidates.length) break;
        try {
          const winner = await startupAttempt(piece, candidates, resolver, options);
          return {
            bytes: winner.bytes,
            pieceCount: 1,
            total: winner.total || null,
            hosts: [new URL(winner.url).hostname]
          };
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          lastError = error;
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function downloadStartupMediaRange(range, resolver, options, settings) {
      const effectiveConcurrency = settings.concurrency;
      semaphore.setLimit(effectiveConcurrency);
      const candidateUrls = (typeof resolver.rangeCandidates === "function" ? resolver.rangeCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index);
      const headLength = Math.min(range.length, Math.max(64 * 1024, settings.minChunkBytes));
      const head = {
        index: 0,
        start: range.start,
        end: range.start + headLength - 1,
        length: headLength
      };
      const headResult = await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220
      );
      await options.onOrderedChunk(headResult.bytes, head, headResult.total);
      if (head.end >= range.end) {
        options.onStartupScheduled?.();
        return {
          bytes: null,
          byteLength: range.length,
          pieceCount: 1,
          streamed: true,
          total: headResult.total || null,
          hosts: [new URL(headResult.url).hostname]
        };
      }

      const rescueReserve = Math.max(1, Math.min(16, Math.ceil(effectiveConcurrency / 8)));
      const mediaBudget = Math.max(1, effectiveConcurrency - rescueReserve);
      const audioBudget = Math.max(1, Math.min(mediaBudget, Math.ceil(effectiveConcurrency / 8)));
      const pieceBudget = options.kind === "audio"
        ? audioBudget
        : Math.max(1, mediaBudget - audioBudget);
      const pieces = core.splitRange(
        head.end + 1,
        range.end,
        pieceBudget,
        settings.minChunkBytes
      ).map((piece, index) => ({ ...piece, index: index + 1 }));
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex], item.total);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          [headResult.url],
          true,
          120 - Math.min(30, piece.index)
        );
        ordered[orderedIndex] = result;
        await flushOrdered();
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await flushOperation;
      const totals = [headResult, ...results].map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: pieces.length + 1,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set([headResult, ...results].map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = core.normalizeSettings(getSettings());
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, options, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // 后台预取可以限制自己的子块数，但不能降低全局信号量上限；
      // 否则一个低优先级预取会把后续播放器的紧急请求也锁在低并发上。
      semaphore.setLimit(globalConcurrency);
      const basePriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
      const rescueReserve = parallel && effectiveConcurrency >= 8
        ? Math.min(8, Math.max(1, Math.ceil(effectiveConcurrency / 8)))
        : 0;
      const pieceConcurrency = options.startup === true
        ? Math.max(1, Math.min(22, effectiveConcurrency))
        : Math.max(1, effectiveConcurrency - rescueReserve);
      const pieces = core.splitRange(
        range.start,
        range.end,
        pieceConcurrency,
        parallel ? settings.minChunkBytes : Number.MAX_SAFE_INTEGER
      );
      const progressive = typeof options.onOrderedChunk === "function";
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex], item.total);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredUrls,
          options.startup === true,
          basePriority - Math.min(20, piece.index)
        );
        if (progressive) {
          ordered[piece.index] = result;
          await flushOrdered();
        }
        return result;
      }));
      if (progressive) await flushOperation;
      const totals = results.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: progressive ? null : core.concatChunks(results.map((item) => item.bytes), range.length),
        byteLength: range.length,
        pieceCount: pieces.length,
        streamed: progressive,
        total: totals[0] || null,
        hosts: [...new Set(results.map((item) => new URL(item.url).hostname))]
      };
    }

    return Object.freeze({ downloadRange, applySettings: () => semaphore.setLimit(core.normalizeSettings(getSettings()).concurrency) });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader });
})(globalThis);


/* shared/runtime-notices.js */
(function installRuntimeNotices(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const EVENT_NAMES = ["playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "loadedmetadata", "canplay", "ratechange"];
  const EVENT_LABELS = { playing: "视频开始播放了", pause: "视频已暂停", waiting: "正在缓冲，请稍等", stalled: "暂时没收到视频数据，还在等待", seeking: "正在跳到你选择的位置", seeked: "已经跳到你选择的位置", ended: "视频播放完了", error: "视频播放出错了", emptied: "旧视频已清空，准备加载新视频", loadedmetadata: "已经读到视频信息", canplay: "视频已经可以播放了", ratechange: "播放速度已改变" };
  let settings = {};
  let attachment = null;
  let controller = null;
  let heartbeat = null;
  let flushTimer = null;
  let sequence = 0;
  let lastTime = 0;
  let lastProgress = -Infinity;
  let lastReportedPlaying = null;
  const pending = new Map();

  function post(type, payload) {
    root.postMessage({ channel: CHANNEL, type, payload }, "*");
  }

  // Signed media URLs and tokens are not useful in an on-screen log.
  function clean(value) {
    return String(value ?? "").replace(/https?:\/\/[^\s]+/gi, (url) => {
      try { return new URL(url).hostname; } catch (_error) { return "[URL]"; }
    }).replace(/[\u00b7\u2022\u2027\u2219\u22c5]+/g, "，").slice(0, 320);
  }

  function flush() {
    flushTimer = null;
    const entries = Array.from(pending.values()).filter(entry => allowed(entry.level, entry.category));
    if (entries.length) post("debug-notices", entries);
    pending.clear();
  }

  function allowed(level, category = "other") {
    return settings.enabled && (level === "error" ? settings.errorNotices : settings.debugNotices && settings.debugCategories?.[category] !== false);
  }

  function log(title, detail = "", level = "info", group = "", route = attachment?.route || "", category = "other") {
    category = ["takeover", "playback", "download", "buffer", "settings", "other"].includes(category) ? category : "other";
    if (!allowed(level, category)) return;
    // Coalesce high-frequency events before publishing a snapshot. The view
    // always creates a new bubble and never edits an already visible message.
    const key = group ? `${route}:${category}:${group}` : `event-${++sequence}`;
    const previous = pending.get(key);
    const entry = { key, title: clean(title), detail: clean(detail), route: clean(route), category, level: ["success", "error"].includes(level) ? level : "info", at: Date.now(), count: (previous?.count || 0) + 1 };
    pending.delete(key);
    pending.set(key, entry);
    if (pending.size > 48) {
      const ordinary = [...pending].find(([, item]) => item.level !== "error");
      pending.delete(ordinary ? ordinary[0] : pending.keys().next().value);
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 180);
  }

  function current() {
    return attachment && attachment.video?.isConnected && attachment.isCurrent();
  }

  function sample(force = false) {
    if (!allowed("info", "playback")) return;
    const video = attachment?.video;
    const valid = Boolean(current());
    const now = performance.now();
    const time = Number(video?.currentTime) || 0;
    if (valid && !video.paused && !video.seeking && !video.ended && time > lastTime + 0.001) lastProgress = now;
    lastTime = time;
    const playing = valid && !video.paused && !video.ended && !video.seeking && !video.error && video.readyState >= 2 && now - lastProgress < 1800;
    if (force || playing !== lastReportedPlaying) {
      if (valid && playing !== lastReportedPlaying) log(playing ? "画面正在正常播放" : "加速已接管，正在等视频播放", `当前播放到 ${time.toFixed(2)} 秒。`, playing ? "success" : "info", "", attachment?.route || "", "playback");
      lastReportedPlaying = playing;
    }
    // Heartbeats let the isolated UI expire status if the page hook disappears.
    post("playback-notice", { attached: valid, playing, route: valid ? attachment.route : "", session: attachment?.session || 0 });
  }

  function stopWatch() {
    controller?.abort();
    controller = null;
    clearInterval(heartbeat);
    heartbeat = null;
    lastReportedPlaying = null;
    lastProgress = -Infinity;
  }

  function watch() {
    stopWatch();
    if (!settings.enabled || !(settings.debugNotices || settings.errorNotices) || !attachment) return;
    const captured = attachment;
    const video = captured.video;
    controller = new AbortController();
    lastTime = Number(video.currentTime) || 0;
    for (const name of EVENT_NAMES) {
      const category = ["waiting", "stalled", "seeking", "seeked"].includes(name) ? "buffer" : "playback";
      if (!allowed(name === "error" ? "error" : "info", category)) continue;
      video.addEventListener(name, () => {
        if (attachment !== captured || !current()) return;
        if (name === "playing") lastProgress = performance.now();
        else if (["pause", "waiting", "stalled", "seeking", "ended", "error", "emptied"].includes(name)) {
          lastProgress = -Infinity;
          lastTime = Number(video.currentTime) || 0;
        }
        const errorReason = { 1: "视频加载被中断了", 2: "视频数据没能下载下来", 3: "浏览器没能解码这个视频", 4: "浏览器不支持这个视频格式" }[video.error?.code] || "播放器没有给出具体原因";
        const detail = `当前播放到 ${Number(video.currentTime).toFixed(2)} 秒。${name === "error" ? `\n${errorReason}。\n${video.error?.message || ""}` : ""}`;
        const level = name === "error" ? "error" : ["playing", "seeked", "ended", "loadedmetadata", "canplay"].includes(name) ? "success" : "info";
        log(EVENT_LABELS[name], detail, level, "", captured.route, category);
        sample(true);
      }, { signal: controller.signal });
    }
    if (allowed("info", "playback")) {
      video.addEventListener("timeupdate", () => sample(), { signal: controller.signal });
      heartbeat = setInterval(sample, 500);
      sample(true);
    }
  }

  root.__BTR_RUNTIME_NOTICES__ = Object.freeze({
    log,
    configure(next) {
      const changed = settings.enabled !== next.enabled || settings.debugNotices !== next.debugNotices || settings.errorNotices !== (next.errorNotices === true)
        || ["playback", "buffer"].some(category => (settings.debugCategories?.[category] !== false) !== (next.debugCategories?.[category] !== false));
      const wasDebug = settings.enabled && settings.debugNotices;
      settings = { enabled: next.enabled !== false, debugNotices: next.debugNotices === true, errorNotices: next.errorNotices === true, debugCategories: { ...next.debugCategories } };
      for (const [key, entry] of pending) if (!allowed(entry.level, entry.category)) pending.delete(key);
      if (!pending.size) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!wasDebug && settings.enabled && settings.debugNotices) log("调试提示已打开", "接下来会显示你勾选的运行消息。", "success", "", "", "settings");
      if (changed) watch();
    },
    attach(video, route, session, isCurrent) {
      attachment = { video, route, session, isCurrent };
      log("视频已接管", "继续使用 B 站播放器，由多线程下载加速。", "success", "", route, "takeover");
      watch();
    },
    detach(reason = "已停止接管这个视频") {
      if (attachment) log(reason, "", "info", "", attachment.route, "takeover");
      stopWatch();
      attachment = null;
      if (settings.debugNotices) post("playback-notice", { attached: false, playing: false, route: "", session: 0 });
    }
  });
})(globalThis);


/* shared/notification-view.js */
(function installNotificationView(root) {
  "use strict";

  const ID = "__btr_notification_stack__";
  const MAX_CARDS = 6;
  const MAX_ERROR_CARDS = 3;
  const LIFETIME = 6500;
  const ERROR_LIFETIME = 20000;
  const ENTER_MS = 600;
  const MOVE_MS = 560;
  const EXIT_MS = 480;
  const EASING = "cubic-bezier(.2,.75,.25,1)";
  const reducedMotion = root.matchMedia("(prefers-reduced-motion: reduce)");
  const cards = new Set();
  const leaving = new Set();
  let settings = {};
  let host = null;
  let stack = null;
  let normalLayer = null;
  let errorLayer = null;
  let idleCard = null;
  let playback = null;
  let receivedAt = 0;
  let lastMode = "";
  let sequence = 0;
  let timer = null;

  function plainText(value, limit = 320) {
    return String(value ?? "").replace(/[\u00b7\u2022\u2027\u2219\u22c5]+/g, "，").slice(0, limit);
  }

  function categoryOf(entry) {
    return ["takeover", "playback", "download", "buffer", "settings", "other"].includes(entry?.category) ? entry.category : "other";
  }

  function allCards() {
    return [...cards, ...leaving].sort((a, b) => b.id - a.id);
  }

  function moveUp(card, target) {
    if (Number.isFinite(card.y) && target >= card.y - .5) return;
    const current = Number.isFinite(card.y) ? card.wrapper.getBoundingClientRect().top - stack.getBoundingClientRect().top : target;
    // Never reverse an interrupted animation, even when a newer layout request
    // arrives before the previous upward movement has finished.
    target = Math.min(target, current);
    card.motion?.cancel();
    card.y = target;
    card.wrapper.style.transform = `translateY(${target}px)`;
    if (!reducedMotion.matches && current - target > .5) {
      card.motion = card.wrapper.animate([{ transform: `translateY(${current}px)` }, { transform: `translateY(${target}px)` }], { duration: MOVE_MS, easing: EASING });
    }
  }

  function packUpwards() {
    if (!stack) return;
    const ordered = allCards();
    for (const card of ordered) card.height = card.wrapper.offsetHeight;
    const errors = ordered.filter(card => card.isError).reverse();
    // Red messages occupy a protected lane at the top of the notification
    // column. Ordinary traffic cannot evict them or push them offscreen.
    let top = Math.max(2, stack.clientHeight - 560);
    for (const card of errors) {
      moveUp(card, Math.min(card.y, top));
      top = card.y + card.height + 8;
    }
    const boundary = errors.length ? top : 0;
    normalLayer.style.clipPath = `inset(${Math.max(0, boundary)}px 0 0 0)`;
    let bottom = stack.clientHeight - 2;
    for (const card of ordered.filter(card => !card.isError)) {
      moveUp(card, Math.min(card.y, bottom - card.height));
      bottom = card.y - 8;
      if (card.y < boundary) {
        // Once clipped out, do not reveal an old message again when an error
        // expires and the protected area becomes smaller.
        retire(card);
        card.wrapper.style.visibility = "hidden";
      }
    }
  }

  function positionStack() {
    if (!host) return;
    const errorNotice = document.getElementById("__bilibili_thread_ripper_error_notice__");
    const fullscreen = document.fullscreenElement;
    const errorVisible = errorNotice?.getClientRects().length && (!fullscreen || fullscreen.contains(errorNotice));
    const bottom = errorVisible ? Math.max(14, innerHeight - errorNotice.getBoundingClientRect().top + 8) : 14;
    const height = `${Math.max(0, innerHeight - bottom - 14)}px`;
    if (host.style.height === height) return;
    host.style.setProperty("height", height, "important");
    // A cleared error or taller viewport may offer more space below. Existing
    // messages keep their positions; only newly created messages use that space.
    trimErrors();
    packUpwards();
  }

  function mount() {
    if (!host) {
      host = document.createElement("div");
      host.id = ID;
      host.style.cssText = "all:initial!important;position:fixed!important;left:14px!important;top:14px!important;width:min(280px,calc(100vw - 28px))!important;z-index:2147483647!important;pointer-events:none!important;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host{color-scheme:dark}
        .stack{position:absolute;inset:0;overflow:hidden}
        .layer{position:absolute;inset:0}
        .errors{z-index:1}
        .entry{position:absolute;top:0;left:2px;right:2px;min-width:0}
        .bubble{--edge:#a5913a;--accent:#f0d66b;box-sizing:border-box;display:block;width:100%;margin:0;padding:7px 9px;border:1px solid var(--edge);border-radius:5px;background:rgba(8,8,10,.78);box-shadow:inset 0 1px 0 #ffffff12,1px 1px 2px #0007;color:#f2f2ee;font:700 13px/1.35 Tahoma,"Microsoft YaHei",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;text-shadow:1px 1px 0 #0009}
        .bubble[data-level="success"]{--edge:#518346;--accent:#a2d983}
        .bubble[data-level="error"]{--edge:#a44949;--accent:#f28b85}
        .debug{cursor:pointer;pointer-events:auto;appearance:none}
        .debug:focus-visible{outline:2px solid #fff;outline-offset:-3px}
        .leaving{pointer-events:none}
        .heading{display:block;font-weight:700;color:var(--accent)}
        .detail{display:block;margin-top:3px}
        .meta{display:block;margin-top:5px;font-size:10px;line-height:1.3;color:#c4c4bc;font-weight:400}
      `;
      stack = document.createElement("div");
      stack.className = "stack";
      normalLayer = document.createElement("div");
      normalLayer.className = "layer normal";
      errorLayer = document.createElement("div");
      errorLayer.className = "layer errors";
      stack.append(normalLayer, errorLayer);
      shadow.append(style, stack);
    }
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.documentElement;
    if (parent && host.parentNode !== parent) parent.append(host);
    positionStack();
    if (!timer) timer = setInterval(tick, 250);
  }

  function createCard(entry, kind) {
    const id = ++sequence;
    const wrapper = document.createElement("div");
    wrapper.className = "entry";
    wrapper.dataset.id = String(id);
    const node = document.createElement(kind === "debug" ? "button" : "div");
    node.className = `bubble ${kind}`;
    node.dataset.level = ["success", "error"].includes(entry.level) ? entry.level : "info";
    if (kind === "debug") {
      node.type = "button";
      node.setAttribute("aria-label", "关闭这条 Debug 提示");
    } else node.setAttribute("role", "status");
    const heading = document.createElement("span");
    heading.className = "heading";
    heading.textContent = entry.level === "error" && !settings.debugNotices ? "BTR 提示" : "BTR Debug";
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = [plainText(entry.title, 80), plainText(entry.detail)].filter(Boolean).join("\n");
    node.append(heading, detail);
    if (kind === "debug") {
      const meta = document.createElement("span");
      meta.className = "meta";
      const route = plainText(entry.route, 100);
      const part = /^(.*):p(\d+)$/.exec(route);
      const videoLabel = part ? `视频 ${part[1]}，第 ${part[2]} P` : route;
      const count = Math.max(1, Math.min(10000, Number(entry.count) || 1));
      meta.textContent = [`时间 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, videoLabel, count > 1 ? `本条包含 ${count} 条同类记录` : ""].filter(Boolean).join("\n");
      node.append(meta);
    }
    wrapper.append(node);
    const isError = entry.level === "error";
    const card = { id, kind, isError, category: kind === "mode" && !entry.category ? "mode" : categoryOf(entry), wrapper, node, y: Infinity, height: 0, expires: Date.now() + (isError ? ERROR_LIFETIME : LIFETIME), fade: null, motion: null };
    if (kind === "debug") node.addEventListener("click", () => retire(card));
    return card;
  }

  function appendCards(entries, kind = "debug") {
    mount();
    if (idleCard) { idleCard.expires = Date.now() + LIFETIME; idleCard = null; }
    const added = entries.map(entry => createCard(entry, kind));
    for (const card of added) {
      cards.add(card);
      (card.isError ? errorLayer : normalLayer).append(card.wrapper);
    }
    trimErrors();
    packUpwards();
    for (const card of added) if (cards.has(card) && !reducedMotion.matches) {
      card.fade = card.node.animate([{ opacity: 0, transform: "translateX(-32px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: ENTER_MS, easing: EASING });
    }
    const ordinary = [...cards].filter(card => !card.isError);
    while (ordinary.length > MAX_CARDS) retire(ordinary.shift());
    return added.at(-1);
  }

  function trimErrors() {
    if (!stack) return;
    const errors = allCards().filter(card => card.isError).reverse();
    const available = Math.min(560, stack.clientHeight) - 4;
    let occupied = errors.reduce((sum, card) => sum + card.wrapper.offsetHeight + 8, 0);
    // Bounded even for a burst of large errors or a very short viewport.
    // Keep the most recent errors when the protected lane is full.
    while (errors.length > MAX_ERROR_CARDS || (errors.length > 1 && occupied > available)) {
      const card = errors.shift();
      occupied -= card.wrapper.offsetHeight + 8;
      retire(card);
      finishLeaving(card);
    }
  }

  function finishLeaving(card) {
    if (!leaving.delete(card)) return;
    clearTimeout(card.exitTimer);
    card.fade?.cancel();
    card.motion?.cancel();
    card.wrapper.remove();
    // Absolute positions intentionally leave a gap. Removing a bubble must not
    // pull older bubbles down to refill a bottom-aligned flex layout.
  }

  function retire(card) {
    if (!cards.delete(card)) return;
    if (idleCard === card) idleCard = null;
    const opacity = getComputedStyle(card.node).opacity;
    const transform = getComputedStyle(card.node).transform;
    card.fade?.cancel();
    card.node.classList.add("leaving");
    card.node.disabled = true;
    leaving.add(card);
    if (reducedMotion.matches) { finishLeaving(card); return; }
    card.fade = card.node.animate([{ opacity, transform }, { opacity: 0, transform: "translateX(-28px)" }], { duration: EXIT_MS, easing: "ease-in", fill: "forwards" });
    card.fade.finished.then(() => finishLeaving(card), () => {});
    // Hidden/background tabs may suspend animation completion callbacks.
    card.exitTimer = setTimeout(() => finishLeaving(card), EXIT_MS + 80);
    const sameLevel = [...leaving].filter(item => item.isError === card.isError);
    while (sameLevel.length > (card.isError ? MAX_ERROR_CARDS : MAX_CARDS)) finishLeaving(sameLevel.shift());
  }

  function reset() {
    for (const card of allCards()) { clearTimeout(card.exitTimer); card.fade?.cancel(); card.motion?.cancel(); }
    cards.clear();
    leaving.clear();
    host?.remove();
    host = stack = normalLayer = errorLayer = idleCard = playback = null;
    lastMode = "";
    clearInterval(timer);
    timer = null;
  }

  function syncMode() {
    if (!settings.debugNotices) {
      if (!cards.size && !leaving.size) reset();
      return;
    }
    mount();
    const fresh = settings.debugCategories?.playback !== false && playback?.attached && Date.now() - receivedAt < 2500;
    const detail = !settings.enabled ? "视频加速目前已关闭。" : fresh ? (playback.playing ? "加速已接管，视频正在播放。" : "加速已接管，视频还没播放。\n如果视频正在播放，请刷新网页。") : "有新的运行消息时，会显示在这里。";
    const signature = `${fresh ? `${playback.route}:${playback.session}` : ""}\n${detail}`;
    if (signature === lastMode && (cards.size || leaving.size)) return;
    lastMode = signature;
    // Status changes create a new immutable snapshot too. When the stack is
    // empty, create a fresh idle card; never bring an old card back down.
    idleCard = appendCards([{ title: "Debug 模式已开启", detail, category: fresh ? "playback" : undefined, level: settings.enabled && (!fresh || playback.playing) ? "success" : "info" }], "mode");
    idleCard.expires = Infinity;
  }

  function tick() {
    positionStack();
    for (const card of cards) if (card.expires <= Date.now()) retire(card);
    packUpwards();
    syncMode();
  }

  root.__BTR_NOTIFICATION_VIEW__ = Object.freeze({
    configure(next) {
      if (settings.enabled !== next.enabled || settings.debugNotices !== next.debugNotices) playback = null;
      settings = { enabled: next.enabled !== false, debugNotices: next.debugNotices === true, errorNotices: next.errorNotices === true, debugCategories: { ...next.debugCategories } };
      if (!settings.debugNotices) lastMode = "";
      for (const card of cards) {
        const debugAllowed = settings.debugNotices && settings.debugCategories[card.category] !== false;
        const keep = card.kind === "mode" ? debugAllowed : settings.enabled && (card.isError ? settings.errorNotices : debugAllowed);
        if (!keep) retire(card);
      }
      syncMode();
    },
    playback(next) {
      if (!settings.enabled || !settings.debugNotices || settings.debugCategories.playback === false) return;
      playback = { attached: next?.attached === true, playing: next?.playing === true, route: String(next?.route || "").slice(0, 100), session: Number(next?.session) || 0 };
      receivedAt = Date.now();
      syncMode();
    },
    logs(entries) {
      if (!settings.enabled || !Array.isArray(entries)) return;
      const allowed = entries.filter(entry => entry && typeof entry === "object" && (entry.level === "error" ? settings.errorNotices : settings.debugNotices && settings.debugCategories[categoryOf(entry)] !== false));
      const selected = new Set([
        ...allowed.filter(entry => entry.level === "error").slice(-MAX_ERROR_CARDS),
        ...allowed.filter(entry => entry.level !== "error").slice(-MAX_CARDS)
      ]);
      const snapshots = allowed.filter(entry => selected.has(entry));
      if (snapshots.length) appendCards(snapshots);
    }
  });
  document.addEventListener("DOMContentLoaded", () => { if (settings.debugNotices) syncMode(); }, { once: true });
  document.addEventListener("fullscreenchange", () => { if (host) mount(); });
  root.addEventListener("resize", () => { positionStack(); packUpwards(); });
  reducedMotion.addEventListener("change", () => {
    if (!reducedMotion.matches) return;
    for (const card of allCards()) { card.fade?.cancel(); card.motion?.cancel(); }
    for (const card of [...leaving]) finishLeaving(card);
  });
})(globalThis);


/* src/settings.js */
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


/* src/transport.js */
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
  // A node that twice sends nothing is skipped until the video changes. A signed address that
  // the nodes keep refusing (HTTP 4xx) is dropped instead of the nodes it was tried on.
  // Same wording as the browser version.
  const bans = resolverFactory.createBanList({
    onBan: (host, _count, _error, kind) => kind === "address"
      ? log("已停用一个下载地址", "B 站给的一个下载地址一直被服务器拒绝，这个视频接下来改用其他地址。", "info", "download")
      : log("已停用这个 CDN 节点", `${host} 两次没有返回任何数据，这个视频接下来不再使用它。`, "error", "download")
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
      // Mode and custom servers are read for every request, so a change in the settings
      // applies to the next downloads of the video that is playing.
      const resolver = resolverFactory.createResolver(exact ? rep : { baseUrl: url }, () => api.getSettings().mode, bans, () => api.getSettings().customHosts);
      // When no other node can take this address, keep the one the client asked for. An
      // akamaized.net-only address goes to other nodes too; the ban list drops refused ones.
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


/* src/client.js */
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


/* src/updates.js */
(function(root) {
  "use strict";
  const api=root.__BTR_DESKTOP__, channel="__BTR_DESKTOP_UPDATE__", listeners=new Set();
  let state={state:"idle",message:"从 GitHub 检查 BTR 更新"}, pending=null, timer=null;
  const emit = next => {state=next;for(const fn of listeners)fn({...state});};
  api.getUpdate=()=>({...state});
  api.onUpdate=fn=>{listeners.add(fn);fn({...state});return()=>listeners.delete(fn);};
  api.checkUpdate=()=>{
    if(["confirming","installing","uninstalling"].includes(state.state))return Promise.resolve({...state});
    if(pending)return pending;
    emit({state:"checking",message:"正在检查 BTR 更新"});
    pending=new Promise(resolve=>{
      api._resolveUpdate=resolve;
      timer=setTimeout(()=>finish({state:"error",message:"更新检查超时，请稍后再试"}),12000);
      root.postMessage({channel,type:"check"},location.origin);
    });
    return pending;
  };
  function finish(result){clearTimeout(timer);const resolve=api._resolveUpdate;api._resolveUpdate=null;pending=null;emit(result);resolve?.(result);}
  root.addEventListener("message",event=>{
    if(event.source!==root || event.data?.channel!==channel)return;
    if(event.data.type==="auto-config") {
      if(typeof event.data.enabled==="boolean" && api.getSettings().autoCheckUpdates!==event.data.enabled)api.setSettings({autoCheckUpdates:event.data.enabled});
      return;
    }
    if(event.data.type!=="result")return;
    const value=event.data.result;
    if(!value || !["current","available","checking","confirming","installing","uninstalling","idle","error","not-configured"].includes(value.state))return;
    finish(value);
  });
  // The main process owns one timer for all windows, not a timer in every renderer.
  let configured=false, previousAuto;
  const unsubscribe=api.onSettings(settings=>{
    const enabled=settings.autoCheckUpdates!==false;
    if(configured && previousAuto===enabled)return;
    const changed=configured; configured=true; previousAuto=enabled;
    root.postMessage({channel,type:"configure-auto",enabled,changed},location.origin);
  });
  root.addEventListener("pagehide",()=>{unsubscribe();clearTimeout(timer);},{once:true});
})(globalThis);


/* src/settings-view.js */
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


/* src/player-settings.js */
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
      group("并发线程", "concurrency", threads.map(value => [value, String(value)]))
    );
    const error = document.createElement("div"); error.className = "btr-save-error"; error.setAttribute("role", "status"); panel.append(error);
    panel.addEventListener("change", event => {
      const input = event.target; if (!(input instanceof HTMLInputElement) || !input.checked) return;
      const setting = input.dataset.btrSetting;
      if (setting !== "mode" && setting !== "concurrency") return;
      try { api.setSettings({[setting]: setting === "concurrency" ? Number(input.value) : input.value}); error.textContent = ""; }
      catch (_) { error.textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
    });
    target.insertBefore(panel, target.querySelector(".bpx-player-ctrl-setting-others") || target.firstChild);
    unsubscribe = api.onSettings(settings => {
      for (const input of panel.querySelectorAll("[data-btr-setting]")) input.checked = input.value === String(settings[input.dataset.btrSetting]);
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

