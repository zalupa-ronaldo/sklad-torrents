/** Read-only CIM query. The indexer refuses any other PowerShell text. */
export const WINDOWS_VOLUME_SCRIPT = `
$ErrorActionPreference = 'Stop'
$disks = @(Get-CimInstance -ClassName Win32_DiskDrive | Select-Object Index, SerialNumber, Size, Model)
$parts = @(Get-Partition | Select-Object DiskNumber, DriveLetter)
$vols = @(Get-Volume | Select-Object DriveLetter, FileSystem, FileSystemLabel, Size, SizeRemaining, UniqueId)
$perf = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk | Select-Object Name, PercentDiskTime)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[pscustomobject]@{ disks = $disks; parts = $parts; vols = $vols; perf = $perf; admin = [bool]$admin } | ConvertTo-Json -Depth 4
`.trim();
