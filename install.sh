#!/bin/bash

# Turbonox Web Panel - One-Click Installer
# Super easy installation for Ubuntu/Debian servers
#
# One-liner install:
# curl -fsSL https://raw.githubusercontent.com/Turbonox-Dev/Turbonox-Headless/main/install.sh | bash

set -e

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║              TURBONOX VPS INSTALLER                ║"
echo "║         Self-Controlled Hosting Hub                ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "⚠️  Warning: Running as root. Consider using a non-root user."
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check for required commands
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}❌ $1 is not installed${NC}"
        return 1
    fi
    echo -e "${GREEN}✓ $1 found${NC}"
    return 0
}

echo "📋 Checking prerequisites..."

# Check Node.js
if ! check_command node; then
    echo ""
    echo -e "${YELLOW}Installing Node.js v20...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Check npm
if ! check_command npm; then
    echo -e "${RED}❌ npm not found. Please install Node.js properly.${NC}"
    exit 1
fi

# Check Git
if ! check_command git; then
    echo ""
    echo -e "${YELLOW}Installing Git...${NC}"
    sudo apt-get update && sudo apt-get install -y git
fi

# Verify Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js version 18+ required. Current: $(node -v)${NC}"
    exit 1
fi

# Check Docker
if ! check_command docker; then
    echo ""
    echo -e "${YELLOW}Installing Docker...${NC}"
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    echo -e "${GREEN}✓ Docker installed. You may need to log out and back in for group changes to take effect.${NC}"
    rm get-docker.sh
fi

echo ""
echo "📦 Installing Turbonox..."

# Set installation directory
INSTALL_DIR="${TURBONOX_INSTALL_DIR:-/opt/turbonox}"

    # Clone or update repository
    if [ -d "$INSTALL_DIR" ]; then
        echo "⚠️  Installation directory exists. Updating..."
        cd "$INSTALL_DIR"
        git pull origin main || git pull origin master
    else
        echo "📥 Cloning repository..."
        sudo mkdir -p "$(dirname $INSTALL_DIR)"
        sudo git clone git@github.com:Turbonox-Dev/Turbonox-Headless.git "$INSTALL_DIR"
        sudo chown -R $USER:$USER "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install --production

# Build frontend
echo ""
echo "🔨 Building frontend..."
npm run build

# Create data directory
DATA_DIR="${TURBONOX_DATA_DIR:-$HOME/Turbonox}"
mkdir -p "$DATA_DIR"
echo "📁 Data directory: $DATA_DIR"

# Create .env file if not exists
if [ ! -f "$INSTALL_DIR/.env" ]; then
    echo ""
    echo "📝 Creating configuration..."
    cat > "$INSTALL_DIR/.env" << EOF
# Turbonox Configuration
NODE_ENV=production
PORT=3456

# Data directory (where databases, backups, etc. are stored)
APPDATA=$DATA_DIR

# Optional: Set a fixed JWT secret (auto-generated if not set)
# JWT_SECRET=your-secret-here

# Optional: Control Plane URL
# CONTROL_PLANE_URL=https://turbonox.oriko.lk
EOF
fi

# Create systemd service
echo ""
echo "🔧 Creating systemd service..."

sudo tee /etc/systemd/system/turbonox.service > /dev/null << EOF
[Unit]
Description=Turbonox Web Panel
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=turbonox
Environment=NODE_ENV=production
Environment=APPDATA=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable turbonox

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              INSTALLATION COMPLETE!                ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo "📍 Installation:  $INSTALL_DIR"
echo "📁 Data:          $DATA_DIR"
echo "🌐 URL:           http://$(hostname -I | awk '{print $1}'):3456"
echo ""
echo "Commands:"
echo "  Start:   sudo systemctl start turbonox"
echo "  Stop:    sudo systemctl stop turbonox"
echo "  Status:  sudo systemctl status turbonox"
echo "  Logs:    sudo journalctl -u turbonox -f"
echo ""
echo "🚀 Starting Turbonox..."
sudo systemctl start turbonox

sleep 2
if sudo systemctl is-active --quiet turbonox; then
    echo -e "${GREEN}✓ Turbonox is running!${NC}"
    echo ""
    echo "Open http://$(hostname -I | awk '{print $1}'):3456 in your browser"
else
    echo -e "${RED}❌ Failed to start. Check logs: sudo journalctl -u turbonox -f${NC}"
fi
