param(
    [string]$ClientPath = '',
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'

# Fetch a fresh official installer instead of relying on the installed updater.
# The installer always reinstalls the manifest version, even if it is unchanged.
# Its package hashes, client compatibility checks and original backups still apply.
$btrInstallerUrl = 'https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/install.ps1?t=' + [Guid]::NewGuid().ToString('N')
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Write-Host 'Fetching the latest BTR Desktop installer for a forced update...'
try {
    $btrInstallerSource = Invoke-RestMethod -Uri $btrInstallerUrl -TimeoutSec 90 -MaximumRedirection 0 -Headers @{'Cache-Control'='no-cache'} -ErrorAction Stop
    if ($btrInstallerSource -isnot [string] -or [string]::IsNullOrWhiteSpace($btrInstallerSource) -or $btrInstallerSource.Length -gt 262144) {
        throw 'The repository returned an invalid installer. Nothing was installed.'
    }
    & ([ScriptBlock]::Create($btrInstallerSource)) -ClientPath $ClientPath -NoLaunch:$NoLaunch
} catch {
    throw ('BTR force update failed: ' + $_.Exception.Message)
}
