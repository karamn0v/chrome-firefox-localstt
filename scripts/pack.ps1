$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "extension"
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "gigaam-stt.zip"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

Compress-Archive -Path (Join-Path $src "*") -DestinationPath $zip -CompressionLevel Optimal

$ffDir = Join-Path $dist "firefox"
if (Test-Path $ffDir) { Remove-Item $ffDir -Recurse -Force }
Copy-Item $src $ffDir -Recurse
Copy-Item (Join-Path $src "manifest.firefox.json") (Join-Path $ffDir "manifest.json") -Force
Remove-Item (Join-Path $ffDir "manifest.firefox.json") -Force
$ffZip = Join-Path $dist "gigaam-stt-firefox.zip"
if (Test-Path $ffZip) { Remove-Item $ffZip -Force }
Compress-Archive -Path (Join-Path $ffDir "*") -DestinationPath $ffZip -CompressionLevel Optimal
Remove-Item $ffDir -Recurse -Force

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
  $packDir = Join-Path $dist "unpacked"
  if (Test-Path $packDir) { Remove-Item $packDir -Recurse -Force }
  Copy-Item $src $packDir -Recurse
  $key = Join-Path $dist "gigaam-stt.pem"
  $packArgs = @("--pack-extension=$packDir")
  if (Test-Path $key) { $packArgs += "--pack-extension-key=$key" }
  Start-Process -FilePath $chrome -ArgumentList $packArgs -Wait
  $builtCrx = Join-Path $dist "unpacked.crx"
  $builtPem = Join-Path $dist "unpacked.pem"
  if (Test-Path $builtCrx) { Move-Item $builtCrx (Join-Path $dist "gigaam-stt.crx") -Force }
  if ((Test-Path $builtPem) -and -not (Test-Path $key)) { Move-Item $builtPem $key -Force }
  elseif (Test-Path $builtPem) { Remove-Item $builtPem -Force }
  Remove-Item $packDir -Recurse -Force
}

Get-ChildItem $dist | Format-Table Name, Length, LastWriteTime -AutoSize
