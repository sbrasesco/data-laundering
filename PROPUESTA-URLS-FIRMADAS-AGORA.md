# Propuesta — pasar a URLs firmadas y cerrar los buckets

*Agora · v2, 2026-09-10 · Verificado contra la base y el código en vivo. **Propuesta, no ejecutada.***

> **v2 corrige dos errores de la v1.** Decía "cuatro lugares" (son **cinco**) y decía que `facturas` quedaba congelado (**no lo está**: la carga desde el panel web sigue escribiendo ahí). Los dos errores salen del mismo descuido: busqué sólo en la carpeta `worker/` y di por cerrado el mapa sin abrir el frontend. Lo detectó el agente de Claude Code y lo confirmé leyendo `src/lib/pdfJobHelpers.ts`.

---

## 0. Antes de leer el resto

Buscando el quinto lugar encontré algo que **no tiene que ver con los buckets y pesa más que ellos**. Está en §6. Si tenés cinco minutos y no quince, leé §6 primero.

---

## 1. El problema en una línea

Los buckets `documents` y `facturas` son **públicos**: cualquiera que conozca la dirección exacta de un archivo se lo descarga sin autenticarse, para siempre.

No se pueden cerrar hoy porque **el OCR descarga el archivo por esa URL pública**. Mistral es un servicio externo: no tiene nuestra sesión ni nuestras claves. Si el archivo no es alcanzable desde afuera, no hay extracción.

La URL firmada resuelve exactamente eso: es alcanzable desde afuera, pero **caduca**.

---

## 2. El hallazgo que hace esto barato

*(Esto de la v1 se mantiene: lo volví a verificar.)*

```
pdf_jobs: 1.383 filas
  input_file_url  con valor →  0
  output_file_url con valor →  0
  file_manifest / file_location con una URL pública dentro → 0
```

La URL **nunca se persiste**. Nace cuando se sube el archivo, viaja adentro del trabajo, se usa para el OCR, y muere ahí.

No hay catálogo viejo que migrar. No hay enlace guardado que se rompa al caducar. El cambio es **hacia adelante solamente**, y por eso es barato ahora.

---

## 3. Los cinco lugares donde se arma la URL pública

| # | Archivo | Línea | Bucket | Estado |
|---|---|---|---|---|
| 1 | `worker/poller-handoff.mjs` | 148 | `documents` | Activo — camino principal |
| 2 | `worker/integration-poller.mjs` | 74 | `documents` | Activo — Drive |
| 3 | `worker/zip-processor.mjs` | 68 | `STORAGE_BUCKET` | Activo — ZIP y RAR |
| 4 | `worker/ftp-sftp-poller.mjs` | 67 | `documents` | Inactivo (SFTP apagado) |
| 5 | **`src/lib/pdfJobHelpers.ts`** | **88** | **`facturas`** | **Activo — carga web** |

**El quinto es distinto de los otros cuatro, y ahí está toda la dificultad.**

Los cuatro del worker corren en el servidor, con la clave de servicio. Firmar ahí es trivial: una función nueva y cuatro llamadas.

El quinto corre **en el navegador del usuario, con la sesión del usuario**. Y hoy no puede firmar nada:

```
Políticas SELECT sobre facturas para usuarios autenticados: NINGUNA
```

Para firmar una URL hay que tener permiso de lectura sobre el objeto. El navegador no lo tiene. Hoy funciona **sólo** porque el bucket es público.

---

## 4. Cómo se resuelve el quinto

El panel sube el archivo así (`pdfJobHelpers.ts:79-88`):

```ts
const storageKey = `${jobId}.${ext}`;               // raíz del bucket, sin organización
await supabase.storage.from('facturas').upload(storageKey, file, { upsert: true });
const { data: { publicUrl } } = supabase.storage.from('facturas').getPublicUrl(storageKey);
```

Dos opciones. **Recomiendo la A**, porque arregla de paso el agujero de §5.1.

### Opción A — el panel guarda dentro de su organización y firma él

```ts
const storageKey = `${organizationId}/uploads/${jobId}.${ext}`;
await supabase.storage.from('documents').upload(storageKey, file, { upsert: false });
const { data } = await supabase.storage.from('documents')
  .createSignedUrl(storageKey, 86400);
```

Requiere dos políticas nuevas sobre `documents`, las dos acotadas a la organización del usuario:

```sql
CREATE POLICY documents_insert_propia ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents'
              AND (storage.foldername(name))[1] = (current_org_id())::text);

CREATE POLICY documents_select_propia ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents'
         AND (storage.foldername(name))[1] = (current_org_id())::text);
```

**A favor:** cada organización queda encerrada en su carpeta. Habilita borrar las dos políticas abiertas de `facturas` (§5.1). Y ahí sí `facturas` queda congelado de verdad.
**En contra:** toca el frontend y hay que desplegarlo.

### Opción B — firma el gateway

El panel manda al gateway el **camino** del archivo en vez de la URL, y el gateway firma con la clave de servicio.

**A favor:** el navegador no necesita ningún permiso nuevo.
**En contra:** cambia el contrato del gateway (`file_url` → `bucket` + `path`, y la validación de `gateway.mjs:825` que exige que empiece con `https://`), y **no arregla el agujero de escritura**: las políticas abiertas de `facturas` siguen igual.

---

## 5. El plan, en pasos que se validan por separado

**No cerrar los buckets en el mismo paso que se cambian las URLs.** Si algo falla hay que poder distinguir qué lo rompió.

### Paso 1 — Firmar en el worker, con los buckets todavía abiertos

Los cuatro lugares del worker. Función nueva:

```js
async function firmarUrl(supabaseUrl, supabaseKey, bucket, path, segundos = 86400) {
  const res = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`, {
    method:  'POST',
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
               'Content-Type': 'application/json' },
    body:    JSON.stringify({ expiresIn: segundos }),
  });
  if (!res.ok) throw new Error(`No se pudo firmar (${res.status}): ${await res.text()}`);
  const { signedURL } = await res.json();          // viene como "/object/sign/..."
  return `${supabaseUrl}/storage/v1${signedURL}`;
}
```

Como los buckets siguen abiertos, si la firma falla el archivo se sigue descargando igual y **no se le corta el procesamiento a nadie**.

**Cuánto dura: 24 horas.** Un trabajo puede reintentar con espera creciente; si la firma vence antes del último reintento, ese reintento falla y no se recupera. 24 h es muchísimo menos que "para siempre" y deja margen de sobra.

Los cuatro consumidores aguantan una URL firmada — verificado leyendo el código:

| Dónde | Qué hace | ¿Aguanta? |
|---|---|---|
| `document-processor.mjs:366` | Se la pasa a Mistral | Sí, es un GET común |
| `document-processor.mjs:306` | `fetch(fileUrl)` para la primera página | Sí |
| `worker.mjs:316` | `fetch` + `writeFile` | Sí |
| `zip-processor.mjs:263` | `fetch` + `writeFile` | Sí |

> **Actualizado el 2026-09-11.** La v2 de este documento decía que estos
> dos lugares usaban `wget` y que "las comillas dobles protegen". **Las
> dos cosas eran falsas y ya no aplican:** INC-001 reemplazó `wget` por
> `fetch` + `writeFile` justamente porque `exec` pasa por `/bin/sh` y las
> comillas dobles no impiden que `$(...)` se expanda. Ningún lugar del
> worker construye comandos de shell con texto interpolado.

*Validación:* una factura real por Drive. En los registros, la URL del OCR tiene que empezar con `/object/sign/` y llevar `?token=`. El trabajo tiene que llegar a `done`.

### Paso 2 — El panel: opción A

Cambiar `pdfJobHelpers.ts`, crear las dos políticas, desplegar el frontend.

*Validación:* subir un ZIP desde el panel y que llegue a `done`. Y con la sesión de otra organización, intentar leer un archivo ajeno: tiene que fallar.

### Paso 3 — Cerrar los dos buckets

```sql
UPDATE storage.buckets SET public = false WHERE id IN ('documents', 'facturas');
```

*Vuelta atrás:* la misma sentencia con `true`. Instantánea.

*Validación:* pedir por el navegador, sin sesión, la URL pública de un archivo conocido → error. Y a la vez, una factura real por Drive tiene que seguir llegando a `done`.

### Paso 4 — Recién ahora, cerrar la escritura de `facturas`

```sql
DROP POLICY facturas_authenticated_upload ON storage.objects;
DROP POLICY facturas_authenticated_update ON storage.objects;
```

**No antes del paso 2**, o se rompe la carga web.

---

## 6. Lo que encontré buscando el quinto lugar

Esto no es parte de la propuesta. Lo pongo acá porque apareció leyendo el mismo archivo y me parece que **pesa más que los buckets**.

`pdfJobHelpers.ts:73-74`:

```ts
const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';
const workerApiKey     = import.meta.env.VITE_WORKER_API_KEY     ?? 'staging-key-2026';
```

Las variables `VITE_` **se compilan adentro del JavaScript que descarga cualquiera que abra la aplicación**. No son secretos del servidor: son texto visible en el navegador. Y si la variable no está definida al compilar, queda pegada la de reserva, `staging-key-2026`.

Del otro lado, `gateway.mjs:1216-1221`: **todas las rutas del gateway** (menos el aviso de MercadoPago) se protegen con esa única llave compartida.

Y `/api/enqueue` toma el `organization_id` **del cuerpo del pedido**, sin comprobar que quien llama pertenezca a esa organización (`gateway.mjs:813-825`).

Puesto junto: quien tenga esa llave puede encolar trabajos **a nombre de cualquier organización**, gastándole el saldo. Y también leer `/api/prompt`, que devuelve el prompt de extracción completo.

### CONFIRMADO — 2026-09-10, contra el sitio en producción

No es una sospecha sobre el código fuente. Lo verifiqué **descargando lo que sirve `agoradigital.io`**:

| Comprobación | Resultado |
|---|---|
| Valor real de `VITE_WORKER_API_KEY` en el `.env` de compilación | 16 caracteres, empieza `stagin` → **es la llave de reserva** |
| `staging-key-2026` dentro del bundle compilado | **Sí**, en texto plano, en `main-POGKC2yf.js` y en `SubirZipPage-B63UJkcz.js` |
| El sitio sirve esos mismos archivos | **Sí** — el nombre lleva el hash del contenido, así que mismo nombre = mismo contenido |
| **Los mapas de código (`.js.map`) están publicados** | **Sí.** `agoradigital.io/assets/SubirZipPage-B63UJkcz.js.map` se descarga sin sesión |

Lo último es lo peor y no lo esperaba. Los mapas de código llevan `sourcesContent`: **el código fuente TypeScript original, sin minificar y con los comentarios**. Leí desde el sitio en vivo, sin autenticarme, el contenido completo de `src/lib/pdfJobHelpers.ts` y `src/pages/SubirZipPage.tsx`.

**Lo que NO está expuesto:** la clave de servicio de Supabase no aparece en ningún lado del bundle. La única clave de Supabase que viaja es la pública (`role: anon`), que es pública **por diseño** y está bien que esté ahí.

### Qué habilita

`gateway.mjs:1216-1221` protege **todas** las rutas con esa única llave. Con ella se alcanza `enqueue`, `mp/create-preference`, `mp/create-custom-preference`, `deposit-row`, `drive/folders`, `drive/set-folder`, `metrics` y `prompt`.

- **`/api/prompt`** devuelve el prompt de extracción completo. No hace falta ningún dato más. **Es el activo del producto y hoy se descarga.**
- **`/api/enqueue`** toma el `organization_id` del cuerpo del pedido sin comprobar que quien llama pertenezca a esa organización. Hace falta conocer un identificador válido de organización, que no es adivinable — pero cualquier cliente conoce el suyo.

**No probé ninguna de estas rutas contra producción.** Esto sale de leer el código del gateway, no de ejercitarlo.

### El arreglo

**Rotar la llave no sirve**: la llave nueva vuelve a quedar adentro del bundle siguiente. Cualquier secreto que se compile en el frontend es público, sin excepción.

Tres cosas, de más barata a más de fondo:

1. **Dejar de publicar los mapas de código.** Una línea en `vite.config.ts` (`build: { sourcemap: false }`) y volver a desplegar. No arregla la llave —sigue en el bundle minificado— pero saca el código fuente completo de la vía pública. Es de hoy para mañana.
2. **Sacar `/api/prompt` de la superficie pública**, o exigirle un permiso distinto del resto.
3. **El arreglo de fondo:** que el gateway valide **la sesión del usuario** (el JWT de Supabase que el navegador ya tiene) y saque el `organization_id` del token, no del cuerpo. La llave compartida queda sólo para los pollers, que corren en el servidor y nunca la mandan a un navegador. Es un cambio de contrato y **necesita su propio plan** — no entra acá.

---

## 7. Dos cosas menores que ya no son un misterio

**Los "143 archivos sin organización identificable" de `facturas`.** Son **142 archivos que subiste vos desde el panel web con la cuenta de Aignition**, entre mayo y agosto. Están en la raíz del bucket como `<uuid>.<extensión>`, sin carpeta de organización — exactamente lo que hace `pdfJobHelpers.ts:79`. Por eso parecían huérfanos. No hay nada de ningún cliente ahí.

**Un archivo con estado `upload_failed`** en el registro de un trabajo de ZIP: nombre de 118 caracteres, con comas, paréntesis y espacios dobles. **No sé por qué falló y no lo investigué.** Queda anotado, no diagnosticado.

---

## 8. Qué NO toca esta propuesta

- La lógica de extracción, el prompt y la capa determinística.
- El bucket `amono`, que ya nace cerrado y con políticas por organización.
- Las tablas, disparadores y funciones existentes.
- El proxy web, el despliegue y la cola.
- Los archivos ya guardados: no se mueve ni se renombra ninguno.

---

## 9. Criterio de terminado

- [ ] Una factura real por Drive procesada de punta a punta con URL firmada, verificada campo por campo.
- [ ] Un ZIP subido desde el panel procesado de punta a punta, con el archivo dentro de la carpeta de su organización.
- [ ] Con los buckets cerrados, una URL pública conocida devuelve error sin sesión.
- [ ] Con la sesión de otra organización, un archivo ajeno no se puede leer.
- [ ] La bitácora de Agora actualizada con la decisión y su porqué.
