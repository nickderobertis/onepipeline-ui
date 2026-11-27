# The Windows half of record.sh: process creation (4688, with command lines)
# and termination (4689) audit events, and a two-second sampler of every
# process's CPU time, which those events do not carry.
param([string]$Mode, [string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Clock($name) { [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Set-Content -Path (Join-Path $Out $name) }
if ($Mode -eq 'start') {
  try {
    reg add 'HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit' /v ProcessCreationIncludeCmdLine_Enabled /t REG_DWORD /d 1 /f | Out-Null
    wevtutil sl Security /ms:2147483648
    wevtutil cl Security
    auditpol /set /subcategory:"Process Creation" /success:enable | Out-Null
    auditpol /set /subcategory:"Process Termination" /success:enable | Out-Null
  } catch { "audit setup failed: $_" | Set-Content -Path (Join-Path $Out 'audit.unavailable') }
  $sampler = Join-Path $Out 'sampler.ps1'
  @'
param([string]$File)
while ($true) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $lines = foreach ($p in Get-Process) {
    try { "$t,$($p.Id),$($p.ProcessName),$([int64]$p.TotalProcessorTime.TotalMilliseconds),$([DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds())" } catch { }
  }
  Add-Content -Path $File -Value $lines
  Start-Sleep -Seconds 2
}
'@ | Set-Content -Path $sampler
  $p = Start-Process pwsh -ArgumentList '-NoProfile', '-File', $sampler, (Join-Path $Out 'samples.csv') -WindowStyle Hidden -PassThru
  [string]$p.Id | Set-Content -Path (Join-Path $Out 'sampler.pid')
  Clock 'clock-start.txt'
} else {
  Clock 'clock-stop.txt'
  $id = Get-Content -Path (Join-Path $Out 'sampler.pid') -ErrorAction SilentlyContinue
  if ($id) { Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue }
  auditpol /set /subcategory:"Process Creation" /success:disable | Out-Null
  auditpol /set /subcategory:"Process Termination" /success:disable | Out-Null
  wevtutil qe Security '/q:*[System[(EventID=4688 or EventID=4689)]]' /f:xml /e:Events | Set-Content -Path (Join-Path $Out 'events.xml')
  Get-ChildItem $Out | Format-Table Name, Length
}
