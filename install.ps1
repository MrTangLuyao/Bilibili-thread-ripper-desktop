param(
    [string]$ClientPath = '',
    [switch]$NoLaunch,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'

function Get-BtrBytes([string]$Url, [int]$Limit) {
    if (-not $Url.StartsWith('https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/', [StringComparison]::Ordinal)) { throw 'Unexpected download URL.' }
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $http = New-Object Net.Http.HttpClient($handler)
    $http.Timeout = [TimeSpan]::FromSeconds(90)
    $cancel = New-Object Threading.CancellationTokenSource
    $cancel.CancelAfter(90000)
    $response = $null; $stream = $null; $buffered = New-Object IO.MemoryStream
    try {
        $response = $http.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw ('Download HTTP ' + [int]$response.StatusCode + '. Has the repository been pushed?') }
        if ($response.Content.Headers.ContentLength -gt $Limit) { throw 'Download exceeds size limit.' }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $chunk = New-Object byte[] 16384
        while (($count = $stream.ReadAsync($chunk, 0, $chunk.Length, $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
            if ($buffered.Length + $count -gt $Limit) { throw 'Download exceeds size limit.' }
            $buffered.Write($chunk, 0, $count)
        }
        return ,$buffered.ToArray()
    } finally { if ($stream) {$stream.Dispose()}; if ($response) {$response.Dispose()}; $buffered.Dispose(); $http.Dispose(); $handler.Dispose(); $cancel.Dispose() }
}
function Get-BtrSha([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
}
function Get-BtrManifest {
    $bytes = Get-BtrBytes ('https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.json?t=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) 65536
    $manifest = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -cnotmatch '^\d+\.\d+\.\d+\.\d+-d[1-9]\d*$' -or $manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid release manifest.' }
    $expected = 'https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/packages/BTR_Desktop-' + $manifest.version + '.zip'
    if ($manifest.downloadUrl -cne $expected) { throw 'Release package must belong to the BTR Desktop repository.' }
    if (-not $manifest.supportedClientVersions -or @($manifest.supportedClientVersions | Where-Object { $_ -notmatch '^\d+(\.\d+){2,3}$' }).Count) { throw 'Invalid client compatibility list.' }
    return $manifest
}
function Find-BtrClient([string]$Requested) {
    if ($Requested) { $candidates = @($Requested) }
    else {
        $candidates = @((Join-Path $env:ProgramFiles 'bilibili'), (Join-Path $env:LOCALAPPDATA 'Programs\bilibili'))
        if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'bilibili' }
        foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
            foreach ($item in @(Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
                if ($item.DisplayName -match 'bilibili|\u54d4\u54e9\u54d4\u54e9' -and $item.InstallLocation) { $candidates += $item.InstallLocation }
            }
        }
    }
    $exeName = ([char]0x54d4).ToString() + [char]0x54e9 + [char]0x54d4 + [char]0x54e9 + '.exe'
    foreach ($folder in $candidates) {
        if ((Test-Path -LiteralPath (Join-Path $folder $exeName) -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $folder 'resources\app.asar') -PathType Leaf)) { return [IO.Path]::GetFullPath($folder).TrimEnd('\') }
    }
    throw 'Bilibili client not found. Install the official Windows client first, or pass -ClientPath.'
}
function Expand-BtrPackage([string]$Archive, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $total = 0L
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/')
            if ($name -notmatch '^BTR_Desktop/[A-Za-z0-9_.\-/]*$' -or $name -match '(^|/)\.\.?(/|$)' -or -not $seen.Add($name)) { throw 'Unsafe package entry.' }
            if ($seen.Count -gt 128) { throw 'Too many package entries.' }
            $total += $entry.Length
            if ($total -gt 24MB) { throw 'Expanded package exceeds size limit.' }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $name))
            if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe extraction target.' }
            if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $zip.Dispose() }
}
function Stop-BtrClient([string]$Folder) {
    $exeName = ([char]0x54d4).ToString() + [char]0x54e9 + [char]0x54d4 + [char]0x54e9
    $expected = Join-Path $Folder ($exeName + '.exe')
    $matches = @()
    foreach ($process in @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)) {
        if (-not $process.Path) { throw 'Cannot verify running client path. Exit Bilibili before installing.' }
        if ([String]::Equals($process.Path, $expected, [StringComparison]::OrdinalIgnoreCase)) { $matches += $process }
    }
    if ($matches.Count) {
        Write-Host 'Closing only the selected Bilibili client to install BTR...'
        $matches | Stop-Process -ErrorAction SilentlyContinue
        $matches | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
}
function New-BtrShortcut([string]$Launcher, [string]$Folder) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'BTR Desktop.lnk'))
    $shortcut.TargetPath = $Launcher; $shortcut.Arguments = 'launch --client "' + $Folder + '"'
    $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($Launcher)
    $shortcut.Description = 'Bilibili with BTR Desktop'; $shortcut.Save()
}
function Install-BtrDesktop([string]$RequestedClient, [bool]$SkipLaunch) {
    $client = Find-BtrClient $RequestedClient
    Write-Host 'Checking the BTR Desktop release...'
    $manifest = Get-BtrManifest
    $bytes = Get-BtrBytes $manifest.downloadUrl 16MB
    if ((Get-BtrSha $bytes) -ne $manifest.sha256.ToLowerInvariant()) { throw 'Package SHA-256 mismatch. Nothing was installed.' }
    $root = Join-Path $env:LOCALAPPDATA 'BTR_Desktop'
    [IO.Directory]::CreateDirectory($root) | Out-Null
    if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root must not be a link.' }
    $stage = Join-Path $root ('stage-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        $zipPath = Join-Path $stage 'package.zip'; [IO.File]::WriteAllBytes($zipPath, $bytes)
        Expand-BtrPackage $zipPath $stage
        $packageRoot = Join-Path $stage 'BTR_Desktop'
        $config = Get-Content -LiteralPath (Join-Path $packageRoot 'desktop.json') -Raw | ConvertFrom-Json
        $payload = Get-Content -LiteralPath (Join-Path $packageRoot 'dist\payload.json') -Raw | ConvertFrom-Json
        if ($config.version -cne $manifest.version -or $payload.version -cne $manifest.version -or (Get-BtrSha ([IO.File]::ReadAllBytes((Join-Path $packageRoot 'dist\desktop.js')))) -ne $payload.sha256) { throw 'Package metadata verification failed.' }
        foreach ($required in @('BTR_Desktop.exe','install.ps1','tools\client-package.cjs','src\bootstrap.cjs')) { if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $required) -PathType Leaf)) { throw ('Missing package file: ' + $required) } }
        $versions = Join-Path $root 'versions'; [IO.Directory]::CreateDirectory($versions) | Out-Null
        if ((Get-Item -LiteralPath $versions).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Version directory must not be a link.' }
        # A fresh directory also permits recovery from a damaged installation of the same version.
        $destination = Join-Path $versions ($manifest.version + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
        $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
        if (-not [IO.Path]::GetFullPath($packageRoot).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($destination).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installation move.' }
        Move-Item -LiteralPath $packageRoot -Destination $destination
        $launcher = Join-Path $destination 'BTR_Desktop.exe'
        # Read-only compatibility check runs before closing the current video.
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect client.' }
        $status = $statusText | ConvertFrom-Json
        if (-not $status.supported -or $manifest.supportedClientVersions -notcontains $status.clientVersion) { throw ('Client ' + $status.clientVersion + ' is not supported. Original client was not changed.') }
        Stop-BtrClient $client
        & $launcher install --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'BTR install failed or Windows permission was cancelled.' }
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0 -or -not ($statusText | ConvertFrom-Json).current) { throw 'Installed files did not pass verification.' }
        New-BtrShortcut $launcher $client
        [IO.File]::WriteAllText((Join-Path $root 'current.json'), (@{version=$manifest.version;installPath=$destination;clientPath=$client} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Write-Host ('Installed BTR Desktop ' + $manifest.version + '. Use the BTR Desktop shortcut next time.') -ForegroundColor Green
        if (-not $SkipLaunch) { & $launcher launch --client $client --noninteractive; if ($LASTEXITCODE -ne 0) { throw 'Installed, but client launch failed.' } }
    } finally {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if ($resolvedStage.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\stage-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
}
if (-not $LibraryOnly) { Install-BtrDesktop $ClientPath ([bool]$NoLaunch) }
