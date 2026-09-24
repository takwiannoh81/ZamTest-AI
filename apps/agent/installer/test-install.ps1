# Installs the built setup file silently, checks the installed agent and
# uninstalls it again. Used by .github/workflows/agent-installer.yml; also
# works locally. With -Signed it first checks that every shipped executable
# carries a valid signature from the expected publisher.
param(
  [string]$Setup = (Get-ChildItem "$PSScriptRoot\..\dist\installer\ZamTechAI-Agent-Setup-*.exe" | Select-Object -First 1).FullName,
  [switch]$Signed,
  # Allow running on a PC where the agent is already installed (it will be uninstalled).
  [switch]$Force,
  [string]$Publisher = 'ZAMTECH&HOME LLC'
)
$ErrorActionPreference = 'Stop'
if (-not $Setup -or -not (Test-Path $Setup)) { throw 'No setup file found; build it first (pnpm --filter @zamtest/agent build:installer).' }

function Assert-Signed([string]$file) {
  $s = Get-AuthenticodeSignature $file
  if ($s.Status -ne 'Valid') { throw "$file is not validly signed: $($s.Status) $($s.StatusMessage)" }
  if ($s.SignerCertificate.Subject -notlike "*CN=$Publisher*") { throw "$file is signed by '$($s.SignerCertificate.Subject)', expected $Publisher" }
  if (-not $s.TimeStamperCertificate) { throw "$file has no timestamp; its signature would expire with the certificate" }
  "signed: $(Split-Path $file -Leaf) by $Publisher"
}

if ($Signed) { Assert-Signed $Setup }

# Process.WaitForExit, unlike Start-Process -Wait, does not also wait for the tray app setup may start.
function Invoke-AndWait([string]$file, [string]$arguments) {
  $p = [Diagnostics.Process]::Start($file, $arguments)
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "$(Split-Path $file -Leaf) failed with exit code $($p.ExitCode)" }
}

$app = "$env:LOCALAPPDATA\Programs\ZamTech AI Agent"
# This test installs over and then uninstalls the agent: never run it on a PC whose agent is in use.
if ((Test-Path "$app\unins000.exe") -and -not $Force) {
  throw "ZamTech AI Agent is already installed on this PC; this test would replace and then uninstall it. Run it on a clean machine, or pass -Force."
}

Invoke-AndWait $Setup '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOSTART /MERGETASKS="!autostart" /SERVER=http://127.0.0.1:4000/ /INSTALLKEY=ztik_ci /NAME=ci-bot'
foreach ($f in 'node.exe', 'agent.mjs', 'driver.ps1', 'ZamTechAgent.exe', 'setup.json', 'unins000.exe', 'node_modules\playwright\package.json') {
  if (-not (Test-Path "$app\$f")) { throw "Missing $f" }
}
if ($Signed) {
  Assert-Signed "$app\ZamTechAgent.exe"
  Assert-Signed "$app\unins000.exe"
}

# Setup hands its choices to the tray app in setup.json; the tray app merges them into agent.json.
$choices = Get-Content "$app\setup.json" -Raw | ConvertFrom-Json
if ($choices.server -ne 'http://127.0.0.1:4000' -or $choices.name -ne 'ci-bot' -or $choices.installKey -ne 'ztik_ci') {
  throw "Unexpected setup.json: $($choices | ConvertTo-Json -Compress)"
}
$help = & "$app\node.exe" "$app\agent.mjs" --help | Out-String
if ($help -notmatch 'ZamTech AI bot agent') { throw "The installed agent did not start: $help" }

Invoke-AndWait "$app\unins000.exe" '/VERYSILENT /SUPPRESSMSGBOXES'
Start-Sleep 3
if (Test-Path "$app\agent.mjs") { throw 'Uninstall left files behind' }
'Install, check and uninstall passed.'
