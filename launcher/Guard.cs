using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal enum GuardAction { None, Retry, Ask, Unsupported }

// Official hot updates never touch Program Files, so BTR normally survives them.
// A full installer replaces app.asar; this per-user guard notices that and offers to reconnect.
internal static class Guard {
    internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    internal const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    internal const string ValueName = "BTR Desktop";
    internal static readonly TimeSpan Quiet = TimeSpan.FromSeconds(8);
    internal static string Command(string root) { return Program.Quote(Path.Combine(root, "BTR_Guard.exe")) + " guard"; }
    internal static void Register(string runKey, string root) {
        using (var key = Registry.CurrentUser.CreateSubKey(runKey)) {
            if (!String.Equals(key.GetValue(ValueName) as string, Command(root), StringComparison.Ordinal)) key.SetValue(ValueName, Command(root));
        }
    }
    internal static bool Unregister(string runKey, string root) {
        using (var key = Registry.CurrentUser.OpenSubKey(runKey, true)) {
            if (key == null || !String.Equals(key.GetValue(ValueName) as string, Command(root), StringComparison.OrdinalIgnoreCase)) return false;
            key.DeleteValue(ValueName, false);
            return true;
        }
    }
    // Task Manager stores its own startup switch. An odd first byte means the user disabled BTR.
    internal static bool DisabledByUser(string approvedKey) {
        using (var key = Registry.CurrentUser.OpenSubKey(approvedKey)) {
            var value = key == null ? null : key.GetValue(ValueName) as byte[];
            return value != null && value.Length > 0 && (value[0] & 1) == 1;
        }
    }
    private static int ReadFully(Stream stream, byte[] buffer) {
        int total = 0, count;
        while (total < buffer.Length && (count = stream.Read(buffer, total, buffer.Length - total)) > 0) total += count;
        return total;
    }
    // Reads only the ASAR header. The maintenance program still does the full verification.
    internal static bool HasBtr(string asar) {
        try {
            using (var file = new FileStream(asar, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                var head = new byte[16];
                if (ReadFully(file, head) != head.Length || BitConverter.ToUInt32(head, 0) != 4) return false;
                int size = BitConverter.ToInt32(head, 12);
                if (size <= 0 || size > 64 * 1024 * 1024) return false;
                var json = new byte[size];
                if (ReadFully(file, json) != size) return false;
                string header = Encoding.UTF8.GetString(json);
                return header.Contains("\"btr-desktop\":{\"files\":{") && header.Contains("\"installed.json\":{");
            }
        } catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
    internal static string LockPath() { return Path.Combine(Program.DataRoot(), "maintenance.lock"); }
    // install.ps1 holds this file exclusively while it installs, removes or reconnects BTR.
    internal static bool MaintenanceRunning() {
        try { using (new FileStream(LockPath(), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) return false; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
        catch (IOException) { return true; }
    }
    // Official installers and their temporary uninstallers. A name match only delays the prompt.
    internal static bool InstallerRunning() {
        var pattern = new Regex(@"^(bili.*inst.*|installer|au_|un_a)$", RegexOptions.IgnoreCase);
        return Process.GetProcesses().Any(p => { try { return pattern.IsMatch(p.ProcessName); } finally { p.Dispose(); } });
    }
    internal static string Stamp(string asar) {
        var info = new FileInfo(asar);
        return info.Length + ":" + info.LastWriteTimeUtc.Ticks + ":" + info.CreationTimeUtc.Ticks;
    }
    internal static GuardAction Decide(string client, ICollection<string> skipped, out string stamp) {
        stamp = "";
        string asar = Path.Combine(client, "resources", "app.asar");
        if (!File.Exists(asar) || !File.Exists(Path.Combine(client, Program.ClientExe))) return GuardAction.None;
        if (HasBtr(asar)) return GuardAction.None;
        if (MaintenanceRunning() || InstallerRunning()) return GuardAction.Retry;
        stamp = Stamp(asar);
        if (skipped.Contains(stamp)) return GuardAction.None;
        Dictionary<string, object> status;
        try { status = Program.RunNode(client, "status"); } catch (Exception) { return GuardAction.None; }
        if (status == null || (status.ContainsKey("installed") && status["installed"] != null)) return GuardAction.None;
        return Program.Flag(status, "supported") ? GuardAction.Ask : GuardAction.Unsupported;
    }
    private static string MutexName(string root) {
        using (var sha = SHA256.Create()) {
            var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()));
            return @"Local\BTR_Desktop_Guard_" + BitConverter.ToString(hash, 0, 8).Replace("-", "");
        }
    }
    internal static int Run(string[] args) {
        if (args.Length == 0 || args[0] != "guard" || Program.Admin()) return 2;
        var pointer = Program.ReadPointer();
        if (!Program.OwnedBy(pointer, Program.Root)) return 0;
        string client = pointer.ContainsKey("clientPath") ? pointer["clientPath"] as string : null;
        if (String.IsNullOrEmpty(client) || !Path.IsPathRooted(client)) return 0;
        if (args.Contains("--register")) Register(RunKey, Program.Root);
        if (DisabledByUser(ApprovedKey)) return 0;
        using (var single = new Mutex(false, MutexName(Program.Root))) {
            bool owned;
            try { owned = single.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
            if (!owned) return 0;
            try {
                Application.EnableVisualStyles();
                using (var context = new GuardContext(Path.GetFullPath(client).TrimEnd('\\'))) Application.Run(context);
            } finally { single.ReleaseMutex(); }
        }
        return 0;
    }
}

internal sealed class GuardContext : ApplicationContext {
    private readonly string client, resources, statePath;
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer {Interval = 1000};
    private readonly HashSet<string> skipped = new HashSet<string>();
    private FileSystemWatcher clientWatcher, dataWatcher;
    private long changedAt, pointerChangedAt;
    private DateTime nextFull = DateTime.MinValue, nextOwnerCheck = DateTime.MinValue, nextWatch = DateTime.MinValue;
    private bool busy;
    internal GuardContext(string client) {
        this.client = client;
        resources = Path.Combine(client, "resources");
        statePath = Path.Combine(Program.DataRoot(), "guard.json");
        try {
            var saved = Program.Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(statePath, Encoding.UTF8));
            if (saved != null && saved.ContainsKey("declined") && saved["declined"] is string) skipped.Add((string)saved["declined"]);
        } catch (Exception) { }
        try {
            dataWatcher = new FileSystemWatcher(Program.DataRoot(), "current.json") {NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size};
            FileSystemEventHandler mark = (s, e) => Interlocked.Exchange(ref pointerChangedAt, DateTime.UtcNow.Ticks);
            dataWatcher.Changed += mark; dataWatcher.Created += mark; dataWatcher.Deleted += mark;
            dataWatcher.Renamed += (s, e) => mark(s, e);
            dataWatcher.EnableRaisingEvents = true;
        } catch (Exception) { dataWatcher = null; }
        timer.Tick += (s, e) => Tick();
        timer.Start();
    }
    private void Changed() { Interlocked.Exchange(ref changedAt, DateTime.UtcNow.Ticks); }
    private void Watch() {
        DisposeClientWatcher();
        nextWatch = DateTime.UtcNow.AddSeconds(30);
        if (!Directory.Exists(resources)) return;
        try {
            var watcher = new FileSystemWatcher(resources, "app.asar") {NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime};
            FileSystemEventHandler mark = (s, e) => Changed();
            watcher.Changed += mark; watcher.Created += mark; watcher.Deleted += mark;
            watcher.Renamed += (s, e) => Changed();
            // A reinstall can delete the folder. Watch it again once it exists.
            watcher.Error += (s, e) => { Interlocked.Exchange(ref pointerChangedAt, DateTime.UtcNow.Ticks); Changed(); };
            watcher.EnableRaisingEvents = true;
            clientWatcher = watcher;
            Changed();
        } catch (Exception) { clientWatcher = null; }
    }
    private void DisposeClientWatcher() { if (clientWatcher != null) { clientWatcher.Dispose(); clientWatcher = null; } }
    private void Tick() {
        if (busy) return;
        var now = DateTime.UtcNow;
        long pointerTicks = Interlocked.Exchange(ref pointerChangedAt, 0);
        if (pointerTicks != 0 || now >= nextOwnerCheck) {
            nextOwnerCheck = now.AddMinutes(1);
            if (!Program.OwnedBy(Program.ReadPointer(), Program.Root, client)) { ExitThread(); return; }
        }
        if ((clientWatcher == null || !Directory.Exists(resources)) && now >= nextWatch) Watch();
        long ticks = Interlocked.Read(ref changedAt);
        bool settled = ticks != 0 && now - new DateTime(ticks, DateTimeKind.Utc) >= Guard.Quiet;
        if (!settled && now < nextFull) return;
        Interlocked.CompareExchange(ref changedAt, 0, ticks);
        nextFull = now.AddMinutes(10);
        busy = true;
        try { Check(); } finally { busy = false; }
    }
    private void Check() {
        string stamp;
        var action = Guard.Decide(client, skipped, out stamp);
        if (action == GuardAction.Retry) { Changed(); return; }
        if (action == GuardAction.None) return;
        if (!Program.OwnedBy(Program.ReadPointer(), Program.Root, client)) { ExitThread(); return; }
        if (action == GuardAction.Unsupported) {
            Remember(stamp);
            GuardPrompt.Ask("哔哩哔哩已经被重新安装或更新，但这个版本的程序结构 BTR 无法识别。\n\n本次保持官方客户端不变，不强行接入 BTR。", null, "知道了");
            return;
        }
        if (!GuardPrompt.Ask("哔哩哔哩已经被重新安装或更新，BTR 被官方安装程序覆盖了。\n\n现在重新接入 BTR 吗？会关闭哔哩哔哩，写入时需要一次管理员授权，完成后自动重新打开。", "重新接入 BTR", "这次不用")) {
            Remember(stamp);
            return;
        }
        var start = new ProcessStartInfo(Path.Combine(Program.Root, "BTR_Desktop.exe"), Program.Arguments(new[] {"reconnect", "--client", client}));
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        int code;
        try { using (var p = Process.Start(start)) { p.WaitForExit(); code = p.ExitCode; } }
        catch (Exception) { code = 1; }
        // A failed or cancelled attempt is asked again after the next sign-in, not in a loop now.
        if (code != 0) skipped.Add(stamp);
        Changed();
    }
    private void Remember(string stamp) {
        skipped.Add(stamp);
        try { File.WriteAllText(statePath, Program.Json.Serialize(new Dictionary<string, object> {{"declined", stamp}}), new UTF8Encoding(false)); } catch (Exception) { }
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { timer.Dispose(); DisposeClientWatcher(); if (dataWatcher != null) dataWatcher.Dispose(); }
        base.Dispose(disposing);
    }
}

internal sealed class GuardPrompt : Form {
    private GuardPrompt(string message, string accept, string decline) {
        Text = "BTR 提示"; StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(500, 210);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; TopMost = true; ShowInTaskbar = true;
        Font = new Font("Microsoft YaHei UI", 10F); BackColor = Color.FromArgb(27, 29, 34); ForeColor = Color.WhiteSmoke;
        var text = new Label {Text = message, AutoSize = false};
        text.SetBounds(24, 22, 452, 120);
        Controls.Add(text);
        var right = 476;
        var no = AddButton(decline, DialogResult.Cancel);
        no.SetBounds(right - 110, 158, 110, 32); right -= 122;
        CancelButton = no;
        if (accept != null) {
            var yes = AddButton(accept, DialogResult.OK);
            yes.SetBounds(right - 130, 158, 130, 32); yes.BackColor = Color.FromArgb(191, 77, 123);
            AcceptButton = yes;
        }
    }
    private Button AddButton(string label, DialogResult result) {
        var button = new Button {Text = label, DialogResult = result, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(55, 58, 66)};
        Controls.Add(button);
        return button;
    }
    internal static bool Ask(string message, string accept, string decline) {
        using (var prompt = new GuardPrompt(message, accept, decline)) {
            prompt.Shown += (s, e) => prompt.Activate();
            return prompt.ShowDialog() == DialogResult.OK;
        }
    }
}
