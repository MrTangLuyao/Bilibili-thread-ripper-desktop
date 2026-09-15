"use strict";
// Electron 22 embeds Node 16, which does not provide fetch by default.
const https = require("node:https");
module.exports = function fetchSmallJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal: options.signal, headers: { Accept: "application/json", "User-Agent": "BTR-Desktop-update-check" } }, response => {
      const code = response.statusCode;
      if (code >= 300 && code < 400) { response.resume(); reject(Error("Update redirects are not allowed")); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 65536) { response.destroy(Error("Update manifest too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ok:code >= 200 && code < 300,status:code,text:async()=>Buffer.concat(chunks).toString("utf8")}));
    });
    request.on("error", reject);
  });
};
