# Installs the Sklad Windows agents as scheduled tasks that start at boot without a logon.
#   SkladPcAgent    - job agent (HandBrake, compact.exe, link heartbeat) on port 4730
#   SkladDriveAgent - drive/shelf agent on port 4372
# Run from an elevated PowerShell. Drive Z: is never used. User files are not deleted.
# -Mock keeps the job agent in demo mode. -BindHost 127.0.0.1 keeps it local-only.
param(
  [string]$BindHost = "0.0.0.0",
  [switch]$Mock,
  [switch]$NoFirewall,
  [string]$StableQbUrl = ""
)
$ErrorActionPreference = "Stop"
$taskName = "SkladPcAgent"
$driveTask = "SkladDriveAgent"
$legacyDriveTask = "Sklad Windows Drive Agent"
$node = (Get-Command node -ErrorAction Stop).Source
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$supervisor = Join-Path $PSScriptRoot "supervisor.mjs"
$data = Join-Path $env:ProgramData "Sklad\agent"
$logDir = Join-Path $data "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$mockValue = if ($Mock) { "1" } else { "0" }
$envValues = [ordered]@{
  SKLAD_PC_AGENT_STATE = "$data\jobs.json"
  SKLAD_PC_AGENT_LOG_DIR = $logDir
  SKLAD_PC_AGENT_HOST = $BindHost
  SKLAD_PC_AGENT_MOCK = $mockValue
  SKLAD_NODE = $node
}
if ($StableQbUrl) { $envValues["SKLAD_CHANNEL_STABLE_URL"] = $StableQbUrl }
$envValues | ConvertTo-Json | Set-Content -Path (Join-Path $data "agent-env.json") -Encoding UTF8
$launcher = Join-Path $PSScriptRoot "run-agent.ps1"

# S4U: runs at boot without a logged-on user and without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Kind job" -WorkingDirectory $repo
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
$driveAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Kind drive" -WorkingDirectory $repo
Register-ScheduledTask -TaskName $driveTask -Action $driveAction -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# The older hand-made drive task would race for port 4372 at boot. Disable it, keep it for rollback.
$legacy = Get-ScheduledTask -TaskName $legacyDriveTask -ErrorAction SilentlyContinue
if ($legacy -and $legacy.State -ne "Disabled") {
  Stop-ScheduledTask -TaskName $legacyDriveTask -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName $legacyDriveTask | Out-Null
  Write-Output "Старая задача '$legacyDriveTask' отключена (не удалена)."
}

if (-not $NoFirewall -and $BindHost -ne "127.0.0.1") {
  foreach ($rule in @(@{ Name = "Sklad PC Agent 4730 LAN"; Port = 4730 }, @{ Name = "Sklad Drive Agent 4372 LAN"; Port = 4372 }, @{ Name = "Sklad qBittorrent link 18080 LAN"; Port = 18080 })) {
    if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Port -RemoteAddress LocalSubnet -Profile Any | Out-Null
    }
  }
}

foreach ($name in @($taskName, $driveTask)) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Start-ScheduledTask -TaskName $name
}
Write-Output "SkladPcAgent installed"
Write-Output "SkladDriveAgent installed"
