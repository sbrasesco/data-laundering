# Cómo arrancar una sesión de Agora

*Pegar este documento —o su contenido— al abrir un chat nuevo de Agora.*
*Última actualización: 2026-09-19*

---

Retomamos **Agora** — SaaS multitenant de digitalización de facturas argentinas. **EN PRODUCCIÓN**, con un cliente facturando (Menara). La regla de oro del proyecto: **estabilidad antes que velocidad**.

---

## 1. Cómo cargar contexto — en este orden, antes de responder nada

1. La memoria del proyecto.
2. `ONBOARDING-TECNICO-AGORA.md` — arquitectura y método de la casa.
3. `CLAUDE.md` — estado vivo: decisiones, incidentes (INC-001..005), problemas conocidos y la cola de seguridad.
4. `RUNBOOK-ROLLBACK.md` — worker y frontend.
5. El tablero **Ágora — Kanban** en Trello (https://trello.com/b/tYu0PDIQ) — qué está en curso y qué se hizo, tarjeta por tarjeta. El kanban de Notion ya no se usa (llegó al límite del plan gratuito).
6. Si el trabajo toca compras de saldo: `ESPEC-COMPRA-DE-SALDO.md` (v3, aprobada).

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

11. **Toda tarjeta del tablero tiene su estado escrito, siempre.** En progreso: sección *📍 Estado* con una línea fechada por avance (qué se hizo, en qué quedó, qué falta). Hecha: sección *✅ Resultado* con qué se hizo, cómo se comprobó, cómo se vuelve atrás y qué quedó por validar. Se escribe en el momento, no al final: el que llegue después tiene que entender sin releer ninguna conversación. Claude Code no escribe en Trello; lo hace la sesión de chat con su reporte.

12. **Separar lo comprobado de lo deducido** cuando se le informa al director. Y revisar el filtro antes de concluir que algo "no dejó rastro": el 14/09 una ventana de tiempo mal elegida produjo una conclusión falsa.

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

## 6. Dónde estamos (al 2026-09-19)

**Seguridad.** Cinco incidentes registrados entre el 10 y el 12 de septiembre, **cuatro cerrados** (INC-001, INC-003, INC-004, INC-005). **INC-002 sigue abierto.** Además, cerrado después:

- **14/09 — funciones abiertas a cualquiera.** Nueve funciones de la base se podían llamar sin sesión y sin ningún control adentro, entre ellas las que suman y descuentan saldo. Ocho quedaron sólo para el servidor; `get_system_avg_confidence` quedó para usuario logueado porque la usa el tablero del cliente. Validado con documentos reales cobrando normal.
- **19/09 — permiso de vaciar tablas.** `anon` y `authenticated` podían vaciar 25 y 29 tablas (la seguridad por filas no frena el vaciado). Quitado, y las tablas nuevas ya no nacen con ese permiso.

Cola de seguridad, sin cambios desde el 12/09 (**no reverificada desde entonces**):

1. El gateway que falla cerrado *(commiteado, sin desplegar)*
2. El gateway con JWT *(INC-002)*
3. Las URLs firmadas en los cuatro lugares del worker, para poder cerrar los buckets

**En curso: compra de saldo.** El flujo con Mercado Pago **nunca acreditó una compra en producción**: los pagos pendientes (ocho hasta el 18/09, más los que abrió el 19/09 probando) son enlaces que abrió el director para comprobar que el checkout abre, no pagos fallidos. Hay una especificación nueva aprobada (`ESPEC-COMPRA-DE-SALDO.md` v3) y siete fases en el tablero. **Fases 0, 1 y 2 cerradas el 19/09:** diagnóstico del webhook; precios, bonos y monedas en la base; y la acreditación que suma al saldo existente una sola vez. Las fases 1 y 2 son cambios de base de datos: ya están en producción y no llevan despliegue, pero todavía nada del código las usa. **Fase 3 desplegada y validada el 19/09:** el servidor crea el cobro en pesos con el dólar del Banco Central del momento (puerta nueva `POST /api/purchase/create`). Ninguna pantalla la usa todavía: el modal de «Recargar saldo» sigue en el camino viejo, con precios en pesos fijos de junio, hasta la fase 5. **Fase 4 desplegada el 19/09:** el aviso de Mercado Pago carga el saldo de las compras nuevas sumándolo una sola vez, y pide reintento si algo falla de nuestro lado. Por decisión del director no hubo pago de prueba: **el primer pago real se vigila** y, si no se acredita solo, se rescata a mano con `credit_payment`. **Fase 5, en tres partes. 5.1 desplegada y validada el 19/09:** cada 10 minutos el servidor le pregunta a Mercado Pago por las compras nuevas pendientes y carga las que se pagaron si el aviso no llegó. **5.2 desplegada y validada el 19/09:** la ventana «Recargar saldo» compra por la puerta nueva, en dólares, con bonos 0 / 10 / 20 % sobre el monto del plan (decisión del director) y la landing dice lo mismo. El mismo día pasaron también a la puerta nueva los botones de compra de la landing y del login: **ninguna pantalla usa ya el camino viejo**. **5.3 desplegada y validada el 19/09:** el director edita monto base, mínimo, máximo y bonos desde Monitoreo → Precios, y se guarda directo en la base. **5.4 desplegada y validada el 19/09:** la landing lee los precios de la base y los sigue sola (documentos estimados al precio base; el saldo no vence, corregido en las preguntas frecuentes). **Sigue:** retirar del servidor las puertas viejas (5.5).

**Vigilancia.** Desde el 14/09 hay una revisión automática cada hora (días hábiles, 8 a 20 de Argentina) que lee la base y avisa si falla algún proceso; desde el 19/09 también avisa si hay plata cobrada sin saldo cargado, pagos en revisión o compras que tuvo que cargar la revisión automática del servidor. No hay Sentry en el worker; el frontend sí lo tiene.

**Problemas abiertos nuevos** (detalle en `CLAUDE.md`): la subida desde el panel volvió a fallar el 14/09 por seguridad de filas (a Menara no le afecta, carga por la integración); el saldo y el libro de movimientos no cuadran porque las cargas manuales no dejan fila.

---

## 7. El producto hermano

Existe **Amono**, que comparte **sólo** el proyecto de Supabase —cuenta del usuario y billetera de créditos— y lo maneja **otro agente**.

**Cuatro hallazgos de seguridad salieron de ese agente** — dos anteriores a que empezáramos a numerar incidentes (una vista sin `security_invoker` y los buckets públicos) y dos registrados como INC-003 e INC-004. Si escala algo: verificalo contra la base antes de actuar. Tuvo razón las cuatro veces — pero **dos veces el arreglo que proponía no servía**, por la regla 3.

El barrido de puertos que terminó en el cortafuegos (INC-005) también arrancó de ahí: no fue un hallazgo suyo directo, pero fue consecuencia de tirar del mismo hilo. Y las funciones abiertas del 14/09 las encontramos los dos equipos por separado, con el mismo resultado.

Lo que ya se le contestó a Ámono (verificado contra la base): **el saldo está en dólares**, no en créditos; `organizations.tax_id` es texto libre y nada de Ágora asume CUIT (sí lo asume `proveedor_profiles`, que es otra cosa); **no existen invitaciones** de usuarios a una organización (un usuario, una organización); ~~el flujo de compra no acredita~~ → **el 19/09 se levantó el «no mandar a nadie a pagar»** (respuesta pasada por el director): pueden mandar usuarios a `app.agoradigital.io/login?plan=basico|profesional|business` o a «Recargar saldo»; el saldo se carga en la organización del usuario que inicia sesión; los precios los edita el director (leerlos con `get_purchase_options` / `quote_purchase`, mostrar sólo dólares). Esas compras quedan como `origin_product='agora'` y vuelven a Ágora: marcarlas como Ámono o volver al bot está sin armar y lo tienen que pedir con la URL de vuelta.

---

**Empezá leyendo. No propongas nada hasta haber verificado el estado real.**
