#!/bin/bash
set -e

echo ">>> Setting up Turbonox Web Panel..."

# Install production dependencies
echo "📦 Installing dependencies..."
npm install --production

# Rebuild native modules
echo "🔨 Rebuilding native modules..."
npm rebuild better-sqlite3 || true

echo ""
echo "✅ Setup complete!"
echo "Run './start.sh' to start the server."
echo "Or use: sudo systemctl start turbonox"
