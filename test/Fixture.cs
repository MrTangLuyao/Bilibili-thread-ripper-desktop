using System;
using System.Diagnostics;
using System.Linq;
class Fixture {
    static int Main(string[] args) {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        if (args.Length == 0) return 0;
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("BTR_TEST_NODE"), String.Join(" ", args.Select(x => "\"" + x.Replace("\"", "\\\"") + "\"")));
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.StandardOutputEncoding = System.Text.Encoding.UTF8; start.StandardErrorEncoding = System.Text.Encoding.UTF8;
        using (var p = Process.Start(start)) {
            var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
            p.WaitForExit(); Console.Write(output.Result); Console.Error.Write(error.Result); return p.ExitCode;
        }
    }
}
