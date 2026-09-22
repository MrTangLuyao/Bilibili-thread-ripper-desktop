using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
class Fixture {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static string Quote(string x) { return "\"" + x.Replace("\"", "\\\"") + "\""; }
    // Electron's libuv puts every non-detached child in a kill-on-close job. Children of that
    // child silently break away. Reproduce exactly that, then stay alive until BTR closes us.
    static int FakeElectron(string[] args) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new ExtendedLimit();
        info.Basic.LimitFlags = 0x800 | 0x1000 | 0x400 | 0x2000; // BREAKAWAY_OK, SILENT_BREAKAWAY_OK, DIE_ON_UNHANDLED_EXCEPTION, KILL_ON_JOB_CLOSE
        if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimit)))) return 3;
        var start = new ProcessStartInfo(args[1], String.Join(" ", args.Skip(2).Select(Quote)));
        start.UseShellExecute = false; start.CreateNoWindow = true;
        var child = Process.Start(start);
        if (!AssignProcessToJobObject(job, child.Handle)) return 4;
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
    static int Main(string[] args) {
        // Built as a window program so that starting it, as the installer does with the real
        // client, opens no console window. Its output still reaches the tests through pipes.
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch (System.IO.IOException) { }
        if (args.Length == 0) {
            var marker = Environment.GetEnvironmentVariable("BTR_TEST_LAUNCH_MARKER");
            if (!String.IsNullOrEmpty(marker)) System.IO.File.AppendAllText(marker, "official-client-started\n");
            return 0;
        }
        if (args[0] == "--btr-fake-electron") return FakeElectron(args);
        var node = new ProcessStartInfo(Environment.GetEnvironmentVariable("BTR_TEST_NODE"), String.Join(" ", args.Select(Quote)));
        node.UseShellExecute = false; node.CreateNoWindow = true;
        node.RedirectStandardOutput = true; node.RedirectStandardError = true;
        node.StandardOutputEncoding = System.Text.Encoding.UTF8; node.StandardErrorEncoding = System.Text.Encoding.UTF8;
        using (var p = Process.Start(node)) {
            var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
            p.WaitForExit(); Console.Write(output.Result); Console.Error.Write(error.Result); return p.ExitCode;
        }
    }
}
