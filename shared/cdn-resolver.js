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
    if (!GLOBAL_HOSTS.includes(host)) return null;
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

  function representationUrls(representation, mode) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
      .map(safeMediaUrl)
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const hosts = mode === "mainland" ? MAINLAND_HOSTS : OVERSEAS_HOSTS;
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
    const allowedOriginals = mode === "mainland"
      ? originals.filter((url) => MAINLAND_HOSTS.includes(new URL(url).hostname.toLowerCase()))
      : originals.filter((url) => !MAINLAND_HOSTS.includes(new URL(url).hostname.toLowerCase()));
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

  function createResolver(representation, getMode, bans = null) {
    const health = new Map();
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.() === "overseas" ? "overseas" : "mainland");
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
      const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
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
