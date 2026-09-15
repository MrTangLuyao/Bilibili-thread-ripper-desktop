"use strict";
const { evaluate } = require("./inspect-client.cjs");
(async () => {
  const pages = await (await fetch("http://127.0.0.1:19391/json/list", {signal:AbortSignal.timeout(5000)})).json();
  const page = pages.find(p => p.type === "page" && p.url.startsWith("https://bilipc.bilibili.com/player.html"));
  if (!page) throw Error("Client player page not found");
  const count = Math.min(60, Math.max(2, Number(process.argv[2]) || 12));
  for (let i = 0; i < count; i++) {
    const data = await evaluate(page, `JSON.stringify({at:Date.now(),...window.__BTR_DESKTOP__?.getStatus?.()})`);
    console.log(data);
    if (i + 1 < count) await new Promise(resolve => setTimeout(resolve, 1000));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
