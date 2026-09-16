"use strict";
const path = require("node:path"), fs = require("node:fs"), { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(compiler)) throw Error("Windows .NET Framework C# compiler was not found");
const sources = ["Program.cs", "UpdateWindow.cs", "Guard.cs"].map(file => path.join(root, "launcher", file));
const common = ["/nologo", "/optimize+", "/codepage:65001", "/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll"];
// The guard is the same code as a window-subsystem program, so signing in never flashes a console.
for (const [target, output, extra] of [["exe", "BTR_Desktop.exe", []], ["winexe", "BTR_Guard.exe", ["/define:GUARD"]]]) {
  const result = spawnSync(compiler, [...common, `/target:${target}`, ...extra, `/out:${path.join(root, output)}`, ...sources], { encoding: "utf8", windowsHide: true });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
