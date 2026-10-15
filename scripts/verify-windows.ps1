param([string]$EvidencePath = (Join-Path $env:TEMP 'windows-company-validation.json'), [switch]$PublicDownload)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$companyRepo = Split-Path $PSScriptRoot -Parent
$companyTemp = Join-Path $env:TEMP ('company-verify-' + [guid]::NewGuid().ToString('N'))
$companyInstall = Join-Path $companyTemp '示例 company'
$companyEvidence = @{ platform = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString(); checks = @{}; desktopAppTested = $false; modelTaskExecuted = $false }
try {
  New-Item -ItemType Directory -Path $companyTemp | Out-Null
  $env:CODEX_HOME = Join-Path $companyTemp 'empty-codex'
  New-Item -ItemType Directory -Path $env:CODEX_HOME | Out-Null
  $env:ONE_PERSON_COMPANY_NO_OPEN = '1'
  $env:CODEX_BIN = Get-Command codex.cmd -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
  $companyEvidence.codex = (& node (Join-Path $companyRepo 'scripts/manage.mjs') doctor --json | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $companyEvidence.codex.codexAvailable) { throw 'Codex CLI discovery failed.' }
  $companyStage = Join-Path $companyTemp 'source'
  New-Item -ItemType Directory -Path $companyStage | Out-Null
  Push-Location $companyRepo
  try {
    foreach ($file in (& git -c core.quotePath=false ls-files)) {
      $target = Join-Path $companyStage $file
      New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $companyRepo $file) -Destination $target
    }
  } finally { Pop-Location }
  $companyArchive = Join-Path $companyTemp 'source.zip'
  Compress-Archive -Path $companyStage -DestinationPath $companyArchive
  if ($PublicDownload) {
    if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'Public verification requires the exact commit SHA.' }
    $companyArchive = 'https://github.com/Let-Lee/one-person-company/archive/' + $env:GITHUB_SHA + '.zip'
    $companyEvidence.downloadSource = $companyArchive
  }
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $listener.Start(); $companyPort = $listener.LocalEndpoint.Port; $listener.Stop()
  & (Join-Path $companyRepo 'install.ps1') -InstallRoot $companyInstall -Archive $companyArchive -Port $companyPort -NoOpen
  if ($LASTEXITCODE -ne 0) { throw 'First installation failed.' }
  $companyBase = 'http://127.0.0.1:' + $companyPort
  $headers = @{ 'x-yewang-workbench' = '1' }
  $setup = Invoke-RestMethod ($companyBase + '/api/setup')
  if (-not $setup.required -or $setup.step -ne 'welcome' -or $setup.name -ne '我的公司') { throw 'Fresh onboarding failed.' }
  foreach ($collection in @('roles','sessions','runs')) {
    $response = Invoke-RestMethod ($companyBase + '/api/' + $collection)
    if (@($response.$collection).Count -ne 0) { throw ('Fresh company is not empty: ' + $collection) }
  }
  $companyEvidence.checks.zeroRolesAndWelcome = $true
  if ((Invoke-WebRequest ($companyBase + '/') -UseBasicParsing).StatusCode -ne 200) { throw 'Page failed.' }
  $companyEvidence.checks.pageServed = $true
  Invoke-RestMethod ($companyBase + '/api/setup') -Method Patch -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes('{"name":"示例公司"}')) | Out-Null
  Invoke-RestMethod ($companyBase + '/api/runtime/start') -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  if ((Invoke-RestMethod ($companyBase + '/api/runtime')).status -ne 'ready') { throw 'Real Codex App Server initialization failed.' }
  $companyEvidence.checks.realCodexAppServerInitialized = $true
  & (Join-Path $companyRepo 'install.ps1') -InstallRoot $companyInstall -Archive $companyArchive -NoOpen
  if ($LASTEXITCODE -ne 0) { throw 'Repeat installation failed.' }
  if ((Invoke-RestMethod ($companyBase + '/api/setup')).name -ne '示例公司') { throw 'Settings were not preserved.' }
  $companyEvidence.checks.installUpdatePreservesSettingsAndPort = $true
  if (Test-Path -LiteralPath (Join-Path $env:CODEX_HOME 'auth.json')) { throw 'Unexpected credentials.' }
  if (Test-Path -LiteralPath (Join-Path $companyInstall 'data/desktop-manager.json')) { throw 'Unexpected desktop binding.' }
  $companyEvidence.checks.noCredentialsOrAuthorBinding = $true
  & (Join-Path $companyInstall '停止公司.cmd')
  if ($LASTEXITCODE -ne 0) { throw 'CMD stop launcher failed.' }
  & (Join-Path $companyInstall '启动公司.cmd')
  if ($LASTEXITCODE -ne 0 -or (Invoke-RestMethod ($companyBase + '/api/setup')).name -ne '示例公司') { throw 'CMD restart launcher failed.' }
  $companyEvidence.checks.cmdLaunchers = $true
  $companyEvidence.success = $true
} catch {
  $companyEvidence.success = $false
  $companyEvidence.error = $_.ToString()
  throw
} finally {
  if (Test-Path -LiteralPath (Join-Path $companyInstall 'run-company.ps1')) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $companyInstall 'run-company.ps1') -Action stop
    $companyEvidence.checks.launcherStop = ($LASTEXITCODE -eq 0)
    if (-not $companyEvidence.checks.launcherStop) { $companyEvidence.success = $false }
  }
  $companyEvidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
  Write-Host ($companyEvidence | ConvertTo-Json -Depth 8 -Compress)
}
if (-not $companyEvidence.success) { exit 1 }
