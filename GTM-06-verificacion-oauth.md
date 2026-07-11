# GTM-06 — Verificación OAuth (scope restringido `drive`)

**Task:** TASK-131 · **OAuth Client:** `59795666065-qhm5r5p4q9rj8glpauhir6a6r4uen4sj.apps.googleusercontent.com`
**Estado:** prereqs hechos (dominio verificado + marca "Agora" publicada). Falta: registrar scope + justificación + video demo + CASA.

---

## 0. Hechos que condicionan la tarea (verificados 2026-07-11)

- **El scope restringido es necesario.** `drive.file` NO sirve: solo da acceso a archivos creados por la app o elegidos por el usuario en el Picker, y **no da acceso continuo a archivos que se agregan a la carpeta después**. Nuestro producto es exactamente una carpeta vigilada. Confirmado en la doc de Google.
- **CASA es anual y pago.** Los scopes restringidos exigen evaluación de seguridad de un tercero + recertificación cada 12 meses. No es un trámite de una sola vez.
- **"Test Users" NO aplica.** Solo funciona con la app en estado *Testing*. La nuestra está **En Producción** con usuarios externos. Volver a modo prueba rompería a los usuarios actuales → **no tocar "Volver a modo prueba"**.
- **Driver real:** cupo de **100 autorizaciones de por vida** del scope restringido sin verificar (vamos 4/100, no reseteable). Al llegar al tope, ningún cliente nuevo puede conectar Drive.
- **No hay inconsistencia de scopes en el código:** el front pide `drive` (completo) y el cliente OAuth del worker hereda ese scope vía refresh token. El `drive.readonly` que aparece en `integration-poller.mjs` es de `buildDriveClientServiceAccount` (ruta **legacy** de service account, TASK-39), no del flujo OAuth activo.

---

## 1. Justificación del scope (texto para el formulario — en inglés)

> **Scope requested:** `https://www.googleapis.com/auth/drive`

**How the app uses the scope**

Agora is a B2B SaaS that digitizes Argentine tax invoices (facturas, notas de crédito/débito) for accounting teams. When a user connects Google Drive, the app creates a single dedicated folder in the user's Drive (`AGORA_SOFTWARE`) with a fixed structure (`en_proceso/`, `procesados/`, `fallidos/`, `extracciones/`).

The app's core function is a **watched folder**: the user drops invoice files (PDF/JPG/PNG/ZIP) into that folder, and Agora automatically:

1. **Lists** the files the user has added to the designated folder (`files.list`).
2. **Downloads** each file to run OCR and AI-based field extraction (`files.get`).
3. **Moves** each file between the subfolders as it progresses — from the root to `en_proceso/`, then to `procesados/` or `fallidos/` (`files.update` with `addParents`/`removeParents`).
4. **Creates** the folder structure and **writes back** the extraction results as a spreadsheet (`resultados.xlsx`, `productos.xlsx`) into `extracciones/` (`files.create`).

All access is confined to the folder the user designates when connecting. The app does not browse, read, or modify any other file in the user's Drive.

**Why a narrower scope is not sufficient**

- `drive.file` is not viable. It grants per-file access only to files **created by the app** or **explicitly selected by the user through the Google Picker**. It does **not** grant ongoing access to files that the user adds to a folder afterwards. Our entire product model is an automated watched folder: the user drops new invoices over time and the app must discover and process them without any further interaction. With `drive.file`, those files would be invisible to the app.
- `drive.readonly` is not sufficient either, because the app must **write**: it creates the folder structure, moves each processed file into `procesados/` or `fallidos/` so the user can see the processing state, and uploads the extraction output back to the user's Drive.
- Therefore the app requires read **and** write access to the user's Drive folder, which today is only achievable with the `drive` scope.

**Data handling**

Files are downloaded only to be processed (OCR + extraction) and the extracted fields are stored in the user's own tenant (multitenant database with row-level security). Data is never shared with third parties or used for advertising. Users can request deletion of their data at any time. Privacy Policy: `https://agoradigital.io/privacy.html`.

---

## 2. Guion del video demo

Requisitos de Google que el video **debe** cumplir:

- Todo el flujo de consentimiento **en inglés** (cambiar el idioma en el selector abajo a la izquierda de la pantalla de consentimiento).
- Se debe ver la **barra de direcciones** del navegador con el **OAuth client ID** en la URL del consent screen.
- El consent screen debe mostrar el **nombre de la app ("Agora")** y **exactamente los scopes** que pedimos.
- Se debe mostrar **en detalle el uso real** del scope dentro de la app.

**Shot list**

1. **(0:00)** Abrir `https://app.agoradigital.io`, iniciar sesión. Mostrar brevemente la app.
2. **(0:15)** Ir a **Integraciones** → click en **Conectar con Google Drive**.
3. **(0:20)** Al abrir el consent screen: **pausar y hacer zoom en la barra de direcciones** para que se lea el `client_id=59795666065-...`. Cambiar el idioma a **English** (abajo a la izquierda).
4. **(0:30)** Mostrar el consent screen completo: nombre **Agora**, y el permiso solicitado ("See, edit, create and delete all of your Google Drive files"). Leerlo en voz alta / mostrarlo claramente.
5. **(0:45)** Otorgar el consentimiento. Volver a la app y mostrar que la integración quedó conectada.
6. **(1:00)** Abrir Google Drive del usuario y mostrar la carpeta **`AGORA_SOFTWARE`** creada, con sus subcarpetas.
7. **(1:15)** **Arrastrar una factura PDF** a la carpeta (el gesto clave: el usuario agrega un archivo que la app no creó).
8. **(1:30)** Volver a la app: mostrar que apareció el **proceso nuevo** y el documento procesado (datos extraídos).
9. **(1:50)** Volver a Drive: mostrar que el archivo **se movió a `procesados/`** y que se generó **`resultados.xlsx`** en `extracciones/`.
10. **(2:10)** Cierre: narrar que ese es el uso completo del scope — listar y leer los archivos de la carpeta designada, moverlos entre subcarpetas y escribir el resultado; nada fuera de esa carpeta.

Subir a **YouTube como "no listado"** y pegar el link en el formulario.

---

## 3. Pasos en Google Cloud Console

1. **Google Auth Platform → Branding** (ex OAuth consent screen). Verificar que esté: nombre **Agora**, home `https://agoradigital.io`, privacy `https://agoradigital.io/privacy.html`, emails de soporte/desarrollador. *(Ya hecho.)*
2. **Data Access** → agregar el scope `https://www.googleapis.com/auth/drive` → pegar la **justificación** de la sección 1.
3. Adjuntar el **link del video demo**.
4. **Enviar a verificación.** Revisión estimada 2-4 semanas. Esperar que Google pida la **evaluación de seguridad (CASA)**.
5. Responder a lo que pidan (suelen volver con observaciones; no es raro un par de rondas).

## 4. Housekeeping (hacer ahora, es gratis)

- **Credentials → OAuth Client `59795666065-…`**: quitar la redirect URI vieja `https://dataland.aignition.net/worker/api/auth/google/callback` y el JS origin viejo `https://dataland.aignition.net`.
- **Branding**: quitar el dominio autorizado `aignition.net` si sigue cargado.

## 5. No tocar

- ⚠️ **No** volver la app a "modo prueba" (rompe a los usuarios actuales).
- ⚠️ **No** borrar el TXT `google-site-verification=...` del DNS de agoradigital.io (Search Console).
