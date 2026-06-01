#!/bin/bash
# deploy.sh — Deploy versionado del Worker
# Uso: ./deploy.sh v1.1.0
# Si no se pasa versión, usa la que está en WORKER_VERSION del .env (o v1.0.0)

set -e

VERSION=${1:-}

if [ -z "$VERSION" ]; then
  # Leer versión actual del .env si existe
  if grep -q "^WORKER_VERSION=" .env 2>/dev/null; then
    VERSION=$(grep "^WORKER_VERSION=" .env | cut -d= -f2)
  else
    VERSION="v1.0.0"
  fi
fi

echo "==> Deploy Worker $VERSION"

# Actualizar WORKER_VERSION en .env
if grep -q "^WORKER_VERSION=" .env 2>/dev/null; then
  sed -i "s/^WORKER_VERSION=.*/WORKER_VERSION=$VERSION/" .env
else
  echo "WORKER_VERSION=$VERSION" >> .env
fi

# Build y tag
WORKER_VERSION=$VERSION docker compose build worker
WORKER_VERSION=$VERSION docker compose up -d worker

echo "==> Worker $VERSION desplegado"
echo "==> Verificando estado..."
sleep 3
docker compose ps worker
