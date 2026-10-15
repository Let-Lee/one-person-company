param(
  [string]$InstallRoot = $env:ONE_PERSON_COMPANY_HOME,
  [string]$Archive = $env:ONE_PERSON_COMPANY_ARCHIVE,
  [int]$Port = 0,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$companyTemp = $null
try {
  if ($env:OS -ne 'Windows_NT') { throw '此安装器需要 Windows。Mac 请使用 install.sh。' }
  if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'OnePersonCompany' }
  $companyHome = [IO.Path]::GetFullPath($InstallRoot)
  $companyMarker = Join-Path $companyHome '.one-person-company'
  if (Test-Path -LiteralPath $companyHome) {
    if (-not (Test-Path -LiteralPath $companyHome -PathType Container)) { throw '安装路径须是文件夹。' }
    if (@(Get-ChildItem -LiteralPath $companyHome -Force).Count -gt 0 -and -not (Test-Path -LiteralPath $companyMarker -PathType Leaf)) { throw '目录已有其他内容，请用 -InstallRoot 选择一个空文件夹。' }
    if ((Get-Item -LiteralPath $companyHome -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装目录不能是目录链接。' }
  }
  $companyPrevious = $null
  $companyPointer = Join-Path $companyHome 'current.json'
  if (Test-Path -LiteralPath $companyPointer) {
    $companyPrevious = Get-Content -LiteralPath $companyPointer -Raw | ConvertFrom-Json
    if ($companyPrevious.release -notmatch '^[a-f0-9]{16}$') { throw '已有安装版本记录无效。' }
  }
  if ($Port -eq 0 -and $env:PORT) { $Port = [int]$env:PORT }
  if ($Port -eq 0) { $Port = if ($companyPrevious) { [int]$companyPrevious.port } else { 4318 } }
  if ($Port -lt 1 -or $Port -gt 65535) { throw '端口须是 1 至 65535 的整数。' }
  $companyNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
  if (-not $companyNode -and $env:ProgramFiles) { $companyNode = Join-Path $env:ProgramFiles 'nodejs/node.exe' }
  if (-not $companyNode -or -not (Test-Path -LiteralPath $companyNode -PathType Leaf)) { throw '请先安装 Node.js 20 或以上，再重新运行安装器。' }
  & $companyNode -e 'process.exit(Number.parseInt(process.versions.node,10)>=20?0:1)'
  if ($LASTEXITCODE -ne 0) { throw '需要 Node.js 20 或以上。' }
  $companyTemp = Join-Path ([IO.Path]::GetTempPath()) ('one-person-company-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $companyTemp | Out-Null
  $companyZip = Join-Path $companyTemp 'source.zip'
  if (-not $Archive) { $Archive = 'https://github.com/Let-Lee/one-person-company/archive/refs/heads/main.zip' }
  Write-Host '正在下载公司源码…'
  if (Test-Path -LiteralPath $Archive -PathType Leaf) { Copy-Item -LiteralPath $Archive -Destination $companyZip }
  else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $download = @{ Uri = $Archive; OutFile = $companyZip; UseBasicParsing = $true; TimeoutSec = 60 }
    if ($env:HTTPS_PROXY) { $download.Proxy = $env:HTTPS_PROXY }
    Invoke-WebRequest @download
  }
  $companyExtract = Join-Path $companyTemp 'source'
  Expand-Archive -LiteralPath $companyZip -DestinationPath $companyExtract
  $companyFolders = @(Get-ChildItem -LiteralPath $companyExtract -Directory)
  if ($companyFolders.Count -ne 1) { throw '下载内容不是有效的公司源码包。' }
  $companySource = $companyFolders[0].FullName
  foreach ($required in @('src/server.mjs','scripts/manage.mjs','scripts/run-windows.ps1','package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $companySource $required) -PathType Leaf)) { throw '源码包缺少必要文件。' }
  }
  $companyRelease = (Get-FileHash -LiteralPath $companyZip -Algorithm SHA256).Hash.Substring(0,16).ToLowerInvariant()
  $companyReleases = Join-Path $companyHome 'releases'
  $companyDestination = Join-Path $companyReleases $companyRelease
  New-Item -ItemType Directory -Path $companyReleases -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $companyHome 'data') -Force | Out-Null
  if (-not (Test-Path -LiteralPath $companyDestination)) { Move-Item -LiteralPath $companySource -Destination $companyDestination }
  Set-Content -LiteralPath $companyMarker -Value 'one-person-company' -Encoding ASCII
  $env:YEWANG_DATA_DIR = Join-Path $companyHome 'data'
  $env:YEWANG_RUNTIME_DIR = Join-Path $env:YEWANG_DATA_DIR 'runtime'
  $env:YEWANG_IMPORT_COMPANY = '0'
  if ($companyPrevious) {
    $env:PORT = [string]$companyPrevious.port
    $oldManage = Join-Path (Join-Path $companyReleases $companyPrevious.release) 'scripts/manage.mjs'
    & $companyNode $oldManage stop
    if ($LASTEXITCODE -ne 0) { throw '原公司未能停止，已保留原版本。' }
  }
  $companyNewPointer = @{ release = $companyRelease; port = $Port } | ConvertTo-Json
  Set-Content -LiteralPath ($companyPointer + '.tmp') -Value $companyNewPointer -Encoding UTF8
  Move-Item -LiteralPath ($companyPointer + '.tmp') -Destination $companyPointer -Force
  $companyBootstrap = @'
param([string]$Action = 'start')
$ErrorActionPreference = 'Stop'
try {
  $current = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Raw | ConvertFrom-Json
  if ($current.release -notmatch '^[a-f0-9]{16}$') { throw 'Invalid installed release.' }
  $launcher = Join-Path (Join-Path (Join-Path $PSScriptRoot 'releases') $current.release) 'scripts/run-windows.ps1'
  & $launcher -InstallRoot $PSScriptRoot -Action $Action
  exit $LASTEXITCODE
} catch { Write-Error $_; exit 1 }
'@
  Set-Content -LiteralPath (Join-Path $companyHome 'run-company.ps1') -Value $companyBootstrap -Encoding UTF8
  foreach ($item in @(@('启动公司.cmd','start'),@('停止公司.cmd','stop'),@('检查公司.cmd','doctor'))) {
    $companyBatch = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-company.ps1" -Action ' + $item[1] + "`r`n" + 'set "company_result=%errorlevel%"' + "`r`n" + 'if not "%company_result%"=="0" if not defined CI pause' + "`r`n" + 'exit /b %company_result%' + "`r`n"
    Set-Content -LiteralPath (Join-Path $companyHome $item[0]) -Value $companyBatch -Encoding ASCII
  }
  $env:PORT = [string]$Port
  $companyArgs = @((Join-Path $companyDestination 'scripts/manage.mjs'), 'start')
  if (-not $NoOpen) { $companyArgs += '--open' }
  & $companyNode @companyArgs
  if ($LASTEXITCODE -ne 0) {
    if ($companyPrevious) { $companyPrevious | ConvertTo-Json | Set-Content -LiteralPath $companyPointer -Encoding UTF8 }
    throw '新版本未能启动；原数据保留，请检查端口和 data/runtime/server.log。'
  }
  Write-Host ('已安装到：' + $companyHome)
  Write-Host '以后双击“启动公司.cmd”即可。岗位和任务保存在 data 中。'
} catch { Write-Error $_; exit 1 }
finally { if ($companyTemp -and (Test-Path -LiteralPath $companyTemp)) { Remove-Item -LiteralPath $companyTemp -Recurse -Force } }
