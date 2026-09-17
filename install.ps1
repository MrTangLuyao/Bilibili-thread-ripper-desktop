param(
    [string]$ClientPath = '',
    [switch]$NoLaunch,
    [switch]$LibraryOnly,
    [switch]$Uninstall,
    [switch]$Reconnect,
    [string]$PackageRoot = '',
    [switch]$UpdateProgress,
    [switch]$CloseFirst,
    [string]$ExpectedVersion = '',
    [string]$ExpectedSha256 = ''
)
$ErrorActionPreference = 'Stop'
if ($UpdateProgress) { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $ProgressPreference = 'SilentlyContinue' }
function Write-BtrProgress([string]$Phase, [long]$Done = 0, [long]$Total = 0) {
    if ($UpdateProgress) { [Console]::WriteLine('BTR_PROGRESS ' + (@{phase=$Phase;done=$Done;total=$Total} | ConvertTo-Json -Compress)) }
}

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
            if ($Url -match '/packages/') { Write-BtrProgress 'download' $buffered.Length ([long]$response.Content.Headers.ContentLength) }
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
    # supportedClientVersions only serves d1-d4 updaters. d5 checks the client structure instead.
    if ($null -ne $manifest.supportedClientVersions -and @($manifest.supportedClientVersions | Where-Object { $_ -notmatch '^\d+(\.\d+){2,3}$' }).Count) { throw 'Invalid legacy client list.' }
    return $manifest
}
# Chinese text is kept as \u escapes so the script stays ASCII for Windows PowerShell 5.1.
function Get-BtrText([string]$Escaped) { return [regex]::Unescape($Escaped) }
function Test-BtrClient([string]$Folder) {
    try {
        if (-not $Folder -or -not [IO.Path]::IsPathRooted($Folder)) { return $false }
        $exeName = ([char]0x54d4).ToString() + [char]0x54e9 + [char]0x54d4 + [char]0x54e9 + '.exe'
        return ((Test-Path -LiteralPath (Join-Path $Folder $exeName) -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $Folder 'resources\app.asar') -PathType Leaf))
    } catch { return $false }
}
function Read-BtrLine([string]$Prompt) { return Read-Host $Prompt }
function Request-BtrClient([string]$DefaultFolder) {
    # The client is not in the default folder: ask for it. Accepts the folder or the dropped exe, quoted or not.
    Write-Host ''
    Write-Host ((Get-BtrText '\u6ca1\u6709\u5728\u9ed8\u8ba4\u4f4d\u7f6e\u627e\u5230\u54d4\u54e9\u54d4\u54e9\uff1a') + $DefaultFolder) -ForegroundColor Yellow
    Write-Host ((Get-BtrText '\u8bf7\u8f93\u5165\u54d4\u54e9\u54d4\u54e9\u7684\u5b89\u88c5\u6587\u4ef6\u5939\uff08\u91cc\u9762\u6709 \u54d4\u54e9\u54d4\u54e9.exe\uff09\uff0c\u6bd4\u5982 ') + 'D:\bilibili')
    Write-Host (Get-BtrText '\u4e0d\u77e5\u9053\u5728\u54ea\uff1a\u53f3\u952e\u684c\u9762\u4e0a\u7684\u54d4\u54e9\u54d4\u54e9\u56fe\u6807\uff0c\u9009\u201c\u6253\u5f00\u6587\u4ef6\u6240\u5728\u7684\u4f4d\u7f6e\u201d\uff0c\u628a\u5730\u5740\u680f\u7684\u8def\u5f84\u590d\u5236\u8fc7\u6765\u3002\u4e5f\u53ef\u4ee5\u76f4\u63a5\u628a \u54d4\u54e9\u54d4\u54e9.exe \u62d6\u8fdb\u8fd9\u4e2a\u7a97\u53e3\u3002')
    Write-Host (Get-BtrText '\u4ec0\u4e48\u90fd\u4e0d\u8f93\u5165\u76f4\u63a5\u6309\u56de\u8f66\u5c31\u53d6\u6d88\u3002')
    while ($true) {
        try { $answer = Read-BtrLine (Get-BtrText '\u54d4\u54e9\u54d4\u54e9\u5b89\u88c5\u6587\u4ef6\u5939') }
        catch { throw 'Bilibili client not found. Install the official Windows client first, or pass -ClientPath.' }
        if ([string]::IsNullOrWhiteSpace($answer)) { throw (Get-BtrText '\u5df2\u53d6\u6d88\uff0c\u6ca1\u6709\u505a\u4efb\u4f55\u4fee\u6539\u3002') }
        $folder = [Environment]::ExpandEnvironmentVariables($answer.Trim().Trim('"', "'").Trim())
        try { if ([IO.Path]::IsPathRooted($folder) -and (Test-Path -LiteralPath $folder -PathType Leaf)) { $folder = [IO.Path]::GetDirectoryName($folder) } } catch { }
        if (Test-BtrClient $folder) {
            $folder = [IO.Path]::GetFullPath($folder).TrimEnd('\')
            Write-Host ((Get-BtrText '\u627e\u5230\u54d4\u54e9\u54d4\u54e9\uff1a') + $folder) -ForegroundColor Green
            return $folder
        }
        Write-Host (Get-BtrText '\u8fd9\u91cc\u6ca1\u627e\u5230\u54d4\u54e9\u54d4\u54e9\uff0c\u8bf7\u8f93\u5165\u5b8c\u6574\u7684\u6587\u4ef6\u5939\u8def\u5f84\u518d\u8bd5\u4e00\u6b21\u3002') -ForegroundColor Yellow
    }
}
function Find-BtrClient([string]$Requested) {
    $defaultFolder = Join-Path $env:ProgramFiles 'bilibili'
    if ($Requested) { $candidates = @($Requested) }
    else {
        $candidates = @($defaultFolder)
        # The folder recorded by the last BTR install, so a forced update does not ask again.
        try { $candidates += ([IO.File]::ReadAllText((Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).clientPath } catch { }
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\bilibili'
        if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'bilibili' }
        # The official installer leaves InstallLocation empty, but its icon and uninstaller sit in the client folder.
        foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
            foreach ($item in @(Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
                if ($item.DisplayName -notmatch 'bilibili|\u54d4\u54e9\u54d4\u54e9') { continue }
                if ($item.InstallLocation) { $candidates += $item.InstallLocation.Trim().Trim('"') }
                foreach ($file in @($item.DisplayIcon, $item.UninstallString)) {
                    if ($file -match '^\s*"?([^"]+?\.(exe|ico))') { try { $candidates += [IO.Path]::GetDirectoryName($Matches[1]) } catch { } }
                }
            }
        }
    }
    foreach ($folder in $candidates) {
        if (Test-BtrClient $folder) { return [IO.Path]::GetFullPath($folder).TrimEnd('\') }
    }
    # Maintenance windows always pass the client and cannot answer a prompt.
    if (-not $Requested -and -not $UpdateProgress) { return Request-BtrClient $defaultFolder }
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
function Enter-BtrMaintenance([int]$Attempts = 50) {
    # The background guard waits while this file is held, so it never asks to reconnect mid-operation.
    $root = Join-Path $env:LOCALAPPDATA 'BTR_Desktop'
    [IO.Directory]::CreateDirectory($root) | Out-Null
    for ($i = 1; $i -le $Attempts; $i++) {
        try { return [IO.File]::Open((Join-Path $root 'maintenance.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { if ($i -lt $Attempts) { Start-Sleep -Milliseconds 200 } }
    }
    throw 'Another BTR maintenance task is running. Try again later.'
}
function Start-BtrGuard([string]$InstalledRoot) {
    # Registers the per-user startup entry and watches for official full reinstalls.
    try { Start-Process -FilePath (Join-Path $InstalledRoot 'BTR_Guard.exe') -ArgumentList 'guard','--register' -WorkingDirectory $InstalledRoot | Out-Null }
    catch { Write-Warning ('BTR is installed, but the background guard did not start: ' + $_.Exception.Message) }
}
function Get-BtrShortcutPath { return Join-Path ([Environment]::GetFolderPath('Desktop')) 'BTR Desktop.lnk' }
function Remove-BtrShortcut([string]$Folder, [string]$InstalledRoot) {
    $shortcutPath = Get-BtrShortcutPath
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if (-not $shortcut.TargetPath -or -not [IO.Path]::IsPathRooted($shortcut.TargetPath)) { return }
    $target = [IO.Path]::GetFullPath($shortcut.TargetPath)
    $exact = Join-Path ([IO.Path]::GetFullPath($InstalledRoot)) 'BTR_Desktop.exe'
    $versionsPrefix = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'BTR_Desktop\versions')).TrimEnd('\') + '\'
    $owned = [String]::Equals($target,$exact,[StringComparison]::OrdinalIgnoreCase) -or ($target.StartsWith($versionsPrefix,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($target) -ieq 'BTR_Desktop.exe')
    if ($owned -and $shortcut.Arguments -ceq ('launch --client "' + $Folder + '"')) { Remove-Item -LiteralPath $shortcutPath -Force }
}
function Install-BtrDesktop([string]$RequestedClient, [bool]$SkipLaunch) {
    # Find the client before taking the lock, so the guard does not wait while someone types a folder.
    $client = Find-BtrClient $RequestedClient
    $lock = Enter-BtrMaintenance
    try { Invoke-BtrInstall $client $SkipLaunch } finally { $lock.Dispose() }
}
function Invoke-BtrInstall([string]$RequestedClient, [bool]$SkipLaunch) {
    $client = Find-BtrClient $RequestedClient
    if ($CloseFirst) { Write-BtrProgress 'closing'; Stop-BtrClient $client }
    Write-BtrProgress 'manifest'
    Write-Host 'Checking the BTR Desktop release...'
    $manifest = Get-BtrManifest
    if (($ExpectedVersion -and $manifest.version -cne $ExpectedVersion) -or ($ExpectedSha256 -and $manifest.sha256 -ine $ExpectedSha256)) { throw 'Release changed after confirmation. Check for updates again. Nothing was installed.' }
    Write-BtrProgress 'download'
    $bytes = Get-BtrBytes $manifest.downloadUrl 16MB
    Write-BtrProgress 'verify'
    if ((Get-BtrSha $bytes) -ne $manifest.sha256.ToLowerInvariant()) { throw 'Package SHA-256 mismatch. Nothing was installed.' }
    $root = Join-Path $env:LOCALAPPDATA 'BTR_Desktop'
    [IO.Directory]::CreateDirectory($root) | Out-Null
    if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root must not be a link.' }
    $stage = Join-Path $root ('stage-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        $zipPath = Join-Path $stage 'package.zip'; [IO.File]::WriteAllBytes($zipPath, $bytes)
        Write-BtrProgress 'extract'
        Expand-BtrPackage $zipPath $stage
        $packageRoot = Join-Path $stage 'BTR_Desktop'
        $config = Get-Content -LiteralPath (Join-Path $packageRoot 'desktop.json') -Raw | ConvertFrom-Json
        $payload = Get-Content -LiteralPath (Join-Path $packageRoot 'dist\payload.json') -Raw | ConvertFrom-Json
        if ($config.version -cne $manifest.version -or $payload.version -cne $manifest.version -or (Get-BtrSha ([IO.File]::ReadAllBytes((Join-Path $packageRoot 'dist\desktop.js')))) -ne $payload.sha256) { throw 'Package metadata verification failed.' }
        foreach ($required in @('BTR_Desktop.exe','BTR_Guard.exe','install.ps1','tools\client-package.cjs','src\bootstrap.cjs')) { if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $required) -PathType Leaf)) { throw ('Missing package file: ' + $required) } }
        $versions = Join-Path $root 'versions'; [IO.Directory]::CreateDirectory($versions) | Out-Null
        if ((Get-Item -LiteralPath $versions).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Version directory must not be a link.' }
        # A fresh directory also permits recovery from a damaged installation of the same version.
        $destination = Join-Path $versions ($manifest.version + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
        $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
        if (-not [IO.Path]::GetFullPath($packageRoot).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($destination).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installation move.' }
        Move-Item -LiteralPath $packageRoot -Destination $destination
        $launcher = Join-Path $destination 'BTR_Desktop.exe'
        Write-BtrProgress 'compatibility'
        # Read-only structure check runs before closing the current video. Any client version is accepted.
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect client.' }
        $status = $statusText | ConvertFrom-Json
        if (-not $status.supported) { throw ('The structure of client ' + $status.clientVersion + ' is not recognized. Original client was not changed.') }
        if (-not $CloseFirst) { Write-BtrProgress 'closing'; Stop-BtrClient $client }
        Write-BtrProgress 'install'
        & $launcher install --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'BTR install failed or Windows permission was cancelled.' }
        Write-BtrProgress 'validate'
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0 -or -not ($statusText | ConvertFrom-Json).current) { throw 'Installed files did not pass verification.' }
        Remove-BtrShortcut $client $destination
        [IO.File]::WriteAllText((Join-Path $root 'current.json'), (@{version=$manifest.version;installPath=$destination;clientPath=$client} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Start-BtrGuard $destination
        Write-Host ('Installed BTR Desktop ' + $manifest.version + '. Open Bilibili normally; no BTR shortcut is created.') -ForegroundColor Green
        if (-not $SkipLaunch) { Write-BtrProgress 'restart'; & $launcher launch --client $client --noninteractive; if ($LASTEXITCODE -ne 0) { throw 'Installed, but client launch failed.' } }
        Write-BtrProgress 'complete'
    } finally {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if ($resolvedStage.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\stage-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
}
function Get-BtrLauncher([string]$InstalledRoot) {
    if (-not $InstalledRoot -or -not [IO.Path]::IsPathRooted($InstalledRoot)) { throw 'Missing BTR installation directory.' }
    $launcher = Join-Path ([IO.Path]::GetFullPath($InstalledRoot)) 'BTR_Desktop.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'BTR maintenance launcher not found.' }
    return $launcher
}
function Remove-BtrDesktop([string]$RequestedClient, [string]$InstalledRoot, [bool]$SkipLaunch) {
    $client = Find-BtrClient $RequestedClient
    $launcher = Get-BtrLauncher $InstalledRoot
    $lock = Enter-BtrMaintenance
    try {
        # Validate the deployment and original backup while the current video is still open.
        Write-BtrProgress 'backup'
        $checkText = & $launcher check-remove --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'Cannot verify original backup. Client was not closed or changed.' }
        $check = $checkText | ConvertFrom-Json
        if ($check.state -notin @('ready-to-remove','not-installed')) { throw 'Unexpected uninstall status.' }
        Write-BtrProgress 'closing'
        Stop-BtrClient $client
        Write-BtrProgress 'restore'
        & $launcher remove --client $client --noninteractive --keep-record
        if ($LASTEXITCODE -ne 0) { throw 'BTR removal failed or Windows permission was cancelled. Backup is preserved.' }
        Write-BtrProgress 'validate'
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'Cannot verify removal.' }
        $status = $statusText | ConvertFrom-Json
        if ($status.installed -or ($check.state -eq 'ready-to-remove' -and $status.sha256 -cne $check.originalSha256)) { throw 'Official client restoration did not pass verification.' }
        # Remove only this installation's shortcut, pointer and startup entry. The guard exits once
        # its pointer is gone. Keep backups, source and user data.
        Write-BtrProgress 'cleanup'
        Remove-BtrShortcut $client $InstalledRoot
        & $launcher forget --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'BTR was removed, but its installation record could not be cleared.' }
        Write-Host 'BTR removed. Official client restored; account data and settings preserved.' -ForegroundColor Green
        if (-not $SkipLaunch) {
            Write-BtrProgress 'restart'
            $exeName = ([char]0x54d4).ToString() + [char]0x54e9 + [char]0x54d4 + [char]0x54e9 + '.exe'
            # Start the official EXE directly. The BTR launcher would install the patch again.
            Start-Process -FilePath (Join-Path $client $exeName) -WorkingDirectory $client | Out-Null
        }
        Write-BtrProgress 'complete'
    } finally { $lock.Dispose() }
}
function Repair-BtrDesktop([string]$RequestedClient, [string]$InstalledRoot, [bool]$SkipLaunch) {
    # Used by the guard after an official full installer replaced app.asar. Works offline
    # from the installed package; a new original backup is taken from the new client.
    $client = Find-BtrClient $RequestedClient
    $launcher = Get-BtrLauncher $InstalledRoot
    $lock = Enter-BtrMaintenance
    try {
        Write-BtrProgress 'compatibility'
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect client.' }
        $status = $statusText | ConvertFrom-Json
        if (-not $status.supported) { throw ('The structure of client ' + $status.clientVersion + ' is not recognized. Original client was not changed.') }
        Write-BtrProgress 'closing'
        Stop-BtrClient $client
        Write-BtrProgress 'install'
        & $launcher repair --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'BTR install failed or Windows permission was cancelled.' }
        Write-BtrProgress 'validate'
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0 -or -not ($statusText | ConvertFrom-Json).current) { throw 'Installed files did not pass verification.' }
        Write-Host ('Reconnected BTR to Bilibili ' + $status.clientVersion + '.') -ForegroundColor Green
        if (-not $SkipLaunch) { Write-BtrProgress 'restart'; & $launcher launch --client $client --noninteractive; if ($LASTEXITCODE -ne 0) { throw 'Reconnected, but client launch failed.' } }
        Write-BtrProgress 'complete'
    } finally { $lock.Dispose() }
}
if (-not $LibraryOnly) {
    if ($Uninstall) { Remove-BtrDesktop $ClientPath $PackageRoot ([bool]$NoLaunch) }
    elseif ($Reconnect) { Repair-BtrDesktop $ClientPath $PackageRoot ([bool]$NoLaunch) }
    else { Install-BtrDesktop $ClientPath ([bool]$NoLaunch) }
}
