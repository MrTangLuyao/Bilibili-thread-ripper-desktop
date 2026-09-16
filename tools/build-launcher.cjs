"use strict";
const path = require("node:path"), fs = require("node:fs"), { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(compiler)) throw Error("Windows .NET Framework C# compiler was not found");
const result = spawnSync(compiler, ["/nologo", "/target:exe", "/optimize+", "/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", `/out:${path.join(root, "BTR_Desktop.exe")}`, path.join(root, "launcher", "Program.cs"), path.join(root,"launcher","UpdateWindow.cs")], { encoding: "utf8", windowsHide: true });
process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exitCode = result.status || 0;
