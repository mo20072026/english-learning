param(
  [string]$Repo = "",
  [string]$Branch = "main",
  [switch]$DryRun
)

# Push this folder to your own GitHub repo, then enable Pages.
# Auth is handled by Git Credential Manager: it opens a sign-in window and asks you to approve.
# This script never asks for, receives, or stores your password or token.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not $Repo) {
  Write-Host ""
  Write-Host "Step 1: create a PUBLIC repo on github.com (do not add README)." -ForegroundColor Cyan
  $Repo = Read-Host "Repo URL (https://github.com/USER/REPO.git)"
}

$Repo = $Repo.Trim()
if ($Repo -notmatch '^(https://|git@)') {
  Write-Host "Bad URL: must start with https://github.com/ or git@github.com:" -ForegroundColor Red
  exit 1
}
if ($Repo -notmatch '\.git$') { $Repo = $Repo + ".git" }

$webUrl = $Repo
$webUrl = $webUrl -replace '\.git$', ''
$webUrl = $webUrl -replace '^git@github\.com:', 'https://github.com/'
$webUrl = $webUrl -replace '^https://github\.com/', ''
$parts = $webUrl.Split('/')
$owner = $parts[0]
$repoName = $parts[1]
$pagesUrl = "https://$owner.github.io/$repoName/"
$settingsUrl = "https://github.com/$owner/$repoName/settings/pages"

Write-Host ""
Write-Host "Repo      : $Repo" -ForegroundColor Gray
Write-Host "Pages URL : $pagesUrl" -ForegroundColor Gray

if ($DryRun) {
  Write-Host ""
  Write-Host "[DryRun] checks only, nothing is pushed." -ForegroundColor Yellow
  Write-Host "Folder: $PSScriptRoot"
  $files = Get-ChildItem -File | Where-Object { $_.Name -ne 'publish.ps1' } | ForEach-Object { $_.Name }
  Write-Host ("Files : " + ($files -join ', '))
  exit 0
}

if (-not (Test-Path ".git")) {
  git init | Out-Null
  Write-Host "git repo initialized" -ForegroundColor Gray
}

git add -A
$changes = git status --porcelain
if ($changes) {
  git -c user.name="English Workspace" -c user.email="noreply@local" commit -m "update: $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null
  Write-Host "local changes committed" -ForegroundColor Gray
} else {
  Write-Host "no new changes, pushing as is" -ForegroundColor Gray
}

$remotes = git remote
if ($remotes -contains "origin") { git remote remove origin | Out-Null }
git remote add origin $Repo

git branch -M $Branch
Write-Host ""
Write-Host "Pushing now. A GitHub sign-in window may pop up - approve it there." -ForegroundColor Cyan
git push -u origin $Branch
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Push failed: repo missing, no write access, or authorization declined." -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Pushed OK." -ForegroundColor Green
Write-Host "One-time step: enable Pages" -ForegroundColor Cyan
Write-Host "  1) open $settingsUrl"
Write-Host "  2) Source: Deploy from a branch; Branch: $Branch; folder: / (root); Save"
Write-Host "  3) wait ~1 min, then open $pagesUrl"
Write-Host ""

$open = Read-Host "Open the Pages settings page now? (y/N)"
if ($open -eq 'y' -or $open -eq 'Y') { Start-Process $settingsUrl }
