param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
  [string]$NodeExecutable = (Get-Command node -ErrorAction Stop).Source,
  [string]$NodeLicense = (Join-Path $PSScriptRoot 'runtime\NODE-LICENSE.txt')
)
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $NodeExecutable)) { throw 'Node runtime not found' }
if(!(Test-Path -LiteralPath $NodeLicense)) { throw 'Node LICENSE missing. Supply -NodeLicense with the LICENSE of the runtime version.' }
$version=& $NodeExecutable -p 'process.versions.node'
if([int]($version.Split('.')[0]) -lt 22) { throw 'Build requires Node 22 or later' }
$arch=& $NodeExecutable -p 'process.arch'
$folder=Join-Path $OutputDirectory ('yangjibao-windows-'+$arch)
if(Test-Path -LiteralPath $folder) { throw 'Output folder already exists; choose another output directory to avoid overwriting data' }
New-Item -ItemType Directory -Force -Path (Join-Path $folder 'runtime') | Out-Null
# Deliberate whitelist: never copy account files, generated dashboards, caches, logs or backups.
$files=@('local-server.js','runtime-ui.js','trading-schedule.js','trading-calendar.json','welcome.html','refresh-job.js','dashboard-core.js','dashboard.js','dashboard.template.html','market-analysis.js','yjb.js','portfolio.py','启动看板.vbs','启动看板.cmd','刷新数据.bat','weekly_report.bat','README.md','看这里-使用说明.txt')
foreach($name in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $folder $name) }
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $folder 'runtime\node.exe')
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $folder 'runtime\NODE-LICENSE.txt')
$utf16=[Text.UnicodeEncoding]::new($false,$true)
$vbs=Join-Path $folder '启动看板.vbs'
[IO.File]::WriteAllText($vbs,[IO.File]::ReadAllText($vbs),$utf16)
$utf8=[Text.UTF8Encoding]::new($false)
foreach($name in @('启动看板.cmd','刷新数据.bat','weekly_report.bat')) { $file=Join-Path $folder $name; [IO.File]::WriteAllText($file,([IO.File]::ReadAllText($file) -replace '\r?\n',"`r`n"),$utf8) }
[IO.File]::WriteAllText((Join-Path $folder 'runtime\VERSION.txt'),"Node.js $version ($arch). Embedded runtime; no system installation required.`r`n",$utf8)
$zip=Join-Path $OutputDirectory ('yangjibao-windows-'+$arch+'.zip')
Compress-Archive -LiteralPath $folder -DestinationPath $zip -CompressionLevel Optimal
Get-FileHash -LiteralPath $zip -Algorithm SHA256 | Format-List
Write-Output "Portable package: $zip"
