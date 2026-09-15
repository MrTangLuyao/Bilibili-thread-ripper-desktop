param([string]$Project, [string]$Fixture)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$script = [IO.File]::ReadAllText((Join-Path $Project 'install.ps1'))
# Run the same IEX entry point without contacting the unpublished GitHub branch.
Invoke-Expression ('. {' + $script + '} -LibraryOnly')
$env:LOCALAPPDATA=Join-Path $Fixture 'user-data'
[IO.Directory]::CreateDirectory($env:LOCALAPPDATA) | Out-Null
$script:Stopped=0
$script:BadHash=$false
function Get-BtrBytes([string]$Url,[int]$Limit) {
    if ($Url -like 'https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.json?*') {
        $value=Get-Content -LiteralPath (Join-Path $Project 'latest.json') -Raw | ConvertFrom-Json
        if($script:BadHash){$value.sha256='0'*64}
        return ,[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json))
    }
    $fileName=[IO.Path]::GetFileName(([Uri]$Url).AbsolutePath)
    return ,[IO.File]::ReadAllBytes((Join-Path $Project ('packages\'+$fileName)))
}
function Stop-BtrClient([string]$Folder) {
    if($Folder -ne (Join-Path $Fixture 'client')){throw 'Refusing non-fixture client'}
    $script:Stopped++
}
function New-BtrShortcut([string]$Launcher,[string]$Folder) {
    [IO.File]::WriteAllText((Join-Path $Fixture 'shortcut-target.txt'),$Launcher)
}
$client=Join-Path $Fixture 'client'
$target=Join-Path $client 'resources\app.asar'
$before=Get-BtrSha ([IO.File]::ReadAllBytes($target))
$script:BadHash=$true
$failed=$false
try {Install-BtrDesktop $client $true} catch {if($_.Exception.Message -notmatch 'SHA-256'){throw};$failed=$true}
if(-not $failed -or $script:Stopped -ne 0 -or (Get-BtrSha ([IO.File]::ReadAllBytes($target))) -ne $before){throw 'Hash mismatch safety failed'}
$script:BadHash=$false
Install-BtrDesktop $client $true
$current=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json') -Raw | ConvertFrom-Json
if($current.version -ne '0.9.1.1-d1' -or $script:Stopped -ne 1){throw 'Installation not completed'}
$firstRoot=$current.installPath
# Re-running the one-line command must repair from the original backup, not nest patches.
Install-BtrDesktop $client $true
$current=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json') -Raw | ConvertFrom-Json
if($current.installPath -eq $firstRoot -or $script:Stopped -ne 2){throw 'Reinstall path not updated'}
$launcher=Join-Path $current.installPath 'BTR_Desktop.exe'
$status=(& $launcher status --client $client --noninteractive)|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or -not $status.current -or $status.installed.installRoot -ne $current.installPath){throw 'Installed status is incorrect'}
& $launcher remove --client $client --noninteractive
if($LASTEXITCODE -ne 0 -or (Get-BtrSha ([IO.File]::ReadAllBytes($target))) -ne $before){throw 'Removal did not restore exact original bytes'}
# Reject path traversal before any file can escape the fresh staging folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$badZip=Join-Path $Fixture 'bad.zip'
$zip=[IO.Compression.ZipFile]::Open($badZip,[IO.Compression.ZipArchiveMode]::Create)
$entry=$zip.CreateEntry('BTR_Desktop/../../escape.txt');$writer=New-Object IO.StreamWriter($entry.Open());$writer.Write('bad');$writer.Dispose();$zip.Dispose()
$rejected=$false
try{Expand-BtrPackage $badZip (Join-Path $Fixture 'extract')}catch{$rejected=$true}
if(-not $rejected -or (Test-Path -LiteralPath (Join-Path $Fixture 'escape.txt'))){throw 'Unsafe ZIP was not rejected'}
'PASS Windows PowerShell IEX installation, checksum rejection, reinstall, exact restoration and unsafe ZIP rejection'
