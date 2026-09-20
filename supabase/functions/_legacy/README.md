# Funciones viejas de Mercado Pago (apagadas el 2026-09-20)

BILLING-COMPRA-5.6. Código tal como estaba desplegado en Supabase antes de apagarlas.
Se guarda solo para volver atrás. No se despliega desde acá.

| Función | Versión original | verify_jwt | Qué hacía |
|---|---|---|---|
| create-payment-preference | v13 | true | Cobro con precios en pesos de billing_plans; cualquier usuario logueado |
| mp-webhook | v5 | false | Receptor de avisos de MP: marcaba pagos y acreditaba docs como dólares (add_credits) |

Hoy están desplegadas las versiones apagadas de `supabase/functions/<nombre>/index.ts`.

## Volver atrás

Desplegar el archivo `<nombre>.vN.ts` de esta carpeta como `index.ts` de la función,
con el mismo verify_jwt de la tabla (por el MCP de Supabase, `deploy_edge_function`).
Antes de hacerlo: la compra nueva acredita por el gateway; si mp-webhook vuelve a estar
activa y Mercado Pago le manda avisos, puede marcar pagos nuevos como aprobados sin acreditarlos.
