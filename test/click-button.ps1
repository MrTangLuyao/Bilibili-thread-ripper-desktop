param([int]$ProcessId, [string]$Button, [int]$TimeoutSeconds = 60)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
# Test helper: presses a button in a top-level window of one process. UI Automation finds it;
# BM_CLICK presses it like a real click, without needing keyboard focus.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace BtrTest -Name Click -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);'
$automation=[Windows.Automation.AutomationElement]
$deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while([DateTime]::UtcNow -lt $deadline){
    $window=$automation::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition($automation::ProcessIdProperty,$ProcessId)))
    if($window){
        $target=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition($automation::NameProperty,$Button)))
        if($target -and $target.Current.NativeWindowHandle){
            $text=$window.Current.Name
            [BtrTest.Click]::SendMessage([IntPtr]$target.Current.NativeWindowHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
            "CLICKED $text"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 250
}
exit 1
