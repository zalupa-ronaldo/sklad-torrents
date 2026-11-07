/**
 * Read-only per-letter inventory.
 * Letters come from MountedDevices names. Excluded letters are removed before any
 * Get-Volume, Get-Partition, or CIM call. A stale or inaccessible letter is recorded
 * and skipped; it does not discard the other letters or the administrator token.
 * The token is WindowsIdentity, measured before those probes.
 * This does not claim Windows itself never touches a mounted volume.
 */
export const ABSENT_VOLUME_ERROR =
  "NotFound_DriveLetter|No MSFT_Volume objects found|No MSFT_Partition objects found";

export const ACCESS_VOLUME_ERROR =
  "Access is denied|Отказано в доступе|UnauthorizedAccess|0x80070005";

export function classifyVolumeProbeError(detail: string): "absent" | "access" | "error" {
  if (new RegExp(ABSENT_VOLUME_ERROR, "i").test(detail)) return "absent";
  if (new RegExp(ACCESS_VOLUME_ERROR, "i").test(detail)) return "access";
  return "error";
}

export const WINDOWS_VOLUME_SCRIPT = `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$exclude = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($item in ([string]$env:SKLAD_EXCLUDE_LETTERS).ToUpper().Split(',')) {
  $token = $item.Trim().TrimEnd(':')
  if ($token -match '^[A-Z]$') { [void]$exclude.Add($token) }
}
if (-not (Get-Command Test-SkladElevation -ErrorAction SilentlyContinue)) {
  function Test-SkladElevation {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
}
$admin = [bool](Test-SkladElevation)
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
$skipped = New-Object System.Collections.Generic.List[object]
$queried = New-Object System.Collections.Generic.List[string]
foreach ($letter in $allowed) {
  if ($exclude.Contains($letter)) { continue }
  [void]$queried.Add($letter)
  $raw = $null
  try {
    $raw = Get-Volume -DriveLetter $letter -ErrorAction Stop | Select-Object DriveLetter, FileSystem, FileSystemLabel, Size, SizeRemaining, UniqueId
  } catch {
    $detail = ([string]$_.FullyQualifiedErrorId) + [char]10 + ([string]$_.Exception.Message)
    $kind = 'error'
    if ($detail -match '${ABSENT_VOLUME_ERROR}') { $kind = 'absent' }
    elseif ($detail -match '${ACCESS_VOLUME_ERROR}') { $kind = 'access' }
    [void]$skipped.Add([pscustomobject]@{ letter = $letter; kind = $kind; message = [string]$_.Exception.Message })
    continue
  }
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($item in @($raw)) { if ($null -ne $item) { [void]$found.Add($item) } }
  if ($found.Count -eq 0) {
    [void]$skipped.Add([pscustomobject]@{ letter = $letter; kind = 'absent'; message = 'Буква есть в реестре, том не подключён.' })
    continue
  }
  foreach ($item in $found) { [void]$vols.Add($item) }
  try {
    $partsRaw = Get-Partition -DriveLetter $letter -ErrorAction Stop | Select-Object DiskNumber, DriveLetter
    foreach ($part in @($partsRaw)) {
      if ($null -eq $part) { continue }
      [void]$parts.Add($part)
      try {
        $diskRaw = Get-CimInstance -ClassName Win32_DiskDrive -Filter ("Index=" + [int]$part.DiskNumber) -ErrorAction Stop | Select-Object Index, SerialNumber, Size, Model
        foreach ($disk in @($diskRaw)) { if ($null -ne $disk) { [void]$disks.Add($disk) } }
      } catch { }
    }
  } catch { }
  try {
    $perfRaw = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter ("Name='" + $letter + ":'") -ErrorAction Stop | Select-Object Name, PercentDiskTime
    foreach ($row in @($perfRaw)) { if ($null -ne $row) { [void]$perf.Add($row) } }
  } catch { }
}
[pscustomobject]@{
  disks = $disks.ToArray()
  parts = $parts.ToArray()
  vols = $vols.ToArray()
  perf = $perf.ToArray()
  probed = $allowed.ToArray()
  queried = $queried.ToArray()
  skipped = $skipped.ToArray()
  admin = [bool]$admin
} | ConvertTo-Json -Depth 4
`.trim();
