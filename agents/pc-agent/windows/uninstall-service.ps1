# Removes the Sklad agent tasks. Logs, job state and user files stay on disk.
$ErrorActionPreference = "Stop"
foreach ($name in @("SkladPcAgent", "SkladDriveAgent")) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Output "$name removed"
  }
}
# Stop-ScheduledTask ends only the launcher; end the node processes it started.
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*pc-agent*windows*supervisor.mjs*" -or $_.CommandLine -like "*pc-agent*server.mjs*" -or $_.CommandLine -like "*pc-agent*drive.mts*") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$legacy = Get-ScheduledTask -TaskName "Sklad Windows Drive Agent" -ErrorAction SilentlyContinue
if ($legacy -and $legacy.State -eq "Disabled") {
  Enable-ScheduledTask -TaskName "Sklad Windows Drive Agent" | Out-Null
  Write-Output "Старая задача 'Sklad Windows Drive Agent' снова включена."
}
Write-Output "SkladPcAgent removed"
