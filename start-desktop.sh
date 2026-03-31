#!/bin/bash

set -e

TILEMAKER_DIR="tilemaker"
TILEMAKER_REPO="https://github.com/ppugend/tilemaker.git"
TILEMAKER_TAG="v3.1.0"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🚀 VectorMapForge Desktop Launcher"
echo "===================================="

# Check if tilemaker directory exists
if [ ! -d "$TILEMAKER_DIR" ]; then
    echo -e "${YELLOW}📦 tilemaker not found. Cloning from $TILEMAKER_REPO...${NC}"
    git clone "$TILEMAKER_REPO" "$TILEMAKER_DIR"
    cd "$TILEMAKER_DIR"
    git checkout "$TILEMAKER_TAG"
    cd ..
    echo -e "${GREEN}✅ tilemaker cloned and checked out to $TILEMAKER_TAG${NC}"
else
    echo -e "${YELLOW}🔄 tilemaker found. Updating to $TILEMAKER_TAG...${NC}"
    cd "$TILEMAKER_DIR"
    
    # Fetch latest tags
    git fetch --tags
    
    # Check current commit
    CURRENT_COMMIT=$(git rev-parse --short HEAD)
    TARGET_COMMIT=$(git rev-parse --short "$TILEMAKER_TAG" 2>/dev/null || echo "")
    
    if [ "$CURRENT_COMMIT" = "$TARGET_COMMIT" ]; then
        echo -e "${GREEN}✅ Already at $TILEMAKER_TAG ($CURRENT_COMMIT)${NC}"
    else
        echo "📋 Current: $CURRENT_COMMIT, Target: $TILEMAKER_TAG ($TARGET_COMMIT)"
        git checkout "$TILEMAKER_TAG"
        echo -e "${GREEN}✅ Updated to $TILEMAKER_TAG${NC}"
    fi
    cd ..
fi

echo ""
echo -e "${GREEN}🐳 Starting Docker Compose...${NC}"
docker compose -f docker-compose.desktop.yml up -d "$@"

echo ""
echo -e "${GREEN}✨ VectorMapForge is running!${NC}"
echo "   Public:  http://localhost:8050"
echo "   Admin:   http://localhost:8051"
echo ""
echo "Logs: docker compose -f docker-compose.desktop.yml logs -f"
