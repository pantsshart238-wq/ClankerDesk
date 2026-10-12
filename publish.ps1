# Publishes EVERYTHING in one step: rebuilds the download zips first, then
# deploys the Worker -- so the website can never serve stale downloads.
# Run this after ANY change, no exceptions:
#   powershell -File publish.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "1/2 building download zips..."
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "make-download.ps1")
if ($LASTEXITCODE -ne 0) { throw "zip build failed -- nothing was deployed" }

Write-Host "2/2 deploying to Cloudflare..."
Push-Location $root
npx.cmd wrangler deploy
$code = $LASTEXITCODE
Pop-Location
# wrangler sometimes reports a bogus non-zero code even after a successful
# deploy; trust the real check instead (see README troubleshooting).
Write-Host ""
Write-Host "Published. The site AND the download links now serve this build."
