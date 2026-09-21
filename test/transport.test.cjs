"use strict";
// The adapter's transport (src/transport.js) on top of the shared download core, without a
// browser: the requests the client makes, the way it makes them. What test/browser.cjs cannot
// do is decide how a node behaves byte by byte: slow, stalling, or never answering.
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const HOSTS = ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com"];
const KB = 1024, MB = 1024 * KB;
const address = (file, signature = "1") => `https://${HOSTS[0]}/upgcxcode/${file}.m4s?deadline=9999999999&sig=${signature}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const rangeOf = init => /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get("range")).slice(1).map(Number);
const pattern = (start, size) => Uint8Array.from({ length: size }, (_, i) => (start + i) % 251);
const partial = (start, end, body = pattern(start, end - start + 1)) => new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${64 * MB}` } });
// A response that never sends anything and ends when the request is cancelled.
const silent = (start, end, init) => partial(start, end, new ReadableStream({ start(controller) {
  init.signal.addEventListener("abort", () => { try { controller.error(init.signal.reason); } catch (_) {} }, { once: true });
} }));
class ProgressEvent extends Event { constructor(type, init = {}) { super(type); Object.assign(this, init); } }

function setup(nativeFetch, { concurrency = 8, hosts = HOSTS } = {}) {
  const fallbacks = [];
  class NativeXHR extends EventTarget {
    open() {} setRequestHeader() {} abort() {} send() { fallbacks.push("xhr"); }
    get readyState() { return 1; } get status() { return 0; } get response() { return null; }
  }
  const context = vm.createContext({ URL, AbortController, DOMException, Response, Headers, ReadableStream, Uint8Array, Promise, setTimeout, clearTimeout, performance, console, Event, EventTarget, ProgressEvent,
    XMLHttpRequest: NativeXHR, location: new URL("https://bilipc.bilibili.com/player.html"),
    fetch: (input, init) => nativeFetch(String(input), init || {}) });
  context.globalThis = context;
  // The resolver's clock, so a test can let a speed measurement go stale.
  context.__now = Date.now();
  vm.runInContext("Date.now = () => globalThis.__now;", context);
  const api = context.__BTR_DESKTOP__ = { getSettings: () => ({ enabled: true, mode: "custom", concurrency, customHosts: [...hosts] }) };
  for (const file of ["shared/range-core.js", "shared/cdn-resolver.js", "shared/idm-downloader.js", "src/transport.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return { context, api, fallbacks, advance(ms) { context.__now += ms; }, idle() { const s = api.transport.snapshot(); return s.activeThreads === 0 && s.pending === 0; } };
}
async function fetchRange(context, url, start, size, signal) {
  const response = await context.fetch(url, { headers: { Range: `bytes=${start}-${start + size - 1}` }, signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, size);
  assert.ok(bytes.every((value, i) => value === (start + i) % 251), "the client gets exactly the bytes it asked for");
}
// The first two accelerated requests of a window take the start-up path; tests of ordinary
// requests get them out of the way first.
async function warm(context) { for (let i = 0; i < 2; i++) await fetchRange(context, address("warm"), i * KB, KB); }
// Requests the way the client's player makes them: a few in flight, the next as one ends.
async function inFlight(count, width, start) {
  const pending = new Map(); let next = 0;
  for (let head = 0; head < count; head++) {
    while (next < count && next < head + width) { const index = next++; pending.set(index, start(index)); }
    await pending.get(head); pending.delete(head);
  }
}

for (const concurrency of [8, 32]) {
  test(`a run of small requests takes the nodes in turns (${concurrency} threads)`, { timeout: 60000 }, async () => {
    const counts = new Map();
    const { context, api, fallbacks, idle } = setup(async (url, init) => {
      const [start, end] = rangeOf(init), host = new URL(url).hostname;
      if (!url.includes("warm")) { const key = `${new URL(url).pathname.includes("sound") ? "sound" : "picture"} ${host}`; counts.set(key, (counts.get(key) || 0) + 1); }
      await wait(15);
      if (init.signal?.aborted) throw init.signal.reason;
      return partial(start, end);
    }, { concurrency });
    try {
      await warm(context);
      // Sound and picture, each a run of 96 KiB requests on its own address, three at a time.
      await Promise.all(["sound", "picture"].map(file => inFlight(24, 3, index => fetchRange(context, address(file), 2 * MB + index * 96 * KB, 96 * KB))));
      for (const track of ["sound", "picture"]) {
        const used = HOSTS.map(host => counts.get(`${track} ${host}`) || 0);
        assert.ok(Math.min(...used) >= 4, `${track}: every node takes its turn: ${used.join("/")}`);
        assert.ok(Math.max(...used) <= 10, `${track}: and none carries the run alone: ${used.join("/")}`);
      }
      assert.equal(fallbacks.length, 0); assert.equal(api.transport.snapshot().fallbackRequests, 0); assert.ok(idle());
    } finally { api.transport.restore(); }
  });
}

test("a node far slower than the others drops out of the turns once it is measured, and comes back when it has recovered", { timeout: 60000 }, async () => {
  const SLOW = HOSTS[1], counts = new Map();
  let slowMs = 400;
  const { context, api, advance, idle } = setup(async (url, init) => {
    const [start, end] = rangeOf(init), host = new URL(url).hostname;
    if (!url.includes("warm")) counts.set(host, (counts.get(host) || 0) + 1);
    await wait(host === SLOW ? slowMs : 5);
    if (init.signal?.aborted) throw init.signal.reason;
    return partial(start, end);
  });
  try {
    await warm(context);
    await inFlight(32, 3, index => fetchRange(context, address("slow-node"), 2 * MB + index * 96 * KB, 96 * KB));
    const slow = counts.get(SLOW) || 0, others = HOSTS.filter(host => host !== SLOW).map(host => counts.get(host) || 0);
    assert.ok(slow >= 1 && slow <= 4, `the slow node was tried, then left alone: ${slow} of ${slow + others.reduce((a, b) => a + b, 0)} requests`);
    assert.ok(Math.min(...others) >= 7, `the others share the rest: ${others.join("/")}`);
    // Ninety seconds on its measurement is stale, and the node has recovered meanwhile: it
    // gets another try and then takes its turns like the others.
    advance(91000); slowMs = 5; counts.clear();
    await inFlight(32, 3, index => fetchRange(context, address("slow-node"), 8 * MB + index * 96 * KB, 96 * KB));
    const back = counts.get(SLOW) || 0;
    assert.ok(back >= 5, `the recovered node is back in the turns: ${back} of 32 requests`);
    assert.ok(idle());
  } finally { api.transport.restore(); }
});

test("64 KiB, 128 KiB and a request from byte 0 keep their own paths and stay exact", { timeout: 60000 }, async () => {
  const requests = [];
  const { context, api, fallbacks, idle } = setup(async (url, init) => {
    const [start, end] = rangeOf(init);
    requests.push({ file: new URL(url).pathname, host: new URL(url).hostname, length: end - start + 1 });
    return partial(start, end);
  });
  try {
    await warm(context);
    const of = file => requests.filter(item => item.file.includes(file));
    await fetchRange(context, address("edge-64"), 4 * MB, 64 * KB);
    assert.ok(of("edge-64").every(item => item.length === 64 * KB), "64 KiB is fetched whole, as video information");
    await fetchRange(context, address("edge-65"), 4 * MB, 64 * KB + 1);
    assert.equal(of("edge-65").length, 1, "just above 64 KiB is one piece on one node");
    await fetchRange(context, address("edge-127"), 4 * MB, 128 * KB - 1);
    assert.equal(of("edge-127").length, 1, "just under 128 KiB is still one piece");
    await fetchRange(context, address("edge-128"), 4 * MB, 128 * KB);
    assert.ok(of("edge-128").length >= 2, "128 KiB is split again");
    await fetchRange(context, address("edge-start"), 0, 96 * KB);
    assert.ok(of("edge-start").some(item => item.length === 64 * KB), "a request from byte 0 starts with the 64 KiB probe");
    assert.equal(fallbacks.length, 0); assert.equal(api.transport.snapshot().fallbackRequests, 0); assert.ok(idle());
  } finally { api.transport.restore(); }
});

test("requests cancelled while queued, while a piece is being resumed, and by an XHR timeout leave no thread behind", { timeout: 60000 }, async () => {
  let interrupt = false;
  const { context, api, idle } = setup(async (url, init) => {
    const [start, end] = rangeOf(init);
    if (url.includes("warm")) return partial(start, end);
    if (interrupt && new URL(url).hostname === HOSTS[0] && end - start + 1 > 64 * KB) {
      // Sends 64 KiB, then the connection breaks: the rest is asked of another node, which stays silent.
      let sent = false;
      return partial(start, end, new ReadableStream({ pull(controller) {
        if (sent) { controller.error(new Error("connection interrupted")); return; }
        sent = true; controller.enqueue(pattern(start, 64 * KB));
      } }));
    }
    return silent(start, end, init);
  }, { concurrency: 4, hosts: HOSTS.slice(0, 2) });
  try {
    await warm(context);
    // Twelve 512 KiB requests on four threads: most of their pieces are still queued.
    const queued = new AbortController();
    const waiting = Array.from({ length: 12 }, (_, index) => fetchRange(context, address("queued"), MB + index * MB, 512 * KB, queued.signal).then(() => "completed", error => error.name));
    await wait(40); queued.abort(new DOMException("cancelled by the client", "AbortError"));
    assert.ok((await Promise.all(waiting)).every(result => result === "AbortError"));
    await wait(30); assert.ok(idle(), "queued and running pieces are gone after the cancel");

    interrupt = true;
    const resuming = new AbortController();
    const broken = fetchRange(context, address("resume"), 8 * MB, 96 * KB, resuming.signal).then(() => "completed", error => error.name);
    await wait(120); resuming.abort(new DOMException("cancelled by the client", "AbortError"));
    assert.equal(await broken, "AbortError");
    await wait(30); assert.ok(idle(), "a piece that was being resumed is gone after the cancel");
    interrupt = false;

    const timedOut = await new Promise(resolve => {
      const x = new context.XMLHttpRequest(), events = [];
      x.open("GET", address("timeout")); x.responseType = "arraybuffer"; x.timeout = 80;
      x.setRequestHeader("Range", `bytes=${16 * MB}-${16 * MB + 512 * KB - 1}`);
      for (const type of ["timeout", "load", "error", "abort", "loadend"]) x.addEventListener(type, () => { events.push(type); if (type === "loadend") resolve(events); });
      x.send();
    });
    assert.deepEqual(timedOut, ["timeout", "loadend"]);
    await wait(30); assert.ok(idle(), "an XHR that timed out gives its threads back");
    const s = api.transport.snapshot();
    assert.equal(s.fallbackRequests, 0); assert.equal(s.bannedHosts.length, 0); assert.equal(s.timedOutRequests, 1);
  } finally { api.transport.restore(); }
});

test("after the client gets freshly signed addresses the old requests end and the new ones complete", { timeout: 60000 }, async () => {
  const seen = [];
  const { context, api, fallbacks, idle } = setup(async (url, init) => {
    const [start, end] = rangeOf(init), signature = new URL(url).searchParams.get("sig");
    if (url.includes("warm")) return partial(start, end);
    seen.push(signature);
    return signature === "old" ? silent(start, end, init) : partial(start, end);
  });
  try {
    await warm(context);
    const old = new AbortController();
    const stale = Array.from({ length: 4 }, (_, index) => fetchRange(context, address("resigned", "old"), MB + index * MB, 512 * KB, old.signal).then(() => "completed", error => error.name));
    await wait(40); old.abort(new DOMException("the client dropped the old address", "AbortError"));
    assert.ok((await Promise.all(stale)).every(result => result === "AbortError"));
    const before = seen.length;
    await Promise.all(Array.from({ length: 4 }, (_, index) => fetchRange(context, address("resigned", "new"), MB + index * MB, 512 * KB)));
    assert.ok(seen.slice(before).every(signature => signature === "new"), "nothing is asked of the old address any more");
    await wait(30);
    assert.equal(fallbacks.length, 0); assert.equal(api.transport.snapshot().fallbackRequests, 0); assert.ok(idle());
  } finally { api.transport.restore(); }
});
