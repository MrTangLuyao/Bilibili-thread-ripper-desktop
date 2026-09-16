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
$script:Guards=@()
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
function Get-BtrShortcutPath { return Join-Path $Fixture 'BTR Desktop.lnk' }
# Never register a real startup entry for a fixture installation.
function Start-BtrGuard([string]$InstalledRoot) { $script:Guards += $InstalledRoot }
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
if($current.version -ne (Get-Content -LiteralPath (Join-Path $Project 'desktop.json') -Raw | ConvertFrom-Json).version -or $script:Stopped -ne 1){throw 'Installation not completed'}
if($script:Guards.Count -ne 1 -or $script:Guards[0] -ne $current.installPath){throw 'Installation did not start the guard for its own folder'}
if(-not (Test-Path -LiteralPath (Join-Path $current.installPath 'BTR_Guard.exe') -PathType Leaf)){throw 'Guard program missing from the installation'}
$firstRoot=$current.installPath
if(Test-Path -LiteralPath (Get-BtrShortcutPath)){throw 'Installer unexpectedly created a shortcut'}
# Simulate the old release's shortcut: upgrading must remove it, not replace it.
$shell=New-Object -ComObject WScript.Shell
$legacy=$shell.CreateShortcut((Get-BtrShortcutPath));$legacy.TargetPath=Join-Path $firstRoot 'BTR_Desktop.exe';$legacy.Arguments='launch --client "'+$client+'"';$legacy.Save()
# Re-running the one-line command must repair from the original backup, not nest patches.
Install-BtrDesktop $client $true
$current=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json') -Raw | ConvertFrom-Json
if($current.installPath -eq $firstRoot -or $script:Stopped -ne 2){throw 'Reinstall path not updated'}
if(Test-Path -LiteralPath (Get-BtrShortcutPath)){throw 'Legacy shortcut survived upgrade'}
$launcher=Join-Path $current.installPath 'BTR_Desktop.exe'
$legacy=$shell.CreateShortcut((Get-BtrShortcutPath));$legacy.TargetPath=$launcher;$legacy.Arguments='launch --client "'+$client+'"';$legacy.Save()
# Verify d1's old updater cannot leave a newly-created shortcut behind at launch.
$assembly=[Reflection.Assembly]::LoadFrom($launcher)
$cleanup=$assembly.GetType('Program').GetMethod('RemoveLegacyShortcut',[Reflection.BindingFlags]'NonPublic,Static')
$cleanup.Invoke($null,([string[]]@($client,$launcher,(Get-BtrShortcutPath)))) | Out-Null
if(Test-Path -LiteralPath (Get-BtrShortcutPath)){throw 'Launcher did not clean a shortcut created by the legacy updater'}
$legacy=$shell.CreateShortcut((Get-BtrShortcutPath));$legacy.TargetPath=Join-Path $Fixture 'other.exe';$legacy.Save()
$cleanup.Invoke($null,([string[]]@($client,$launcher,(Get-BtrShortcutPath)))) | Out-Null
if(-not (Test-Path -LiteralPath (Get-BtrShortcutPath))){throw 'Launcher deleted an unrelated shortcut'}
$legacy=$shell.CreateShortcut((Get-BtrShortcutPath));$legacy.TargetPath=$launcher;$legacy.Arguments='launch --client "'+$client+'"';$legacy.Save()
$status=(& $launcher status --client $client --noninteractive)|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or -not $status.current -or $status.installed.installRoot -ne $current.installPath){throw 'Installed status is incorrect'}
# While one maintenance task holds the lock, another one (and the guard) must wait.
$held=Enter-BtrMaintenance
$blocked=$false
try { (Enter-BtrMaintenance 1).Dispose() } catch { $blocked=$_.Exception.Message -match 'Another BTR maintenance' }
$held.Dispose()
if(-not $blocked){throw 'Maintenance lock did not block a second task'}
(Enter-BtrMaintenance 1).Dispose()
# An official full installer replaced app.asar with a newer build. Reconnecting works offline,
# accepts the new version, keeps only the new original and does not start a second guard.
function Get-BtrBytes([string]$Url,[int]$Limit) { throw 'Network must not be used by reconnect or uninstall' }
$oldOriginal=$before
$next=[IO.File]::ReadAllBytes((Join-Path $Fixture 'next-app.asar'))
[IO.File]::WriteAllBytes($target,$next)
$before=Get-BtrSha $next
$guards=$script:Guards.Count
Repair-BtrDesktop $client $current.installPath $true
$status=(& $launcher status --client $client --noninteractive)|ConvertFrom-Json
if(-not $status.current -or $status.clientVersion -ne '1.19.0' -or $script:Stopped -ne 3 -or $script:Guards.Count -ne $guards){throw 'Reconnect did not patch the new client build'}
$backups=Join-Path $client 'resources\btr-desktop-backups'
if((Test-Path -LiteralPath (Join-Path $backups ($oldOriginal+'.asar'))) -or -not (Test-Path -LiteralPath (Join-Path $backups ($before+'.asar')))){throw 'The replaced build backup was kept or the new original is missing'}
# Uninstall must not need GitHub, and a damaged backup must not close the client.
$record=Get-Content -LiteralPath (Join-Path $backups 'deployment.json') -Raw | ConvertFrom-Json
$backup=Join-Path $backups ($record.originalSha256+'.asar')
$originalBytes=[IO.File]::ReadAllBytes($backup)
$patchedHash=Get-BtrSha ([IO.File]::ReadAllBytes($target))
[IO.File]::WriteAllText($backup,'damaged')
$refused=$false
try { Remove-BtrDesktop $client $current.installPath $true } catch { $refused=$true }
if(-not $refused -or $script:Stopped -ne 3 -or (Get-BtrSha ([IO.File]::ReadAllBytes($target))) -ne $patchedHash){throw 'Bad backup did not block removal before closing client'}
[IO.File]::WriteAllBytes($backup,$originalBytes)
$accountFile=Join-Path $env:LOCALAPPDATA 'account-sentinel.json'
[IO.File]::WriteAllText($accountFile,'keep-account-data')
Remove-BtrDesktop $client $current.installPath $false
$deadline=[DateTime]::UtcNow.AddSeconds(3)
while(-not (Test-Path -LiteralPath $env:BTR_TEST_LAUNCH_MARKER) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
if(-not (Test-Path -LiteralPath $env:BTR_TEST_LAUNCH_MARKER)){throw 'Official client was not restarted'}
if((Get-BtrSha ([IO.File]::ReadAllBytes($target))) -ne $before -or $script:Stopped -ne 4){throw 'Removal did not restore exact original bytes'}
if((Test-Path -LiteralPath (Get-BtrShortcutPath)) -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json'))){throw 'Matching BTR shortcut or install pointer not removed'}
if([IO.File]::ReadAllText($accountFile) -ne 'keep-account-data' -or -not (Test-Path -LiteralPath $backup)){throw 'User data or original backup was removed'}
# A shortcut pointing elsewhere and another installation record must be left alone.
$shell=New-Object -ComObject WScript.Shell
$otherShortcut=$shell.CreateShortcut((Get-BtrShortcutPath));$otherShortcut.TargetPath=Join-Path $Fixture 'other.exe';$otherShortcut.Save()
$pointer=Join-Path $env:LOCALAPPDATA 'BTR_Desktop\current.json'
[IO.File]::WriteAllText($pointer,'{"installPath":"C:\\another-install","clientPath":"C:\\another-client"}')
Remove-BtrDesktop $client $current.installPath $true
if(-not (Test-Path -LiteralPath (Get-BtrShortcutPath)) -or -not (Test-Path -LiteralPath $pointer)){throw 'Unrelated shortcut or installation pointer was deleted'}
# Reject path traversal before any file can escape the fresh staging folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$badZip=Join-Path $Fixture 'bad.zip'
$zip=[IO.Compression.ZipFile]::Open($badZip,[IO.Compression.ZipArchiveMode]::Create)
$entry=$zip.CreateEntry('BTR_Desktop/../../escape.txt');$writer=New-Object IO.StreamWriter($entry.Open());$writer.Write('bad');$writer.Dispose();$zip.Dispose()
$rejected=$false
try{Expand-BtrPackage $badZip (Join-Path $Fixture 'extract')}catch{$rejected=$true}
if(-not $rejected -or (Test-Path -LiteralPath (Join-Path $Fixture 'escape.txt'))){throw 'Unsafe ZIP was not rejected'}
'PASS Windows PowerShell IEX installation, reinstall, maintenance lock, offline reconnect to a new client build, offline uninstall, backup failure, exact restoration, scoped cleanup and unsafe ZIP rejection'
