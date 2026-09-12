# Runbook de Rollback — Data Laundering (Worker y Frontend)

**Versión del runbook**: 1.1  
**Última actualización**: 2026-09-12  
**Tiempo objetivo de recuperación**: < 5 minutos

---

## ¿Cuándo ejecutar un rollback?

Ejecutar rollback si se observa cualquiera de estas situaciones:

| Síntoma | Cómo verificarlo |
|---|---|
| Facturas procesadas con datos incorrectos | Revisar `pdf_job_rows` en Supabase |
| Jobs que quedan en `processing` sin avanzar > 10 min | Logs del worker o tabla `pdf_jobs` |
| Créditos descontados incorrectamente | Revisar `credit_transactions` |
| Error 5xx persistente de Mistral u OpenAI (> 5 min) | Logs: `docker compose logs worker` |
| Worker caído y no se recupera solo | `docker compose ps worker` |

**Regla**: Si el problema persiste más de 5 minutos sin solución clara → rollback inmediato.

---

## Paso 1 — Conectarse al servidor

```bash
ssh root@157.230.231.207
cd /root/worker
```

---

## Paso 2 — Ver versiones disponibles

```bash
docker images data-laundering-worker --format "{{.Tag}}\t{{.CreatedAt}}"
```

Ejemplo de salida esperada:
```
v1.1.0    2026-06-15 10:30:00
v1.0.0    2026-06-01 14:00:00
```

---

## Paso 3 — Ejecutar el rollback

```bash
./rollback.sh v1.0.0   # reemplazar con la versión objetivo
```

El script:
1. Verifica que la imagen existe
2. Actualiza `WORKER_VERSION` en `.env`
3. Levanta el contenedor con la imagen anterior (sin rebuild)
4. Muestra estado y logs al finalizar

**Tiempo esperado**: < 60 segundos

---

## Paso 4 — Verificar que el rollback fue exitoso

```bash
# Ver que el contenedor está corriendo
docker compose ps worker

# Ver que procesa sin errores (esperar ~30 segundos)
docker compose logs -f --tail=50 worker
```

Señales de éxito:
- `Worker listening for jobs...` en los logs
- Próximo job procesado sin errores

---

## Paso 5 — Comunicar el incidente

Anotar en el canal correspondiente:
- Versión que se revertió
- Versión a la que se volvió
- Hora del rollback
- Síntoma que lo causó

---

## Flujo de deploy normal (para referencia)

```bash
# En local: sincronizar archivos al servidor
scp worker/*.mjs root@157.230.231.207:/root/worker/
scp worker/extract_attachments.py root@157.230.231.207:/root/worker/

# En servidor: deploy con nueva versión
ssh root@157.230.231.207 "cd /root/worker && ./deploy.sh v1.1.0"
```

El script `deploy.sh` construye la imagen, la tagea con la versión indicada, y levanta el contenedor. La imagen anterior queda disponible para rollback.

---

## Versiones en producción

| Versión | Fecha | Descripción |
|---|---|---|
| v1.0.0 | 2026-06-01 | OCR Mistral + extracción OpenAI directo. N8n removido. PyMuPDF para OCs. |

---
## Rollback del FRONTEND

> El frontend son archivos estáticos en `/var/www/dataland/`, servidos por **Caddy en Docker** (`n8n-caddy-1`, Caddyfile del host en `/opt/n8n/caddy/Caddyfile`). No hay CI: **no existe ningún despliegue automático al mergear a `main`**. El build sale SIEMPRE de la máquina local y viaja por `scp`; `dist/` está en `.gitignore` y el servidor **no compila**.

### ⚠️ La copia de respaldo es paso OBLIGATORIO del deploy

El despliegue empieza con `rm -rf /var/www/dataland/assets`: es **destructivo y no deja copia**. Si el build nuevo sale mal y no se hizo respaldo, la única vuelta atrás es recompilar desde git. Por eso el respaldo va ANTES, siempre:

```bash
TS=$(date +%Y%m%d-%H%M%S)
ssh root@157.230.231.207 "cp -a /var/www/dataland /var/www/dataland.bak-$TS && ls -d /var/www/dataland.bak-$TS"
# ANOTAR EL TS. Sin esto el deploy no tiene vuelta atrás barata.
```

El respaldo queda como hermano de la raíz que sirve Caddy, así que **no es alcanzable desde internet** (verificado: esa URL devuelve el `index.html` del fallback de SPA, no el respaldo).

### Vuelta atrás — segundos, sin recompilar

```bash
ssh root@157.230.231.207 "rm -rf /var/www/dataland && \
                          mv /var/www/dataland.bak-<TS> /var/www/dataland"
```

Se toma al recargar: `index.html` va con `Cache-Control: no-cache` y `assets/*` con hash inmutable. **No cachear `index.html`**, o los usuarios no ven ni los deploys ni los rollbacks.

### Si NO hay respaldo (camino largo)

```bash
git checkout <commit bueno> && npm run build   # con SENTRY_AUTH_TOKEN en .env
ssh root@157.230.231.207 "rm -rf /var/www/dataland/assets"
scp -r dist/. root@157.230.231.207:/var/www/dataland/
```

Antes de subir: `find dist -name "*.map"` tiene que dar **vacío** (si no, se publican los mapas de código). Ver la regla de `loadEnv` en CLAUDE.md.

### Verificar el rollback

```bash
curl -s https://app.agoradigital.io/index.html | grep -oE '/assets/main-[A-Za-z0-9_-]+\.js'   # bundle esperado
ssh root@157.230.231.207 "find /var/www/dataland -name '*.map' | wc -l"                        # 0
```
Y abrir `app.agoradigital.io` en el navegador: tiene que cargar el login.

### Retención

Borrar el respaldo recién a los **días**, no el mismo día. Ocupa ~7 MB.

---


## Contacto de emergencia

- Servidor: `root@157.230.231.207`
- Supabase: proyecto `klhbgsiatzbmxbkzpbzv`
- Redis: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
