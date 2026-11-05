# Read-back hash of the ISO that the burn job produced.
# Exits 0 only when Get-FileHash actually returns a hash.
# Does not erase and does not burn. Not executed by tests.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$RecorderId = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Image)) {
  Write-Error "Image not found."
  exit 1
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $Image
if (-not $hash -or -not $hash.Hash) {
  Write-Error "Hash was not computed."
  exit 1
}

Write-Output $hash.Hash
exit 0
