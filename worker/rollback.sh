#!/bin/bash
# rollback.sh — Rollback del Worker a una versión anterior
# Uso: ./rollback.sh v1.0.0
# Lista versiones disponibles: docker images data-laundering-worker

set -e

TARGET_VERSION=${1:-}

if [ -z "$TARGET_VERSION" ]; then
  echo "ERROR: Debes especificar la versión de destino."
  echo "Uso: ./rollback.sh v1.0.0"
  echo ""
  echo "Versiones disponibles:"
  docker images data-laundering-worker --format "  {{.Tag}}\t({{.CreatedAt}})"
  exit 1
fi

# Verificar que la imagen existe localmente
if ! docker images data-laundering-worker --format "{{.Tag}}" | grep -q "^${TARGET_VERSION}$"; then
  echo "ERROR: La imagen data-laundering-worker:$TARGET_VERSION no existe localmente."
  echo ""
  echo "Versiones disponibles:"
  docker images data-laundering-worker --format "  {{.Tag}}\t({{.CreatedAt}})"
  exit 1
fi

CURRENT_VERSION=$(grep "^WORKER_VERSION=" .env 2>/dev/null | cut -d= -f2 || echo "desconocida")

echo "==> ROLLBACK: $CURRENT_VERSION → $TARGET_VERSION"
echo "==> Iniciando en 3 segundos... (Ctrl+C para cancelar)"
sleep 3

# Actualizar WORKER_VERSION en .env
if grep -q "^WORKER_VERSION=" .env 2>/dev/null; then
  sed -i "s/^WORKER_VERSION=.*/WORKER_VERSION=$TARGET_VERSION/" .env
else
  echo "WORKER_VERSION=$TARGET_VERSION" >> .env
fi

# Levantar con la imagen ya construida (sin rebuild)
WORKER_VERSION=$TARGET_VERSION docker compose up -d worker

echo "==> Rollback completado. Worker corriendo en $TARGET_VERSION"
echo ""
echo "==> Estado del contenedor:"
docker compose ps worker
echo ""
echo "==> Últimas líneas de log:"
docker compose logs --tail=20 worker
