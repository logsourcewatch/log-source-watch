param(
  [string]$Remote = "https://github.com/logsourcewatch/log-source-watch.git"
)

$ErrorActionPreference = "Stop"

Write-Host "==> Checking tools"
git --version
gh --version

Write-Host "==> GitHub authentication"
gh auth status

if (Test-Path ".git") {
  throw "This folder already contains .git. Use a clean extracted bootstrap folder."
}

Write-Host "==> Validating repository"
py -3 scripts\validate.py

Write-Host "==> Initializing clean history"
git init -b main
git add .
git commit -m "Initial public release candidate: Log Source Watch 4.9.3 RC2"

Write-Host "==> Connecting GitHub repository"
git remote add origin $Remote
git push -u origin main

Write-Host ""
Write-Host "READY"
Write-Host "Remote: $Remote"
Write-Host "Next: open GitHub -> Actions and verify Validate passes."
