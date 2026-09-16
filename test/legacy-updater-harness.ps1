param([string]$Project, [string]$Client, [string]$LegacyInstaller)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Runs an already-installed old updater exactly as its update window does, but serves this
# repository's release instead of GitHub. The client path is explicit and never discovered.
if (-not [IO.Path]::IsPathRooted($Client)) { throw 'An explicit client path is required.' }
$requestedClient = $Client
$manifestText = [IO.File]::ReadAllText((Join-Path $Project 'latest.json'))
$release = $manifestText | ConvertFrom-Json
. ([ScriptBlock]::Create([IO.File]::ReadAllText($LegacyInstaller))) -LibraryOnly -ClientPath $requestedClient -CloseFirst -ExpectedVersion $release.version -ExpectedSha256 $release.sha256
if ($ClientPath -cne $requestedClient) { throw 'Test client path changed unexpectedly.' }
$script:Stopped = 0
function Get-BtrBytes([string]$Url, [int]$Limit) {
    if ($Url -like 'https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.json?*') { return ,[Text.Encoding]::UTF8.GetBytes($manifestText) }
    if ($Url -cne $release.downloadUrl) { throw 'Unexpected fixture URL.' }
    return ,[IO.File]::ReadAllBytes((Join-Path $Project ('packages\' + [IO.Path]::GetFileName(([Uri]$Url).AbsolutePath))))
}
function Stop-BtrClient([string]$Folder) { if ($Folder -ne $requestedClient) { throw 'Refusing non-fixture client' }; $script:Stopped++ }
Install-BtrDesktop $requestedClient $false
$current = [IO.File]::ReadAllText((Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json')) | ConvertFrom-Json
if ($current.version -cne $release.version -or $script:Stopped -ne 1) { throw 'The old updater did not install this release.' }
$status = (& (Join-Path $current.installPath 'BTR_Desktop.exe') status --client $requestedClient --noninteractive) | ConvertFrom-Json
if (-not $status.current -or -not $status.supported) { throw 'The release installed by the old updater is not current.' }
'PASS old updater installed ' + $release.version
