"use strict";
// Add an ordinary Electron preload. Do not modify the official update cache,
// disable integrity checks, or weaken renderer isolation / web security.
const { app, session } = require("electron");
const path = require("path");
const fs = require("fs");
try { require("./update-main.cjs").register(require("electron")); }
catch (error) { console.error("BTR update initialization:", error.message); }
const preload = path.join(__dirname, "preload.cjs");
const supported = ["1.18.0"];
function attach(target) {
  // The desktop updater may replace the renderer independently of the EXE.
  // Refuse unknown cached builds instead of blindly injecting into them.
  try {
    const versionPath = path.join(app.getPath("appData"), "bilibili", "resource", ".version");
    if (fs.existsSync(versionPath) && !supported.includes(fs.readFileSync(versionPath, "utf8").trim())) {
      console.warn("BTR: updated client is not yet supported; leaving native playback unchanged"); return;
    }
  } catch (error) { console.warn("BTR: cannot verify client cache", error.message); return; }
  const existing = target.getPreloads();
  if (!existing.includes(preload)) target.setPreloads([...existing, preload]);
}
app.on("session-created", attach);
app.whenReady().then(() => attach(session.defaultSession)).catch(error => console.error("BTR preload:", error.message));
