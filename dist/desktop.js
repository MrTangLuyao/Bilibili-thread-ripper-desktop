globalThis.__BTR_DESKTOP_RELEASE__={"version":"2026.10.30.1-d2","adapterRevision":2};

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
      theme: ["light", "dark"].includes(source.theme) ? source.theme : "auto",
      // The live module on live.bilibili.com; the master switch above still rules. Off unless
      // switched on: a viewer who never chose keeps Bilibili's own live player.
      liveEnabled: source.liveEnabled === true,
      // 剧集加速: episode pages (/bangumi/play/ep… and ss…: anime, films, documentaries, …),
      // sped up in the compatibility mode only.
      episodeEnabled: source.episodeEnabled !== false,
      // 阻止使用国际版: keeps the viewer on Bilibili's domestic site (bilibili-site.js). Off unless
      // switched on.
      blockInternational: source.blockInternational === true,
      // "full" replaces Bilibili's playback core; "compat" leaves it in charge and only
      // downloads its media requests.
      takeover: source.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(source.mode) ? source.mode : "mainland",
      customHosts: (Array.isArray(source.customHosts) ? source.customHosts : [])
        .map(normalizeCdnHost)
        .filter((host, index, all) => host && all.indexOf(host) === index)
        .slice(0, 32),
      // The round button in the page corner that opens the settings panel.
      floatingButton: source.floatingButton !== false,
      // Where the viewer dragged it, as shares of the window (0 = flush left, 1 = flush
      // right); null when it was never moved.
      floatingButtonLeft: source.floatingButtonLeft != null && Number(source.floatingButtonLeft) >= 0 && Number(source.floatingButtonLeft) <= 1 ? Number(source.floatingButtonLeft) : null,
      floatingButtonTop: source.floatingButtonTop != null && Number(source.floatingButtonTop) >= 0 && Number(source.floatingButtonTop) <= 1 ? Number(source.floatingButtonTop) : null,
      // The first-run guide to the floating button was answered (settings-panel.js).
      guideDone: source.guideDone === true,
      debugNotices: source.debugNotices === true,
      errorNotices: source.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, source.debugCategories?.[key] !== false])),
      concurrency: allowed.includes(requested) ? requested : 8,
      // 自动线程数: the downloader picks the thread count itself, between 8 and 64, and
      // `concurrency` above is only what the viewer set by hand. Off when the value is
      // missing here; the userscript's stored settings (bridge.js) default it to on.
      autoConcurrency: source.autoConcurrency === true,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      // 全接管预缓冲时长: how far ahead the full takeover buffers, one of a few choices.
      bufferAheadSeconds: [30, 45, 90, 180].includes(Number(source.bufferAheadSeconds)) ? Number(source.bufferAheadSeconds) : 45,
      // 二级缓冲: what the browser's buffer has no room for waits in memory (native-mse-player.js).
      // Experimental, off unless switched on.
      secondaryBuffer: source.secondaryBuffer === true
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
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  function isAkamaiUrl(value) {
    try { return new URL(value).hostname.toLowerCase().endsWith(".akamaized.net"); }
    catch (_error) { return false; }
  }

  // A P2P or edge-cache relay (an mcdn node, or the mountaintoys.cn caches beside them) wraps
  // the file in its own path and signature. Its address works only on relays: every ordinary
  // node refuses it.
  function isRelayUrl(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)mcdn\./i.test(url.hostname) || /^\/v1\/resource\//i.test(url.pathname)
        || String(url.searchParams.get("os") || "").toLowerCase() === "mcdn";
    } catch (_error) {
      return false;
    }
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
      // Setting only the host name would keep a non-standard port, such as a peer CDN's
      // :4483, so the port is cleared too.
      url.hostname = host;
      url.port = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  // The custom mode uses only the servers picked in the settings. Without any, it uses the
  // mainland node list.
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
    // A relay address moved to an ordinary node is refused there, so only ordinary addresses
    // are moved to the other nodes.
    const ordinary = originals.filter((url) => !isRelayUrl(url));
    const donor = ordinary.find((url) => !isAkamaiUrl(url));
    // Some overseas accounts are given nothing but akamaized.net addresses. That used to leave
    // no node at all in mainland mode and a single one in overseas mode. The nodes accept
    // those signatures too, so only in that case the akamaized.net addresses are the donors.
    // Bilibili may hand out an address that every node refuses (HTTP 403) next to one that
    // works, so each of them is tried; the ban list drops the refused one. Node-major order
    // puts every address in the first few requests, so one that every node refuses cannot
    // take all of them.
    const synthetic = (donor
      ? hosts.map((host) => swapOrdinaryHost(donor, host))
      : hosts.flatMap((host) => ordinary.map((url) => swapOrdinaryHost(url, host, true))))
      .map(safeMediaUrl)
      .filter(Boolean);
    const allowedOriginals = custom.length
      ? originals.filter((url) => custom.includes(hostOf(url)))
      : mode === "overseas"
        ? originals.filter((url) => !MAINLAND_HOSTS.includes(hostOf(url)))
        : originals.filter((url) => MAINLAND_HOSTS.includes(hostOf(url)));
    // Bilibili sometimes hands a track out only through relays. No other node can serve it
    // then, so the relays are used whatever the mode, rather than giving the video up.
    const relays = ordinary.length ? [] : originals;
    return [...allowedOriginals, ...synthetic, ...relays].filter((value, index, all) => all.indexOf(value) === index);
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

  // How long a measured speed counts. A node in use is measured again with every segment; one
  // that was left out for being slow goes back to the untested ones after this, and gets
  // another try through the exploration slot.
  const MEASUREMENT_TTL_MS = 90000;

  function createResolver(representation, getMode, bans = null, getCustomHosts = null) {
    const health = new Map();
    // What is known about a node's speed, per node and file, without the query. An address
    // with a fresh signature is the same route, so it starts with what its predecessor
    // measured. Failures are not kept here: those belong to the address they happened on.
    const routes = new Map();
    const routeKeys = new Map();
    const routeOf = (url) => {
      let key = routeKeys.get(url);
      if (!key) {
        try {
          const parsed = new URL(url);
          key = `${parsed.host}${parsed.pathname}`;
        } catch (_error) { key = String(url); }
        if (routeKeys.size > 512) routeKeys.clear();
        routeKeys.set(url, key);
      }
      return key;
    };
    const measurement = (url) => routes.get(routeOf(url)) || null;
    // Only a transfer long enough to measure a speed renews it. The short tail of a resumed
    // piece proves the node works, and must not keep an old speed alive for ever.
    const measuredNow = (url, now = Date.now()) => {
      const item = measurement(url);
      return Boolean(item?.lastMeasuredAt) && now - item.lastMeasuredAt < MEASUREMENT_TTL_MS;
    };
    const bySpeed = (a, b) => {
      const am = measurement(a) || {};
      const bm = measurement(b) || {};
      return Number(Boolean(bm.lastSuccessAt)) - Number(Boolean(am.lastSuccessAt)) || (bm.bps || 0) - (am.bps || 0);
    };
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.(), getCustomHosts?.() || []);
    }

    // Banned nodes, addresses and node/address pairs are left out. If everything is banned,
    // keep using the full list rather than leaving the video with no download address at all.
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
        .sort(bySpeed);
      if (!pool.length) return urls();
      const firstRange = mediaRangeCount === 0;
      const width = Math.min(firstRange ? pool.length : 6, pool.length);
      let selected;
      const warmupRanges = getMode?.() === "mainland" ? 1 : 4;
      if (mediaRangeCount < warmupRanges) {
        selected = pool.slice(0, width);
        rangeCursor = width % pool.length;
      } else {
        // After the warm-up the measured nodes carry the segments in speed order; the
        // downloader gives the fast ones the larger share. One other node rides along per
        // segment: one that never answered, or one whose measurement has gone stale because
        // it was too slow to be used. Routes change, so a slow node is not slow for good.
        // While fewer nodes are measured than a segment uses, the free places go to the others
        // as well: the downloader gives an unmeasured node only a trial piece or two, so
        // finding the good nodes quickly costs little.
        const measured = pool.filter((url) => measuredNow(url, now));
        const rest = pool.filter((url) => !measuredNow(url, now));
        const places = Math.min(rest.length, Math.max(1, width - measured.length));
        const explore = Array.from({ length: places }, (_item, index) => rest[(rangeCursor + index) % rest.length]);
        rangeCursor = (rangeCursor + places) % Math.max(1, pool.length);
        selected = [...measured.slice(0, width - explore.length), ...explore];
        for (const url of pool) {
          if (selected.length >= Math.min(3, pool.length)) break;
          if (!selected.includes(url)) selected.push(url);
        }
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
        .sort(bySpeed);
    }

    function success(url, bps) {
      bans?.success?.(url);
      const old = measurement(url) || {};
      const now = Date.now();
      const measured = bps > 0;
      health.set(url, { failures: 0, blockedUntil: 0, lastSuccessAt: now });
      routes.set(routeOf(url), {
        lastSuccessAt: now,
        // No speed comes with a transfer too short to measure one; the last one stays, and
        // keeps its age.
        lastMeasuredAt: measured ? now : old.lastMeasuredAt || 0,
        bps: !measured ? old.bps || 0 : old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    // The speed of a transfer that was cut off before its end. It says how fast the node is
    // and nothing more: the address has not proven itself, and earlier failures stay.
    function sample(url, bps) {
      if (!(bps > 0)) return;
      const old = measurement(url) || {};
      routes.set(routeOf(url), {
        lastSuccessAt: old.lastSuccessAt || 0,
        lastMeasuredAt: Date.now(),
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
          state: nodeBanned ? "banned" : (item.blockedUntil || 0) > now ? "blocked" : measurement(url)?.lastSuccessAt ? "healthy" : "untested",
          bps: measurement(url)?.bps || 0
        };
      });
    }

    const allows = (url) => !bans || bans.allows(url);
    // The measured download speed of an address, for weighting piece assignments. 0 when
    // there is none or it has gone stale.
    const speed = (url) => (measuredNow(url) ? measurement(url)?.bps || 0 : 0);
    return Object.freeze({ allows, failure, ordered, rangeCandidates, rescueCandidates, sample, speed, startupCandidates, status, success, urls });
  }

  root.__BILI_CDN_RESOLVER_FACTORY__ = Object.freeze({
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createResolver,
    isAkamaiUrl,
    isRelayUrl,
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
  // The pause before a piece's next round of addresses: half a second, doubling, at most two.
  const roundPause = (round) => Math.min(2000, 500 * (2 ** (round - 1)));
  // Below this a resumed request saves less than its own round trip costs.
  const RESUME_MIN_BYTES = 32 * 1024;
  // Hedging a piece with a playback deadline (see hedgeDue): a first copy projected to finish
  // this long before the deadline gets no copy yet; one receiving at least HEDGE_PACE of the
  // usual connection speed is on pace; a copy's node measured HEDGE_FASTER times faster than the
  // first copy is receiving is worth a copy anyway.
  const HEDGE_SLACK_MS = 1500;
  const HEDGE_PACE = 0.6;
  const HEDGE_FASTER = 1.5;
  // Queue classes, served in this order: the startup probe and init/index, then startup
  // pieces, then everything else. A class never waits behind a lower one.
  const QUEUE_CRITICAL = 0, QUEUE_STARTUP = 1, QUEUE_ORDINARY = 2;
  // Priority an ordinary request with a playback deadline gains per millisecond of waiting:
  // 20 (a hedge copy's boost) in 0.9 s.
  const QUEUE_AGING_PER_MS = 20 / 900;
  // A shorter transfer is mostly round trip. The tail of a resumed piece can be a few KiB,
  // and counting it would mark down the very node that came to the rescue.
  const SPEED_SAMPLE_MIN_BYTES = 48 * 1024;

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
      try { this.drainQueue(); } finally { this.onChange?.(this.active, this.limit, this.queue.length); }
    }

    drainQueue() {
      while (this.active < this.limit && this.queue.length) {
        const now = performance.now();
        const urgency = entry => {
          // Read again at every pass: the player's deadline moves with the playhead and the
          // playback rate, and a queued piece may have become due while it waited.
          const deadlineAt = entry.deadline ? entry.deadline() : entry.deadlineAt;
          if (!Number.isFinite(deadlineAt)) return 0;
          const remaining = deadlineAt - now;
          if (remaining <= 0) return 12;
          if (remaining <= 750) return 9;
          if (remaining <= 2000) return 6;
          return 0;
        };
        // A bounded, recomputed boost prevents overdue primaries from sitting behind
        // prefetch work without turning the queue back into strict deadline ordering. A
        // request with a deadline also gains priority while it waits, so a piece queued long
        // ago is not passed over again and again by newer ones of a slightly higher priority;
        // requests without one (compatibility mode, the desktop client) keep the fixed order.
        // Sorting inside the class keeps the startup probe, init and index, and then the
        // startup pieces, ahead of ordinary media whatever the boosts add up to.
        const rank = entry => entry.priority + urgency(entry)
          + (entry.ages ? (now - entry.queuedAt) * QUEUE_AGING_PER_MS : 0);
        this.queue.sort((a, b) => a.queueClass - b.queueClass || rank(b) - rank(a)
          || a.sequence - b.sequence);
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

    // deadline: a function giving the clock time playback needs this request, or null; the
    // fixed deadlineAt is what callers without one pass.
    acquire(signal, priority = 0, deadlineAt = Infinity, queueClass = QUEUE_CRITICAL, ages = false, deadline = null) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: Number(priority) || 0,
          deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Infinity,
          deadline,
          queueClass,
          ages,
          queuedAt: performance.now(),
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
        this.drain();
      });
    }
  }

  // 自动线程数. One controller for the whole page: the thread count starts at 8 and climbs a
  // ladder towards 64 on every sign that the download is not keeping up with playback
  // (the player stalls; a low buffer stops growing while bytes keep arriving; a
  // connection waits too long for its first byte while every slot is busy). Every step up
  // is a trial: ten seconds later the bytes per second must have grown, otherwise the
  // step is taken back to where it started and that level rests for a while — more
  // connections that bring nothing only add risk. A server refusing the load (412, 429)
  // steps it back too, and nothing climbs past a refused level until it has rested. The
  // level is kept across videos on the same page; a new page starts at 8 again.
  //
  // Each start (a new video, a seek outside the buffer) opens with at least 16 threads: the
  // first seconds are when a slow node turns into a spinning wheel. Once the buffer is well
  // ahead, the count steps back down to the level the page had before. A sign of not keeping
  // up meanwhile climbs as usual and ends the start there; so does half a minute without
  // catching up. From then on the rules above carry on.
  //
  // Stalls, the buffer and new starts come from the player (stall, buffer, newSession); a
  // caller that reports none of them (the userscript's compatibility mode) gets only the
  // slow-first-byte climb and the refusals.
  const AUTO_LADDER = Object.freeze([8, 12, 16, 24, 32, 48, 64]);
  const AUTO_STARTUP_LEVEL = 2;
  const AUTO_STARTUP_COMFORT_SECONDS = 15;
  const AUTO_STARTUP_MAX_MS = 30000;
  const AUTO_STEP_COOLDOWN_MS = 2500;
  const AUTO_TRIAL_MS = 10000;
  const AUTO_WINDOW_MS = 5000;
  const AUTO_BUCKET_MS = 250;
  const AUTO_REST_MS = 90000;
  const AUTO_PUSHBACK_REST_MS = 180000;
  const AUTO_LOW_BUFFER_SECONDS = 6;
  const AUTO_PRESSURE_MS = 1000;
  const AUTO_ACTIVITY_MS = 1500;

  function createAutoConcurrency({ now = () => performance.now() } = {}) {
    const listeners = new Set();
    const state = {
      level: 0, changedAt: 0, reason: "起步", steps: 0, trial: null,
      // level index -> { until, hard }: hard rests (refusals) also cap every level above.
      resting: new Map(),
      buckets: [], lastActivityAt: -Infinity,
      // Time the connections spent saturated: intervals of { from, to } within the window.
      saturated: false, saturatedSince: 0, saturatedSpans: [],
      aheadSamples: [], pressureSince: 0,
      // The start of a session while it runs above the page's own level: { base, until }.
      startup: null
    };
    const threads = () => AUTO_LADDER[state.level];

    function pruneBuckets(at) {
      while (state.buckets.length && at - state.buckets[0].at > AUTO_WINDOW_MS) state.buckets.shift();
    }

    // Bytes per second over the window, from completed pieces only: a hedge copy that lost
    // its race is not delivery.
    function throughput(at = now()) {
      pruneBuckets(at);
      if (!state.buckets.length) return 0;
      const bytes = state.buckets.reduce((sum, item) => sum + item.bytes, 0);
      // Over the time between the first and the last delivery in the window: an idle tail
      // (nothing wanted) is not slowness.
      return bytes * 1000 / Math.max(1000, state.buckets.at(-1).at - state.buckets[0].at + AUTO_BUCKET_MS);
    }

    // The share of the window during which every slot was busy and pieces were queued.
    function saturation(at = now()) {
      const from = at - AUTO_WINDOW_MS;
      state.saturatedSpans = state.saturatedSpans.filter((span) => span.to > from);
      let busy = state.saturatedSpans.reduce((sum, span) => sum + Math.max(0, span.to - Math.max(span.from, from)), 0);
      if (state.saturated) busy += Math.max(0, at - Math.max(state.saturatedSince, from));
      return Math.min(1, busy / AUTO_WINDOW_MS);
    }

    function resting(level, at) {
      const rest = state.resting.get(level);
      if (!rest) return null;
      if (rest.until <= at) { state.resting.delete(level); return null; }
      return rest;
    }

    function setLevel(level, reason, trial) {
      const previous = threads();
      const at = now();
      state.level = level;
      state.changedAt = at;
      state.reason = reason;
      state.steps += 1;
      state.trial = trial || null;
      state.pressureSince = 0;
      for (const listener of listeners) {
        try { listener({ threads: threads(), previous, reason }); } catch (_error) {}
      }
    }

    // Up one level. A level resting after a refusal caps the climb; one resting after a
    // fruitless trial is skipped only by a strong signal (a stall), not by pressure.
    function stepUp(reason, strong) {
      const at = now();
      if (at - state.changedAt < AUTO_STEP_COOLDOWN_MS) return false;
      if (resting(state.level, at)?.hard) return false;
      let next = state.level + 1;
      while (next < AUTO_LADDER.length) {
        const rest = resting(next, at);
        if (!rest) break;
        if (rest.hard || !strong) return false;
        next += 1;
      }
      if (next >= AUTO_LADDER.length) return false;
      setLevel(next, reason, { from: state.level, level: next, at, baseline: throughput(at), stalled: false });
      // Not keeping up even with the start's threads: the start ends at this level.
      state.startup = null;
      return true;
    }

    // How high a start may go: up to 16 threads, but not onto or past a level the server
    // refused (a fruitless trial does not hold it back; the start comes down on its own).
    function startupLevel(at) {
      if (resting(state.level, at)?.hard) return state.level;
      let level = state.level;
      while (level < AUTO_STARTUP_LEVEL && !resting(level + 1, at)?.hard) level += 1;
      return level;
    }

    function stepDown(target, restLevel, reason, restMs, hard) {
      state.resting.set(restLevel, { until: now() + restMs, hard });
      if (target >= state.level) return false;
      setLevel(target, reason, null);
      return true;
    }

    // A step up has had its time: did the extra connections deliver? Only judged when the
    // connections were busy meanwhile; an idle download (buffer full) proves nothing, and
    // so does a stall in between. Without any gain the step goes back to where it started.
    function judgeTrial(at) {
      const trial = state.trial;
      if (!trial || at - trial.at < AUTO_TRIAL_MS) return;
      state.trial = null;
      if (trial.stalled || saturation(at) < 0.6 || trial.baseline <= 0) return;
      if (throughput(at) < trial.baseline) {
        stepDown(trial.from, trial.level, `${AUTO_LADDER[trial.level]} 线程没有比 ${AUTO_LADDER[trial.from]} 线程更快`, AUTO_REST_MS, false);
      }
    }

    return Object.freeze({
      ladder: AUTO_LADDER,
      threads,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      // A piece arrived whole.
      delivered(bytes, at = now()) {
        const last = state.buckets.at(-1);
        if (last && at - last.at < AUTO_BUCKET_MS) last.bytes += bytes;
        else state.buckets.push({ at, bytes });
        pruneBuckets(at);
        judgeTrial(at);
      },
      // Bytes are flowing on some connection right now.
      activity(at = now()) {
        state.lastActivityAt = at;
      },
      // The connections' state whenever it changes.
      demand(active, limit, queued, at = now()) {
        const saturated = active >= limit && queued > 0;
        if (saturated === state.saturated) return;
        if (state.saturated) state.saturatedSpans.push({ from: state.saturatedSince, to: at });
        state.saturated = saturated;
        state.saturatedSince = at;
        saturation(at);
      },
      // The player stalled: more threads at once.
      stall(reason = "播放卡了一下") {
        if (state.trial) state.trial.stalled = true;
        return stepUp(reason, true);
      },
      // The buffer ahead of the playhead, a few times a second while playing. A low buffer
      // that has not grown over the last second although bytes keep arriving, for a whole
      // second, means the connections are too few.
      buffer(ahead, playing, at = now()) {
        state.aheadSamples.push({ at, ahead });
        while (state.aheadSamples.length && at - state.aheadSamples[0].at > AUTO_PRESSURE_MS + AUTO_BUCKET_MS) state.aheadSamples.shift();
        // The start: once well ahead, one step back down per cooldown towards the page's level.
        const start = state.startup;
        if (start && at >= start.until) state.startup = null;
        else if (start && ahead >= AUTO_STARTUP_COMFORT_SECONDS && at - state.changedAt >= AUTO_STEP_COOLDOWN_MS) {
          if (state.level > start.base) setLevel(state.level - 1, `开头已经跟上，线程数降到 ${AUTO_LADDER[state.level - 1]}`, null);
          if (state.level <= start.base) state.startup = null;
        }
        const earlier = state.aheadSamples.find((item) => at - item.at >= AUTO_PRESSURE_MS);
        const downloading = at - state.lastActivityAt < AUTO_ACTIVITY_MS;
        const pressed = playing && downloading && ahead < AUTO_LOW_BUFFER_SECONDS && earlier && ahead <= earlier.ahead + 0.05;
        if (!pressed) { state.pressureSince = 0; return false; }
        if (!state.pressureSince) { state.pressureSince = at; return false; }
        if (at - state.pressureSince < AUTO_PRESSURE_MS) return false;
        state.pressureSince = 0;
        return stepUp("缓冲跟不上播放", false);
      },
      // A connection waited too long for its first byte while every slot was busy.
      slow() {
        return saturation() >= 0.6 ? stepUp("连接排队等太久", false) : false;
      },
      // The server refused the load: back one level, and nothing climbs past this one for
      // a while.
      pushback(status) {
        return stepDown(Math.max(0, state.level - 1), state.level, `服务器返回 ${status}`, AUTO_PUSHBACK_REST_MS, true);
      },
      // A new playback session: what the buffer did before means nothing now, and the start
      // runs with more threads. A session that begins while another one's start is still
      // running keeps the page's own level to come back to.
      newSession() {
        const at = now();
        state.aheadSamples.length = 0;
        state.pressureSince = 0;
        state.trial = null;
        state.buckets.length = 0;
        state.saturatedSpans.length = 0;
        if (state.saturated) state.saturatedSince = at;
        const base = state.startup ? state.startup.base : state.level;
        const target = startupLevel(at);
        if (target > state.level) setLevel(target, `开头先用 ${AUTO_LADDER[target]} 线程`, null);
        state.startup = state.level > base ? { base, until: at + AUTO_STARTUP_MAX_MS } : null;
      },
      status() {
        const at = now();
        return {
          threads: threads(), level: state.level, reason: state.reason, steps: state.steps, changedAt: state.changedAt,
          throughputBps: Math.round(throughput(at)), saturation: Math.round(saturation(at) * 100) / 100,
          buckets: state.buckets.length, activityAgeMs: Math.round(at - state.lastActivityAt),
          resting: [...state.resting.entries()].filter(([, rest]) => rest.until > at).map(([level, rest]) => ({ threads: AUTO_LADDER[level], hard: rest.hard, forMs: Math.round(rest.until - at) })),
          trial: state.trial ? { from: AUTO_LADDER[state.trial.from], level: AUTO_LADDER[state.trial.level], ageMs: Math.round(at - state.trial.at), baselineBps: Math.round(state.trial.baseline), stalled: state.trial.stalled } : null,
          startup: state.startup ? { base: AUTO_LADDER[state.startup.base], forMs: Math.round(state.startup.until - at) } : null
        };
      },
      reset() {
        state.level = 0; state.changedAt = 0; state.reason = "起步"; state.steps = 0; state.trial = null;
        state.resting.clear(); state.buckets.length = 0; state.lastActivityAt = -Infinity;
        state.saturated = false; state.saturatedSince = 0; state.saturatedSpans.length = 0;
        state.aheadSamples.length = 0; state.pressureSince = 0; state.startup = null;
      }
    });
  }
  const autoConcurrency = createAutoConcurrency();
  // Every downloader on the page follows the controller's count at once.
  const autoFollowers = new Set();
  autoConcurrency.subscribe(() => {
    for (const ref of autoFollowers) {
      const follow = ref.deref();
      if (follow) follow(); else autoFollowers.delete(ref);
    }
  });

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    // getSettings returns a new object whenever something changes (the userscript's page
    // does), so the reference tells whether the previous normalization is still valid.
    let rawSettings = null;
    let normalizedSettings = null;
    let autoView = null;
    function config() {
      const raw = getSettings();
      if (raw !== rawSettings || !normalizedSettings) {
        rawSettings = raw;
        normalizedSettings = core.normalizeSettings(raw);
        autoView = null;
      }
      if (!normalizedSettings.autoConcurrency) return normalizedSettings;
      // In the automatic mode the thread count is the controller's, everything else the viewer's.
      const threads = autoConcurrency.threads();
      if (!autoView || autoView.concurrency !== threads) autoView = { ...normalizedSettings, concurrency: threads };
      return autoView;
    }
    const semaphore = new Semaphore(config().concurrency);
    const applySettings = () => semaphore.setLimit(config().concurrency);
    autoFollowers.add(new WeakRef(applySettings));
    semaphore.onChange = (active, limit, queued) => { if (config().autoConcurrency) autoConcurrency.demand(active, limit, queued); };

    // What one connection typically delivers here and how long a sub-chunk typically
    // takes. Sub-chunk sizing and the hedge delay follow these measurements.
    const meter = { connectionBps: 0, pieceMs: 0 };
    function recordMeter(bytes, elapsedMs) {
      if (bytes < SPEED_SAMPLE_MIN_BYTES || elapsedMs <= 0) return;
      const bps = bytes * 1000 / elapsedMs;
      meter.connectionBps = meter.connectionBps ? meter.connectionBps * 0.7 + bps * 0.3 : bps;
      meter.pieceMs = meter.pieceMs ? meter.pieceMs * 0.7 + elapsedMs * 0.3 : elapsedMs;
    }

    // A sub-chunk should keep its connection busy for a good part of a second, otherwise
    // request round trips dominate on high-latency routes. 64 KiB stays the floor while
    // the speed is still unknown, and a range still splits into at least one piece per
    // node: the total bandwidth only grows by spreading over hosts, and the hedges
    // against a stalling one need more than a single request to work with.
    function adaptiveMinChunk(settings, rangeLength, pieceLimit, hostCount = 4) {
      if (!meter.connectionBps) return settings.minChunkBytes;
      const target = Math.floor(meter.connectionBps * 0.6 / (64 * 1024)) * 64 * 1024;
      const spread = Math.ceil(rangeLength / Math.max(1, Math.min(Math.max(4, hostCount), pieceLimit)));
      return Math.max(settings.minChunkBytes, Math.min(1024 * 1024, target, spread));
    }

    // A second copy starts once a piece takes clearly longer than pieces have been
    // taking, instead of always waiting the full fixed delay.
    function hedgeDelayMs(settings) {
      return meter.pieceMs
        ? Math.max(250, Math.min(settings.hedgeDelayMs, Math.round(meter.pieceMs * 1.5)))
        : settings.hedgeDelayMs;
    }

    // Whether the second copy of a piece with a playback deadline should start now. Checked
    // every 50 ms once the first copy holds a connection (a copy of a request still queued
    // would only queue as well, and with its higher priority take the connection meant for
    // it). first: the first copy (when it started, bytes received, bytes asked for); the delay
    // counts from its start. copyBps: the measured speed of the copy's node, 0 when unknown.
    // - No data yet, or nothing new for a whole delay (stopped): copy.
    // - A deadline it meets with time to spare at its speed so far: no copy yet, the bandwidth
    //   goes to pieces needed sooner.
    // - The copy's node known to be clearly faster (HEDGE_FASTER times): copy.
    // - Slower than connections usually are, or no usual speed measured yet: copy.
    // - On pace: a copy on a node not known to be HEDGE_FASTER times faster only takes the
    //   next piece's connection and bandwidth; one on a node not measured yet is tried, as
    //   the chance of a faster one. A piece that will miss its deadline even so may spend one
    //   of the range's rescue slots on that node anyway: its measurement can be stale (a node
    //   that was slow a minute ago may have recovered), and waiting for the request to time
    //   out costs far more.
    function hedgeDue(first, delayMs, deadlineAt, copyBps, rescue) {
      const now = performance.now(), ran = now - first.startedAt;
      const got = first.recorder.bytes;
      if (got !== first.seenBytes) {
        first.seenBytes = got;
        first.seenAt = now;
      }
      if (ran < delayMs) return false;
      if (!got || now - first.seenAt >= delayMs) return true;
      const rate = got * 1000 / ran;
      if (now + Math.max(0, first.length - got) * 1000 / rate <= deadlineAt - HEDGE_SLACK_MS) return false;
      if (copyBps > rate * HEDGE_FASTER) return true;
      if (!(meter.connectionBps > 0) || rate < meter.connectionBps * HEDGE_PACE) return true;
      if (!(copyBps > 0)) return true;
      return now + Math.max(0, first.length - got) * 1000 / rate > deadlineAt
        && Boolean(rescue?.claimStale?.());
    }

    // When playback needs a range, as a clock time; Infinity when the caller did not say.
    // options.deadlineAt is that time, options.deadlineMs the time left; either can be a
    // function, read again at every check, so a new playback rate or position also moves the
    // deadline of pieces already on their way.
    function deadlineOf(options) {
      const read = (value, relative) => {
        const ms = Number(value);
        if (value == null || !Number.isFinite(ms)) return Infinity;
        return relative ? performance.now() + Math.max(0, ms) : ms;
      };
      const live = (value, relative) => () => {
        try { return read(value(), relative); } catch (_error) { return Infinity; }
      };
      if (typeof options.deadlineAt === "function") return live(options.deadlineAt, false);
      if (options.deadlineAt != null && Number.isFinite(Number(options.deadlineAt))) {
        const fixed = Number(options.deadlineAt);
        return () => fixed;
      }
      if (typeof options.deadlineMs === "function") return live(options.deadlineMs, true);
      const fixed = read(options.deadlineMs, true);
      return () => fixed;
    }

    // Only measured per-request progress can spend this bounded rescue budget. The second
    // budget is for pieces that will miss their deadline while their copy's node is not
    // measured as HEDGE_FASTER times faster: that measurement can be stale, and a bounded
    // number of such copies per range is far cheaper than waiting for a timeout.
    function createEarlyHedge(limit) {
      return {
        progressRemaining: Math.max(0, limit),
        claimProgress() {
          if (this.progressRemaining <= 0) return false;
          this.progressRemaining -= 1;
          return true;
        },
        // At least one per range, even where no connection is held back (a single-piece
        // download): one request is much cheaper than waiting out a timeout.
        staleRemaining: Math.max(1, limit),
        claimStale() {
          if (this.staleRemaining <= 0) return false;
          this.staleRemaining -= 1;
          return true;
        }
      };
    }

    async function readBody(response, controller, transferId, settings, received, report = onTransfer) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        received.chunks?.push(bytes);
        if (settings.autoConcurrency) autoConcurrency.activity();
        report({ phase: "progress", id: transferId, bytes: bytes.byteLength });
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
          // The recorder keeps what a failed attempt already received, so a retry or a
          // hedge copy can ask only for the missing tail.
          received.chunks?.push(chunk);
          if (settings.autoConcurrency) autoConcurrency.activity();
          report({ phase: "progress", id: transferId, bytes: chunk.byteLength });
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

    // begin: called once the request has its connection slot, and returns what to ask for.
    // A copy that waited in the queue resumes from what the first copy has received by then,
    // not from what it had when the copy was queued.
    async function attempt(piece, url, signal, kind, resolver, priority = 0, begin = null,
      deadline = null, observeProgress = null, queueClass = QUEUE_CRITICAL) {
      const settings = config();
      const deadlineAt = deadline ? deadline() : Infinity;
      const release = await semaphore.acquire(signal, priority, deadlineAt, queueClass,
        queueClass === QUEUE_ORDINARY && Number.isFinite(deadlineAt), deadline);
      let received = { bytes: 0, chunks: [] };
      if (begin) {
        try {
          const plan = begin();
          piece = plan.part;
          received = plan.recorder;
        } catch (error) {
          release();
          throw error;
        }
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const startedAt = performance.now();
      const report = event => {
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        const bps = received.bytes * 1000 / elapsedMs;
        const remaining = Math.max(0, piece.length - received.bytes);
        const payload = { ...event, receivedBytes: received.bytes, totalBytes: piece.length,
          bps, etaMs: bps > 0 ? Math.round(remaining * 1000 / bps) : null };
        observeProgress?.({ ...payload, elapsedMs });
        return onTransfer(payload);
      };
      const transferId = report({ phase: "start", kind, totalBytes: piece.length, url,
        deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null });
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          priority: priority >= 100 ? "high" : "auto",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received, report);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        recordMeter(bytes.byteLength, elapsedMs);
        // The node answered either way; only a large enough transfer says how fast it is.
        resolver.success(url, bytes.byteLength >= SPEED_SAMPLE_MIN_BYTES ? bytes.byteLength * 1000 / elapsedMs : 0);
        report({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        const canceled = error?.name === "AbortError";
        // A copy that lost the race was cut off, not broken, and what it had received by then
        // is a measurement of its node. Without it a slow node is never measured at all: its
        // pieces are always finished by a faster copy first, and an unmeasured node only ever
        // gets trial pieces.
        if (canceled && received.bytes >= SPEED_SAMPLE_MIN_BYTES && typeof resolver.sample === "function") {
          resolver.sample(url, received.bytes * 1000 / Math.max(1, performance.now() - startedAt));
        }
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes);
        if (settings.autoConcurrency) {
          if (error?.status === 412 || error?.status === 429) autoConcurrency.pushback(error.status);
          else if (!canceled && error?.name === "TimeoutError" && received.bytes === 0) autoConcurrency.slow();
        }
        report({ phase: canceled ? "cancel" : "error", id: transferId, error });
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
      // The first preferred address is the node this piece was assigned to by speed;
      // only a retry round moves past it.
      const preferredOffset = preferred.length ? round % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      if (typeof resolver.speed === "function") {
        // The copies after the first go to the fastest known nodes, wherever they were
        // listed: a hedge that lands on the slowest node saves nothing.
        const rest = [...rotatedPreferred.slice(1), ...rescue]
          .sort((left, right) => resolver.speed(right) - resolver.speed(left));
        const candidates = rotatedPreferred.length ? [rotatedPreferred[0], ...rest] : rest;
        for (const url of resolver.ordered(piece.index)) {
          if (!candidates.includes(url)) candidates.push(url);
        }
        return candidates;
      }
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

    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0,
      deadline = null, earlyHedge = null) {
      const hasDeadline = Boolean(deadline) && Number.isFinite(deadline());
      const deadlineNow = () => (deadline ? deadline() : Infinity);
      const settings = config();
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const probe = startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

      // The longest contiguous run of bytes fetched from the front of this piece so far.
      // A retry or a hedge copy asks only for what is still missing and splices the two
      // halves, instead of downloading the whole piece again. Every kept byte came out
      // of a response whose 206 Content-Range was verified against this piece.
      let prefix = null;
      const keepProgress = (base, recorder) => {
        const bytes = (base?.bytes || 0) + recorder.bytes;
        if (bytes > (prefix?.bytes || 0) && bytes < piece.length) {
          prefix = { bytes, chunks: base ? [...base.chunks, ...recorder.chunks] : recorder.chunks.slice() };
        }
      };
      const liveProgress = (context) => {
        if (!context) return null;
        const chunks = context.recorder.chunks.slice();
        let bytes = context.base?.bytes || 0;
        for (const chunk of chunks) bytes += chunk.byteLength;
        return { bytes, chunks: context.base ? [...context.base.chunks, ...chunks] : chunks };
      };

      // Failing a piece ends acceleration for the whole video, and the list can be as short as
      // one working address. One slow reply must not decide that, so the list is walked again
      // after a pause; node health and bans have changed by then, so it is rebuilt each time.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(roundPause(round), signal);
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
          let firstStartedAt = 0, deadlineDeficitSamples = 0, firstBecameStraggler = () => {};
          const firstStraggler = new Promise((resolve) => { firstBecameStraggler = resolve; });
          const observeFirst = event => {
            if (!hasDeadline || event.phase !== "progress" || !Number.isFinite(event.etaMs)) return;
            const deadlineAt = deadlineNow();
            const missesDeadline = Number.isFinite(deadlineAt)
              && event.etaMs >= Math.max(0, deadlineAt - performance.now());
            const slowerThanPeers = meter.connectionBps > 0 && event.bps < meter.connectionBps * 0.5
              && event.etaMs >= 500;
            const remainingToDeadline = deadlineAt - performance.now();
            deadlineDeficitSamples = Number.isFinite(deadlineAt)
              && event.etaMs - remainingToDeadline >= 250
              ? deadlineDeficitSamples + 1
              : 0;
            // A clearly slow node is rescued immediately. If the whole route is slow,
            // two consecutive deficit samples may spend the same per-range rescue budget
            // (createEarlyHedge).
            if (Number.isFinite(deadlineAt)
              && ((missesDeadline && slowerThanPeers) || deadlineDeficitSamples >= 2)) {
              firstBecameStraggler();
            }
          };
          const contexts = [];
          const attempts = pair.map((url, pairIndex) => (async () => {
            if (pairIndex) await new Promise((resolve, reject) => {
              let timer = null, settled = false, earlyClaimed = false;
              const finish = (operation) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                controllers[pairIndex].signal.removeEventListener("abort", canceled);
                operation();
              };
              const measured = hedgeDelayMs(settings);
              const delay = probe ? 0 : startup
                ? Math.min(hasDeadline ? 200 : 250, measured)
                : measured;
              const copyBps = () => (typeof resolver.speed === "function" ? resolver.speed(url) || 0 : 0);
              // A playback-deadline request decides once its first copy has a connection (see
              // hedgeDue); one without a deadline (compatibility mode, the desktop client)
              // keeps the fixed hedge delay (hedgeDelayMs), counted from the moment the piece
              // asked, queue time included.
              const check = () => {
                if (settled) return;
                if (contexts[0] && hedgeDue(contexts[0], delay, deadlineNow(), copyBps(), earlyHedge)) return finish(resolve);
                timer = setTimeout(check, 50);
              };
              if (hasDeadline && !probe) timer = setTimeout(check, 0);
              else timer = setTimeout(() => finish(resolve), delay);
              firstStraggler.then(() => {
                if (settled || probe || earlyClaimed || !earlyHedge?.claimProgress?.()) return;
                earlyClaimed = true;
                if (timer) clearTimeout(timer);
                const grace = Math.max(0, 250 - (performance.now() - firstStartedAt));
                timer = setTimeout(() => finish(resolve), grace);
              });
              firstFailure.then(() => finish(resolve));
              const canceled = () => {
                finish(() => reject(abortError(controllers[pairIndex].signal.reason)));
              };
              if (controllers[pairIndex].signal.aborted) canceled();
              else controllers[pairIndex].signal.addEventListener("abort", canceled, { once: true });
            });
            // Resume from the longest prefix known when the request really starts: an earlier
            // failed attempt, or what the still-running first copy has received by then.
            let base = null;
            const recorder = { bytes: 0, chunks: [] };
            const begin = () => {
              if (!pairIndex) firstStartedAt = performance.now();
              base = prefix && prefix.bytes >= RESUME_MIN_BYTES ? prefix : null;
              if (pairIndex) {
                const live = liveProgress(contexts[0]);
                if (live && live.bytes >= RESUME_MIN_BYTES && live.bytes > (base?.bytes || 0)) base = live;
              }
              if (base && base.bytes >= piece.length) base = null;
              const startedAt = performance.now();
              contexts[pairIndex] = { base, recorder, startedAt, seenBytes: 0, seenAt: startedAt, length: piece.length - (base?.bytes || 0) };
              return {
                recorder,
                part: base
                  ? { index: piece.index, start: piece.start + base.bytes, end: piece.end, length: piece.length - base.bytes }
                  : piece
              };
            };
            try {
              const result = await attempt(piece, url, controllers[pairIndex].signal, kind, resolver,
                priority + (pairIndex ? 20 : 0), begin, deadline, pairIndex ? null : observeFirst,
                probe ? QUEUE_CRITICAL : startup ? QUEUE_STARTUP : QUEUE_ORDINARY);
              return base
                ? { bytes: core.concatChunks([...base.chunks, result.bytes], piece.length), total: result.total, url: result.url }
                : result;
            } catch (error) {
              keepProgress(base, recorder);
              if (!pairIndex) firstFailed();
              throw error;
            }
          })());
          try {
            const winner = await Promise.any(attempts);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
            });
            if (settings.autoConcurrency) autoConcurrency.delivered(piece.length);
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

    // Which address each piece tries first. The fastest node gets the most pieces, and a node
    // measured at under a twelfth of the best is left out entirely: a piece it starts has to
    // be rescued anyway. Its measurement goes stale after a while, and the resolver's
    // exploration slot then gives it, like any untested node, another try.
    let assignTurn = 0;
    // Trials are counted per resolver: the video and the audio track take turns on this
    // downloader, and one shared count could leave a track without a trial for good.
    const trialStates = new WeakMap();
    function assignPrimaries(urls, resolver, count) {
      if (!urls.length || count <= 0) return [];
      if (urls.length === 1) return new Array(count).fill(urls[0]);
      // Each range opens one node further on, so ranges in flight together do not all
      // send their first pieces to the same node.
      const turn = assignTurn;
      assignTurn = (assignTurn + 1) % 4096;
      const measure = typeof resolver.speed === "function" ? (url) => Math.max(0, Number(resolver.speed(url)) || 0) : () => 0;
      let known = urls.map(measure);
      const positive = known.filter((value) => value > 0);
      if (!positive.length) return Array.from({ length: count }, (_ignored, index) => urls[(index + turn) % urls.length]);
      const top = Math.max(...known);
      const eligible = urls.filter((_url, index) => !known[index] || known[index] >= top / 12);
      if (eligible.length && eligible.length < urls.length) {
        urls = eligible;
        known = urls.map(measure);
      }
      // A node without a measurement is a trial. It gets a piece or two from the end of the
      // range, which are needed last and may take longest, enough to measure it and cheap
      // when it turns out to be slow. With very few pieces there is none to spare.
      const unknown = urls.filter((_url, index) => !known[index]);
      let trials = Math.min(unknown.length * 2, Math.floor(count / 4));
      let trialState = trialStates.get(resolver);
      if (!trialState) trialStates.set(resolver, trialState = { waited: 0, cursor: 0 });
      // Small segments never have a piece to spare, and a node left out for being slow would
      // stay unmeasured for good. Every fourth such range gives up its last piece for a trial.
      if (!trials && unknown.length && count >= 2) {
        trialState.waited += 1;
        if (trialState.waited >= 4) trials = 1;
      }
      if (trials) trialState.waited = 0;
      if (unknown.length) {
        urls = urls.filter((_url, index) => known[index]);
        known = urls.map(measure);
        count -= trials;
      }
      const weights = known.map((value) => Math.max(value, top * 0.05));
      const total = weights.reduce((sum, value) => sum + value, 0);
      // Handed out in turns (smooth weighted round-robin), not in one block per node. The
      // pieces with the lowest numbers get the free connections first, and the player has
      // several segments in flight: with blocks, every segment's first pieces went to the
      // same node and the others sat idle.
      const primaries = [];
      const credit = weights.map(() => 0);
      const order = urls.map((_url, index) => (index + turn) % urls.length);
      for (let index = 0; index < count; index += 1) {
        let best = order[0];
        for (const urlIndex of order) {
          credit[urlIndex] += weights[urlIndex];
          if (credit[urlIndex] > credit[best]) best = urlIndex;
        }
        credit[best] -= total;
        primaries.push(urls[best]);
      }
      for (let index = 0; index < trials; index += 1) primaries.push(unknown[(index + trialState.cursor) % unknown.length]);
      trialState.cursor = (trialState.cursor + trials) % 4096;
      return primaries;
    }

    function preferredFor(primary, urls) {
      return primary ? [primary, ...urls.filter((url) => url !== primary)] : urls;
    }

    // Hands the finished pieces to onOrderedChunk in order: each one as soon as every piece
    // before it has been handed over. done() waits for what has been handed over so far.
    function orderedDelivery(pieces, onOrderedChunk) {
      const ordered = new Array(pieces.length);
      let next = 0;
      let operation = Promise.resolve();
      return {
        add(index, result) {
          ordered[index] = result;
          operation = operation.then(async () => {
            while (ordered[next]) {
              const item = ordered[next];
              ordered[next] = null;
              await onOrderedChunk(item.bytes, pieces[next], item.total);
              next += 1;
            }
          });
          return operation;
        },
        done: () => operation
      };
    }

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(config().concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const startedAt = performance.now();
      let lastError = null;
      // The addresses that just failed are backing off by the next round, so each round
      // moves on to the next three.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(roundPause(round), options.signal);
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
        220,
        options.deadline
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
        adaptiveMinChunk(settings, range.end - head.end, pieceBudget, candidateUrls.length)
      ).map((piece, index) => ({ ...piece, index: index + 1 }));
      const delivery = orderedDelivery(pieces, options.onOrderedChunk);
      // The probe measured at least its own winner, so the pieces spread over the nodes by
      // speed at once; the proven address is among each piece's fallbacks, which
      // pieceCandidates orders by measured speed. Only the probe's winner and nodes with a
      // speed measurement carry the first segment: a node whose probe never finished would
      // otherwise get a share of it and hold up the start. The others stay available for
      // rescue, and later ranges try them.
      const measured = typeof resolver.speed === "function" ? (url) => resolver.speed(url) > 0 : () => false;
      const provenUrls = candidateUrls.filter((url) => url === headResult.url || measured(url));
      const primaries = assignPrimaries(provenUrls.length ? provenUrls : [headResult.url], resolver, pieces.length);
      const earlyHedge = createEarlyHedge(rescueReserve);
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[orderedIndex], [headResult.url, ...candidateUrls.filter((url) => url !== headResult.url)]),
          true,
          120 - Math.min(30, piece.index),
          options.deadline,
          earlyHedge
        );
        await delivery.add(orderedIndex, result);
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await delivery.done();
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
      const settings = config();
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      // One deadline for the whole range, resolved at its boundary: every piece, including work
      // scheduled after the startup probe, refers to the same playback instant.
      const deadline = deadlineOf(options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, { ...options, deadline }, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // Fewer primary pieces than slots is not a hard-reserved connection: it gives a
      // stalled piece's hedge/retry room to start immediately while the other primaries run.
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
        parallel ? adaptiveMinChunk(settings, range.length, pieceConcurrency, preferredUrls.length) : Number.MAX_SAFE_INTEGER
      );
      const primaries = parallel ? assignPrimaries(preferredUrls, resolver, pieces.length) : [];
      const earlyHedge = createEarlyHedge(rescueReserve);
      const progressive = typeof options.onOrderedChunk === "function";
      const delivery = orderedDelivery(pieces, options.onOrderedChunk);
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[piece.index], preferredUrls),
          options.startup === true,
          basePriority - Math.min(20, piece.index),
          deadline,
          earlyHedge
        );
        if (progressive) await delivery.add(piece.index, result);
        return result;
      }));
      if (progressive) await delivery.done();
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

    return Object.freeze({ downloadRange, applySettings, getConcurrency: () => semaphore.limit });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader, createAutoConcurrency, autoConcurrency });
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
    // Red messages occupy a protected lane above the ordinary ones, starting at
    // most 560px above the bottom of the column. Ordinary traffic cannot evict
    // them or push them offscreen.
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
    // When the takeover error notice below closes, or the viewport grows, there
    // is more space below. Existing messages keep their positions; only newly
    // created messages use that space.
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
        .stack{position:absolute;inset:0;overflow:hidden;user-select:none;-webkit-user-select:none}
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
    // A removed bubble leaves its gap on purpose: older bubbles never move down
    // to fill it.
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
    // 自动线程数 is on unless switched off, as in the browser version; concurrency is then only
    // the manual choice, used again when it is switched off.
    return { enabled: s.enabled, autoConcurrency: value?.autoConcurrency !== false, concurrency: s.concurrency, mode: s.mode, customHosts: s.customHosts, debugNotices: s.debugNotices, errorNotices: s.errorNotices, debugCategories: s.debugCategories, theme: s.theme, floatingButton: s.floatingButton, floatingButtonLeft: s.floatingButtonLeft, floatingButtonTop: s.floatingButtonTop, guideDone: s.guideDone, autoCheckUpdates: value?.autoCheckUpdates !== false, revision: REVISION };
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
  const store = next => {
    localStorage.setItem(KEY, JSON.stringify(next)); // Failure must not pretend to save.
    current = next; emit(); channel?.postMessage(current);
    return api.getSettings();
  };
  const api = {
    version: root.__BTR_DESKTOP_RELEASE__?.version || "2026.10.30.1-d2",
    adapterRevision: root.__BTR_DESKTOP_RELEASE__?.adapterRevision || 2,
    categories,
    getSettings: () => ({ ...current, customHosts: current.customHosts.slice(), debugCategories: { ...current.debugCategories } }),
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
  // The thread count a request may use: the controller's level with 自动线程数 on (see
  // client.js for its signals), otherwise the one set by hand.
  const autoConcurrency = root.__BILI_IDM_DOWNLOADER_FACTORY__.autoConcurrency;
  const threadsNow = () => { const settings = api.getSettings(); return settings.autoConcurrency && autoConcurrency ? autoConcurrency.threads() : settings.concurrency; };
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
  // A request of 64 to 128 KiB is a single piece, and since 0.9.3.0 the downloader gives a
  // single piece to the fastest node every time. The client asks for sound in a run of such
  // requests, several at once, and they would all queue on that one node. Their first node is
  // picked in turns here instead; a node far slower than the best is left out, and the
  // copies that rescue a slow piece are still chosen by the downloader.
  const turnViews = new WeakMap();
  function inTurns(resolver) {
    if (!turnViews.has(resolver)) {
      let turn = 0;
      const speed = typeof resolver.speed === "function" ? resolver.speed : () => 0;
      turnViews.set(resolver, Object.freeze({ ...resolver, rangeCandidates() {
        const all = resolver.rangeCandidates(), best = Math.max(0, ...all.map(speed));
        const usable = all.filter(url => !speed(url) || speed(url) >= best / 12);
        const list = usable.length ? usable : all;
        return list.length ? [list[turn++ % list.length]] : list;
      } }));
    }
    return turnViews.get(resolver);
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
      const startup = range.start === 0 || stats.acceleratedRequests < 2;
      const onePiece = !startup && range.length > 64 * 1024 && range.length < 128 * 1024;
      const result = await downloader.downloadRange(range, onePiece ? inTurns(resolverFor(url)) : resolverFor(url), {
        // Small audio/index requests must not lower the shared semaphore to 1.
        // Use the original downloader's metadata race for tiny ranges instead.
        signal: controller.signal, parallel: true,
        maxConcurrency: range.length < 128 * 1024 ? 1 : threadsNow(),
        kind: range.length <= 64 * 1024 ? "meta" : rep?._btrKind || "video", startup,
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
    snapshot: () => ({ ...stats, generation, pending: pending.size, bannedHosts: bans.hosts(), threads: threadsNow() }),
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
  // 自动线程数 (the controller lives in the shared idm-downloader.js). The client's own video
  // element tells it what the browser version's player tells it there: a stall once playback
  // had started, and a low buffer that stops growing while bytes arrive. A new video or a
  // seek starts the buffer watch afresh, and opens with more threads; switched off, the
  // controller is left alone.
  const auto = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency;
  const autoOn = () => { const settings = api.getSettings(); return settings.enabled && settings.autoConcurrency; };
  const newSession = () => { if (autoOn()) auto?.newSession(); };
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
      newSession();
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


/* src/panel-bridge.js */
(function (root) {
  "use strict";
  // The settings panel and the floating button are the browser version's own code
  // (shared/settings-panel.js), so there is one panel to maintain. This file is what stands
  // in for its bridge.js: it answers the panel's messages from the desktop settings, leaves
  // out what the client has no use for and adds the block for updates and uninstalling.
  const api = root.__BTR_DESKTOP__, transport = () => api.transport;
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");
  let saveError = () => {};

  function saved(write) {
    try { write(); saveError(""); }
    catch (_) { saveError("设置保存失败，请检查客户端的数据目录是否可写。"); }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const area = document.createElement("textarea");
    area.value = text; area.style.cssText = "position:fixed;opacity:0";
    (document.querySelector("dialog") || document.body).append(area);
    area.select();
    try { return document.execCommand("copy"); } catch (_) { return false; } finally { area.remove(); }
  }

  function mount(panel) {
    const block = document.createElement("div");
    block.className = "block btr-update";
    block.innerHTML = `<h2 class="block-title">更新</h2>
      <section class="notice-controls" aria-label="更新">
        <label class="notice-row" for="btr-desktop-auto-update"><span class="row-text">自动检查 BTR 更新</span><span class="switch"><input id="btr-desktop-auto-update" type="checkbox" aria-label="自动检查 BTR 更新"><span></span></span></label>
        <div class="btr-maintenance">
          <button id="btr-desktop-install-update" type="button" hidden>安装更新</button>
          <button id="btr-desktop-check-update" type="button">检查 BTR 更新</button>
          <button id="btr-desktop-uninstall" type="button">卸载 BTR</button>
        </div>
        <p class="btr-update-status" role="status"></p>
        <p class="btr-save-error" role="status"></p>
      </section>`;
    // On the panel's first page, not under 高级设置: this is how the app is kept up to date.
    panel.querySelector(".view-main").append(block);
    const find = selector => block.querySelector(selector);
    find("#btr-desktop-auto-update").addEventListener("change", event => saved(() => api.setSettings({ autoCheckUpdates: event.target.checked })));
    // Installing and uninstalling are started by the preload, which only trusts real clicks.
    find("#btr-desktop-check-update").addEventListener("click", () => api.checkUpdate());
    saveError = message => { find(".btr-save-error").textContent = message; };
    // The client cannot open links in a browser: the GitHub button copies the address instead.
    const link = panel.querySelector("#github-link");
    link.title = link.ariaLabel = "复制项目地址";
    link.removeAttribute("target");
    link.addEventListener("click", async event => {
      event.preventDefault();
      find(".btr-update-status").textContent = await copy(link.href) ? "已复制项目地址" : "复制失败，地址是 " + link.href;
    });
    // The panel is rebuilt on every open; a closed one stops listening. It joins the page
    // only after this runs, so "gone" means it was connected once.
    const whileOpen = (subscribe, show) => {
      let shown = false, stop = null;
      stop = subscribe(value => {
        if (block.isConnected) shown = true;
        else if (shown) { stop?.(); return; }
        show(value);
      });
    };
    whileOpen(api.onSettings, settings => { find("#btr-desktop-auto-update").checked = settings.autoCheckUpdates !== false; });
    whileOpen(api.onUpdate, update => {
      find(".btr-update-status").textContent = update.message;
      const busy = ["confirming", "installing", "uninstalling"].includes(update.state);
      find("#btr-desktop-check-update").disabled = busy || update.state === "checking";
      find("#btr-desktop-uninstall").disabled = busy;
      const install = find("#btr-desktop-install-update");
      install.hidden = update.state !== "available";
      install.textContent = update.manifest ? `更新到 ${update.manifest.version}` : "安装更新";
    });
  }

  root.__BTR_PANEL_HOST__ = Object.freeze({
    projectUrl: "https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop",
    // 接管方式, 缓冲, 加速范围 and 网页版本 are the browser version's: the client plays by itself.
    hide: [".takeover-select", ".accel-controls", ".site-controls", "#tab-buffer", "#panel-buffer"],
    css: `
      .tabs { grid-template-columns: repeat(3, 1fr); }
      .btr-maintenance { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px; margin: 6px 0 8px; padding: 3px; border-radius: 10px; background: var(--bg); }
      .btr-maintenance button { padding: 7px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
      .btr-maintenance button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
      .btr-maintenance button:disabled { opacity: .55; cursor: default; }
      .btr-maintenance button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
      #btr-desktop-install-update { grid-column: 1 / -1; background: #fb7299; color: #fff; font-weight: 600; }
      #btr-desktop-install-update[hidden] { display: none; }
      #btr-desktop-install-update:hover:not(:disabled) { background: #fb7299; color: #fff; }
      #btr-desktop-uninstall:hover:not(:disabled) { color: var(--error); }
      .btr-update-status, .btr-save-error { margin: 0 0 8px 2px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
      .btr-save-error { color: var(--error); }
      .btr-update-status:empty, .btr-save-error:empty { display: none; }
    `,
    mount
  });

  // The transport counts bytes; the panel shows a speed.
  let lastBytes = 0, lastAt = 0, speed = 0;
  function stats() {
    const snapshot = transport()?.snapshot() || {}, now = performance.now(), bytes = Number(snapshot.networkBytes) || 0;
    if (lastAt && now > lastAt) speed = Math.max(0, bytes - lastBytes) * 1000 / (now - lastAt);
    lastBytes = bytes; lastAt = now;
    return { activeThreads: Number(snapshot.activeThreads) || 0, totalSpeedBps: speed };
  }

  api.onSettings(settings => post("settings", settings));
  root.addEventListener("message", event => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "get-settings") post("settings", api.getSettings());
    else if (event.data.type === "get-stats") post("stats", stats());
    else if (event.data.type === "settings-update") saved(() => api.setSettings(event.data.payload));
    else if (event.data.type === "settings-reset") saved(api.resetSettings);
  });
  // The panel's diagnostic copy.
  root.__biliThreadRipperDebug = { report: () => JSON.stringify(api.getStatus?.() || {}) };
})(globalThis);


/* shared/settings-panel.js */
// The settings panel. It runs in the bilibili page and opens from the button in the page's
// corner, the userscript manager's menu, or "自定义" in the player's gear menu. Settings are
// read and saved through bridge.js; storage-shim.js keeps them in the script manager's
// storage.
(function installSettingsPanel(root) {
  "use strict";

  if (root.__BTR_SETTINGS_PANEL__) return;
  const core = root.__BILI_RANGE_CORE__;
  const cdn = root.__BILI_CDN_RESOLVER_FACTORY__;
  if (!core || !cdn) return;
  // The desktop app opens this same panel. It names what the client has no use for and adds
  // its own block (its src/panel-bridge.js); the userscript sets none of this.
  const hostApp = root.__BTR_PANEL_HOST__;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  // Which script this is: the released one, or the Canary built from main.
  const SCRIPT_CHANNEL = "stable" === "canary" ? "canary" : "stable";
  const CHANNEL_NAMES = { stable: "正式版", canary: "Canary" };
  // Set by the other of the two scripts when both are switched on (see loader.js).
  const otherScript = () => document.documentElement?.getAttribute("data-btr-also-running") || "";
  const HOST_ID = "__bilibili_thread_ripper_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_settings_dialog__";
  const LAUNCHER_ID = "__bilibili_thread_ripper_launcher__";
  const GUIDE_ID = "__bilibili_thread_ripper_guide__";
  const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
  const BUFFER_OPTIONS = [30, 45, 90, 180];
  const MAX_CUSTOM_HOSTS = 32;
  const HOST_GROUPS = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
  const PROJECT_URL = "https://github.com/MrTangLuyao/Bilibili-thread-ripper";
  // GitHub's mark.
  const GITHUB_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>`;
  // The script's own icon, icons/icon-128.png (dev/userscript-test.js checks the two stay the same).
  const ICON_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAHzklEQVR4nO2d248VNRjA58HLuySi0UcV/xoDMZHoEw8Gjcil3WVFjUIUb1FcNhC23x7kohFwTbyh4opGAVHuKBBhXcALBCTrgnAWzp6208909pAYg7LrtNPOnO+XfG9sOPN9v2k7baeTJARBEARBEARBEARBEAThEuxceZtm8JDi0CM5DCguhiSD85KDVBywHUNykDYHWS6ynECP5r0P2lxVwj6cs2KKZDBPcdgbOtmlCyb2SC7m2hwmZQO7+u5UTCyXHC4HT2TJQzIxqjh0I+u9I4kdnA03Sg7zJYd66MRVLaS9mRgswbk9NycxMjZ/1TTF4fvQiap+iINjvO+eJCYUg/vprofiWgMmLinWNyOJgSbvmyUZqPB3RnuF5ELLBeLRoMWXDB4JnYh2D8nF3IDNvtChE9DuIcdrML3Q4jdY7S7J4WLoi6eAlgRQH+NwbyHFx8X9N9FoH+KTj8EB+xjuXQDJYVHwi6XAa3cH0Om1+HY2qjUzRUXgcXYFuABu9yaAnd4NfZEUcL2uYJm/hR2a28fYBbQttJcFpNaqXvALpIAJdAVijnMBaEkXyiTfbqfFtwMLyYWJ4MIo+IRaAIPzalOdCdDayUPJ5+XJgeZipjMB7Fal0BdEAZPNQbczAVr71agIvDw5kEx86kwAxeFE6AuigEnmQAw5E0ByMUIFgFJJKBkMuxOAiWboC6KAyQnAYcyZAJR8KKWAJEAERVAkQPhEtGskVesCCqfRRLwyhubcBTQnzqI5MITpZ/tQv7kV9dINwfNBAoTmz1E0ewdRrxlA9cQbwQtOLUBIGk1Mtx9G/dKm4IW/GtQFhCA1mO4ZRPX82yRA6ccAeWgqTD/ejaqjj1qAthSghfnxV1RPraUuoF0FsJhTw6ieXkdjgHYVwGJ+PYdqUbFPCjQIjAxz4DgJ0K4twFX0W19QC9DOAuCfo4V1BeG6gIU1TLfsRXNmBPF8fUJh/639G/u3lRYAEdP3dlZbgPSzvRMu/D/D/q0vAa7727tWo3pmPeqX30G9biumXxxE8/sFdI1dW1AdFRZgMnf+tVqCYALwa4de/n62GOQS/eq7JEBZBFA2OgDTT3YjGif1H58lrGoLUNougE/g2gb2ORHAfH+iugLEOgh0ktiFNTRnR/ILcPZ8hQXwFFEIwAHT93fm/i1Yb5AAZRVAv9KfXwClSYCyCqCeXJNfgKYiAUorwFNr3cwIeu4yaQwQcRdgTg+TAGVtAdIPvs39W9JdR0mAUgqw0M1jYNq/jQQoowCpi4kgY1A993aFxgD/Y+KndBNBHe6mgs3gae/FL1SAPFO/ZZgK1j1uF4P0us+rJUCeOz+qxaCu1aieXY/6FX/LwdnewAKWgkmAGDEG9YoPCyk+dQERkn6+v7DiFypAWQaBITHHTqHqrFVUgIKirJiTZ7P1g6LzRQJEgDl0MkjxSYDQ6BTTzbsKG/GTABFhBk9nC0ahu0zqAkIJcGoY9YavUHWGezWcBIgAc+4CaviEBHBldFkxdgfwM+upBWhXASxm5FLh5weFGwNEui08OPUrqLvfq74Asb4YEgVXxlC/uKnaAsT6bmAsGPtyaAHnBpEAEWP2/VRdAagLmAAGUa/8sJoCxDoInPDv71qNaslb2WyeXr8V022HnGwEvebpYR1VFMBT5CXv/69XfpQt67pEr9pMApRFAHV1c+i727N3+1xg9g+RAKUSgLdag3Vbsy1e+X+U9vZEQF2ARwGUHex+edBNN+BpvYAE8CyAsi+J1hu5BbAvm5AAJesC1NVWYMeR3L/LHP2NBCirALq2Jb8A/zH7SV1A7AIs3RDtWQE0BihAALXojWiPiyEBihDgSQfHxZAAE0t2lF3ACxvzCzDq58QwagHKMgj84yIJUNYWIP3mSLTnBVALUJaJoB1H4hYgls/H5yXWqeB009dxfz5ecjESuvixCaDXDGQfiXSBj49MSgbDzgRQDI6HLn5ll4PP+JkFVFwMORNAchgIXfyqbghJP/jWS64kE586E0Bx6GkrAbqK2RKGUvn8oGS3MwE0732wCgLERvrlQW+50gv6HnAmAM6rTZVcGBLAIfUr3nYC2VrZmiUuUUzsIQHcYZ8i/OVTfJe4RnIxlwRwQ7rjsNeuUjJ4zLkAOGfFFMnEKI0B8mGO/PKf7z7kL74YtbVKfGBHliRAzq1f9gnD492vOLyW+AJZ7x0hW4Eyk9rvA3i881t3/yXsXHlb4hPJxBMkwCRoNDHd+FUhN4hk0JH4BmfDjYrBAWoBroNBND+cLOS7AK3Yb2uTFEGD1e6SHC5SF/AvhR88lR0xX1R+JIf62PxV05IiUaxvhuRCFylB1NQb2bq+PWq+yJy0anBfEgLZIWa3rQCpyV7vtusE2Ru+Ac4EtDN+TQ4PJyFp8r5ZkoGqnACNZnaejz3dy/z8O5rDP2fFTvu3jx/sEOj837/f+ZLBI0kMKA7T7SNIyIS0U8jx8VeYZv/fGFvYe3eop4M2i/12EJ7ECC5efIPkMJ9aA/Bx119WDJbg4v6bktjBBXC7YuL10GsHVQhpc8hgmfcZPh+MLyDB44rBrhj2E5QlZJYr8Z3kYg6y2i1JFcCOVbdqLmbaBSXJYYvicMzuNo5ly7kKUWgmmq0d18daOem2ObK5Cl0vgiAIgiAIgiAIgiAIomL8Bc0CR4+jT4wjAAAAAElFTkSuQmCC";
  // The theme button shows the choice in use: a sun for 浅色, a moon for 深色, and for 自动 a
  // half sun, half moon with a small A in the corner.
  const THEME_ICONS = `<svg class="icon-light" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"></path></svg>`
    + `<svg class="icon-dark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 13.8A8.5 8.5 0 1 1 10.2 3.5a6.6 6.6 0 0 0 10.3 10.3z"></path></svg>`
    + `<svg class="icon-auto" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="4"></circle><path d="M10 6a4 4 0 0 1 0 8z" fill="currentColor" stroke="none"></path><path d="M10 1.7v1.8M10 16.5v1.8M1.7 10h1.8M16.5 10h1.8M4.1 4.1l1.3 1.3M15.9 4.1l-1.3 1.3M4.1 15.9l1.3-1.3"></path><path d="M14.6 22.8l4.1-9 4.1 9M16 19.6h5.4"></path></svg>`;
  const THEME_LABELS = { auto: "自动（跟随系统）", light: "浅色", dark: "深色" };
  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`;
  const KNOWN_HOSTS = HOST_GROUPS.flatMap(([, hosts]) => hosts);

  // The ripple on everything that can be pressed, the same one as on louie1.com: a circle that
  // grows from where the press landed and fades out. A timer removes each circle after its run,
  // not only animationend: an animation does not run while its element is hidden (a page or
  // tab of the panel not shown, the floating button taken off the page while the panel is
  // open), so animationend would never come, and the leftover circle would play again as
  // soon as the element showed up.
  const RIPPLE_MS = 600;
  const RIPPLE_CSS = `
    .btr-ripple-host { overflow: hidden; }
    .btr-ripple { position: absolute; display: block; border-radius: 50%; transform: scale(0); background: var(--ripple, rgba(255, 255, 255, .15)); pointer-events: none; animation: btr-ripple ${RIPPLE_MS}ms linear forwards; }
    @keyframes btr-ripple { to { transform: scale(4); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .btr-ripple { display: none; } }
  `;

  function ripple(surface, event) {
    if (!surface) return;
    if (root.getComputedStyle(surface).position === "static") surface.style.position = "relative";
    surface.classList.add("btr-ripple-host");
    clearRipples(surface);
    const box = surface.getBoundingClientRect();
    const size = Math.max(surface.clientWidth, surface.clientHeight);
    // Its own element rather than a span, which the panel's span rules (the switches, the
    // choices) would restyle.
    const circle = document.createElement("btr-ripple");
    circle.className = "btr-ripple";
    circle.style.width = circle.style.height = `${size}px`;
    circle.style.left = `${event.clientX - box.left - size / 2}px`;
    circle.style.top = `${event.clientY - box.top - size / 2}px`;
    surface.append(circle);
    const timer = setTimeout(() => circle.remove(), RIPPLE_MS + 50);
    circle.addEventListener("animationend", () => {
      clearTimeout(timer);
      circle.remove();
    }, { once: true });
  }

  function clearRipples(scope) {
    for (const circle of scope?.querySelectorAll(".btr-ripple") || []) circle.remove();
  }

  // 运行状态's speed: KB/s, MB/s from one megabyte a second up.
  function formatSpeed(bps) {
    const value = Math.max(0, Number(bps) || 0);
    if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10 * 1048576 ? 0 : 1)} MB/s`;
    return `${Math.round(value / 1024)} KB/s`;
  }

  const PANEL_HTML = `
    <main>
      <header>
        <img class="logo" src="${ICON_URI}" alt="" width="42" height="42">
        <div class="title">
          <div class="name">
            <h1>线程撕裂者</h1>
            <span class="version">v2026.10.30.1-d2${SCRIPT_CHANNEL === "canary" ? '<b class="canary">Canary</b>' : ""}</span>
          </div>
          <a id="github-link" class="github-link" href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer" title="在 GitHub 上查看项目" aria-label="在 GitHub 上查看项目">${GITHUB_ICON}</a>
          <button id="theme" class="theme-toggle" type="button" data-value="auto">${THEME_ICONS}</button>
        </div>
        <label class="switch" title="启用或停用">
          <input id="enabled" type="checkbox">
          <span></span>
        </label>
      </header>
      <p id="also-running" class="also-running" role="alert" hidden></p>
      <p id="disabled-note" class="disabled-note" role="status" hidden>线程撕裂者已关闭，打开右上角的开关即可启用。</p>

      <div class="view-main">
        <div class="block" data-needs-enabled>
          <h2 class="block-title">接管方式</h2>
          <section class="takeover-select" aria-label="接管方式">
            <label><input type="radio" name="takeover" value="full"><span>全接管</span></label>
            <label><input type="radio" name="takeover" value="compat"><span>兼容模式</span></label>
          </section>
          <p class="takeover-note">Safari 用户建议使用兼容模式。<br><br>全接管：播放内核由BTR接管，速度最快。<br>兼容模式：遇到任何问题，尝试兼容模式。</p>
        </div>
        <div class="block" data-needs-enabled>
          <h2 class="block-title">运行状态</h2>
          <section class="run-state" aria-label="运行状态">
            <span><b id="active-count">0</b> 条线程</span>
            <b class="run-speed">0 KB/s</b>
          </section>
        </div>
      </div>

      <details id="advanced" class="advanced">
        <summary>
          <span class="advanced-title">高级设置${CHEVRON_ICON}</span>
          <small>默认设置在绝大多数场景就是表现最优的。如果你遇到了问题，修改这里的一些设置可能有帮助。</small>
        </summary>
        <div class="advanced-page">
          <div class="page-bar">
            <button id="advanced-back" class="page-back" type="button" aria-label="返回">${CHEVRON_ICON}</button>
            <span class="page-title">高级设置</span>
          </div>
          <div class="tabs" role="tablist" aria-label="高级设置">
            <button id="tab-network" type="button" role="tab" data-tab="network" aria-controls="panel-network" aria-selected="true">网络</button>
            <button id="tab-buffer" type="button" role="tab" data-tab="buffer" aria-controls="panel-buffer" aria-selected="false" tabindex="-1">缓冲</button>
            <button id="tab-features" type="button" role="tab" data-tab="features" aria-controls="panel-features" aria-selected="false" tabindex="-1">功能</button>
            <button id="tab-interface" type="button" role="tab" data-tab="interface" aria-controls="panel-interface" aria-selected="false" tabindex="-1">界面</button>
          </div>
          <div id="panel-network" class="tab-panel" role="tabpanel" aria-labelledby="tab-network" data-tab-panel="network">
            <div class="block" data-needs-enabled>
              <h2 class="block-title">CDN 模式</h2>
              <section class="mode-select" aria-label="CDN 模式">
                <label><input type="radio" name="mode" value="mainland"><span>大陆</span></label>
                <label><input type="radio" name="mode" value="overseas"><span>海外</span></label>
                <label><input type="radio" name="mode" value="custom"><span>自定义</span></label>
              </section>
              <section id="custom-hosts" class="custom-hosts" aria-label="自定义服务器" hidden>
                <div class="custom-head"><span>自定义服务器</span><b id="custom-count">0</b></div>
                <p id="custom-empty" class="custom-note">还没选服务器，暂时按大陆 CDN 下载。</p>
                <div id="known-hosts"></div>
                <fieldset class="host-group">
                  <legend>手动添加</legend>
                  <div id="manual-hosts" class="manual-hosts"></div>
                  <form id="host-form" class="host-form">
                    <input id="host-input" type="text" placeholder="例如 upos-sz-mirrorali.bilivideo.com" spellcheck="false" autocomplete="off" aria-label="服务器地址">
                    <button type="submit">添加</button>
                  </form>
                  <p id="host-error" class="host-error" role="alert"></p>
                </fieldset>
                <p class="custom-note">只能填 B 站的视频服务器（bilivideo.com、akamaized.net 等），视频的下载地址不会发给别的网站。</p>
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">线程</h2>
              <section class="controls">
                <div class="control-title">
                  <label for="concurrency">线程加载数</label>
                  <output id="thread-value" for="concurrency">8</output>
                </div>
                <label class="auto-row" for="auto-concurrency"><span class="row-text">自动线程数（推荐）<small>BTR将智能选择需要的线程数。</small></span><span class="switch"><input id="auto-concurrency" type="checkbox" aria-label="自动线程数"><span></span></span></label>
                <div class="slider">
                  <div id="slider-fill" class="slider-fill" aria-hidden="true"></div>
                  <input id="concurrency" type="range" min="0" max="5" step="1" value="1" aria-label="线程加载数" aria-valuetext="8">
                </div>
                <div class="scale" aria-hidden="true">
                  <span>4</span><span>8</span><span>16</span><span>32</span><span>64</span><span>128</span>
                </div>
              </section>
            </div>
          </div>
          <div id="panel-buffer" class="tab-panel" role="tabpanel" aria-labelledby="tab-buffer" data-tab-panel="buffer" hidden>
            <div class="block" data-needs-enabled>
              <section class="controls buffer-controls" aria-label="缓冲">
                <div class="control-title">
                  <label for="buffer-ahead" class="row-text">全接管预缓冲时长<small>可能受到浏览器150MiB限制</small></label>
                  <output id="buffer-value" for="buffer-ahead">45s</output>
                </div>
                <div class="slider">
                  <div id="buffer-fill" class="slider-fill" aria-hidden="true"></div>
                  <input id="buffer-ahead" type="range" min="0" max="3" step="1" value="1" aria-label="全接管预缓冲时长" aria-valuetext="45 秒">
                </div>
                <div class="scale" aria-hidden="true">
                  <span>30s</span><span>45s</span><span>90s</span><span>180s</span>
                </div>
                <label class="auto-row" for="secondary-buffer"><span class="row-text">开启二级缓冲（实验性）<small>尝试绕过浏览器视频缓冲容量限制</small></span><span class="switch"><input id="secondary-buffer" type="checkbox" aria-label="开启二级缓冲（实验性）"><span></span></span></label>
              </section>
            </div>
          </div>
          <div id="panel-features" class="tab-panel" role="tabpanel" aria-labelledby="tab-features" data-tab-panel="features" hidden>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">加速范围</h2>
              <section class="accel-controls" aria-label="加速范围">
                <label class="accel-row" for="episode-enabled"><span class="row-text">剧集加速<small>加速番剧、电影、纪录片等剧集，使用兼容模式。</small></span><span class="switch"><input id="episode-enabled" type="checkbox" aria-label="剧集加速"><span></span></span></label>
                <label class="accel-row" for="live-enabled"><span class="row-text">直播加速（实验性）</span><span class="switch"><input id="live-enabled" type="checkbox" aria-label="直播加速（实验性）"><span></span></span></label>
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">网页版本</h2>
              <section class="site-controls" aria-label="网页版本">
                <label class="accel-row" for="block-international"><span class="row-text">阻止使用国际版<small>重定向B站到国内版网页</small></span><span class="switch"><input id="block-international" type="checkbox" aria-label="阻止使用国际版"><span></span></span></label>
              </section>
            </div>
            <div class="block">
              <h2 class="block-title">调试</h2>
              <section class="notice-controls" aria-label="调试">
                <label class="notice-row" for="error-notices"><span class="row-text">显示错误</span><span class="switch"><input id="error-notices" type="checkbox" aria-label="显示错误"><span></span></span></label>
                <label class="notice-row" for="debug-notices"><span class="row-text">Debug 模式</span><span class="switch"><input id="debug-notices" type="checkbox" aria-label="Debug 模式"><span></span></span></label>
                <fieldset id="debug-filters" class="debug-filters" hidden>
                  <legend>显示哪些 Debug 消息</legend>
                  <div class="debug-filter-actions"><button id="debug-select-all" type="button">全选</button><button id="debug-select-none" type="button">全不选</button></div>
                  <div class="debug-filter-options">
                    <label><input type="checkbox" data-debug-category="takeover">接管与切换</label>
                    <label><input type="checkbox" data-debug-category="playback">播放与暂停</label>
                    <label><input type="checkbox" data-debug-category="download">下载线程</label>
                    <label><input type="checkbox" data-debug-category="buffer">缓冲与跳转</label>
                    <label><input type="checkbox" data-debug-category="settings">设置变化</label>
                    <label><input type="checkbox" data-debug-category="other">其他日志</label>
                  </div>
                  <div class="debug-copy">
                    <button id="debug-copy" type="button">复制诊断信息</button>
                    <span id="debug-copy-status" class="debug-copy-status" role="status"></span>
                  </div>
                  <p class="debug-copy-note">反馈问题时点一下，把复制下来的内容贴到 issue 里。里面没有 Cookie、账号信息和视频的下载地址。</p>
                  <textarea id="debug-copy-text" class="debug-copy-text" readonly hidden aria-label="诊断信息"></textarea>
                </fieldset>
              </section>
            </div>
            <div class="block">
              <button id="reset-settings" class="reset-settings" type="button">恢复默认设置</button>
            </div>
          </div>
          <div id="panel-interface" class="tab-panel" role="tabpanel" aria-labelledby="tab-interface" data-tab-panel="interface" hidden>
            <div class="block">
              <section class="interface-controls" aria-label="界面">
                <label class="notice-row" for="floating-button"><span class="row-text">悬浮按钮</span><span class="switch"><input id="floating-button" type="checkbox" aria-label="悬浮按钮"><span></span></span></label>
              </section>
            </div>
          </div>
        </div>
      </details>
    </main>`;

  const PANEL_CSS = `
    .btr-popup {
      --scheme: dark; --bg: #17191f; --surface: #20232a; --hover: #292d35;
      --divider: #343943; --control-border: #444b57;
      --text: #f5f7fb; --label: #c9ced9; --button-text: #d9dee8;
      --muted: #949baa; --subtle: #8a93a6; --switch: #313a4c; --track: #3a3e47;
      --error: #f28b85; --success: #9fd9a8; --focus: #fff; --tab: #343943;
      --shadow: 0 24px 60px rgba(0, 0, 0, .5), 0 2px 10px rgba(0, 0, 0, .3);
    }
    .btr-popup[data-theme="light"] {
      --scheme: light; --bg: #fff; --surface: #f4f5f8; --hover: #e8ebf0;
      --divider: #d6dae2; --control-border: #aeb6c4;
      --text: #202532; --label: #363f50; --button-text: #363f50;
      --muted: #596579; --subtle: #596579; --switch: #758197; --track: #d6dae2;
      --error: #b42318; --success: #227536; --focus: #244e9b; --tab: #fff;
      --shadow: 0 24px 60px rgba(15, 23, 42, .18), 0 2px 10px rgba(15, 23, 42, .08);
    }
    * { box-sizing: border-box; }
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 360px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 0; border-radius: 16px; box-shadow: var(--shadow); color-scheme: var(--scheme); font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: normal; text-align: left; user-select: none; -webkit-user-select: none; }
    input, textarea { user-select: text; -webkit-user-select: text; }
    /* The panel takes the focus when it opens, for the keyboard; it is no control to outline. */
    .btr-popup:focus { outline: none; }
    main { padding: 18px 18px 14px; }
    header { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 11px; margin-bottom: 18px; }
    .logo { display: block; width: 42px; height: 42px; }
    h1 { margin: 0; font-size: 17px; letter-spacing: .2px; }
    .name { display: grid; gap: 2px; min-width: 0; }
    .version { color: var(--muted); font-size: 11px; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .version .canary { margin-left: 6px; padding: 0 5px; border-radius: 4px; background: #f5b301; color: #1d1d1f; font-size: 10px; font-weight: 700; }
    /* With the master switch off the panel says so, and what only works with BTR on fades out
       and cannot be used: not 调试 (the notices and the diagnostic copy) or the floating button,
       which still apply. */
    .disabled-note { margin: -10px 0 14px; padding: 8px 10px; border-radius: 8px; background: rgba(251, 114, 153, .16); color: var(--text); font-size: 12px; line-height: 1.55; }
    [data-needs-enabled] { transition: opacity .2s ease, filter .2s ease; }
    main.is-off [data-needs-enabled] { opacity: .38; filter: grayscale(1); pointer-events: none; user-select: none; }
    .also-running { margin: -10px 0 14px; padding: 8px 10px; border-radius: 8px; background: rgba(245, 179, 1, .16); color: var(--text); font-size: 12px; line-height: 1.55; }
    .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .github-link, .theme-toggle { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); transition: color 160ms ease, background 160ms ease; }
    .github-link:hover, .theme-toggle:hover { color: var(--text); background: var(--hover); }
    .github-link:focus-visible, .theme-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .github-link svg, .theme-toggle svg { width: 18px; height: 18px; }
    .theme-toggle { margin-left: -6px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .theme-toggle svg { display: none; }
    .theme-toggle[data-value="auto"] .icon-auto, .theme-toggle[data-value="light"] .icon-light, .theme-toggle[data-value="dark"] .icon-dark { display: block; }
    .switch { position: relative; display: block; width: 42px; height: 24px; }
    .switch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--switch); cursor: pointer; transition: 160ms ease; }
    .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: 160ms ease; }
    .switch input:checked + span { background: #fb7299; }
    .switch input:checked + span::after { transform: translateX(18px); }
    .switch input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 3px; }
    .mode-select { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .mode-select label { position: relative; }
    .mode-select input { position: absolute; opacity: 0; }
    .mode-select span { display: block; padding: 8px 6px; border-radius: 7px; color: var(--muted); background: transparent; font-size: 12px; text-align: center; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .mode-select input:not(:checked) + span:hover { color: var(--text); }
    .mode-select input:checked + span { color: #fff; background: #fb7299; }
    .mode-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-select { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px; margin-bottom: 8px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .takeover-select label { position: relative; }
    .takeover-select input { position: absolute; opacity: 0; }
    .takeover-select span { display: block; padding: 8px 6px; border-radius: 7px; color: var(--muted); background: transparent; font-size: 12px; text-align: center; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .takeover-select input:not(:checked) + span:hover { color: var(--text); }
    .takeover-select input:checked + span { color: #fff; background: #fb7299; }
    .takeover-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-note { margin: 0; padding: 0 2px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-hosts { margin-top: 8px; padding: 14px 16px; border-radius: 12px; background: var(--surface); }
    .custom-hosts[hidden] { display: none; }
    .custom-head { display: flex; align-items: center; justify-content: space-between; color: var(--label); font-size: 13px; }
    .custom-head b { min-width: 28px; padding: 2px 8px; border-radius: 5px; background: #fb7299; color: #fff; font-size: 12px; text-align: center; }
    .custom-note { margin: 8px 0 0; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-note[hidden] { display: none; }
    .host-group { min-width: 0; margin: 12px 0 0; padding: 10px 0 0; border: 0; border-top: 1px solid var(--divider); }
    .host-group legend { padding: 0 0 4px; color: var(--label); font-size: 12px; }
    .host-option { display: flex; align-items: center; gap: 7px; margin-top: 7px; color: var(--label); font-size: 11px; overflow-wrap: anywhere; cursor: pointer; }
    .host-option input { flex: none; width: 14px; height: 14px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .manual-host { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--label); font-size: 11px; overflow-wrap: anywhere; }
    .manual-host button { flex: none; width: 22px; height: 22px; padding: 0; border: 1px solid var(--control-border); border-radius: 4px; background: var(--hover); color: var(--button-text); font: inherit; line-height: 20px; cursor: pointer; }
    .host-form { display: flex; gap: 6px; margin-top: 10px; }
    .host-form input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--control-border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
    .host-form button { flex: none; padding: 6px 10px; border: 0; border-radius: 5px; background: #fb7299; color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .host-error { min-height: 0; margin: 6px 0 0; color: var(--error); font-size: 11px; }
    .host-error:empty { display: none; }
    .host-form input:focus-visible, .host-form button:focus-visible, .manual-host button:focus-visible, .host-option input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .controls { padding: 12px 16px; border-radius: 12px; background: var(--surface); }
    .control-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
    .control-title label { color: var(--label); font-size: 13px; }
    /* A switch row is pressed as a whole: it reaches to near the edge of its block, and its
       padding stands in for the space the rows used to keep between them. */
    .auto-row, .accel-row, .notice-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 -10px; padding: 6px 10px; border-radius: 6px; color: var(--label); font-size: 13px; cursor: pointer; transition: background 160ms ease; }
    .auto-row:hover, .accel-row:hover, .notice-row:hover { background: var(--hover); }
    .auto-row { margin-bottom: 7px; }
    .auto-row .switch, .accel-row .switch, .notice-row .switch { flex: none; }
    .row-text { display: flex; flex-direction: column; gap: 2px; }
    .auto-row small, .accel-row small { color: var(--subtle); font-size: 11px; }
    .controls.auto .slider, .controls.auto .scale { opacity: 0.4; pointer-events: none; }
    output { min-width: 42px; padding: 4px 8px; border-radius: 5px; color: #fff; background: #fb7299; font-size: 13px; font-weight: 700; text-align: center; }
    .slider { position: relative; width: 100%; height: 18px; border-radius: 9px; background: var(--track); }
    .slider-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 60%; border-radius: 9px; background: #fb7299; pointer-events: none; }
    input[type="range"] { position: absolute; inset: 0; width: 100%; height: 18px; margin: 0; appearance: none; -webkit-appearance: none; border: 0; outline: 0; background: transparent; cursor: pointer; }
    input[type="range"]::-webkit-slider-runnable-track { height: 18px; background: transparent; }
    input[type="range"]::-webkit-slider-thumb { width: 24px; height: 24px; margin-top: -3px; appearance: none; -webkit-appearance: none; border: 2px solid #fff; border-radius: 50%; background: #fff; }
    input[type="range"]:focus-visible::-webkit-slider-thumb { border-color: #fb7299; }
    .scale { display: flex; justify-content: space-between; margin-top: 5px; color: var(--subtle); font-size: 10px; }
    .scale span { width: 24px; text-align: center; }
    .scale span:first-child { text-align: left; }
    .scale span:last-child { text-align: right; }
    .accel-controls, .site-controls, .notice-controls, .interface-controls { padding: 5px 16px; border-radius: 12px; background: var(--surface); }
    .debug-filters { min-width: 0; margin: 9px 0 7px; padding: 12px 0 0; border: 0; border-top: 1px solid var(--divider); }
    .debug-filters[hidden] { display: none; }
    .debug-filters legend { padding: 0 0 4px; color: var(--label); font-size: 12px; }
    .debug-filter-actions { display: flex; gap: 8px; margin-bottom: 12px; }
    .debug-filter-actions button { padding: 4px 8px; border: 1px solid var(--control-border); border-radius: 4px; background: var(--hover); color: var(--button-text); font: inherit; font-size: 11px; cursor: pointer; }
    .debug-filter-actions button:hover, .manual-host button:hover { border-color: #fb7299; }
    .debug-filter-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 8px; }
    .debug-filter-options label { display: flex; align-items: center; gap: 7px; color: var(--label); font-size: 12px; cursor: pointer; }
    .debug-filter-options input { flex: none; width: 15px; height: 15px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .debug-filter-actions button:focus-visible, .debug-filter-options input:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .debug-copy { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
    .debug-copy button { padding: 6px 12px; border: 1px solid #fb7299; border-radius: 6px; background: var(--hover); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
    .debug-copy button:hover { background: #fb7299; }
    .debug-copy button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .debug-copy-status { color: var(--success); font-size: 12px; }
    .debug-copy-status.failed { color: var(--error); }
    .debug-copy-note { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .reset-settings { width: 100%; padding: 11px 16px; border: 0; border-radius: 12px; background: var(--surface); color: var(--label); font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .reset-settings:hover { background: var(--hover); }
    .reset-settings[data-asking] { color: var(--error); font-weight: 600; }
    .reset-settings:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .debug-copy-text { width: 100%; height: 120px; margin-top: 8px; padding: 6px; border: 1px solid var(--control-border); border-radius: 6px; background: var(--surface); color: var(--button-text); font: 11px/1.4 Consolas, monospace; resize: vertical; }
    .debug-copy-text[hidden] { display: none; }
    .run-state { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 16px; border-radius: 12px; background: var(--surface); color: var(--label); font-size: 13px; }
    .run-state b { color: var(--text); font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .btr-close { position: sticky; bottom: 12px; display: block; width: calc(100% - 36px); margin: 0 18px 16px; padding: 8px; border: 0; border-radius: 6px; background: #4a515e; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 -6px 12px var(--bg); }
    .btr-close:hover { background: #565e6c; }
    /* Solid, for the content scrolling under it. */
    .btr-popup[data-theme="light"] .btr-close { background: #dde1e8; color: #1f2329; }
    .btr-popup[data-theme="light"] .btr-close:hover { background: #d0d5de; }
    .btr-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .advanced > summary { display: block; padding: 14px 16px; border-radius: 12px; background: var(--surface); list-style: none; cursor: pointer; transition: background 160ms ease; }
    .advanced > summary::-webkit-details-marker { display: none; }
    .advanced > summary:hover { background: var(--hover); }
    .advanced > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .advanced-title { display: flex; align-items: center; justify-content: space-between; color: var(--label); font-size: 13px; }
    .advanced-title svg { flex: none; width: 16px; height: 16px; color: var(--muted); }
    .advanced > summary small { display: block; margin-top: 6px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .view-main, .tab-panel { display: grid; gap: 14px; align-content: start; min-width: 0; }
    .view-main { margin-bottom: 14px; }
    .tab-panel[hidden], [data-host-hidden] { display: none !important; }
    .block { min-width: 0; }
    .block-title { margin: 0 0 6px 2px; color: var(--subtle); font-size: 11px; font-weight: 600; line-height: 1.4; }
    .control-title small { display: block; margin-top: 2px; color: var(--subtle); font-size: 11px; }
    .buffer-controls .scale span { width: auto; }
    .buffer-controls .auto-row { margin: 10px -10px 0; }
    /* 高级设置 is a page of its own: its entry leads in, its bar back, and its tabs keep each
       part short enough for one screen. */
    main.is-advanced .view-main, main.is-advanced .advanced > summary { display: none; }
    .advanced > summary .advanced-title svg { transform: rotate(-90deg); }
    .page-bar { display: flex; align-items: center; gap: 4px; margin: -4px 0 12px -6px; }
    .page-back { display: grid; flex: none; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .page-back:hover { background: var(--hover); color: var(--text); }
    .page-back:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .page-back svg { width: 18px; height: 18px; transform: rotate(90deg); }
    .page-title { color: var(--text); font-size: 15px; font-weight: 600; }
    /* Further from what is under it than the blocks are from each other, so the tabs do not
       read as one more block of the page they switch. */
    .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 24px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .tabs button { padding: 7px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .tabs button:hover { color: var(--text); }
    .tabs button[aria-selected="true"] { background: var(--tab); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .12); }
    .tabs button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
    .host-option, .debug-filter-options label { border-radius: 4px; }
    .btr-popup { --ripple: rgba(251, 114, 153, .35); }
    .btr-popup[data-theme="light"] { --ripple: rgba(251, 114, 153, .3); }
    .mode-select input:checked + span, .takeover-select input:checked + span, .switch input:checked + span, .host-form button, .debug-copy button:hover { --ripple: rgba(255, 255, 255, .35); }
    ${RIPPLE_CSS}
  `;

  const LAUNCHER_CSS = `
    .btr-launcher { position: fixed; right: 76px; bottom: 116px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: #fb7299; color: #fff; font: 700 13px/1 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; letter-spacing: .3px; cursor: grab; opacity: .6; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); transition: opacity 160ms ease, transform 160ms ease, left 180ms ease, right 180ms ease; }
    .btr-launcher:hover, .btr-launcher:focus-visible { opacity: 1; transform: scale(1.06); }
    .btr-launcher:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .btr-launcher.dragging { cursor: grabbing; opacity: 1; transform: scale(1.1); transition: opacity 160ms ease, transform 160ms ease; }
    @media (max-width: 700px) { .btr-launcher { width: 40px; height: 40px; font-size: 12px; } }
    .btr-launcher { --ripple: rgba(255, 255, 255, .35); }
    .btr-launcher.guiding { opacity: 1; animation: btr-guide-pulse 1.6s ease-in-out infinite; }
    @keyframes btr-guide-pulse { 50% { transform: scale(1.14); } }
    @media (prefers-reduced-motion: reduce) { .btr-launcher.guiding { animation: none; } }
    ${RIPPLE_CSS}
  `;
  const GUIDE_CSS = `
    .btr-guide { position: fixed; inset: 0; background: rgba(0, 0, 0, .72); cursor: pointer; font: 16px/1.5 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
    .btr-guide p { position: absolute; left: 50%; top: 42%; margin: 0; color: #fff; font-size: 22px; white-space: nowrap; transform: translate(-50%, -50%); }
    .btr-guide b { color: #fb7299; font-weight: 700; }
    .btr-guide svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .btr-guide path { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    @media (max-width: 480px) { .btr-guide p { font-size: 17px; } }
  `;
  // The guide used to come back on every Bilibili subdomain: its record was in that site's
  // localStorage (#26). It is now in the stored settings (the script manager's, shared by all
  // subdomains), with a cookie on .bilibili.com for when those fall back to localStorage. Both
  // reach every subdomain, so 恢复默认设置 can take the record back everywhere.
  // The desktop client is one site, and it brings its cookies back by itself each time it
  // starts: there a cookie has nothing to do and could not be cleared.
  const GUIDE_COOKIE = "BTR.guideDone";
  function writeGuideCookie(value, seconds) {
    if (hostApp) return;
    try { document.cookie = `${GUIDE_COOKIE}=${value}; domain=.bilibili.com; path=/; max-age=${seconds}; SameSite=Lax; Secure`; } catch (_error) {}
  }
  function guideMarked() {
    if (hostApp) return false;
    try { return document.cookie.split("; ").includes(`${GUIDE_COOKIE}=1`); } catch (_error) { return false; }
  }
  const markGuide = () => writeGuideCookie("1", 315360000);
  const forgetGuide = () => writeGuideCookie("", 0);

  let current = null;
  // bridge.js sends the stored settings when they load or change, and the page its stats.
  let latestSettings = null;
  let latestStats = null;
  // The debug notices shown on this page, newest last, for the diagnostic copy.
  const noticeHistory = [];

  // Everything needed to look into a report, as text to paste into an issue. The page's own
  // reports already leave out download addresses and account data; any address that is left
  // is cut down to its host and path, so no signature or token goes along.
  function diagnostics() {
    const safely = (read) => { try { return read(); } catch (error) { return `读取失败：${String(error?.message || error)}`; } };
    const parse = (text) => { try { return JSON.parse(text); } catch (_error) { return text; } };
    const sections = [
      ["环境", {
        BTR: "2026.10.30.1-d2",
        渠道: CHANNEL_NAMES[SCRIPT_CHANNEL],
        同时启用: otherScript() ? CHANNEL_NAMES[otherScript()] || otherScript() : "没有",
        脚本管理器: document.documentElement?.getAttribute("data-btr-userscript-manager") || "未知",
        浏览器: navigator.userAgent,
        页面: `${location.origin}${location.pathname}`,
        时间: new Date().toISOString(),
        语言: navigator.language,
        窗口: `${root.innerWidth}x${root.innerHeight}`
      }],
      ["设置", latestSettings || "设置还没加载"]
    ];
    const video = root.__biliThreadRipperDebug;
    if (typeof video?.report === "function") sections.push(["视频接管", safely(() => parse(video.report()))]);
    const auto = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency;
    if (typeof auto?.status === "function") sections.push(["自动线程数", safely(() => auto.status())]);
    // The live player often sits in a live.bilibili.com iframe, where its module runs.
    const liveModules = [root, ...[...document.querySelectorAll("iframe")].map((frame) => safely(() => frame.contentWindow))]
      .map((view) => safely(() => view?.__biliThreadRipperLiveDebug)).filter((api) => api && typeof api.getStats === "function");
    liveModules.forEach((api, index) => sections.push([liveModules.length > 1 ? `直播模块 ${index + 1}` : "直播模块", safely(() => ({ stats: api.getStats(), context: api.getContext?.() }))]));
    sections.push(["最近的 Debug 提示", noticeHistory.length
      ? noticeHistory.map((item) => `${new Date(item.at).toISOString().slice(11, 19)} [${item.level}/${item.category}] ${item.title}${item.count > 1 ? ` ×${item.count}` : ""}${item.detail ? ` — ${item.detail}` : ""}`).join("\n")
      : "（还没有。打开 Debug 模式以后显示过的提示才会记在这里）"]);
    const text = sections.map(([title, value]) => `## ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`).join("\n\n");
    return text.replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1");
  }
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");

  function open(options = {}) {
    if (current) return;
    // A modal <dialog> sits in the browser's top layer and is the only interactive part of
    // the page while it is open. A plain fixed layer can end up under the page's own
    // top-layer elements, or inside a part of the page made inert, and then clicks on it
    // land on whatever is beneath (issue #8).
    const dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483646!important;";
    const dialogStyle = document.createElement("style");
    dialogStyle.textContent = `#${DIALOG_ID}::backdrop{background:transparent}`;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;";
    dialog.append(dialogStyle, host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS + (hostApp?.css || "");
    const backdrop = document.createElement("div");
    backdrop.className = "btr-backdrop";
    const panel = document.createElement("div");
    panel.className = "btr-popup";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "线程撕裂者设置");
    panel.tabIndex = -1;
    panel.innerHTML = PANEL_HTML;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "btr-close";
    closeButton.textContent = "关闭";
    panel.append(closeButton);
    shadow.append(style, backdrop, panel);

    const $ = (id) => shadow.getElementById(id);
    // The released script and the Canary are both switched on: only this one runs.
    const other = otherScript();
    if (other) {
      const alsoRunning = $("also-running");
      alsoRunning.textContent = `正式版和 Canary 同时启用了。现在生效的是${CHANNEL_NAMES[SCRIPT_CHANNEL]}，${CHANNEL_NAMES[other] || other}没有运行。请在脚本管理器里只启用一个。`;
      alsoRunning.hidden = false;
    }
    for (const selector of hostApp?.hide || []) {
      for (const node of panel.querySelectorAll(selector)) (node.closest(".block") || node).dataset.hostHidden = "";
    }
    if (hostApp?.projectUrl) $("github-link").href = hostApp.projectUrl;
    hostApp?.mount?.(panel);
    const advanced = $("advanced");
    const panelMain = panel.querySelector("main");
    const tabs = [...panel.querySelectorAll('[role="tab"]:not([data-host-hidden])')];
    const tabPanels = [...panel.querySelectorAll("[data-tab-panel]")];
    const still = () => root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const EASE = "cubic-bezier(.2, .8, .2, 1)";
    // The panel's height glides to what it shows next instead of jumping there.
    const resize = (change) => {
      const from = panel.offsetHeight;
      change();
      const to = panel.offsetHeight;
      if (still() || Math.abs(to - from) < 2) return;
      panel.style.overflow = "hidden";
      panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: EASE }).finished
        .finally(() => { panel.style.overflow = ""; }).catch(() => {});
    };
    const enter = (node, from) => {
      if (node && !still()) node.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], { duration: 240, easing: EASE });
    };
    let advancedTab = "network";
    const selectTab = (name) => {
      advancedTab = name;
      for (const tab of tabs) {
        tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
        tab.tabIndex = tab.dataset.tab === name ? 0 : -1;
      }
      for (const part of tabPanels) part.hidden = part.dataset.tabPanel !== name;
    };
    const showAdvanced = (show, animate = true) => {
      const change = () => {
        advanced.open = show;
        panelMain.classList.toggle("is-advanced", show);
      };
      if (!animate) return change();
      clearRipples(panel);
      resize(change);
      enter(panel.querySelector(show ? ".advanced-page" : ".view-main"), show ? "translateX(18px)" : "translateX(-18px)");
    };
    // The panel always opens on its first page; "自定义" in the gear menu opens it on the
    // custom servers, under 网络.
    selectTab("network");
    showAdvanced(options.advanced === true, false);
    advanced.querySelector("summary").addEventListener("click", (event) => {
      event.preventDefault();
      showAdvanced(true);
      // From the keyboard, the focus follows to the page's way back.
      if (event.detail === 0) $("advanced-back").focus();
    });
    $("advanced-back").addEventListener("click", (event) => {
      showAdvanced(false);
      if (event.detail === 0) advanced.querySelector("summary").focus();
    });
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        if (tab.dataset.tab === advancedTab) return;
        resize(() => selectTab(tab.dataset.tab));
        enter(tabPanels.find((part) => !part.hidden), "translateY(6px)");
      });
    }
    // The arrow keys go from tab to tab, as in any tab list.
    panel.querySelector(".tabs").addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(tabs.findIndex((tab) => tab.dataset.tab === advancedTab) + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
    // A press ripples over a whole switch row, the colored part of any other switch or of a
    // choice, otherwise over the control itself.
    panel.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target.closest(".auto-row, .accel-row, .notice-row")
        || event.target.closest("button, a[href], summary, .switch, .mode-select label, .takeover-select label, .host-option, .debug-filter-options label");
      if (!target || target.matches(":disabled")) return;
      ripple(target.matches(".switch, .mode-select label, .takeover-select label") ? target.querySelector("span") : target, event);
    });
    const enabled = $("enabled");
    const disabledNote = $("disabled-note");
    const needsEnabled = [...panel.querySelectorAll("[data-needs-enabled]")];
    const concurrency = $("concurrency");
    const autoConcurrency = $("auto-concurrency");
    const theme = $("theme");
    const systemTheme = root.matchMedia("(prefers-color-scheme: dark)");
    const systemColors = () => (systemTheme.matches ? "dark" : "light");
    const applyTheme = () => {
      panel.dataset.theme = theme.dataset.value === "auto" ? systemColors() : theme.dataset.value;
    };
    const showTheme = (value) => {
      theme.dataset.value = value;
      theme.title = `面板主题：${THEME_LABELS[value]}。点击切换`;
      theme.setAttribute("aria-label", theme.title);
      applyTheme();
    };
    systemTheme.addEventListener("change", applyTheme);
    const threadValue = $("thread-value");
    const sliderFill = $("slider-fill");
    const bufferAhead = $("buffer-ahead");
    const bufferValue = $("buffer-value");
    const bufferFill = $("buffer-fill");
    const secondaryBuffer = $("secondary-buffer");
    const errorNotices = $("error-notices");
    const debugNotices = $("debug-notices");
    const liveEnabled = $("live-enabled");
    const episodeEnabled = $("episode-enabled");
    const blockInternational = $("block-international");
    const floatingButton = $("floating-button");
    const debugFilters = $("debug-filters");
    const resetSettings = $("reset-settings");
    const debugCategoryInputs = [...shadow.querySelectorAll("[data-debug-category]")];
    const customSection = $("custom-hosts");
    const hostInput = $("host-input");
    const hostError = $("host-error");
    const activeCount = $("active-count");
    const totalSpeed = panel.querySelector(".run-speed");
    let customHosts = [];

    const save = (update) => post("settings-update", update);

    function setSlider(threads) {
      const index = THREAD_OPTIONS.indexOf(Number(threads));
      const safe = index < 0 ? 1 : index;
      concurrency.value = String(safe);
      // In the automatic mode the badge says so; the slider keeps the viewer's own count.
      threadValue.value = autoConcurrency.checked ? "自动" : String(THREAD_OPTIONS[safe]);
      concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
      sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
    }

    function setBufferSlider(seconds) {
      const index = BUFFER_OPTIONS.indexOf(Number(seconds));
      const safe = index < 0 ? 1 : index;
      bufferAhead.value = String(safe);
      bufferValue.value = `${BUFFER_OPTIONS[safe]}s`;
      bufferAhead.setAttribute("aria-valuetext", `${BUFFER_OPTIONS[safe]} 秒`);
      bufferFill.style.width = `${safe / (BUFFER_OPTIONS.length - 1) * 100}%`;
    }

    function setMode(mode) {
      for (const radio of shadow.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
      customSection.hidden = mode !== "custom";
    }

    function renderHosts() {
      $("custom-count").textContent = String(customHosts.length);
      $("custom-empty").hidden = customHosts.length > 0;
      const known = $("known-hosts");
      known.replaceChildren(...HOST_GROUPS.map(([title, hosts]) => {
        const group = document.createElement("fieldset");
        group.className = "host-group";
        const legend = document.createElement("legend");
        legend.textContent = title;
        group.append(legend, ...hosts.map((value) => {
          const label = document.createElement("label");
          label.className = "host-option";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = value;
          input.checked = customHosts.includes(value);
          const text = document.createElement("span");
          text.textContent = value;
          label.append(input, text);
          return label;
        }));
        return group;
      }));
      $("manual-hosts").replaceChildren(...customHosts.filter((value) => !KNOWN_HOSTS.includes(value)).map((value) => {
        const row = document.createElement("div");
        row.className = "manual-host";
        const text = document.createElement("span");
        text.textContent = value;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.remove = value;
        remove.textContent = "×";
        remove.setAttribute("aria-label", `删除 ${value}`);
        row.append(text, remove);
        return row;
      }));
    }

    function setCustomHosts(next) {
      customHosts = next;
      renderHosts();
      save({ customHosts });
    }

    function render(settings) {
      showTheme(settings.theme);
      enabled.checked = settings.enabled;
      disabledNote.hidden = settings.enabled !== false;
      panelMain.classList.toggle("is-off", settings.enabled === false);
      for (const node of needsEnabled) node.inert = settings.enabled === false;
      for (const radio of shadow.querySelectorAll('input[name="takeover"]')) radio.checked = radio.value === settings.takeover;
      autoConcurrency.checked = settings.autoConcurrency === true;
      setSlider(settings.concurrency);
      setBufferSlider(settings.bufferAheadSeconds);
      secondaryBuffer.checked = settings.secondaryBuffer === true;
      concurrency.disabled = autoConcurrency.checked;
      concurrency.closest(".controls").classList.toggle("auto", autoConcurrency.checked);
      setMode(settings.mode);
      customHosts = settings.customHosts;
      renderHosts();
      liveEnabled.checked = settings.liveEnabled === true;
      episodeEnabled.checked = settings.episodeEnabled !== false;
      blockInternational.checked = settings.blockInternational === true;
      floatingButton.checked = settings.floatingButton !== false;
      errorNotices.checked = settings.errorNotices;
      debugNotices.checked = settings.debugNotices;
      debugFilters.hidden = !settings.debugNotices;
      for (const input of debugCategoryInputs) input.checked = settings.debugCategories[input.dataset.debugCategory] !== false;
    }

    const saveDebugCategories = () => save({ debugCategories: Object.fromEntries(debugCategoryInputs.map((input) => [input.dataset.debugCategory, input.checked])) });
    enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
    // Each click goes on to the next choice: from 自动 to the colors the system is not showing,
    // then to the ones it is (now kept by hand), then back to 自动.
    theme.addEventListener("click", () => {
      const system = systemColors();
      const other = system === "dark" ? "light" : "dark";
      const current = theme.dataset.value;
      const next = current === "auto" ? other : current === other ? system : "auto";
      showTheme(next);
      save({ theme: next });
    });
    liveEnabled.addEventListener("change", () => save({ liveEnabled: liveEnabled.checked }));
    episodeEnabled.addEventListener("change", () => save({ episodeEnabled: episodeEnabled.checked }));
    blockInternational.addEventListener("change", () => save({ blockInternational: blockInternational.checked }));
    floatingButton.addEventListener("change", () => save({ floatingButton: floatingButton.checked }));
    concurrency.addEventListener("input", () => {
      const threads = THREAD_OPTIONS[Number(concurrency.value)];
      setSlider(threads);
      save({ concurrency: threads });
    });
    autoConcurrency.addEventListener("change", () => save({ autoConcurrency: autoConcurrency.checked }));
    bufferAhead.addEventListener("input", () => {
      const seconds = BUFFER_OPTIONS[Number(bufferAhead.value)];
      setBufferSlider(seconds);
      save({ bufferAheadSeconds: seconds });
    });
    secondaryBuffer.addEventListener("change", () => save({ secondaryBuffer: secondaryBuffer.checked }));
    for (const radio of shadow.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        setMode(radio.value);
        save({ mode: radio.value });
      });
    }
    for (const radio of shadow.querySelectorAll('input[name="takeover"]')) {
      radio.addEventListener("change", () => { if (radio.checked) save({ takeover: radio.value }); });
    }
    $("known-hosts").addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !KNOWN_HOSTS.includes(input.value)) return;
      if (input.checked && customHosts.length >= MAX_CUSTOM_HOSTS) {
        input.checked = false;
        hostError.textContent = `最多选 ${MAX_CUSTOM_HOSTS} 个服务器。`;
        return;
      }
      hostError.textContent = "";
      setCustomHosts(input.checked ? [...customHosts.filter((value) => value !== input.value), input.value] : customHosts.filter((value) => value !== input.value));
    });
    $("manual-hosts").addEventListener("click", (event) => {
      const value = event.target instanceof HTMLElement ? event.target.dataset.remove : "";
      if (value) setCustomHosts(customHosts.filter((item) => item !== value));
    });
    $("host-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const value = core.normalizeCdnHost(hostInput.value);
      if (!value) hostError.textContent = "这不是 B 站的视频服务器地址。";
      else if (customHosts.includes(value)) hostError.textContent = "这个服务器已经在列表里了。";
      else if (customHosts.length >= MAX_CUSTOM_HOSTS) hostError.textContent = `最多选 ${MAX_CUSTOM_HOSTS} 个服务器。`;
      else {
        hostError.textContent = "";
        hostInput.value = "";
        setCustomHosts([...customHosts, value]);
      }
    });
    // It asks in place: the second click is the answer, and going elsewhere takes the question back.
    let resetAsked = 0;
    const stopAsking = () => {
      root.clearTimeout(resetAsked);
      delete resetSettings.dataset.asking;
      resetSettings.textContent = "恢复默认设置";
    };
    resetSettings.addEventListener("click", () => {
      if (resetSettings.dataset.asking) {
        stopAsking();
        // Back to first use: the guide comes up again as soon as the panel is out of the way.
        forgetGuide();
        post("settings-reset");
        current?.close();
        return;
      }
      resetSettings.dataset.asking = "true";
      resetSettings.textContent = "确认？";
      resetAsked = root.setTimeout(stopAsking, 4000);
    });
    resetSettings.addEventListener("blur", stopAsking);
    errorNotices.addEventListener("change", () => save({ errorNotices: errorNotices.checked }));
    debugNotices.addEventListener("change", () => {
      debugFilters.hidden = !debugNotices.checked;
      save({ debugNotices: debugNotices.checked });
    });
    for (const input of debugCategoryInputs) input.addEventListener("change", saveDebugCategories);
    $("debug-select-all").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = true; saveDebugCategories(); });
    $("debug-select-none").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = false; saveDebugCategories(); });
    const copyStatus = $("debug-copy-status");
    const copyText = $("debug-copy-text");
    let copyStatusTimer = null;
    $("debug-copy").addEventListener("click", async () => {
      const text = diagnostics();
      let copied = false;
      try { await navigator.clipboard.writeText(text); copied = true; } catch (_error) {}
      if (!copied) {
        // Without the clipboard API (or its permission): select the text for the viewer.
        copyText.hidden = false;
        copyText.value = text;
        copyText.focus();
        copyText.select();
        try { copied = document.execCommand("copy"); } catch (_error) {}
      }
      copyStatus.classList.toggle("failed", !copied);
      copyStatus.textContent = copied ? "已复制" : "没能自动复制，请手动复制下面的内容";
      clearTimeout(copyStatusTimer);
      if (copied) copyStatusTimer = setTimeout(() => { copyStatus.textContent = ""; }, 2500);
    });

    // Keys typed into the panel belong to it. The shadow root hides the input from the page,
    // so the player's shortcuts (space, F, arrows) would otherwise react to them.
    const keepKeys = (event) => { if (event.key !== "Escape") event.stopPropagation(); };
    for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, keepKeys);

    // The threads and the speed now: asking for stats makes the page send fresh ones. The
    // numbers run to their new values instead of jumping there.
    const shown = { threads: 0, speed: 0 };
    let rollFrame = 0;
    const showRunState = (threads, speed) => {
      activeCount.textContent = String(Math.round(threads));
      totalSpeed.textContent = formatSpeed(speed);
    };
    const refresh = () => {
      const from = { ...shown };
      shown.threads = Math.max(0, Math.trunc(Number(latestStats?.activeThreads) || 0));
      shown.speed = Math.max(0, Number(latestStats?.totalSpeedBps) || 0);
      root.cancelAnimationFrame(rollFrame);
      if (still() || (from.threads === shown.threads && from.speed === shown.speed)) showRunState(shown.threads, shown.speed);
      else {
        const startedAt = performance.now();
        const roll = (now) => {
          if (current?.host !== host) return;
          const progress = Math.min(1, (now - startedAt) / 360);
          const eased = 1 - (1 - progress) ** 3;
          showRunState(from.threads + (shown.threads - from.threads) * eased, from.speed + (shown.speed - from.speed) * eased);
          if (progress < 1) rollFrame = root.requestAnimationFrame(roll);
        };
        rollFrame = root.requestAnimationFrame(roll);
      }
      post("get-stats");
    };
    const timer = setInterval(refresh, 400);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    // However the panel was found, the viewer has found it.
    launcher?.finishGuide();
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      clearInterval(timer);
      root.cancelAnimationFrame(rollFrame);
      systemTheme.removeEventListener("change", applyTheme);
      launcher?.apply();
      document.removeEventListener("keydown", onKey, true);
      clearRipples(panel);
      dialog.remove();
    };
    // Changes made elsewhere (the gear menu, another tab) arrive as new settings.
    current = { host, close, render };
    launcher?.apply();
    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    // Esc on a modal dialog closes it natively; clean up the same way as the button.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    (document.body || document.documentElement).append(dialog);
    try { dialog.showModal(); }
    catch (_error) { dialog.setAttribute("open", ""); }
    // Until bridge.js sends the stored settings, its defaults: 自动线程数 is on there, while
    // normalizeSettings on its own leaves it off.
    render(latestSettings || core.normalizeSettings({ autoConcurrency: true }));
    post("get-settings");
    refresh();
    panel.focus();
  }

  const toggle = () => (current ? current.close() : open());

  // The button in the corner of every bilibili page. The userscript manager's menu is not
  // obvious (and on the home page people do not find it at all), so the panel needs a way in
  // that is always visible.
  // It hides while the video is fullscreen, while the panel itself is open, and when 悬浮按钮
  // is switched off.
  const launcher = (() => {
    if (root.top !== root) return null;
    const MARGIN = 12;
    // How far a press has to travel before it counts as dragging rather than a click.
    const DRAG_SLOP = 4;
    // Let go this close to the left or right edge and it snaps flush to it; let go anywhere
    // else and it simply stays where it was put.
    const SNAP_PX = 72;
    let host = null;
    let button = null;
    let wanted = true;
    // Where the viewer left it, as shares of the window: 0 means stuck to the left edge, 1 to
    // the right edge, anything between is a free spot. null: never moved.
    let leftRatio = null;
    let topRatio = null;
    let dragging = null;
    // The first-run guide waits for the stored settings: before they arrive nobody knows
    // whether it was answered already.
    let guide = null;
    let guideAnswered = null;

    function finishGuide() {
      if (guideAnswered === true && !guide) return;
      guideAnswered = true;
      markGuide();
      post("settings-update", { guideDone: true });
      hideGuide();
    }

    function hideGuide() {
      if (!guide) return;
      root.cancelAnimationFrame(guide.frame);
      guide.host.remove();
      guide = null;
      button?.classList.remove("guiding");
    }

    // The arrow is drawn again on every frame, so it stays on the button however the button
    // or the window moves: from the edge of the text, curving, to just short of the button.
    function drawGuide() {
      if (!guide || !button?.isConnected) return;
      guide.frame = root.requestAnimationFrame(drawGuide);
      const target = button.getBoundingClientRect(), text = guide.text.getBoundingClientRect();
      const toX = target.left + target.width / 2, toY = target.top + target.height / 2;
      const fromX = text.left + text.width / 2, fromY = text.top + text.height / 2;
      const distance = Math.hypot(toX - fromX, toY - fromY) || 1;
      const unitX = (toX - fromX) / distance, unitY = (toY - fromY) / distance;
      // Where the line from the text's middle leaves its box.
      const leave = Math.min(unitX ? (text.width / 2 + 14) / Math.abs(unitX) : Infinity, unitY ? (text.height / 2 + 14) / Math.abs(unitY) : Infinity);
      const stop = target.width / 2 + 16;
      if (distance - leave - stop < 24) { guide.arrow.setAttribute("d", ""); return; }
      const startX = fromX + unitX * leave, startY = fromY + unitY * leave;
      const endX = toX - unitX * stop, endY = toY - unitY * stop;
      const bend = (distance - leave - stop) * .18;
      const bendX = (startX + endX) / 2 - unitY * bend, bendY = (startY + endY) / 2 + unitX * bend;
      const angle = Math.atan2(endY - bendY, endX - bendX);
      const barb = (side) => `${(endX - 15 * Math.cos(angle + side)).toFixed(1)} ${(endY - 15 * Math.sin(angle + side)).toFixed(1)}`;
      guide.arrow.setAttribute("d", `M${startX.toFixed(1)} ${startY.toFixed(1)} Q${bendX.toFixed(1)} ${bendY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)} M${barb(.5)} L${endX.toFixed(1)} ${endY.toFixed(1)} L${barb(-.5)}`);
    }

    function showGuide() {
      const guideHost = document.createElement("div");
      guideHost.id = GUIDE_ID;
      guideHost.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483644!important;";
      const shadow = guideHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = GUIDE_CSS;
      const cover = document.createElement("div");
      cover.className = "btr-guide";
      cover.innerHTML = '<p>点这里打开全新 <b>线程撕裂者</b> 设置</p><svg aria-hidden="true"><path></path></svg>';
      // A click anywhere on it counts: it is the only thing on the screen that can be clicked.
      cover.addEventListener("click", () => open());
      shadow.append(style, cover);
      (document.body || document.documentElement).append(guideHost);
      guide = { host: guideHost, text: cover.querySelector("p"), arrow: cover.querySelector("path"), frame: 0 };
      button.classList.add("guiding");
      drawGuide();
    }

    // Bilibili fills the screen in two ways: the browser fullscreen API, and its own 网页全屏,
    // which only resizes the player inside the page. Rather than follow Bilibili class names,
    // this asks the picture itself: a video that covers the window is a video being watched
    // full screen, whichever way it got there.
    const fullscreen = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen) return true;
      const width = root.innerWidth, height = root.innerHeight;
      if (!width || !height) return false;
      for (const video of document.querySelectorAll("video")) {
        const box = video.getBoundingClientRect();
        if (box.width >= width * 0.92 && box.height >= height * 0.92) return true;
      }
      return false;
    };

    const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

    // Puts it back where it was left. Without a saved spot it sits where it always did: to the
    // left of Bilibili's own column of round buttons, near the bottom.
    function place() {
      if (!button) return;
      const size = button.offsetHeight || 44;
      const width = root.innerWidth || 0, height = root.innerHeight || 0;
      if (leftRatio === null || topRatio === null) {
        button.style.top = `${Math.round(Math.max(MARGIN, height - size - 116))}px`;
        button.style.right = "76px";
        button.style.left = "auto";
        button.style.bottom = "auto";
        return;
      }
      button.style.top = `${Math.round(clamp(topRatio * height, MARGIN, Math.max(MARGIN, height - size - MARGIN)))}px`;
      button.style.bottom = "auto";
      if (leftRatio >= 1) {
        button.style.right = `${MARGIN}px`;
        button.style.left = "auto";
        return;
      }
      button.style.left = `${Math.round(clamp(leftRatio * width, MARGIN, Math.max(MARGIN, width - size - MARGIN)))}px`;
      button.style.right = "auto";
    }

    function startDrag(event) {
      if (event.button !== undefined && event.button !== 0) return;
      const box = button.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        grabX: event.clientX - box.left,
        grabY: event.clientY - box.top,
        fromX: event.clientX,
        fromY: event.clientY,
        moved: false
      };
      try { button.setPointerCapture(event.pointerId); } catch (_error) {}
    }

    function moveDrag(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      if (!dragging.moved && Math.hypot(event.clientX - dragging.fromX, event.clientY - dragging.fromY) < DRAG_SLOP) return;
      dragging.moved = true;
      button.classList.add("dragging");
      const size = button.offsetHeight || 44;
      const width = root.innerWidth, height = root.innerHeight;
      // Kept as numbers: where it lands is decided from these, not from a fresh layout
      // read, which the browser is free to postpone until the pointer is already up.
      dragging.left = Math.round(clamp(event.clientX - dragging.grabX, MARGIN, width - size - MARGIN));
      dragging.top = Math.round(clamp(event.clientY - dragging.grabY, MARGIN, height - size - MARGIN));
      dragging.size = size;
      button.style.left = `${dragging.left}px`;
      button.style.top = `${dragging.top}px`;
      button.style.right = "auto";
      event.preventDefault();
    }

    function endDrag(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      const { moved, left = 0, top = 0, size = 44 } = dragging;
      try { button.releasePointerCapture(dragging.pointerId); } catch (_error) {}
      dragging = null;
      button.classList.remove("dragging");
      if (!moved) return;
      // Dropped within reach of the left or right edge: snap flush to it, and remember the
      // edge rather than the pixel, so it stays there whatever the window size. Dropped
      // anywhere else: it stays exactly where it was put.
      const width = root.innerWidth || 1;
      if (left <= SNAP_PX) leftRatio = 0;
      else if (left + size >= width - SNAP_PX) leftRatio = 1;
      else leftRatio = clamp(left / width, 0, 1);
      topRatio = clamp(top / (root.innerHeight || 1), 0, 1);
      place();
      post("settings-update", { floatingButtonLeft: leftRatio, floatingButtonTop: topRatio });
    }

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement("div");
      host.id = LAUNCHER_ID;
      host.style.cssText = "all:initial!important;position:fixed!important;right:0!important;bottom:0!important;width:0!important;height:0!important;z-index:2147483645!important;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = LAUNCHER_CSS;
      button = document.createElement("button");
      button.type = "button";
      button.className = "btr-launcher";
      button.title = "线程撕裂者设置（可以拖动）";
      button.setAttribute("aria-label", "线程撕裂者设置");
      button.textContent = "BTR";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A drag that ended on the button itself must not also open the panel.
        if (button.dataset.dragged === "true") {
          button.dataset.dragged = "";
          return;
        }
        toggle();
      });
      button.addEventListener("pointerdown", (event) => {
        if (event.button === 0) ripple(button, event);
        startDrag(event);
      });
      button.addEventListener("pointermove", moveDrag);
      for (const type of ["pointerup", "pointercancel"]) {
        button.addEventListener(type, (event) => {
          const moved = Boolean(dragging?.moved);
          endDrag(event);
          if (moved) button.dataset.dragged = "true";
        });
      }
      shadow.append(style, button);
      (document.body || document.documentElement).append(host);
      place();
    }

    function apply() {
      const show = wanted && !fullscreen() && !current;
      if (!show) {
        hideGuide();
        host?.remove();
        return;
      }
      // Bilibili replaces large parts of the page when you navigate; mount puts it back if it went.
      mount();
      if (!dragging) place();
      if (guide && !(guide.host.isConnected && button.isConnected)) hideGuide();
      if (guideAnswered === false && !guide) showGuide();
    }

    const update = (settings) => {
      wanted = settings?.floatingButton !== false;
      // null (never dragged) must stay null: Number(null) is 0, which would pin it to a corner.
      const ratio = (value) => (value != null && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null);
      leftRatio = ratio(settings?.floatingButtonLeft);
      topRatio = ratio(settings?.floatingButtonTop);
      if (settings?.guideDone === true) {
        guideAnswered = true;
        markGuide();
        hideGuide();
      } else if (guideMarked()) {
        // Answered on another subdomain or before the stored settings could take it.
        guideAnswered = false;
        finishGuide();
      } else guideAnswered = false;
      apply();
    };
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(type, apply, true);
    root.addEventListener("resize", apply);
    // A page that swaps its body (the SPA navigations) drops the button with it.
    setInterval(apply, 2000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    // The button is on by default, so it is there before the stored settings arrive.
    apply();
    return { update, apply, finishGuide };
  })();

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      latestSettings = core.normalizeSettings(event.data.payload);
      launcher?.update(latestSettings);
      current?.render(latestSettings);
    } else if (event.data.type === "stats") {
      latestStats = event.data.payload;
    } else if (event.data.type === "debug-notices") {
      for (const item of [].concat(event.data.payload || [])) {
        noticeHistory.push({ at: Number(item?.at) || Date.now(), level: String(item?.level || "info"), category: String(item?.category || "other"), title: String(item?.title || ""), detail: String(item?.detail || ""), count: Number(item?.count) || 1 });
        if (noticeHistory.length > 100) noticeHistory.shift();
      }
    } else if (event.data.type === "open-settings" && root.top === root) {
      // "自定义" in the gear menu: the custom servers are under 高级设置.
      open({ advanced: true });
    }
  });
  // The userscript manager's menu entry.
  document.addEventListener("btr-userscript-open-settings", () => { if (root.top === root) toggle(); });

  // Settings sent before this file ran went unheard.
  post("get-settings");

  root.__BTR_SETTINGS_PANEL__ = Object.freeze({ open, close: () => current?.close(), toggle, isOpen: () => Boolean(current) });
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
    // The servers of the custom mode are picked in the settings panel; this menu is too small for the list.
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
        ? `已选 ${settings.customHosts.length} 个服务器，点 BTR 悬浮球，在“高级设置”里增减。`
        : "还没选服务器，暂时按大陆 CDN 下载。点 BTR 悬浮球，在“高级设置”里选择。";
    });
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(mount); } });
  observer.observe(document.documentElement, {childList:true,subtree:true});
  root.addEventListener("pagehide", () => { observer.disconnect(); unsubscribe?.(); }, {once:true});
  mount();
})(globalThis);


/* src/settings-view.js */
(function (root) {
  "use strict";
  // The client's own settings page keeps a short section. The floating button can be switched
  // off, so this is the way back to it and to the panel; the rest of the settings are the panel's.
  const api = root.__BTR_DESKTOP__;
  let panel, navButton, unsubscribe, unsubscribeUpdate, scheduled = false;
  const style = document.createElement("style");
  style.textContent = `
    #btr-desktop-settings{padding:24px 0;border-bottom:1px solid var(--line_regular,#303133);color:var(--text1,#d8dce2);font:inherit}
    #btr-desktop-settings h4{margin:0 0 20px;font-size:16px}#btr-desktop-settings .btr-version{margin-left:12px;color:var(--text3,#9499a0);font-size:12px;font-weight:400}
    #btr-desktop-settings .btr-row{display:flex;align-items:center;gap:16px;margin:16px 0;flex-wrap:wrap}
    #btr-desktop-settings button{border:1px solid var(--line_regular,#353638);border-radius:5px;background:var(--bg3,#252729);color:inherit;padding:7px 15px;font:inherit;cursor:pointer}
    #btr-desktop-settings #btr-desktop-uninstall{background:#b93843;border-color:#d14c57;color:#fff}
    #btr-desktop-settings #btr-desktop-uninstall:hover:not(:disabled){background:#d04450}
    #btr-desktop-settings button:disabled{opacity:.55;cursor:default}
    #btr-desktop-settings input{accent-color:#d45b88}#btr-desktop-settings input[type=checkbox]{width:16px;height:16px;vertical-align:middle;margin:0 8px 0 0}
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
        <div class="btr-row"><label><input type="checkbox" data-setting="floatingButton">BTR 悬浮窗</label></div>
        <div class="btr-row"><button type="button" id="btr-desktop-open-panel">打开 BTR 设置</button></div>
        <div class="btr-row"><label><input type="checkbox" data-setting="autoCheckUpdates">自动检查 BTR 更新</label></div>
        <div class="btr-row"><button type="button" id="btr-desktop-check-update">检查 BTR 更新</button><button type="button" id="btr-desktop-uninstall">卸载 BTR</button><button type="button" id="btr-desktop-install-update" hidden>安装更新</button></div>
        <div class="btr-note btr-update-status" role="status"></div><div class="btr-note btr-save-error" role="status"></div>`;
      general.before(panel);
      panel.addEventListener("change", event => {
        const input = event.target;
        if (!input.dataset.setting) return;
        try { api.setSettings({ [input.dataset.setting]: input.checked }); panel.querySelector(".btr-save-error").textContent = ""; }
        catch (_) { panel.querySelector(".btr-save-error").textContent = "设置保存失败，请检查客户端的数据目录是否可写。"; }
      });
      panel.addEventListener("click", event => {
        const button = event.target.closest("button"); if (!button) return;
        if (button.id === "btr-desktop-open-panel") root.__BTR_SETTINGS_PANEL__.open();
        // Installing and uninstalling are started by the preload, which only trusts real clicks.
        if (button.id === "btr-desktop-check-update") api.checkUpdate();
      });
      unsubscribe = api.onSettings(settings => {
        panel.querySelectorAll("[data-setting]").forEach(x => { x.checked = settings[x.dataset.setting]; });
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

