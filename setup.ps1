# AZ Doctor post-install setup
# Run this once after /plugin install ACES-AI-Garage/azdoctor

$pluginDir = "$env:USERPROFILE\.copilot\installed-plugins\_direct\ACES-AI-Garage--azdoctor\server"

if (Test-Path $pluginDir) {
    Write-Host "Installing AZ Doctor dependencies..." -ForegroundColor Cyan
    Push-Location $pluginDir
    npm install --omit=dev
    Pop-Location
    Write-Host "Done! Restart Copilot CLI to connect the azdoctor MCP server." -ForegroundColor Green
} else {
    Write-Host "Plugin not found. Run '/plugin install ACES-AI-Garage/azdoctor' in Copilot CLI first." -ForegroundColor Red
}
