param(
    [string]$ClientPath = '',
    [switch]$NoLaunch,
    [switch]$LibraryOnly,
    [switch]$Uninstall,
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
        foreach ($required in @('BTR_Desktop.exe','install.ps1','tools\client-package.cjs','src\bootstrap.cjs')) { if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $required) -PathType Leaf)) { throw ('Missing package file: ' + $required) } }
        $versions = Join-Path $root 'versions'; [IO.Directory]::CreateDirectory($versions) | Out-Null
        if ((Get-Item -LiteralPath $versions).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Version directory must not be a link.' }
        # A fresh directory also permits recovery from a damaged installation of the same version.
        $destination = Join-Path $versions ($manifest.version + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
        $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
        if (-not [IO.Path]::GetFullPath($packageRoot).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($destination).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installation move.' }
        Move-Item -LiteralPath $packageRoot -Destination $destination
        $launcher = Join-Path $destination 'BTR_Desktop.exe'
        Write-BtrProgress 'compatibility'
        # Read-only compatibility check runs before closing the current video.
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect client.' }
        $status = $statusText | ConvertFrom-Json
        if (-not $status.supported -or $manifest.supportedClientVersions -notcontains $status.clientVersion) { throw ('Client ' + $status.clientVersion + ' is not supported. Original client was not changed.') }
        if (-not $CloseFirst) { Write-BtrProgress 'closing'; Stop-BtrClient $client }
        Write-BtrProgress 'install'
        & $launcher install --client $client --noninteractive
        if ($LASTEXITCODE -ne 0) { throw 'BTR install failed or Windows permission was cancelled.' }
        Write-BtrProgress 'validate'
        $statusText = & $launcher status --client $client --noninteractive
        if ($LASTEXITCODE -ne 0 -or -not ($statusText | ConvertFrom-Json).current) { throw 'Installed files did not pass verification.' }
        Remove-BtrShortcut $client $destination
        [IO.File]::WriteAllText((Join-Path $root 'current.json'), (@{version=$manifest.version;installPath=$destination;clientPath=$client} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Write-Host ('Installed BTR Desktop ' + $manifest.version + '. Open Bilibili normally; no BTR shortcut is created.') -ForegroundColor Green
        if (-not $SkipLaunch) { Write-BtrProgress 'restart'; & $launcher launch --client $client --noninteractive; if ($LASTEXITCODE -ne 0) { throw 'Installed, but client launch failed.' } }
        Write-BtrProgress 'complete'
    } finally {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if ($resolvedStage.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\stage-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
}
function Remove-BtrDesktop([string]$RequestedClient, [string]$InstalledRoot, [bool]$SkipLaunch) {
    $client = Find-BtrClient $RequestedClient
    if (-not $InstalledRoot -or -not [IO.Path]::IsPathRooted($InstalledRoot)) { throw 'Missing BTR installation directory.' }
    $launcher = Join-Path ([IO.Path]::GetFullPath($InstalledRoot)) 'BTR_Desktop.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'BTR maintenance launcher not found.' }
    # Validate the deployment and original backup while the current video is still open.
    Write-BtrProgress 'backup'
    $checkText = & $launcher check-remove --client $client --noninteractive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify original backup. Client was not closed or changed.' }
    $check = $checkText | ConvertFrom-Json
    if ($check.state -notin @('ready-to-remove','not-installed')) { throw 'Unexpected uninstall status.' }
    Write-BtrProgress 'closing'
    Stop-BtrClient $client
    Write-BtrProgress 'restore'
    & $launcher remove --client $client --noninteractive
    if ($LASTEXITCODE -ne 0) { throw 'BTR removal failed or Windows permission was cancelled. Backup is preserved.' }
    Write-BtrProgress 'validate'
    $statusText = & $launcher status --client $client --noninteractive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify removal.' }
    $status = $statusText | ConvertFrom-Json
    if ($status.installed -or ($check.state -eq 'ready-to-remove' -and $status.sha256 -cne $check.originalSha256)) { throw 'Official client restoration did not pass verification.' }
    # Remove only this installation's shortcut and pointer. Keep backups, source and user data.
    Write-BtrProgress 'cleanup'
    Remove-BtrShortcut $client $InstalledRoot
    $currentPath = Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json'
    if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
        $current = [IO.File]::ReadAllText($currentPath) | ConvertFrom-Json
        if ([String]::Equals($current.installPath,[IO.Path]::GetFullPath($InstalledRoot),[StringComparison]::OrdinalIgnoreCase) -and [String]::Equals($current.clientPath,$client,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $currentPath -Force }
    }
    Write-Host 'BTR removed. Official client restored; account data and settings preserved.' -ForegroundColor Green
    if (-not $SkipLaunch) {
        Write-BtrProgress 'restart'
        $exeName = ([char]0x54d4).ToString() + [char]0x54e9 + [char]0x54d4 + [char]0x54e9 + '.exe'
        # Start the official EXE directly. The BTR launcher would install the patch again.
        Start-Process -FilePath (Join-Path $client $exeName) -WorkingDirectory $client -WindowStyle Hidden | Out-Null
    }
    Write-BtrProgress 'complete'
}
if (-not $LibraryOnly) {
    if ($Uninstall) { Remove-BtrDesktop $ClientPath $PackageRoot ([bool]$NoLaunch) }
    else { Install-BtrDesktop $ClientPath ([bool]$NoLaunch) }
}
