# Symlink (or copy) this skill into your Claude Code skills directory (Windows).
# Symlinks need Developer Mode or an elevated shell; otherwise it copies.
$ErrorActionPreference = "Stop"

$src = $PSScriptRoot
$destDir = if ($env:CLAUDE_SKILLS_DIR) { $env:CLAUDE_SKILLS_DIR } else { Join-Path $HOME ".claude\skills" }
$dest = Join-Path $destDir "claude-detective"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }

try {
  New-Item -ItemType SymbolicLink -Path $dest -Target $src -ErrorAction Stop | Out-Null
  Write-Host "linked  claude-detective -> $dest"
} catch {
  # Fallback for PowerShell 5.1 / no Developer Mode: mklink, then copy.
  $mk = cmd /c mklink /D "`"$dest`"" "`"$src`"" 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "linked  claude-detective -> $dest"
  } else {
    Copy-Item -Recurse -Force $src $dest
    Write-Host "copied  claude-detective -> $dest (symlink not permitted; re-run after each pull)"
  }
}

Write-Host "Done. Restart Claude Code (or /reload-skills) to pick up the skill."
