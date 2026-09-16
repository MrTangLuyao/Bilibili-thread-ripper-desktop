"use strict";
// Add an ordinary Electron preload. Do not modify the official update cache,
// disable integrity checks, or weaken renderer isolation / web security.
// Official hot updates replace only the cached app under %APPDATA%, never this entry,
// so BTR keeps loading on every client version. The preload itself ignores pages it
// does not recognize, and page code only mounts where the expected elements exist.
const { app, session } = require("electron");
const path = require("path");
try {
  const maintenance = require("./update-main.cjs");
  maintenance.register(require("electron"));
  app.whenReady().then(() => maintenance.startGuard()).catch(error => console.error("BTR guard:", error.message));
} catch (error) { console.error("BTR update initialization:", error.message); }
const preload = path.join(__dirname, "preload.cjs");
function attach(target) {
  try {
    const existing = target.getPreloads();
    if (!existing.includes(preload)) target.setPreloads([...existing, preload]);
  } catch (error) { console.error("BTR preload:", error.message); }
}
app.on("session-created", attach);
app.whenReady().then(() => attach(session.defaultSession)).catch(error => console.error("BTR preload:", error.message));
