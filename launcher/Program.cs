using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program {
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"").TrimEnd('\\') + "\""; }
    private static bool Admin() { using (var id = WindowsIdentity.GetCurrent()) return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator); }
    private static string Client(string[] args) {
        int i = Array.IndexOf(args, "--client");
        string folder = i >= 0 && i + 1 < args.Length ? args[i + 1] : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "bilibili");
        folder = Path.GetFullPath(folder);
        if (!File.Exists(Path.Combine(folder, "哔哩哔哩.exe")) || !File.Exists(Path.Combine(folder, "resources", "app.asar"))) throw new Exception("找不到客户端，请加上 --client 后指定安装目录。");
        return folder;
    }
    private static Process[] Running(string folder) {
        string exe = Path.Combine(folder, "哔哩哔哩.exe");
        var matches = new List<Process>();
        foreach (var process in Process.GetProcessesByName("哔哩哔哩")) {
            try { if (String.Equals(process.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase)) matches.Add(process); }
            catch (Exception e) { if (process.HasExited) continue; throw new Exception("无法确认客户端进程路径，请先退出客户端。", e); }
        }
        return matches.ToArray();
    }
    private static void RequireClosed(string folder) {
        if (Running(folder).Length != 0) throw new Exception("请先从系统托盘完全退出哔哩哔哩，再安装或还原。不会强制结束你的视频。");
    }
    private static Dictionary<string, object> RunNode(string folder, string action) {
        var start = new ProcessStartInfo(Path.Combine(folder, "哔哩哔哩.exe"), Quote(Path.Combine(Root, "tools", "client-package.cjs")) + " " + action + " " + Quote(folder));
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        start.WorkingDirectory = Root;
        using (var p = Process.Start(start)) {
            var output = p.StandardOutput.ReadToEndAsync(); var errors = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(45000)) { p.Kill(); throw new Exception("安装程序等待超时，未启动客户端。"); }
            string result = output.Result;
            if (p.ExitCode != 0) throw new Exception(errors.Result.Trim());
            return Json.Deserialize<Dictionary<string, object>>(result);
        }
    }
    private static bool Flag(Dictionary<string, object> value, string key) { return value.ContainsKey(key) && value[key] is bool && (bool)value[key]; }
    private static bool CanWriteResources(string folder) {
        string probe = Path.Combine(folder, "resources", ".btr-write-" + Guid.NewGuid().ToString("N"));
        try { using (var file = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { } return true; }
        catch (UnauthorizedAccessException) { return false; }
    }
    private static void Apply(string folder, string action) {
        RequireClosed(folder);
        if (Admin() || CanWriteResources(folder)) { Console.WriteLine(Json.Serialize(RunNode(folder, action))); return; }
        var start = new ProcessStartInfo(Path.Combine(Root, "BTR_Desktop.exe"), "--apply " + action + " --client " + Quote(folder));
        start.UseShellExecute = true; start.Verb = "runas"; start.WindowStyle = ProcessWindowStyle.Hidden;
        using (var p = Process.Start(start)) { p.WaitForExit(); if (p.ExitCode != 0) throw new Exception("安装未完成，请查看管理员窗口的错误提示。"); }
    }
    private static bool CacheSupported() {
        string version = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "bilibili", "resource", ".version");
        if (!File.Exists(version)) return true;
        var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Root, "desktop.json"), Encoding.UTF8));
        var supported = (System.Collections.ArrayList)config["supportedClientVersions"];
        return supported.Contains(File.ReadAllText(version, Encoding.UTF8).Trim());
    }
    private static void RemoveLegacyShortcut(string folder, string launcher, string shortcutPath) {
        // d1's already-installed updater creates a shortcut after applying the new package.
        // Remove that exact shortcut before launching, even when the old updater was used.
        if (!File.Exists(shortcutPath)) return;
        object shell = null, shortcut = null;
        try {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            shortcut = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] {shortcutPath});
            string target = (string)shortcut.GetType().InvokeMember("TargetPath", System.Reflection.BindingFlags.GetProperty, null, shortcut, null);
            string arguments = (string)shortcut.GetType().InvokeMember("Arguments", System.Reflection.BindingFlags.GetProperty, null, shortcut, null);
            if (String.Equals(target, launcher, StringComparison.OrdinalIgnoreCase) && arguments == "launch --client " + Quote(folder)) File.Delete(shortcutPath);
        } finally {
            if (shortcut != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
            if (shell != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
        }
    }
    [STAThread]
    private static int Main(string[] args) {
        Console.OutputEncoding = Encoding.UTF8;
        try {
            if (args.Contains("--help")) { Console.WriteLine("BTR_Desktop.exe [launch|install|repair|remove|uninstall|status|check-update] [--client 安装目录]\n不带参数会检查接入状态，然后启动官方客户端。install 和 remove 需要先完全退出客户端。uninstall 显示独立卸载进度并重新打开官方客户端。"); return 0; }
            string folder = Client(args);
            if (args.Length > 0 && args[0] == "--apply") {
                if (!Admin() || args.Length < 2 || !new[] {"install", "repair", "remove"}.Contains(args[1])) throw new Exception("无效的安装操作。");
                RequireClosed(folder); Console.WriteLine(Json.Serialize(RunNode(folder, args[1]))); return 0;
            }
            string action = args.Length > 0 && !args[0].StartsWith("--") ? args[0] : "launch";
            if (action == "update" || action == "uninstall") {
                if (Admin()) throw new Exception("请用普通权限运行维护程序，只有修改客户端文件时才请求管理员授权。");
                Application.EnableVisualStyles();
                using (var window = new UpdateWindow(Root, folder, args, action == "uninstall")) { Application.Run(window); return window.Result; }
            }
            if (action == "status" || action == "check-update" || action == "check-remove") { Console.WriteLine(Json.Serialize(RunNode(folder, action))); return 0; }
            if (new[] {"install", "repair", "remove"}.Contains(action)) { Apply(folder, action); return 0; }
            if (action != "launch") throw new Exception("未知命令，请运行 BTR_Desktop.exe --help。");
            if (Admin()) throw new Exception("请用普通权限启动 BTR_Desktop，客户端不应以管理员身份播放视频。");
            var status = RunNode(folder, "status");
            if (Flag(status, "supported") && CacheSupported()) { if (!Flag(status, "current")) Apply(folder, "repair"); }
            else MessageBox.Show("客户端已更新到尚未适配的版本。本次只启动官方播放器，不强行接入 BTR。", "BTR 提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            RemoveLegacyShortcut(folder, Path.Combine(Root, "BTR_Desktop.exe"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "BTR Desktop.lnk"));
            Process.Start(new ProcessStartInfo(Path.Combine(folder, "哔哩哔哩.exe")) { UseShellExecute = true });
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            if (!args.Contains("--noninteractive")) MessageBox.Show(error.Message, "BTR 提示", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
