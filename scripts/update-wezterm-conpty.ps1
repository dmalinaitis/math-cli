# Replace the ConPTY bundled with WezTerm (Feb 2024) with Microsoft's current release.
#
# Why: the old ConPTY re-renders the screen itself and can forward inline-image escapes ahead of the
# cursor moves that precede them. After a window resize this puts equations in the wrong place.
# ConPTY 1.22+ passes output through in order.
#
# Run from an elevated PowerShell (Program Files needs admin) with every WezTerm window closed:
#   powershell -ExecutionPolicy Bypass -File scripts\update-wezterm-conpty.ps1
# Re-run after reinstalling or upgrading WezTerm. To undo, copy the *.bak files back.
param(
  [string]$Target = "$env:ProgramFiles\WezTerm",
  [string]$Version = "1.25.260930003"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path "$Target\wezterm-gui.exe")) { throw "WezTerm not found in $Target" }
if (Get-Process wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Target*" }) {
  throw "Close all WezTerm windows first (the files are in use)."
}

$tmp = Join-Path $env:TEMP "conpty-$Version"
$pkg = "$tmp.zip"
Write-Host "Downloading ConPTY $Version from nuget.org..."
Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$Version/microsoft.windows.console.conpty.$Version.nupkg" -OutFile $pkg
Expand-Archive $pkg -DestinationPath $tmp -Force

$files = @{
  "conpty.dll"      = "$tmp\runtimes\win-x64\native\conpty.dll"
  "OpenConsole.exe" = "$tmp\build\native\runtimes\x64\OpenConsole.exe"
}
foreach ($name in $files.Keys) {
  $dest = Join-Path $Target $name
  if ((Test-Path $dest) -and -not (Test-Path "$dest.bak")) { Copy-Item $dest "$dest.bak" }
  Copy-Item $files[$name] $dest -Force
  Write-Host "Updated $dest"
}
Remove-Item $pkg, $tmp -Recurse -Force
Write-Host "Done. Originals kept as *.bak in $Target."
