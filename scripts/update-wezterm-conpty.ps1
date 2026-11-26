# Replace the ConPTY bundled with WezTerm (Feb 2024) with Microsoft's current release.
#
# Why: the old ConPTY re-renders the screen itself and can forward inline-image escapes ahead of the
# cursor moves that precede them. After a window resize this puts equations in the wrong place.
# ConPTY 1.22+ passes output through in order.
#
# Run from an elevated PowerShell (Program Files needs admin) with every WezTerm window closed:
#   powershell -ExecutionPolicy Bypass -File scripts\update-wezterm-conpty.ps1
# Re-run after reinstalling or upgrading WezTerm. To undo, copy the *.bak files back.
#
# Safety: the package must match a pinned SHA-512 (the hash nuget.org publishes for it), and both
# binaries must carry a valid Microsoft signature. All of this happens in a staging folder inside
# the WezTerm install folder, which only administrators can write, so nothing can swap the files
# between the checks and the copy.
param(
  [string]$Target = "$env:ProgramFiles\WezTerm",
  [string]$Version = "1.25.260930003",
  # SHA-512 of the .nupkg. Needed only for a -Version that isn't pinned below; take it from the
  # packageHash in nuget.org's catalog entry for that version (base64 there, hex here).
  [string]$Sha512
)
$ErrorActionPreference = "Stop"

$Pinned = @{
  "1.25.260930003" = "2eea8c93daf9a13cde4677b7e483a551d490ec3923a2b3886dc9ce0c667cd4cbe65294ebff5541433ddf01d08d0b091fb91d0c96eabe1fbad2dc77acfc0d5f3b"
}
$expected = if ($Sha512) { $Sha512 } else { $Pinned[$Version] }
if (-not $expected) { throw "No pinned hash for ConPTY $Version. Pass -Sha512 <hex hash of the .nupkg>." }

if (-not (Test-Path "$Target\wezterm-gui.exe")) { throw "WezTerm not found in $Target" }
if (Get-Process wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Target*" }) {
  throw "Close all WezTerm windows first (the files are in use)."
}

function Assert-MicrosoftSigned([string]$Path) {
  $sig = Get-AuthenticodeSignature -LiteralPath $Path
  if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "\bO=Microsoft Corporation\b") {
    throw "$Path is not validly signed by Microsoft (status: $($sig.Status)). Nothing was changed."
  }
}

# Windows PowerShell 5.1 may not offer TLS 1.2 by default; nuget.org requires it.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$stage = Join-Path $Target (".conpty-update-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $pkg = Join-Path $stage "conpty.zip" # .zip: Windows PowerShell's Expand-Archive rejects other extensions
  Write-Host "Downloading ConPTY $Version from nuget.org..."
  Invoke-WebRequest -UseBasicParsing "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$Version/microsoft.windows.console.conpty.$Version.nupkg" -OutFile $pkg
  $actual = (Get-FileHash -LiteralPath $pkg -Algorithm SHA512).Hash
  if ($actual -ne $expected) { throw "Download hash mismatch for ConPTY $Version. Nothing was changed.`n  expected $expected`n  got      $actual" }

  $files = Join-Path $stage "files"
  Expand-Archive $pkg -DestinationPath $files
  $sources = @{
    "conpty.dll"      = "$files\runtimes\win-x64\native\conpty.dll"
    "OpenConsole.exe" = "$files\build\native\runtimes\x64\OpenConsole.exe"
  }
  foreach ($src in $sources.Values) { Assert-MicrosoftSigned $src }

  foreach ($name in $sources.Keys) {
    $dest = Join-Path $Target $name
    if ((Test-Path $dest) -and -not (Test-Path "$dest.bak")) { Copy-Item $dest "$dest.bak" }
    Copy-Item $sources[$name] $dest -Force
    Write-Host "Updated $dest"
  }
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Done. Originals kept as *.bak in $Target."
