# update_ws.ps1 — Обновление crm_api_endpoint до версии с WebSocket
# Запуск: powershell -ExecutionPolicy Bypass -File update_ws.ps1 [-folder "C:\crm_api\crm_api_endpoint"]

param(
    [string]$folder = "C:\crm_api\crm_api_endpoint"
)

Write-Host "=== CRM API Endpoint: WebSocket Update ===" -ForegroundColor Cyan
Write-Host ""

# Проверяем что папка существует
if (-not (Test-Path $folder)) {
    Write-Host "ERROR: Folder $folder not found" -ForegroundColor Red
    Write-Host "Specify path: .\update_ws.ps1 -folder 'C:\path\to\crm_api_endpoint'" -ForegroundColor Yellow
    exit 1
}

Set-Location $folder
Write-Host "[1/4] Working directory: $folder" -ForegroundColor Green

# Стягиваем обновления с гита
Write-Host "[2/4] Pulling latest from git..." -ForegroundColor Green
$Env:PM2_HOME = "C:\ProgramData\pm2\home"

git pull origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARNING: git pull failed, trying reset..." -ForegroundColor Yellow
    git fetch origin
    git reset --hard origin/main
}

# Устанавливаем ws (новая зависимость)
Write-Host "[3/4] Installing ws package..." -ForegroundColor Green
npm install ws

# Перезапускаем через PM2
Write-Host "[4/4] Restarting crm_simple via PM2..." -ForegroundColor Green
pm2 restart crm_simple

Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Cyan
Write-Host "WebSocket client will auto-connect using keys from registry." -ForegroundColor Gray
Write-Host "Check logs: pm2 logs crm_simple" -ForegroundColor Gray
