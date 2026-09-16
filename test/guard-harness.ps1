param([string]$Guard, [string]$Fixture)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
# Loads the real guard program and calls its decision helpers. Registry checks use a throwaway key.
$assembly=[Reflection.Assembly]::LoadFrom($Guard)
$flags=[Reflection.BindingFlags]'NonPublic,Public,Static'
$guardType=$assembly.GetType('Guard'); $program=$assembly.GetType('Program')
# PowerShell wraps values it passes around. Reflection needs the plain .NET objects.
function ConvertTo-Plain([object[]]$values) { $plain=New-Object 'object[]' $values.Count; for($i=0;$i -lt $values.Count;$i++){ if($null -ne $values[$i]){ $plain[$i]=$values[$i].PSObject.BaseObject } }; return ,$plain }
function Invoke-Static($type, [string]$name, [object[]]$arguments) { return $type.GetMethod($name,$flags).Invoke($null,(ConvertTo-Plain $arguments)) }

# Relay and the guard pass paths on command lines. Quoting must survive Windows parsing.
Add-Type -Namespace BtrTest -Name Native -MemberDefinition '[DllImport("shell32.dll")] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line, out int count); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);'
$values=[string[]]@('C:\Program Files\bilibili','C:\with space\','quote"inside','back\"slash','trailing\\','','plain','--window')
$line='program.exe ' + (Invoke-Static $program 'Arguments' @(,$values))
$count=0; $memory=[BtrTest.Native]::CommandLineToArgvW($line,[ref]$count)
$parsed=@(for($i=1;$i -lt $count;$i++){ [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory,$i*[IntPtr]::Size)) })
[BtrTest.Native]::LocalFree($memory) | Out-Null
if($parsed.Count -ne $values.Count){throw "Argument count changed: $line"}
for($i=0;$i -lt $values.Count;$i++){ if($parsed[$i] -cne $values[$i]){throw ('Argument changed: ' + $values[$i] + ' -> ' + $parsed[$i])} }

$base='Software\BTR_Desktop_Test'
$key=$base + '\' + [Guid]::NewGuid().ToString('N')
try {
    $mine='C:\BTR test\versions\mine'; $other='C:\BTR test\versions\other'
    Invoke-Static $guardType 'Register' @(($key+'\Run'),$mine) | Out-Null
    $value=(Get-ItemProperty -LiteralPath ('HKCU:\'+$key+'\Run'))."BTR Desktop"
    if($value -cne '"C:\BTR test\versions\mine\BTR_Guard.exe" guard'){throw "Unexpected startup command: $value"}
    if(Invoke-Static $guardType 'Unregister' @(($key+'\Run'),$other)){throw 'Removed the startup entry of another installation'}
    if(-not (Invoke-Static $guardType 'Unregister' @(($key+'\Run'),$mine))){throw 'Did not remove its own startup entry'}
    if($null -ne (Get-ItemProperty -LiteralPath ('HKCU:\'+$key+'\Run'))."BTR Desktop"){throw 'Startup entry survived'}
    # Task Manager keeps an enabled/disabled switch per entry. Disabled means the guard stays off.
    $approved='HKCU:\'+$key+'\Approved'
    New-Item -Path $approved -Force | Out-Null
    if(Invoke-Static $guardType 'DisabledByUser' @(($key+'\Approved'))){throw 'A missing switch was treated as disabled'}
    New-ItemProperty -LiteralPath $approved -Name 'BTR Desktop' -PropertyType Binary -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0)) | Out-Null
    if(-not (Invoke-Static $guardType 'DisabledByUser' @(($key+'\Approved')))){throw 'The disabled switch was ignored'}
    Set-ItemProperty -LiteralPath $approved -Name 'BTR Desktop' -Value ([byte[]](2,0,0,0,0,0,0,0,0,0,0,0))
    if(Invoke-Static $guardType 'DisabledByUser' @(($key+'\Approved'))){throw 'An enabled switch was treated as disabled'}
} finally {
    Remove-Item -LiteralPath ('HKCU:\'+$key) -Recurse -Force -ErrorAction SilentlyContinue
    if((Test-Path -LiteralPath ('HKCU:\'+$base)) -and -not (Get-ChildItem -LiteralPath ('HKCU:\'+$base))){ Remove-Item -LiteralPath ('HKCU:\'+$base) -Force }
}

$client=Join-Path $Fixture 'client'
$asar=Join-Path $client 'resources\app.asar'
if(Invoke-Static $guardType 'HasBtr' @($asar)){throw 'Official ASAR reported as patched'}
if(-not (Invoke-Static $guardType 'HasBtr' @((Join-Path $Fixture 'patched.asar')))){throw 'Patched ASAR not recognized'}
if(Invoke-Static $guardType 'HasBtr' @((Join-Path $Fixture 'missing.asar'))){throw 'Missing ASAR reported as patched'}

$env:LOCALAPPDATA=Join-Path $Fixture 'guard-data'
[IO.Directory]::CreateDirectory((Join-Path $env:LOCALAPPDATA 'BTR_Desktop')) | Out-Null
function Get-Decision($skipped) {
    $arguments=ConvertTo-Plain @($client,$skipped,$null)
    $action=$guardType.GetMethod('Decide',$flags).Invoke($null,$arguments)
    return @{action=[string]$action;stamp=$arguments[2]}
}
$none=New-Object 'Collections.Generic.HashSet[string]'
$decision=Get-Decision $none
if($decision.action -ne 'Ask' -or -not $decision.stamp){throw ('A replaced client should ask to reconnect, got ' + $decision.action)}
$skipped=New-Object 'Collections.Generic.HashSet[string]'; $skipped.Add($decision.stamp) | Out-Null
if((Get-Decision $skipped).action -ne 'None'){throw 'A declined client build was asked again'}
$lock=[IO.File]::Open((Invoke-Static $guardType 'LockPath' @()),'OpenOrCreate','ReadWrite','None')
try { if((Get-Decision $none).action -ne 'Retry'){throw 'The guard did not wait for running maintenance'} } finally { $lock.Dispose() }
if(Invoke-Static $guardType 'MaintenanceRunning' @()){throw 'Released lock still reported as busy'}
[IO.File]::Copy((Join-Path $Fixture 'patched.asar'),$asar,$true)
if((Get-Decision $none).action -ne 'None'){throw 'A patched client should be left alone'}
[IO.File]::Copy((Join-Path $Fixture 'strange.asar'),$asar,$true)
if((Get-Decision $none).action -ne 'Unsupported'){throw 'An unrecognized client structure should not be patched'}
'PASS guard quoting, startup entry ownership, Task Manager switch, header check, maintenance lock and reconnect decisions'
