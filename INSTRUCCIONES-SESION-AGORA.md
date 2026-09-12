# Cómo arrancar una sesión de Agora

*Pegar este documento —o su contenido— al abrir un chat nuevo de Agora.*
*Última actualización: 2026-09-12*

---

Retomamos **Agora** — SaaS multitenant de digitalización de facturas argentinas. **EN PRODUCCIÓN**, con un cliente facturando (Menara). La regla de oro del proyecto: **estabilidad antes que velocidad**.

---

## 1. Cómo cargar contexto — en este orden, antes de responder nada

1. La memoria del proyecto.
2. `ONBOARDING-TECNICO-AGORA.md` — arquitectura y método de la casa.
3. `CLAUDE.md` — estado vivo: decisiones, incidentes (INC-001..005), problemas conocidos y la cola de seguridad.
4. `RUNBOOK-ROLLBACK.md` — worker y frontend.

Y esto no es opcional: **verificá el estado contra la base y el código antes de afirmar nada.** Los documentos son una foto, no la realidad.

---

## 2. Quién hace qué

| Quién | Qué |
|---|---|
| **La sesión de chat** | Análisis, diseño, y los cambios de base de datos por MCP de Supabase. También la verificación desde la base |
| **Claude Code** | git, ssh, scp, docker, build y despliegue. La sesión de chat **nunca** ejecuta infraestructura: escribe la instrucción y la corre él |
| **Sergio (director)** | Decide. No ejecuta pasos técnicos. Sí hace lo que requiere su sesión o su acceso: soltar archivos en Drive, subir desde el panel, tocar el panel de DigitalOcean |

**Hablarle sin tecnicismo.** Cuando pida "explicame", explicar con imágenes del mundo real, no con nombres de tablas.

---

## 3. Cómo se trabaja acá

*Reglas ganadas a golpes. Cada una salió de un error real.*

1. **Proponer y esperar.** Sobre producción no se ejecuta sin OK explícito. Incluso lo que parece inofensivo.

2. **Validar por comportamiento, nunca por inspección.** "El archivo está en el servidor" no es "el proceso lo está ejecutando". La prueba es un documento real procesado de punta a punta.

3. **Después de cambiar algo, volver a leer.** Un `REVOKE` por columna no recorta un `GRANT` de tabla; un `REVOKE` a un rol no recorta un `GRANT` a `PUBLIC`. Los dos fallan en silencio. Siempre releer el catálogo.

4. **Verificar por contenido, no por código de estado.** En este sitio un archivo borrado devuelve `200` con el `index.html` de la SPA.

5. **Medir antes y después.** Sin línea de base, "no responde" no prueba nada.

6. **Todo despliegue empieza con una copia de respaldo** y con la vuelta atrás escrita completa, pegada en pantalla, **antes** de tocar nada.

7. **De a una cosa a la vez.**

8. **Antes de borrar un permiso, listar qué caminos del producto dependen de él.** "No tiene tráfico" no es "no se usa" — es "todavía no se notó".

9. **No nombrar causas de ejemplo** en mensajes al usuario. Si no se sabe el motivo, decir que hay que revisar; nunca sugerir una causa posible.

10. **Cuando te equivoques, decilo con el mismo detalle con el que reportás un acierto.** Los mejores hallazgos salieron de *"mi medición estaba mal, no el sistema"*.

---

## 4. Método de despliegue de la casa

**No hay staging. `main` = registro de lo que YA está en producción.**

El ciclo es: **desplegar → validar con un documento real → recién ahí commitear y mergear.** Mergear no despliega nada.

- **Frontend:** `npm run build` local + `scp` a `/var/www/dataland`. Es destructivo (empieza con `rm -rf`): la copia de respaldo **no es opcional**.
- **Worker:** `scp` de los `.mjs` + `docker compose build && up -d --force-recreate`.

---

## 5. Zonas cerradas

Requieren OK explícito del director:

Autenticación · facturación y MercadoPago · todas las integraciones · la cañería del worker · Realtime · despliegue y Caddy · y el **prompt de extracción**, que sólo se adapta de forma aditiva.

---

## 6. Dónde estamos

Cinco incidentes de seguridad registrados entre el 10 y el 12 de septiembre, **cuatro cerrados** (INC-001, INC-003, INC-004, INC-005), todos con mecanismo, verificación y vuelta atrás escritos. El quinto, **INC-002, sigue abierto**: es el punto 2 de la cola.

Quedan tres cosas en la cola, ninguna urgente, todas con plan:

1. El gateway que falla cerrado *(commiteado, sin desplegar)*
2. El gateway con JWT *(INC-002)*
3. Las URLs firmadas en los cuatro lugares del worker, para poder cerrar los buckets

---

## 7. El producto hermano

Existe **Amono**, que comparte **sólo** el proyecto de Supabase —cuenta del usuario y billetera de créditos— y lo maneja **otro agente**.

**Cuatro de los cinco incidentes los encontró ese agente.** Si escala algo: verificalo contra la base antes de actuar. Tuvo razón las cuatro veces — pero **dos veces el arreglo que proponía no servía**, por la regla 3.

---

**Empezá leyendo. No propongas nada hasta haber verificado el estado real.**
