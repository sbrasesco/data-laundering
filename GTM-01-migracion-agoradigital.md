# GTM-01 — Migración de dominio y marca: `dataland.aignition.net` → `agoradigital.io`

> **Estado del documento:** Plan aprobado para revisión (2026-06-28). NADA de esto se ejecuta sin OK explícito por fase.
> **Decisiones cerradas (2026-06-28):** Nombre de producto/visual = **Ágora** (el dominio es `agoradigital.io`, pero la marca es solo "Ágora"). Logo/favicon **se mantienen como están**. Estructura: **landing en el apex `agoradigital.io`**, **app en `app.agoradigital.io`**, **worker/gateway en `api.agoradigital.io`** (callback OAuth en `https://api.agoradigital.io/api/auth/google/callback`). Dominio recién contratado, DNS sin configurar.
> **Regla de oro:** Producción con clientes activos. El dominio viejo **sigue funcionando** durante toda la transición. Cada fase es reversible. Google va **al final**, cuando el dominio nuevo ya cargue de forma segura.

---

## 1. Resumen en una frase

Mover todo lo que hoy vive en `dataland.aignition.net` (landing + login + sistema) al dominio nuevo `agoradigital.io`, renombrar la marca a "Ágora", y recién después actualizar la verificación de Google para que el "Conectar con Google Drive" deje de mostrar la advertencia de "app no verificada".

---

## 2. Foto del estado actual (verificado en código, 2026-06-28)

### Direcciones web hoy

| Pieza | Dirección actual | Qué es |
|---|---|---|
| App + Landing + Login | `https://dataland.aignition.net` | SPA React. Una sola dirección sirve la landing (`/`), el login (`/login`) y todo el sistema (dashboard, procesos, integraciones, etc.) |
| Worker / Gateway (el "motor") | `https://automation.aignition.net/worker` | Backend que procesa archivos y habla con Google Drive / MercadoPago. El usuario no lo ve |
| Callback OAuth de Google | `https://dataland.aignition.net/worker/api/auth/google/callback` | La URL exacta a la que Google devuelve al usuario tras autorizar Drive |

### Rutas de la app (todas bajo el mismo dominio)

`/` (landing), `/login`, `/payment/success`, `/payment/failure`, `/payment/pending`, y el área protegida: `/dashboard`, `/jobs/new`, `/jobs/:id`, `/documents`, `/monitoring` (superadmin), `/integrations`, `/settings`, `/mis-procesos`, `/clients`.

### Infraestructura

- **Servidor:** VPS DigitalOcean `157.230.231.207`.
- **Frontend:** archivos estáticos en `/var/www/dataland/`, servidos por **Caddy en Docker (`n8n-caddy-1`)**, con el Caddyfile en el host en `/opt/n8n/caddy/Caddyfile`. (El Caddy del sistema está inactivo — no confundir.)
- **Worker:** Docker Compose en `/root/worker/`.
- **Google Client ID:** `59795666065-qhm5r5p4q9rj8glpauhir6a6r4uen4sj.apps.googleusercontent.com` — **identifica la app, NO cambia** con la migración.
- **Scope de Google:** `https://www.googleapis.com/auth/drive` (restringido — requiere verificación + security assessment de terceros; por eso Google tarda 2-4 semanas).

---

## 3. Estado objetivo (DECIDIDO — 2026-06-28)

| Pieza | Dirección objetivo | Notas |
|---|---|---|
| Landing (marketing) | `https://agoradigital.io` (apex) | Página de bienvenida en el dominio raíz |
| App (sistema) | `https://app.agoradigital.io` | Subdominio dedicado para la aplicación |
| Worker / Gateway | `https://api.agoradigital.io` | Subdominio dedicado, apunta directo al worker (puerto 3001). Reemplaza `automation.aignition.net/worker` y elimina el prefijo `/worker` |
| Callback OAuth | `https://api.agoradigital.io/api/auth/google/callback` | En el subdominio del worker. Debe coincidir EXACTO en frontend env + worker env + Google Cloud Console |

> **Decisión cerrada:** landing en apex, app en `app.`, worker en `api.` (separado y limpio, sin el atajo `/worker` actual). El callback OAuth vive en `api.agoradigital.io`. El nombre de producto/visual es **Ágora**; logo/favicon se mantienen.
>
> **Implicancia del worker en subdominio propio:** el frontend usa `VITE_WORKER_GATEWAY_URL` como base sin path y cada archivo le appenda su endpoint (`/api/enqueue`, `/api/deposit-row`, etc.). Con base = `https://api.agoradigital.io`, las llamadas quedan `https://api.agoradigital.io/api/enqueue` (Caddy rutea `api.` → worker :3001 directo). Ya no hace falta el prefijo `/worker`.

---

## 4. Inventario de TODO lo que cambia

Esta es la lista para "no perder nada". Cada ítem indica **quién** lo ejecuta.

### 4.1 DNS — en el panel del registrador donde compraste agoradigital.io  → **Sergio**

| Tipo | Nombre / Host | Valor | Para qué |
|---|---|---|---|
| A | `@` (apex `agoradigital.io`) | `157.230.231.207` | Landing |
| A | `app` (`app.agoradigital.io`) | `157.230.231.207` | App / sistema |
| A | `api` (`api.agoradigital.io`) | `157.230.231.207` | Worker / gateway |
| TXT | `@` | (lo da Google Search Console al verificar el dominio) | Verificación de propiedad del dominio para OAuth |

> Nota: si más adelante se usa CDN/proxy, podrían ser CNAME en vez de A. Hoy todo apunta directo al VPS.

### 4.2 Servidor — Caddy (certificado SSL + ruteo)  → **Claude Code**

- Agregar bloques en `/opt/n8n/caddy/Caddyfile` para `app.agoradigital.io`, `api.agoradigital.io` y `agoradigital.io`. Caddy emite el certificado HTTPS (Let's Encrypt) automáticamente al primer acceso, **una vez que el DNS ya apunta**.
- Mantener los bloques viejos de `dataland.aignition.net` / `automation.aignition.net` activos en paralelo (no romper a los clientes actuales).
- Regla ya conocida: `index.html` con `no-cache`; `/assets/*` con cache largo + `immutable`.

### 4.3 Frontend — variables de entorno y build  → **Cowork prepara, Claude Code buildea/deploya**

Archivo `.env` (producción del frontend):

| Variable | Valor actual | Valor nuevo |
|---|---|---|
| `VITE_WORKER_GATEWAY_URL` | `https://automation.aignition.net/worker` | `https://api.agoradigital.io` (base sin path) |
| `VITE_GOOGLE_REDIRECT_URI` | `https://dataland.aignition.net/worker/api/auth/google/callback` | (la definitiva, ver §3) |
| `VITE_GOOGLE_CLIENT_ID` | `59795666065-…` | **sin cambios** |
| `VITE_N8N_WEBHOOK_URL` | `https://dataland.aignition.net/webhook/...` | revisar si sigue en uso (DEC-011: n8n eliminado del pipeline) |

### 4.4 Frontend — fallbacks hardcodeados a revisar  → **Cowork**

Hay 4 archivos con un valor por defecto `?? 'https://automation.aignition.net/worker'` (por si falta la env var). En producción la env var está seteada, así que **no es urgente**, pero conviene actualizarlos por prolijidad y para no dejar referencias al dominio viejo:

- `src/components/pdf-jobs/JobDocumentsSection.tsx`
- `src/components/ui/InsufficientCreditsModal.tsx`
- `src/components/pdf-jobs/JobRowsTable.tsx`
- `src/lib/pdfJobHelpers.ts`

### 4.5 Worker — variables de entorno (`/root/worker/.env`)  → **Claude Code / Sergio en el server**

| Variable | Valor actual | Valor nuevo |
|---|---|---|
| `GATEWAY_URL` | `https://automation.aignition.net/worker` | `https://api.agoradigital.io` |
| `GOOGLE_REDIRECT_URI` | `https://dataland.aignition.net/worker/api/auth/google/callback` | (la definitiva, ver §3) — **debe ser idéntica a la del frontend y a la de GCP** |
| `FRONTEND_URL` | `https://dataland.aignition.net` | `https://app.agoradigital.io` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (actuales) | **sin cambios** |

> `FRONTEND_URL` se usa para los redirects de pago (`/payment/success|failure|pending`) y para volver a `/integrations` tras conectar Drive. Si no se actualiza, esos redirects mandan al dominio viejo.

### 4.6 Google Cloud Console (proyecto OAuth)  → **Sergio, con guía de Cowork**

- **Authorized redirect URIs:** agregar la nueva (la definitiva de §3). Se puede tener la vieja y la nueva en simultáneo durante la transición.
- **Authorized JavaScript origins:** agregar `https://app.agoradigital.io`.
- **OAuth consent screen:** nombre de la app → "Ágora"; dominio autorizado → `agoradigital.io`; enlaces a la Privacy Policy y Terms en el dominio nuevo.
- **Domain verification:** verificar `agoradigital.io` (vía el TXT de §4.1 en Search Console).
- **Verificación / Publishing:** enviar el formulario de verificación del scope restringido `drive`.

### 4.7 Marca — rebrand a "Ágora"  → **Cowork**

- Textos visibles en la UI que digan "DataLand" / "Aurora" / "Aignition" como nombre de producto → "Ágora".
- Título del navegador (`index.html` `<title>`) y metadatos.
- **Logo y favicon se MANTIENEN como están** (decisión de Sergio): el rebrand es sólo el nombre de texto, no la identidad visual.
- (A verificar el alcance exacto con un grep de "DataLand"/"Aurora" en `src/`.)

### 4.8 Documentos legales  → **Cowork redacta, Sergio publica**

- **Privacy Policy** publicada en `https://agoradigital.io/privacy` (o ruta equivalente). Requisito **obligatorio** para la verificación OAuth de Google.
- (Opcional pero recomendado) Terms of Service.

---

## 5. Plan por fases (incremental, reversible)

> Principio: el dominio viejo nunca se apaga hasta que el nuevo esté 100% probado. En cada fase, si algo falla, se detiene y los clientes siguen operando en `dataland.aignition.net`.

### Fase 0 — Cerrar decisiones (no técnico)
- Confirmar estructura de URLs (§3): app / landing / worker / callback.
- Confirmar alcance del rebrand (sólo nombre de producto, o también logo/favicon).
- **Bloquea todo lo demás.**

### Fase 1 — DNS + SSL del dominio nuevo, en paralelo  → Sergio (DNS) + Claude Code (Caddy)
- Cargar los registros DNS (§4.1).
- Agregar los bloques de Caddy (§4.2) → certificado HTTPS automático.
- **Resultado esperado:** `https://app.agoradigital.io` y `https://api.agoradigital.io` cargan **lo mismo** que el dominio viejo, con candado de seguridad. El dominio viejo sigue intacto.
- **Rollback:** quitar los bloques nuevos del Caddyfile. Cero impacto en lo viejo.

### Fase 2 — Rebrand a "Ágora"  → Cowork (código) + Claude Code (deploy)
- Cambiar textos/branding (§4.7). Es independiente del dominio; se puede deployar al dominio viejo primero y verlo en vivo.
- **Rollback:** revertir el commit del frontend.

### Fase 3 — Cutover de dominio (el paso coordinado, ZONA CERRADA)  → Cowork prepara, Claude Code/Sergio ejecutan
- Actualizar env del frontend (§4.3) + fallbacks (§4.4) + env del worker (§4.5), **todo apuntando al dominio nuevo**.
- Agregar la nueva redirect URI en Google Cloud Console **antes** de deployar (§4.6), conviviendo con la vieja.
- Deploy del frontend al nuevo destino + rebuild del worker con el `.env` nuevo.
- **Probar el flujo completo en `app.agoradigital.io`:** login, conectar Drive (con la redirect nueva), procesar un documento, pago de prueba.
- **DECISIÓN (2026-06-28): `dataland.aignition.net` se da de baja.** Primero queda como **redirect 301 permanente** a `app.agoradigital.io` (Caddy `redir`); una vez verificado todo, se decomisiona. `automation.aignition.net` ídem hacia `api.agoradigital.io`.
- **⚠️ Riesgo:** la redirect URI de OAuth debe coincidir EXACTO en los 3 lugares (frontend env, worker env, GCP). Si no, "Conectar Drive" falla. Por eso se prueba antes de comunicar a clientes.
- **Rollback:** volver las env vars a los valores viejos + redeploy. La redirect vieja sigue en GCP, así que se puede volver atrás sin tocar Google.

### Fase 4 — Privacy Policy + verificación OAuth de Google  → Cowork (redacta) + Sergio (GCP)
- Publicar Privacy Policy en el dominio nuevo (§4.8).
- Completar consent screen + domain verification + enviar formulario de verificación del scope `drive` (§4.6).
- **Espera de Google: 2-4 semanas.**
- **Mientras tanto:** agregar los emails de los tenants activos como **Test Users** en GCP (parche temporal sano; límite 100 usuarios). Así no ven la advertencia durante la revisión.

### Fase 5 — Cierre
- Google aprueba → el "Conectar Drive" queda limpio, sin advertencia.
- Decidir si se da de baja el dominio viejo o se deja redirigiendo indefinidamente.
- Actualizar `CLAUDE.md`, memoria y Decisions Log con el dominio/URLs definitivos.

---

## 6. Quién hace qué (resumen)

| Tarea | Responsable |
|---|---|
| Cargar registros DNS en el registrador | **Sergio** |
| Caddy (SSL + ruteo) en el VPS | **Claude Code** |
| Cambios de código (env, fallbacks, rebrand) | **Cowork** prepara → **Claude Code** buildea/deploya |
| Env del worker en el server + rebuild | **Claude Code** / Sergio |
| Google Cloud Console (consent, redirect, verificación) | **Sergio** con guía de **Cowork** |
| Redactar Privacy Policy | **Cowork** |
| Publicar Privacy Policy | **Sergio** / Claude Code |

---

## 7. Riesgos y cuidados

- **OAuth redirect URI desalineada** → "Conectar Drive" roto. Mitigación: convivencia de redirect vieja+nueva en GCP y prueba funcional antes de comunicar.
- **DNS con propagación lenta** → el dominio nuevo puede tardar minutos/horas en resolver. No apurar el SSL antes de que el DNS resuelva.
- **Cachear `index.html`** en el dominio nuevo → los usuarios no verían deploys. Mantener `no-cache` en `index.html`.
- **MercadoPago redirects** (`FRONTEND_URL`) → si no se actualiza el env del worker, los pagos vuelven al dominio viejo.
- **Pipeline de integración (zona cerrada)** → el worker no cambia su lógica; sólo cambian env vars (GATEWAY_URL, FRONTEND_URL, REDIRECT_URI). No tocar `poller-handoff`, `integration-file-mover`, etc.
- **n8n webhook** (`VITE_N8N_WEBHOOK_URL`) → verificar si sigue en uso antes de migrarlo (DEC-011 dice n8n eliminado del pipeline).

---

## 8. Tasks en el Kanban

- **GTM-01 (TASK-89)** — Épico paraguas. Decisiones cerradas: Ágora + agoradigital.io.
- **GTM-02** — DNS + SSL del dominio nuevo en paralelo (Fase 1).
- **GTM-03** — Rebrand a "Ágora" en el frontend (Fase 2).
- **GTM-04** — Cutover de dominio + OAuth redirect URI (Fase 3, zona cerrada).
- **GTM-05** — Privacy Policy publicada en agoradigital.io (Fase 4).
- **GTM-06** — Verificación OAuth en Google Cloud Console + Test Users interinos (Fase 4-5).

---

## 9. Próximo paso inmediato

La Fase 0 (decisiones) está **cerrada** (ver §3): landing en apex, app en `app.`, worker en `api.`, nombre "Ágora", logo/favicon sin cambios. Próximo paso ejecutable: **Fase 1 — DNS + SSL** (GTM-02), que es segura y no toca producción. Sergio carga los registros DNS de §4.1; Claude Code agrega los bloques de Caddy.
