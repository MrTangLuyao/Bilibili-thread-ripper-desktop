"use strict";
const RAW = "https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/";
const VERSION = /^\d+\.\d+\.\d+\.\d+-d[1-9]\d*$/;
function validateManifest(value) {
  if (!value || value.schema !== 1 || !VERSION.test(value.version)) throw Error("Invalid desktop version manifest");
  if (!/^[a-f0-9]{64}$/i.test(value.sha256)) throw Error("Invalid update checksum");
  // Only d1-d4 updaters read supportedClientVersions. Validate it when present, never require it.
  const legacy = value.supportedClientVersions;
  if (legacy !== undefined && (!Array.isArray(legacy) || !legacy.every(v => /^\d+(\.\d+){2,3}$/.test(v)))) throw Error("Invalid legacy client list");
  if (value.downloadUrl !== `${RAW}packages/BTR_Desktop-${value.version}.zip`) throw Error("Update package must belong to this repository");
  return {schema:1,version:value.version,sha256:value.sha256.toLowerCase(),downloadUrl:value.downloadUrl};
}
async function check(config, installed, fetchImpl = globalThis.fetch || require("./https-json.cjs")) {
  if (!config.enabled) return {state:"not-configured",message:"更新检查已关闭"};
  if (config.manifestUrl !== RAW + "latest.json") throw Error("Unexpected update manifest URL");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(config.manifestUrl + "?t=" + Date.now(), {signal:controller.signal,redirect:"error",credentials:"omit",cache:"no-store"});
    if (!response.ok) throw Error(`更新检查失败，HTTP ${response.status}`);
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { for (;;) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>65536){await reader.cancel();throw Error("Update manifest too large");} chunks.push(Buffer.from(value)); } text=Buffer.concat(chunks,size).toString("utf8"); }
      finally { reader.releaseLock(); }
    } else text = await response.text();
    if (Buffer.byteLength(text) > 65536) throw Error("Update manifest too large");
    const manifest = validateManifest(JSON.parse(text));
    const different = manifest.version !== installed.version;
    return {state:different?"available":"current",manifest,message:different?`发现 ${manifest.version}`:"当前已是最新版本"};
  } finally { clearTimeout(timer); }
}
module.exports = {check,validateManifest,RAW,VERSION};
