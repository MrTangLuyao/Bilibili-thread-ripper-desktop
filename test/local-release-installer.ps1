param([string]$ClientPath, [switch]$UpdateProgress, [switch]$CloseFirst, [string]$ExpectedVersion, [string]$ExpectedSha256)
$ErrorActionPreference = 'Stop'
# Developer/test adapter only. Never included in a release or accepted by renderer IPC.
$project = $env:BTR_LOCAL_RELEASE_PROJECT
if (-not $project -or -not [IO.Path]::IsPathRooted($project)) { throw 'Missing local release project.' }
$requestedClient = $ClientPath
if (-not $requestedClient -or -not [IO.Path]::IsPathRooted($requestedClient)) { throw 'An explicit client path is required for local testing.' }
. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $project 'install.ps1')))) -LibraryOnly -ClientPath $requestedClient -UpdateProgress:$UpdateProgress -CloseFirst:$CloseFirst -ExpectedVersion $ExpectedVersion -ExpectedSha256 $ExpectedSha256
if ($ClientPath -cne $requestedClient) { throw 'Test client path changed unexpectedly.' }
function Get-BtrBytes([string]$Url, [int]$Limit) {
    $manifest = [IO.File]::ReadAllText((Join-Path $project 'latest.json')) | ConvertFrom-Json
    if ($Url -like 'https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.json?*') { return ,[Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json)) }
    if ($Url -cne $manifest.downloadUrl) { throw 'Unexpected fixture URL.' }
    $bytes = [IO.File]::ReadAllBytes((Join-Path $project ('packages\' + [IO.Path]::GetFileName(([Uri]$Url).AbsolutePath))))
    if ($bytes.Length -gt $Limit) { throw 'Fixture package too large.' }
    Write-BtrProgress 'download' $bytes.Length $bytes.Length
    return ,$bytes
}
# Never register or start a real background guard for a temporary test installation.
function Start-BtrGuard([string]$InstalledRoot) { }
Install-BtrDesktop $ClientPath $false
