$ErrorActionPreference = "Stop"
$taskName = "SkladPcAgent"
$node = (Get-Command node -ErrorAction Stop).Source
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$supervisor = Join-Path $PSScriptRoot "supervisor.mjs"
$data = Join-Path $env:ProgramData "Sklad\agent"
$logDir = Join-Path $data "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$envFile = Join-Path $data "service-env.cmd"
@(
  "@echo off"
  "set SKLAD_PC_AGENT_STATE=$data\jobs.json"
  "set SKLAD_PC_AGENT_LOG_DIR=$logDir"
  "cd /d $repo"
  "`"$node`" `"$supervisor`""
) | Set-Content -Path $envFile -Encoding ASCII
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$envFile`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "SkladPcAgent installed"
