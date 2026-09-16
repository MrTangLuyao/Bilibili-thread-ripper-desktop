param([string]$Project)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $Project 'force-update.ps1'))
$global:BtrForceCalls = @()
$global:BtrForceRequests = @()
$global:BtrForceMode = 'ok'
function Invoke-RestMethod {
    param($Uri, $TimeoutSec, $MaximumRedirection, $Headers, $ErrorAction)
    if ($Uri -cnotmatch '^https://raw\.githubusercontent\.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/install\.ps1\?t=[a-f0-9]{32}$') { throw 'Unexpected installer URL' }
    if ($TimeoutSec -ne 90 -or $MaximumRedirection -ne 0 -or $Headers['Cache-Control'] -ne 'no-cache' -or $ErrorAction -ne 'Stop') { throw 'Missing bounded download options' }
    $global:BtrForceRequests += $Uri
    switch ($global:BtrForceMode) {
        'offline' { throw 'fixture network failure' }
        'empty' { return ' ' }
        'object' { return @{invalid=$true} }
        'large' { return ('x' * 262145) }
        'broken' { return "throw 'fixture installation failed'" }
        default {
            return 'param([string]$ClientPath,[switch]$NoLaunch); $global:BtrForceCalls += @{ClientPath=$ClientPath;NoLaunch=[bool]$NoLaunch}'
        }
    }
}
# The README IEX form needs no local files or installed BTR version.
Invoke-Expression $source
if ($global:BtrForceCalls.Count -ne 1 -or $global:BtrForceCalls[0].ClientPath -ne '' -or $global:BtrForceCalls[0].NoLaunch) { throw 'IEX defaults failed' }
$explicitClient = "C:\fixture user's files\bilibili"
& ([ScriptBlock]::Create($source)) -ClientPath $explicitClient -NoLaunch
& ([ScriptBlock]::Create($source)) -ClientPath $explicitClient -NoLaunch
if ($global:BtrForceCalls.Count -ne 3 -or $global:BtrForceCalls[2].ClientPath -cne $explicitClient -or -not $global:BtrForceCalls[2].NoLaunch) { throw 'Repeat update or argument forwarding failed' }
if (@($global:BtrForceRequests | Select-Object -Unique).Count -ne 3) { throw 'Installer URL cache-buster was reused' }
foreach ($mode in @('offline','empty','object','large','broken')) {
    $global:BtrForceMode = $mode
    $failed = $false
    try { & ([ScriptBlock]::Create($source)) -ClientPath $explicitClient -NoLaunch }
    catch { if ($_.Exception.Message -notlike 'BTR force update failed:*') { throw }; $failed=$true }
    if (-not $failed -or $global:BtrForceCalls.Count -ne 3) { throw ('Failure was not stopped: ' + $mode) }
}
'PASS force-update IEX, repeat execution, exact arguments, fresh fixed URL, rejected responses and failure propagation'
