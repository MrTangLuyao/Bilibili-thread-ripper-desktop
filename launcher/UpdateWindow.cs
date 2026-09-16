using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// This process survives the client closing. Only its own worker writes the protocol.
internal sealed class UpdateWindow : Form {
    private readonly Label stage = new Label(), detail = new Label();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Button close = new Button(), logButton = new Button();
    private readonly string root, client, version, hash, logPath;
    private readonly bool uninstall;
    private readonly object logLock = new object();
    private Process worker;
    private bool finished, completed;
    private string lastError = "";
    public int Result = 1;
    private static string Argument(string[] args, string name) {
        int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : "";
    }
    private static string PS(string value) { return "'" + value.Replace("'", "''") + "'"; }
    internal UpdateWindow(string root, string client, string[] args, bool uninstall = false) {
        this.root = root; this.client = client; this.uninstall = uninstall;
        version = Argument(args,"--version"); hash = Argument(args,"--sha256");
        if (!uninstall && (!Regex.IsMatch(version,@"^\d+\.\d+\.\d+\.\d+-d[1-9]\d*$") || !Regex.IsMatch(hash,@"^[a-fA-F0-9]{64}$"))) throw new Exception("更新参数不完整，请重新检查更新。");
        string logs = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"BTR_Desktop","logs");
        Directory.CreateDirectory(logs);
        logPath = Path.Combine(logs,(uninstall ? "uninstall-" : "update-") + DateTime.Now.ToString("yyyyMMdd-HHmmss-") + Guid.NewGuid().ToString("N").Substring(0,8) + ".log");
        File.WriteAllText(logPath,(uninstall ? "BTR uninstall" : "BTR update " + version) + Environment.NewLine,Encoding.UTF8);
        Text = uninstall ? "BTR 卸载" : "BTR 更新"; StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(550,245);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
        Font = new Font("Microsoft YaHei UI",10F); BackColor = Color.FromArgb(27,29,34); ForeColor = Color.WhiteSmoke;
        stage.SetBounds(24,24,500,30); stage.Font = new Font(Font.FontFamily,13F,FontStyle.Bold); stage.Text=uninstall ? "准备卸载 BTR" : "准备更新到 " + version;
        progress.SetBounds(24,72,500,22); progress.Style=ProgressBarStyle.Marquee;
        detail.SetBounds(24,110,500,75); detail.Text=uninstall ? "先检查原始备份，再关闭客户端并还原。账号和缓存会保留。" : "即将关闭哔哩哔哩，更新完成后会自动打开。";
        close.SetBounds(424,198,100,30); close.Text="关闭"; close.Enabled=false; close.Click+=(s,e)=>Close();
        logButton.SetBounds(24,198,115,30); logButton.Text=uninstall ? "查看卸载日志" : "查看更新日志"; logButton.Click+=(s,e)=>Process.Start(new ProcessStartInfo(logPath){UseShellExecute=true});
        foreach (var button in new[] {close,logButton}) { button.BackColor=Color.FromArgb(55,58,66); button.FlatStyle=FlatStyle.Flat; }
        Controls.AddRange(new Control[]{stage,progress,detail,close,logButton});
        FormClosing+=(s,e)=>{if(!finished)e.Cancel=true;};
        Shown+=(s,e)=>BeginInvoke(new Action(StartWorker));
    }
    private void Log(string line) { lock(logLock) File.AppendAllText(logPath,DateTime.Now.ToString("O") + " " + line + Environment.NewLine,Encoding.UTF8); }
    private void OnUI(Action action) { if(!IsDisposed && IsHandleCreated) BeginInvoke(action); }
    private void StartWorker() {
        try {
            string script=Path.Combine(root,"install.ps1");
            string flags=uninstall ? " -Uninstall -PackageRoot " + PS(root) : " -CloseFirst -ExpectedVersion " + PS(version) + " -ExpectedSha256 " + PS(hash);
            string command="$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; try { & ([ScriptBlock]::Create([IO.File]::ReadAllText(" + PS(script) + "))) -ClientPath " + PS(client) + " -UpdateProgress" + flags + " } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }";
            var start=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),"-NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command)));
            start.UseShellExecute=false; start.CreateNoWindow=true; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
            start.StandardOutputEncoding=Encoding.UTF8; start.StandardErrorEncoding=Encoding.UTF8;
            start.EnvironmentVariables.Remove("PSModulePath"); start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            worker=new Process {StartInfo=start,EnableRaisingEvents=true};
            worker.OutputDataReceived+=(s,e)=>{if(e.Data!=null) { Log(e.Data); if(e.Data.StartsWith("BTR_PROGRESS ",StringComparison.Ordinal)) OnUI(()=>ApplyProgress(e.Data.Substring(13))); }};
            worker.ErrorDataReceived+=(s,e)=>{if(!String.IsNullOrWhiteSpace(e.Data)) { Log("STDERR " + e.Data); if(String.IsNullOrWhiteSpace(lastError) && !e.Data.StartsWith("#< CLIXML") && !e.Data.StartsWith("<Objs"))lastError=e.Data; }};
            worker.Exited+=(s,e)=>{
                // Wait for asynchronous stdout/stderr readers before reporting completion.
                worker.WaitForExit(); int code=worker.ExitCode; Log("Worker exit " + code);
                OnUI(()=>Finish(code));
            };
            worker.Start(); worker.BeginOutputReadLine(); worker.BeginErrorReadLine();
        } catch(Exception error) { lastError=error.Message; Log(error.ToString()); Finish(1); }
    }
    private void ApplyProgress(string json) {
        var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json);
        string phase=Convert.ToString(data["phase"]);
        var labels=new Dictionary<string,string> {
            {"closing","正在关闭哔哩哔哩"},{"manifest","正在读取更新信息"},{"download","正在下载安装包"},
            {"verify","正在校验安装包"},{"extract","正在解压安装包"},{"compatibility","正在检查客户端兼容性"},
            {"install","正在安装 BTR"},{"backup","正在检查原始备份"},{"restore","正在还原官方客户端"},{"cleanup","正在清理 BTR 安装记录"},
            {"validate",uninstall ? "正在验证还原结果" : "正在检查安装结果"},{"restart","正在重新打开哔哩哔哩"},{"complete",uninstall ? "卸载完成" : "更新完成"}
        };
        if (!labels.ContainsKey(phase)) return;
        stage.Text=labels[phase];
        long done=Convert.ToInt64(data["done"]),total=Convert.ToInt64(data["total"]);
        progress.Style=ProgressBarStyle.Marquee;
        detail.Text=uninstall ? "只移除 BTR，不卸载哔哩哔哩。\n请稍候，不要关闭卸载程序。" : "目标版本 " + version + "\n请稍候，不要关闭更新程序。";
        if (phase=="download") {
            if(total>0) { progress.Style=ProgressBarStyle.Continuous; progress.Value=(int)Math.Min(100,done*100/total); }
            detail.Text=total>0 ? String.Format("已下载 {0:N0} / {1:N0} KB  ({2}%)",done/1024.0,total/1024.0,progress.Value) : String.Format("已下载 {0:N0} KB，正在等待服务器返回数据。",done/1024.0);
        }
        if(phase=="install" || phase=="restore") detail.Text="正在写入客户端文件。\n如果出现 Windows 管理员授权窗口，请确认。";
        if(phase=="complete") completed=true;
    }
    private void Finish(int code) {
        finished=true; close.Enabled=true; progress.Style=ProgressBarStyle.Continuous;
        if(code==0 && completed) {
            Result=0; progress.Value=100; stage.Text=uninstall ? "BTR 卸载完成" : "BTR 更新完成"; detail.Text=uninstall ? "已验证官方文件还原成功，并重新打开哔哩哔哩。" : "已安装 " + version + "，哔哩哔哩已重新打开。";
            var timer=new Timer {Interval=1800}; timer.Tick+=(s,e)=>{timer.Stop();timer.Dispose();Close();};timer.Start();
        } else {
            stage.Text=uninstall ? "BTR 卸载未完成" : "BTR 更新未完成"; stage.ForeColor=Color.Salmon; progress.Value=0;
            detail.Text=(String.IsNullOrWhiteSpace(lastError)?"维护程序意外退出，请查看日志后重试。":lastError.Substring(0,Math.Min(lastError.Length,170))) + "\n原始客户端备份已保留。";
        }
    }
}
