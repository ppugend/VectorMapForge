# VectorMapForge Desktop Launcher for Windows
# Run this in PowerShell: .\start-desktop.ps1

$TILEMAKER_DIR = "tilemaker"
$TILEMAKER_REPO = "https://github.com/ppugend/tilemaker.git"
$TILEMAKER_TAG = "v3.1.0"

Write-Host "🚀 VectorMapForge Desktop Launcher" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Green

# Check if git is available
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Git is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Please install Git: https://git-scm.com/download/win"
    exit 1
}

# Check if docker is available
if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Docker is not installed or not in PATH" -ForegroundColor Red
    exit 1
}

# Clone or update tilemaker
if (!(Test-Path $TILEMAKER_DIR)) {
    Write-Host "📦 tilemaker not found. Cloning from $TILEMAKER_REPO..." -ForegroundColor Yellow
    git clone $TILEMAKER_REPO $TILEMAKER_DIR
    Set-Location $TILEMAKER_DIR
    git checkout $TILEMAKER_TAG
    Set-Location ..
    Write-Host "✅ tilemaker cloned and checked out to $TILEMAKER_TAG" -ForegroundColor Green
} else {
    Write-Host "🔄 tilemaker found. Updating to $TILEMAKER_TAG..." -ForegroundColor Yellow
    Set-Location $TILEMAKER_DIR
    
    git fetch --tags
    
    $CURRENT_COMMIT = git rev-parse --short HEAD
    $TARGET_COMMIT = git rev-parse --short $TILEMAKER_TAG 2>$null
    
    if ($CURRENT_COMMIT -eq $TARGET_COMMIT) {
        Write-Host "✅ Already at $TILEMAKER_TAG ($CURRENT_COMMIT)" -ForegroundColor Green
    } else {
        Write-Host "📋 Current: $CURRENT_COMMIT, Target: $TILEMAKER_TAG ($TARGET_COMMIT)"
        git checkout $TILEMAKER_TAG
        Write-Host "✅ Updated to $TILEMAKER_TAG" -ForegroundColor Green
    }
    Set-Location ..
}

Write-Host ""
Write-Host "🐳 Starting Docker Compose..." -ForegroundColor Green
docker compose -f docker-compose.desktop.yml up -d @args

Write-Host ""
Write-Host "✨ VectorMapForge is running!" -ForegroundColor Green
Write-Host "   Public:  http://localhost:8050"
Write-Host "   Admin:   http://localhost:8051"
Write-Host ""
Write-Host "Logs: docker compose -f docker-compose.desktop.yml logs -f"
Write-Host "Stop: docker compose -f docker-compose.desktop.yml down"
