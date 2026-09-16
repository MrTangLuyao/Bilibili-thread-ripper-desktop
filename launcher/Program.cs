using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

#if GUARD
[assembly: AssemblyTitle("BTR Desktop 客户端监视")]
#else
[assembly: AssemblyTitle("BTR Desktop")]
#endif
[assembly: AssemblyProduct("BTR Desktop")]

internal static class Program {
    // Resolved from this assembly, so tests that load it by reflection see the installed folder.
    internal static readonly string Root = Path.GetDirectoryName(Path.GetFullPath(typeof(Program).Assembly.Location)).TrimEnd(Path.DirectorySeparatorChar);
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal const string ClientExe = "哔哩哔哩.exe";
    private static readonly string[] WindowActions = {"update", "uninstall", "reconnect"};
    // Windows command-line quoting, the inverse of CommandLineToArgvW.
    internal static string Quote(string value) {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c);
            slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal static string Arguments(IEnumerable<string> values) { return String.Join(" ", values.Select(Quote)); }
    internal static bool Admin() { using (var id = WindowsIdentity.GetCurrent()) return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator); }
    internal static string DataRoot() {
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        return Path.Combine(String.IsNullOrEmpty(local) ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) : local, "BTR_Desktop");
    }
    private static bool SamePath(object a, string b) {
        var text = a as string;
        if (String.IsNullOrEmpty(text) || !Path.IsPathRooted(text)) return false;
        return String.Equals(Path.GetFullPath(text).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }
    internal static Dictionary<string, object> ReadPointer() {
        string file = Path.Combine(DataRoot(), "current.json");
        try { return File.Exists(file) ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8)) : null; }
        catch (Exception) { return null; }
    }
    // current.json decides which installation owns the client. Older or removed installations stay passive.
    internal static bool OwnedBy(Dictionary<string, object> pointer, string root, string client = null) {
        return pointer != null && pointer.ContainsKey("installPath") && SamePath(pointer["installPath"], root)
            && (client == null || (pointer.ContainsKey("clientPath") && SamePath(pointer["clientPath"], client)));
    }
    internal static string Client(string[] args) {
        int i = Array.IndexOf(args, "--client");
        string folder = i >= 0 && i + 1 < args.Length ? args[i + 1] : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "bilibili");
        folder = Path.GetFullPath(folder).TrimEnd('\\');
        if (!File.Exists(Path.Combine(folder, ClientExe)) || !File.Exists(Path.Combine(folder, "resources", "app.asar"))) throw new Exception("找不到客户端，请加上 --client 后指定安装目录。");
        return folder;
    }
    private static Process[] Running(string folder) {
        string exe = Path.Combine(folder, ClientExe);
        var matches = new List<Process>();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ClientExe))) {
            try { if (String.Equals(process.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase)) matches.Add(process); }
            catch (Exception e) { if (process.HasExited) continue; throw new Exception("无法确认客户端进程路径，请先退出客户端。", e); }
        }
        return matches.ToArray();
    }
    private static void RequireClosed(string folder) {
        if (Running(folder).Length != 0) throw new Exception("请先从系统托盘完全退出哔哩哔哩，再安装或还原。不会强制结束你的视频。");
    }
    internal static Dictionary<string, object> RunNode(string folder, string action) {
        var start = new ProcessStartInfo(Path.Combine(folder, ClientExe), Arguments(new[] {Path.Combine(Root, "tools", "client-package.cjs"), action, folder}));
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
    internal static bool Flag(Dictionary<string, object> value, string key) { return value != null && value.ContainsKey(key) && value[key] is bool && (bool)value[key]; }
    private static bool CanWriteResources(string folder) {
        string probe = Path.Combine(folder, "resources", ".btr-write-" + Guid.NewGuid().ToString("N"));
        try { using (var file = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { } return true; }
        catch (UnauthorizedAccessException) { return false; }
    }
    private static void Apply(string folder, string action) {
        RequireClosed(folder);
        if (Admin() || CanWriteResources(folder)) { Console.WriteLine(Json.Serialize(RunNode(folder, action))); return; }
        var start = new ProcessStartInfo(Path.Combine(Root, "BTR_Desktop.exe"), Arguments(new[] {"--apply", action, "--client", folder}));
        start.UseShellExecute = true; start.Verb = "runas"; start.WindowStyle = ProcessWindowStyle.Hidden;
        using (var p = Process.Start(start)) { p.WaitForExit(); if (p.ExitCode != 0) throw new Exception("安装未完成，请查看管理员窗口的错误提示。"); }
    }
    // Clears this installation's pointer and startup entry. Other installations are left alone.
    private static void Forget(string folder) {
        string pointer = Path.Combine(DataRoot(), "current.json");
        if (OwnedBy(ReadPointer(), Root, folder)) File.Delete(pointer);
        Guard.Unregister(Guard.RunKey, Root);
    }
    // Electron keeps non-detached children in a job that Windows kills together with the client.
    // A process started from here silently leaves that job, so the visible window keeps running
    // after the worker closes Bilibili. Waiting keeps the exit code meaningful for the caller.
    private static int Relay(string[] args) {
        var start = new ProcessStartInfo(Path.Combine(Root, "BTR_Desktop.exe"), Arguments(args.Concat(new[] {"--window"})));
        start.UseShellExecute = false; start.CreateNoWindow = true;
        using (var p = Process.Start(start)) { p.WaitForExit(); return p.ExitCode; }
    }
    private static void RemoveLegacyShortcut(string folder, string launcher, string shortcutPath) {
        // d1's already-installed updater creates a shortcut after applying the new package.
        // Remove that exact shortcut before launching, even when the old updater was used.
        if (!File.Exists(shortcutPath)) return;
        object shell = null, shortcut = null;
        try {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] {shortcutPath});
            string target = (string)shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null);
            string arguments = (string)shortcut.GetType().InvokeMember("Arguments", BindingFlags.GetProperty, null, shortcut, null);
            if (String.Equals(target, launcher, StringComparison.OrdinalIgnoreCase) && arguments == "launch --client \"" + folder + "\"") File.Delete(shortcutPath);
        } finally {
            if (shortcut != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
            if (shell != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
        }
    }
    [STAThread]
    private static int Main(string[] args) {
        // The guard has no console. Its encoding cannot and need not be changed.
        try { Console.OutputEncoding = Encoding.UTF8; } catch (IOException) { }
        bool interactive = !args.Contains("--noninteractive");
        try {
#if GUARD
            interactive = false;
            return Guard.Run(args);
#else
            if (args.Contains("--help")) { Console.WriteLine("BTR_Desktop.exe [launch|install|repair|remove|uninstall|reconnect|status|check-update] [--client 安装目录]\n不带参数会检查接入状态，然后启动官方客户端。install 和 remove 需要先完全退出客户端。uninstall 显示独立卸载进度并重新打开官方客户端。"); return 0; }
            string folder = Client(args);
            if (args.Length > 0 && args[0] == "--apply") {
                if (!Admin() || args.Length < 2 || !new[] {"install", "repair", "remove"}.Contains(args[1])) throw new Exception("无效的安装操作。");
                RequireClosed(folder); Console.WriteLine(Json.Serialize(RunNode(folder, args[1]))); return 0;
            }
            string action = args.Length > 0 && !args[0].StartsWith("--") ? args[0] : "launch";
            if (WindowActions.Contains(action)) {
                if (Admin()) throw new Exception("请用普通权限运行维护程序，只有修改客户端文件时才请求管理员授权。");
                if (!args.Contains("--window")) return Relay(args);
                Application.EnableVisualStyles();
                using (var window = new UpdateWindow(Root, folder, args, action)) { Application.Run(window); return window.Result; }
            }
            if (action == "status" || action == "check-update" || action == "check-remove") { Console.WriteLine(Json.Serialize(RunNode(folder, action))); return 0; }
            if (action == "forget") { Forget(folder); return 0; }
            if (new[] {"install", "repair", "remove"}.Contains(action)) {
                Apply(folder, action);
                if (action == "remove" && !args.Contains("--keep-record")) Forget(folder);
                return 0;
            }
            if (action != "launch") throw new Exception("未知命令，请运行 BTR_Desktop.exe --help。");
            if (Admin()) throw new Exception("请用普通权限启动 BTR_Desktop，客户端不应以管理员身份播放视频。");
            var status = RunNode(folder, "status");
            if (!Flag(status, "supported")) { if (interactive) MessageBox.Show("无法识别这个客户端的程序结构。本次只启动官方播放器，不强行接入 BTR。", "BTR 提示", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            else if (!Flag(status, "current")) Apply(folder, "repair");
            RemoveLegacyShortcut(folder, Path.Combine(Root, "BTR_Desktop.exe"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "BTR Desktop.lnk"));
            Process.Start(new ProcessStartInfo(Path.Combine(folder, ClientExe)) { UseShellExecute = true });
            return 0;
#endif
        } catch (Exception error) {
            try { Console.Error.WriteLine(error.Message); } catch (IOException) { }
            if (interactive) MessageBox.Show(error.Message, "BTR 提示", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
