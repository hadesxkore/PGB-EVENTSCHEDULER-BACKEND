#!/bin/sh
# docker-entrypoint.sh
# Ensures the /app/uploads directory and subdirectories exist with correct permissions
# This is needed because when Coolify mounts a persistent volume over /app/uploads,
# the directory may be empty or owned by root.

set -e

echo "🔧 Ensuring uploads directory structure..."

# Create required subdirectories if they don't exist
mkdir -p /app/uploads/events
mkdir -p /app/uploads/messages
mkdir -p /app/uploads/reports

echo "✅ Uploads directories ready."
echo "📂 /app/uploads contents:"
ls -la /app/uploads/ 2>/dev/null || echo "  (empty)"

# Start the application
exec node dist/server.js
