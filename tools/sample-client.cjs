"use strict";
const fs = require("node:fs"), path = require("node:path");
const { evaluate } = require("./inspect-client.cjs");
(async () => {
  const label = process.argv[2] || "sample";
  if (!/^[a-z0-9-]+$/.test(label)) throw Error("Unsafe sample label");
  const count = Math.min(60, Math.max(2, Number(process.argv[3]) || 15));
  const pages = await (await fetch("http://127.0.0.1:19391/json/list", {signal:AbortSignal.timeout(5000)})).json();
  const page = pages.find(p => p.type === "page" && p.url.startsWith("https://bilipc.bilibili.com/player.html"));
  if (!page) throw Error("Client player page not found");
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(JSON.parse(await evaluate(page, `JSON.stringify({at:Date.now(),...window.__BTR_DESKTOP__?.getStatus?.()})`)));
    if (i + 1 < count) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const dir = path.resolve(__dirname, "../test-output"); fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(samples, null, 2));
  console.log(JSON.stringify({label, count, first:samples[0], last:samples.at(-1), routes:[...new Set(samples.map(s=>s.transport?.route))], errors:samples.filter(s=>s.playback?.error).length, lowReady:samples.filter(s=>s.playback && s.playback.readyState<3).length}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
