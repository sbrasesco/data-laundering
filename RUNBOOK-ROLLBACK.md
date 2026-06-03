# Runbook de Rollback — Data Laundering Worker

**Versión del runbook**: 1.0  
**Última actualización**: 2026-06-01  
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

## Contacto de emergencia

- Servidor: `root@157.230.231.207`
- Supabase: proyecto `klhbgsiatzbmxbkzpbzv`
- Redis: `redis-16705.crce216.sa-east-1-2.ec2.cloud.redislabs.com:16705`
