# Aurora — Contexto de arranque para nueva sesión

## Qué es este proyecto

**Aurora** (antes DataLand) — SaaS multitenant de extracción de datos de facturas con IA. Tiene clientes activos en producción. Empresa detrás: Aignition.

- Frontend: `https://dataland.aignition.net` (VPS DigitalOcean `157.230.231.207`)
- Repo local: `C:\Users\sbras\OneDrive\Documentos\Aignition\Servicios\Data Laundering\data-laundering V2.0`
- Supabase project: `klhbgsiatzbmxbkzpbzv`
- Superadmins: `arcademy.dev@gmail.com`, `sbrasesco@outlook.es`

---

## Estado al 2026-06-16

- **Worker:** v1.9.9 — build estable, BullMQ + Redis Cloud, N8N eliminado definitivamente
- **Frontend:** build main-CZQZmmXM.js (commit f9d53a2) — Aurora rebrand completo, landing actualizada
- **Kanban técnico:** CERRADO — única tarea abierta es GTM-01 (URL definitiva, bloqueada por dominio)
- **Próxima fase:** Comercial (pricing, GTM, videos, Calendly)

---

## Lo primero que hay que hacer al iniciar sesión

1. Leer `CLAUDE.md` sección 🔒 ZONA CERRADA — sistemas que no se tocan sin tarea explícita
2. Confirmar estado real de prod antes de proponer cambios
3. Si la sesión es comercial, retomar desde el backlog de Fase Comercial (abajo)
4. Nunca asumir que algo existe — verificar en código o Notion

---

## Zonas cerradas (NO tocar sin tarea explícita)

- **AuthContext** (`src/contexts/AuthContext.tsx`) — callback `onAuthStateChange` SÍNCRONO, nunca async/await dentro
- **Billing / MercadoPago** — webhook, preferencias, `add_credits`, `MP_ACCESS_TOKEN` en prod
- **Google Drive OAuth** — `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_REDIRECT_URI`, `GATEWAY_URL`
- **RLS / DB** — `integration_processed_files`, trigger `handle_new_user`, RPCs SECURITY DEFINER
- **Sentry** — DSN, source maps, `SENTRY_AUTH_TOKEN`
- **Deploy** — siempre SCP + docker compose, nunca `docker run` manual ni Netlify ni `git pull` en servidor

---

## Backlog activo

### 🚫 BLOQUEADO — GTM-01 (TASK-89)
Verificación OAuth Google + URL definitiva. Requiere definir dominio primero.
- Notion: https://app.notion.com/p/380e32b060fc814eb0b6cd9a7c2f9dab
- Mientras tanto: agregar tenants activos como Test Users en GCP manualmente.

### 🆕 FASE COMERCIAL
- [ ] Política de precios definitiva (planes, condiciones, cancelación)
- [ ] Estrategia GTM — canales de adquisición, ICP
- [ ] Videos explicativos integrados en la landing
- [ ] Calendly (o similar) para agendar demos desde la landing
- [ ] Flujo de onboarding para nuevos clientes

---

## Deploy frontend

```bash
cd "/mnt/c/Users/sbras/OneDrive/Documentos/Aignition/Servicios/Data Laundering/data-laundering V2.0"
git add <archivos> && git commit -m "mensaje"
npm run build
scp -r dist/. root@157.230.231.207:/var/www/dataland/
```

## Deploy worker

```bash
scp worker/*.mjs root@157.230.231.207:/root/worker/
ssh root@157.230.231.207 "cd /root/worker && docker compose build && docker compose up -d --force-recreate"
```

---

## Notion

- Kanban: https://www.notion.so/3f50ef369c7a4e539451f0a9ebee60eb
- GTM-01: https://app.notion.com/p/380e32b060fc814eb0b6cd9a7c2f9dab
