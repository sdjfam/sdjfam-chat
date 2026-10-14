$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$release = Join-Path $root 'src-tauri/target/release'
$msi = Get-ChildItem (Join-Path $release 'bundle/msi') -Filter '*.msi' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$msi) { throw 'MSI missing' }
$probeRoot = Join-Path $release ('installed path probe ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probeRoot | Out-Null
$arguments = '/a "' + $msi.FullName + '" /qn TARGETDIR="' + $probeRoot + '" /L*v "' + (Join-Path $probeRoot 'extract.log') + '"'
$process = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -notin @(0,3010)) { throw "MSI administrative extraction failed: $($process.ExitCode)" }
$app = Get-ChildItem -LiteralPath $probeRoot -Filter 'sdjfam-chat.exe' -Recurse | Select-Object -First 1
if (!$app) { throw 'Extracted application missing' }
$primary = Join-Path $app.DirectoryName 'tiktok-chat-helper.exe'
$fallback = Join-Path $app.DirectoryName 'helpers/tiktok-chat-helper.exe'
foreach ($helper in @($primary,$fallback)) {
  if (!(Test-Path -LiteralPath $helper)) { throw 'Installed helper path missing' }
  $probe = & $helper --self-test
  if ($LASTEXITCODE -ne 0 -or $probe -ne 'TIKTOK_SIDECAR_READY') { throw 'Installed sidecar offline probe failed' }
  $expected = (Get-FileHash (Join-Path $root 'src-tauri/binaries/tiktok-chat-helper-x86_64-pc-windows-msvc.exe')).Hash
  if ((Get-FileHash $helper).Hash -ne $expected) { throw 'Installed helper differs from production build' }
}
$nsis = Get-ChildItem (Join-Path $release 'nsis') -Filter '*.nsi' -Recurse | Select-Object -First 1
if (!$nsis) { throw 'NSIS script missing' }
$content = Get-Content -LiteralPath $nsis.FullName -Raw
foreach ($entry in @('oname=tiktok-chat-helper.exe','oname=helpers\tiktok-chat-helper.exe')) {
  if (!$content.Contains($entry)) { throw 'NSIS installed helper entry missing' }
}
Write-Output 'Windows bundle verified: extracted primary and resource helpers start offline, hashes match, both NSIS paths present.'
