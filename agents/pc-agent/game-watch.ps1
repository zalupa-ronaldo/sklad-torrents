# Original. Process start and stop are WMI events. Wait-Event blocks.
# A covering foreground window is noted once for that event. Nothing is polled,
# stopped, killed, or suspended. Steam and Playnite are not copied.

$ErrorActionPreference = "Stop"

function Test-CoveringForeground([int]$processId) {
  try {
    if (-not ("SkladWindow" -as [type])) {
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SkladWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
    }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $hwnd = [SkladWindow]::GetForegroundWindow()
    $owner = [uint32]0
    [void][SkladWindow]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($owner -ne [uint32]$processId) { return $false }
    $rect = New-Object SkladWindow+RECT
    if (-not [SkladWindow]::GetWindowRect($hwnd, [ref]$rect)) { return $false }
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    return (($rect.R - $rect.L) -ge $screen.Width) -and (($rect.B - $rect.T) -ge $screen.Height)
  } catch {
    return $false
  }
}

function Emit-Row($type, $processId, $name, $exePath, $covering) {
  $row = @{
    type = $type
    pid = [int]$processId
    name = [string]$name
    exePath = [string]$exePath
    fullscreen = [bool]$covering
    gpu = [bool]$covering
  }
  Write-Output ($row | ConvertTo-Json -Compress)
}

try {
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier SkladGameStart | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier SkladGameStop | Out-Null
} catch {
  Write-Output '{"lost":true}'
  exit 1
}

Get-CimInstance Win32_Process | ForEach-Object {
  $name = [string]$_.Name
  if ($name -and -not $name.ToLower().EndsWith(".exe")) { $name = "$name.exe" }
  $covering = Test-CoveringForeground ([int]$_.ProcessId)
  Emit-Row "start" $_.ProcessId $name $_.ExecutablePath $covering
}

while ($true) {
  $event = Wait-Event
  if (-not $event) { continue }
  if ($event.SourceIdentifier -ne "SkladGameStart" -and $event.SourceIdentifier -ne "SkladGameStop") {
    Remove-Event -EventIdentifier $event.EventIdentifier
    continue
  }
  $type = $(if ($event.SourceIdentifier -eq "SkladGameStop") { "stop" } else { "start" })
  $id = [int]$event.SourceEventArgs.NewEvent.ProcessID
  $name = [string]$event.SourceEventArgs.NewEvent.ProcessName
  if ($name -and -not $name.ToLower().EndsWith(".exe")) { $name = "$name.exe" }
  $covering = $(if ($type -eq "start") { Test-CoveringForeground $id } else { $false })
  Emit-Row $type $id $name "" $covering
  Remove-Event -EventIdentifier $event.EventIdentifier
}
