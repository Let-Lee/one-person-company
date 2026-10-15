param(
  [ValidateSet('start','stop','status','doctor')][string]$Action = 'start',
  [string]$InstallRoot = '',
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
  if ($env:OS -ne 'Windows_NT') { throw '此启动入口需要 Windows。Mac 请使用 .command 文件。' }
  $companySource = Split-Path $PSScriptRoot -Parent
  if ($InstallRoot) {
    $companyHome = [IO.Path]::GetFullPath($InstallRoot)
    $companyCurrent = Get-Content -LiteralPath (Join-Path $companyHome 'current.json') -Raw | ConvertFrom-Json
    if ($companyCurrent.release -notmatch '^[a-f0-9]{16}$') { throw '安装版本记录无效，请重新运行安装器。' }
    $companySource = Join-Path (Join-Path $companyHome 'releases') $companyCurrent.release
    $env:YEWANG_DATA_DIR = Join-Path $companyHome 'data'
    $env:YEWANG_RUNTIME_DIR = Join-Path $env:YEWANG_DATA_DIR 'runtime'
    $env:PORT = [string]$companyCurrent.port
  }
  $companyNodes = @((Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source))
  if ($env:ProgramFiles) { $companyNodes += Join-Path $env:ProgramFiles 'nodejs/node.exe' }
  if ($env:LOCALAPPDATA) { $companyNodes += Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe' }
  $companyNode = $null
  foreach ($candidate in $companyNodes) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      & $candidate -e 'process.exit(Number.parseInt(process.versions.node,10)>=20?0:1)'
      if ($LASTEXITCODE -eq 0) { $companyNode = $candidate; break }
    }
  }
  if (-not $companyNode) { throw '需要 Node.js 20 或以上。安装 Node.js LTS 后，再双击启动。' }
  $companyArgs = @((Join-Path $companySource 'scripts/manage.mjs'), $Action)
  if ($Action -eq 'start' -and -not $NoOpen) { $companyArgs += '--open' }
  & $companyNode @companyArgs
  exit $LASTEXITCODE
} catch { Write-Error $_; exit 1 }
