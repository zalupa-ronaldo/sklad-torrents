/**
 * Read-only per-letter inventory.
 * Drive letters are read from the MountedDevices registry. Excluded letters are removed
 * before Get-Volume, Get-Partition, or CIM. Those cmdlets always receive one allowed letter.
 * This does not claim Windows itself never touches a volume; the agent does not name Z.
 */
export const WINDOWS_VOLUME_SCRIPT = `
$ErrorActionPreference = 'Stop'
$exclude = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($item in ([string]$env:SKLAD_EXCLUDE_LETTERS).ToUpper().Split(',')) {
  $token = $item.Trim().TrimEnd(':')
  if ($token -match '^[A-Z]$') { [void]$exclude.Add($token) }
}
$allowed = New-Object System.Collections.Generic.List[string]
$mounted = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\MountedDevices' -ErrorAction SilentlyContinue
if ($mounted) {
  foreach ($name in @($mounted.PSObject.Properties.Name)) {
    if ($name -match '\\\\DosDevices\\\\([A-Z]):$') {
      $letter = $Matches[1]
      if (-not $exclude.Contains($letter)) { [void]$allowed.Add($letter) }
    }
  }
}
$disks = New-Object System.Collections.Generic.List[object]
$parts = New-Object System.Collections.Generic.List[object]
$vols = New-Object System.Collections.Generic.List[object]
$perf = New-Object System.Collections.Generic.List[object]
foreach ($letter in $allowed) {
  if ($exclude.Contains($letter)) { continue }
  foreach ($vol in @(Get-Volume -DriveLetter $letter | Select-Object DriveLetter, FileSystem, FileSystemLabel, Size, SizeRemaining, UniqueId)) {
    if ($vol) { [void]$vols.Add($vol) }
  }
  foreach ($part in @(Get-Partition -DriveLetter $letter | Select-Object DiskNumber, DriveLetter)) {
    if (-not $part) { continue }
    [void]$parts.Add($part)
    foreach ($disk in @(Get-CimInstance -ClassName Win32_DiskDrive -Filter ("Index=" + [int]$part.DiskNumber) | Select-Object Index, SerialNumber, Size, Model)) {
      if ($disk) { [void]$disks.Add($disk) }
    }
  }
  foreach ($row in @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter ("Name='" + $letter + ":'") | Select-Object Name, PercentDiskTime)) {
    if ($row) { [void]$perf.Add($row) }
  }
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[pscustomobject]@{ disks = @($disks); parts = @($parts); vols = @($vols); perf = @($perf); probed = @($allowed); admin = [bool]$admin } | ConvertTo-Json -Depth 4
`.trim();
