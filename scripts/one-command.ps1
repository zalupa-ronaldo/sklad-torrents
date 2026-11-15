# Одна команда установки Склада на Windows.
# Ставит зависимости панели Windows Node и вызывает Ubuntu WSL для пакета qbittorrent-nox.
# Диск Z: не читается. Секреты, прошивки и ключи не скачиваются.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Test-ForbiddenPath([string]$Path) {
  return $Path -match '^[Zz]:' -or $Path -match '/mnt/[zZ]($|/)' -or $Path -match '\\mnt\\[zZ]($|\\)'
}

if (Test-ForbiddenPath $Root) {
  [Console]::Error.WriteLine("Диск Z: не используется.")
  exit 1
}

if ($args -contains "--help" -or $args -contains "-h") {
  & node (Join-Path $Root "scripts\one-command.mjs") --help
  exit $LASTEXITCODE
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  [Console]::Error.WriteLine("Нужен Node.js 22 для Windows с https://nodejs.org/. Node из WSL для агента не подходит.")
  exit 1
}

$Platform = & node -p "process.platform"
if ($Platform -ne "win32") {
  [Console]::Error.WriteLine("Сейчас node отвечает платформой $Platform. Для агента нужен Windows Node, не node из WSL.")
  exit 1
}

& node (Join-Path $Root "scripts\one-command.mjs") @args --role win
exit $LASTEXITCODE
