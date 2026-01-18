# Turbonox Web Panel

Self-Controlled Hosting Hub - Web Panel Edition

## Quick Start

```bash
# Install dependencies
./setup.sh

# Start the server
./start.sh
```

## Systemd Service

```bash
# Copy service file
sudo cp turbonox.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable turbonox
sudo systemctl start turbonox
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
nano .env
```

## Default Port

The panel runs on port **3456** by default.

Access: `http://your-server-ip:3456`
