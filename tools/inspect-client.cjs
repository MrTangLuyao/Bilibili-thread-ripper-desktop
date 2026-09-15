"use strict";
// Local development diagnostics only. Never launched by the installed adapter.
async function evaluate(page, expression) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Diagnostic timeout")), 8000);
      socket.onmessage = event => {
        const data = JSON.parse(event.data); if (data.id !== 1) return;
        clearTimeout(timer);
        if (data.error || data.result.exceptionDetails) reject(Error(JSON.stringify(data.error || data.result.exceptionDetails)));
        else resolve(data.result.result.value);
      };
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally { socket.close(); }
}
async function main() {
  const pages = await (await fetch("http://127.0.0.1:19391/json/list", { signal: AbortSignal.timeout(5000) })).json();
  const expression = `JSON.stringify({page:location.pathname,btr:!!window.__BTR_DESKTOP__,nano:!!window.nano,player:!!window.biliPlayer,status:window.__BTR_DESKTOP__?.getStatus?.(),settingsSection:!!document.querySelector('#btr-desktop-settings')})`;
  for (const page of pages.filter(p => p.type === "page" && /^https:\/\/bilipc\.bilibili\.com\//.test(p.url))) {
    console.log(await evaluate(page, expression));
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { evaluate };
