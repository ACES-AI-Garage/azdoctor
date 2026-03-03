#!/bin/bash
# AZ Doctor post-install setup
# Run this once after /plugin install ACES-AI-Garage/azdoctor

PLUGIN_DIR="$HOME/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor/server"

if [ -d "$PLUGIN_DIR" ]; then
    echo "Installing AZ Doctor dependencies..."
    cd "$PLUGIN_DIR" && npm install --omit=dev
    echo "Done! Restart Copilot CLI to connect the azdoctor MCP server."
else
    echo "Plugin not found. Run '/plugin install ACES-AI-Garage/azdoctor' in Copilot CLI first."
fi
