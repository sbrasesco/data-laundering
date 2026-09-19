# Especificación — Compra de saldo (Ágora + Ámono)

*Versión 3 · 2026-09-19 (v3: decisiones del director incorporadas — bono, cotización al comprar, sin redondeo) · Estado: **aprobada, lista para Fase 0** · Zona cerrada (facturación y Mercado Pago): cada fase necesita OK explícito*

---

## 0. En una frase

El usuario compra **dólares de saldo** —eligiendo un paquete o escribiendo el monto que quiera—, recibe un **bono** según cuánto compra, y **paga en la moneda de su pasarela**: pesos con Mercado Pago hoy, dólares o euros con otra pasarela mañana. La billetera no se entera de qué pasarela ni qué moneda se usó.

---

## 1. Lo que ya existe y NO se toca

Verificado contra la base el 2026-09-18/19. No asumir: releer antes de empezar cada fase.

| Pieza | Estado | Regla |
|---|---|---|
| `organization_credits.balance` | `numeric(12,4)`, **en dólares** | Es la unidad de la billetera. No cambia. |
| `billing_plans` | Mezcla dos cosas: el **precio por documento** (`basico.price_per_doc`, lo lee `charge_credit`) y el **regalo de alta** (`free.balance_usd`, lo lee `assign_free_plan_on_org_create`) | **No se borra ni se renombra.** El flujo de compra nuevo deja de leer sus columnas de paquetes (`price`, `balance_usd` de los planes pagos), pero la tabla sigue viva por lo otro. |
| `add_credits_admin` | Carga manual desde el panel de superadmin | **Es cómo se le carga saldo a Menara** (pospago, el único cliente que factura). No se toca en este trabajo. |
| `charge_credit` / `debit_credits` | Consumo de Ágora / de Ámono | Fuera de alcance. |
| `payments` | 8 filas, todas `pending`, todas de Aignition (pruebas del director) | Se conserva. Los cambios son aditivos. |

---

## 2. Principios — las reglas que evitan romper cosas después

1. **Una sola unidad adentro: el dólar.** "Crédito" es sólo el nombre comercial del dólar de saldo. Ninguna tabla nueva guarda cantidades en otra unidad inventada.
2. **Tres capas separadas.** *Qué compra* (dólares + bono) no depende de *cuánto paga* (moneda de la pasarela) ni de *con qué paga* (la pasarela). Agregar una pasarela o una moneda es agregar una fila de configuración y un adaptador; no cambia ni la billetera, ni los bonos, ni los precios.
3. **Se acredita lo que dice el pago en dólares, nunca lo que cobró la pasarela.** El monto cobrado en pesos es informativo. El saldo sale de `base_usd + bonus_usd` guardados en la fila del pago.
4. **Todos los números los calcula el servidor.** El navegador puede *mostrar* una cotización, pero al crear el pago el servidor recalcula todo desde cero e ignora cualquier número que venga del pedido.
5. **Cada pago guarda su historia completa.** Dentro de seis meses, cualquier compra tiene que poder explicarse sola, sin preguntarle a nadie.
6. **Acreditar dos veces es imposible por construcción**, no por cuidado del código que llama.
7. **El director edita precios a través de funciones con chequeo de superadmin**, nunca escribiendo directo sobre las tablas.

---

## 3. El modelo de precios

### 3.1 Lo que edita el director

**Configuración general** (una sola fila):

| Campo | Qué es | Ejemplo |
|---|---|---|
| `base_usd` | Monto base. Los paquetes se calculan a partir de él | 50 |
| `min_free_usd` | Mínimo que se puede escribir a mano | 5 |
| `max_free_usd` | Máximo que se puede escribir a mano | 2000 |

**Paquetes** (una fila por paquete):

| Campo | Qué es | Ejemplo |
|---|---|---|
| `code` | Identificador estable (`basico`, `profesional`, `business`) | `profesional` |
| `label` | Texto que ve el usuario | "Profesional" |
| `multiplier` | Monto del paquete = `base_usd × multiplier` | 2 |
| `bonus_pct` | Bono en porcentaje de lo pagado | 10 |
| `sort_order`, `active` | Orden y visibilidad | |

Cambiar `base_usd` mueve todos los paquetes a la vez. Los números de ejemplo son ilustrativos: **los define el director.**

### 3.2 La regla del bono — una sola, para paquetes y monto libre

> El bono de una compra es el `bonus_pct` del **paquete activo más grande cuyo monto sea menor o igual** al monto comprado. Si es menor que el paquete más chico, el bono es cero.

Consecuencia: escribir 100 a mano da exactamente lo mismo que apretar el paquete de 100. Escribir 150 da el bono del paquete de 100. No hay dos reglas que puedan contradecirse, y no hay una tabla de escalones aparte: **los paquetes son los escalones.**

> ✅ **Confirmada por el director el 2026-09-19.**

### 3.3 La capa de monedas y pasarelas

**Monedas** (una fila por moneda):

| Campo | Qué es | ARS hoy | USD (futuro) | EUR (futuro) |
|---|---|---|---|---|
| `currency` | Código | `ARS` | `USD` | `EUR` |
| `gateway` | Pasarela que cobra en esa moneda | `mercadopago` | `stripe` | a definir |
| `fx_source` | De dónde sale la cotización | BNA oficial venta | *(ninguna: 1 a 1)* | a definir |
| `enabled` | Si se ofrece | ✅ | ❌ | ❌ |

**Sin redondeo** (decisión del director, 2026-09-19): se cobra el número exacto de la conversión, con los decimales que admita la pasarela.

**Cotizaciones**: `currency`, `rate_per_usd`, `source`, `fetched_at`. La llena **sólo el servidor**. Nadie la edita a mano. Funciona como historial y como respaldo.

**Regla (decisión del director, 2026-09-19): se cobra con la cotización vigente en el momento en que el usuario compra.** Al crear el pago, el servidor consulta en ese instante la cotización oficial (BNA, venta), la guarda en `fx_rates` y la congela en la fila del pago. Fines de semana y feriados la vigente es la del último día hábil, que es lo normal.

**Nunca se deja de vender.** Si en el momento de la compra la fuente no responde, se usa la última cotización guardada y se le avisa al director. Sin margen: es la última oficial conocida. La única situación en que la moneda no se ofrece es si nunca se guardó ninguna cotización (sólo puede pasar el primer día).

### 3.4 El cálculo, de punta a punta

```
base_usd      = monto elegido (paquete o libre)
bonus_usd     = base_usd × bonus_pct / 100         ← regla 3.2
credited_usd  = base_usd + bonus_usd                ← lo que entra a la billetera
charged       = base_usd × rate_per_usd             ← lo que paga, en su moneda (sin redondeo)
```

El bono **no** se cobra: se regala. El usuario paga sólo `base_usd` convertido.

---

## 4. Cambios en la base (todos aditivos)

### 4.1 Tablas nuevas

- `pricing_settings` — §3.1, una fila.
- `pricing_packages` — §3.1.
- `pricing_currencies` — §3.3.
- `fx_rates` — §3.3.

Las cuatro con RLS activada, **sin políticas de escritura**, lectura sólo donde haga falta, y **sin `TRUNCATE`, `INSERT`, `UPDATE` ni `DELETE` para `anon` ni `authenticated`**: revocarlos explícitamente al crearlas. (Contexto: el 2026-09-14 verificamos que `TRUNCATE` no respeta RLS y que la base otorga todo a esos roles por defecto.)

### 4.2 Columnas nuevas en `payments`

| Columna | Para qué |
|---|---|
| `base_usd` | Lo que el usuario compró |
| `bonus_usd` | El bono calculado al crear el pago |
| `credited_usd` | `base_usd + bonus_usd` — lo único que se acredita |
| `package_code` | Paquete elegido, o nulo si fue monto libre |
| `fx_rate`, `fx_source`, `fx_fetched_at` | La cotización usada, congelada |
| `expires_at` | Vencimiento de la preferencia |
| `origin_product` | `agora` o `amono`: quién inició la compra |
| `credited_at` | Cuándo se acreditó |

`amount` y `currency` existentes pasan a ser el monto cobrado y su moneda. `credits_accrued` se conserva y pasa a ser la guarda de §5.2.

Y un índice único: **`UNIQUE (gateway, gateway_payment_id)` donde `gateway_payment_id` no sea nulo.** Hoy no existe, y sin él el mismo pago de Mercado Pago podría registrarse dos veces.

### 4.3 Libro de movimientos

Agregar `'bonus'` a los valores permitidos de `credit_transactions.type` (hoy: `charge`, `refund`, `top_up`, `manual_adjustment`, `purchase`). Cada compra escribe **dos filas**: `purchase` por `base_usd` y `bonus` por `bonus_usd`. Así el libro distingue lo que se cobró de lo que se regaló, que no es lo mismo a la hora de contar ingresos.

---

## 5. Funciones

### 5.1 Cotizar — `quote_purchase(amount_usd | package_code, currency)`

Sólo lectura. Devuelve `base_usd`, `bonus_usd`, `credited_usd`, `charged`, `currency`, `fx_rate`, `fx_fetched_at`, y si se usó la cotización de respaldo porque la fuente no respondió. Rechaza montos fuera de `[min_free_usd, max_free_usd]` y monedas deshabilitadas o sin ninguna cotización cargada. Es lo que usa la pantalla para mostrar el precio. **No crea nada.**

### 5.2 Acreditar — `credit_payment(payment_id, gateway_payment_id)`

`SECURITY DEFINER`, ejecutable **sólo por `service_role`**. Revocar a `PUBLIC`, `anon` y `authenticated` en la misma migración que la crea (por defecto nace abierta a todos: lección del 2026-09-14).

1. Bloquea la fila del pago (`FOR UPDATE`).
2. Si `credits_accrued` ya es `true` → no hace nada y devuelve "ya acreditado". **Idempotencia dentro de la base, no en el código que llama.**
3. Suma `credited_usd` al saldo.
4. Escribe las dos filas del libro (§4.3).
5. Marca `credits_accrued = true`, `status = 'approved'`, `credited_at = now()`, guarda `gateway_payment_id`.

Todo en una transacción. Llamarla dos, diez o cien veces con el mismo pago acredita una sola vez.

**Por qué acá y no en el código del webhook.** La idempotencia actual (tarea 84 del kanban) está en el código: "si `gateway_payment_id` ya existe, saltear". Eso tiene dos agujeros: si dos avisos del mismo pago llegan casi juntos, los dos preguntan antes de que ninguno haya escrito, y los dos acreditan; y además no hay índice único que lo impida en la base. Con el bloqueo de fila, el segundo aviso espera a que el primero termine y encuentra el sello puesto.

Reemplaza a la llamada directa a `add_credits` desde el webhook. `add_credits` se deja como está.

### 5.3 Edición de precios — funciones del director

`admin_set_pricing_settings(...)`, `admin_upsert_package(...)`, `admin_set_currency(...)`. `SECURITY DEFINER`, primera línea: chequeo de `profiles.is_superadmin` como las funciones admin existentes. Revocar a `PUBLIC` y `anon`. Validan rangos (multiplicador > 0, bono entre 0 y 100, etc.).

---

## 6. El recorrido de una compra

1. **La pantalla** muestra paquetes y un campo de monto libre. Para cada opción pide `quote_purchase` y muestra: *"Pagás $X · Recibís US$ Y de saldo (incluye bono de US$ Z)"*.
2. **El usuario confirma.** El navegador manda al servidor sólo: monto o paquete, moneda, producto de origen, y a dónde volver.
3. **El servidor** (worker/gateway, nunca el navegador):
   - recalcula todo con `quote_purchase`, ignorando cualquier número del pedido;
   - valida la URL de vuelta contra una lista permitida (si no, cualquiera podría usar nuestro dominio para redirigir a un sitio falso);
   - inserta la fila en `payments` con todo congelado;
   - crea la preferencia de Mercado Pago **por el monto `charged` ya fijado**, con `expires_at`;
   - devuelve la URL de pago.
4. **Mercado Pago** cobra y avisa al webhook.
5. **El webhook**:
   - verifica que el aviso sea auténtico (firma, o reconsulta del pago contra la API de Mercado Pago). **Nunca le cree al cuerpo del pedido.**
   - si está aprobado → `credit_payment`;
   - si falla → lo registra de forma visible (ver §8), no lo deja en `pending` en silencio.
6. **El usuario vuelve** al producto que inició la compra.

---

## 7. Fases — de a una, cada una validada antes de la siguiente

| Fase | Qué | Mueve plata | Validación |
|---|---|---|---|
| **0** | Diagnóstico del webhook actual (instrucción ya entregada a Claude Code) | No | Reporte con líneas: ¿usa `credits_accrued`?, ¿qué pasa a `add_credits`?, ¿verifica autenticidad? |
| **1** | Tablas de §4.1, columnas de §4.2, `quote_purchase`, funciones del director | No | Cotizar 3 paquetes y 3 montos libres; comparar contra el cálculo a mano. Verificar permisos contra el catálogo. |
| **2** | `credit_payment` | En prueba | Crear un pago de prueba y llamarla **tres veces**: saldo sube una sola vez, libro con exactamente dos filas. |
| **3** | Consulta de cotización al comprar + creación de pago del lado del servidor | No | Una compra de prueba guarda la cotización del momento en `fx_rates` y la congela en el pago; simular que la fuente no responde y verificar que se vende igual con la última guardada y que llega el aviso. |
| **4** | Webhook nuevo → `credit_payment` | **Sí** | **Un pago real chico, de punta a punta**: se cobra, se acredita una vez, el libro cuadra, y el mismo aviso reenviado no acredita de nuevo. |
| **5** | Pantalla del director + pantalla de compra; se retira el camino de `credit_price_tiers` | Sí | El director cambia `base_usd` y ve moverse los tres paquetes. |
| **6** | Stripe en dólares, euros | — | Más adelante. Sólo configuración + adaptador de pasarela. |

Cada fase: copia de respaldo y vuelta atrás **escritas antes** de tocar nada. Mergear no despliega nada.

---

## 8. Vigilancia

La tarea horaria que ya revisa procesos fallidos se extiende a pagos: **avisar cualquier pago en `pending` con más de 2 horas y `expires_at` vencido**, y cualquier pago `approved` con `credits_accrued = false`. Esto último no debería existir nunca; si aparece, es plata cobrada sin entregar.

---

## 9. Para Ámono

Lo que pueden dar por hecho cuando la Fase 4 esté validada:

- **El saldo está en dólares.** Documentos restantes = `balance ÷ su precio por documento`.
- **La compra se inicia con un enlace a la pantalla de Ágora**, pasando `origin_product=amono` y la URL de vuelta. La organización sale de la sesión: la cuenta es la misma.
- **La URL de vuelta tiene que estar en la lista permitida.** Pasen las que van a usar para que se agreguen.
- **No se construye nada de pagos del lado de Ámono.** Ni tablas, ni funciones, ni pasarela.

Hasta la validación de la Fase 4: **no enviar a nadie a pagar.**

---

## 10. Fuera de alcance, anotado

- `add_credits_admin` y el regalo de alta suman saldo **sin escribir fila en el libro**. Por eso saldo y libro no cuadran (Menara: US$ 3.629,80 de diferencia, que son las cargas manuales del pospago). Arreglarlo es chico pero toca el camino del único cliente que factura: va en un cambio aparte, con su propio OK.
- Las 25 tablas con `TRUNCATE` para `anon` — **resuelto el 2026-09-19** (SEC-TRUNCATE).
- Invitaciones de usuarios a una organización: no existen, requiere diseño propio.
