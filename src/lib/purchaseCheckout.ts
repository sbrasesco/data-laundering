// Crear una compra por la puerta nueva (BILLING-COMPRA-5.2).
// La usan los botones de la landing y el «Ingresar y pagar» del login.
// El precio, el bono y los pesos los decide el servidor; acá sólo se dice qué se compra.

const GATEWAY_URL = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';

export const PURCHASE_SESSION_EXPIRED = 'Tu sesión venció. Volvé a entrar e intentá de nuevo.';

export type PurchaseRequest = { package_code: string } | { amount_usd: number };
export type PurchaseCheckout = { ok: true; url: string } | { ok: false; error: string };

/** Pide el cobro al servidor con la sesión del usuario y devuelve la dirección de Mercado Pago. */
export async function createPurchaseCheckout(
  accessToken: string | null | undefined,
  request: PurchaseRequest,
  fetchImpl?: typeof fetch,
): Promise<PurchaseCheckout> {
  if (!accessToken) return { ok: false, error: PURCHASE_SESSION_EXPIRED };
  try {
    const res = await (fetchImpl ?? fetch)(`${GATEWAY_URL}/api/purchase/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...request, currency: 'ARS', origin_product: 'agora' }),
    });
    const body = (await res.json().catch(() => null)) as { init_point?: string; error?: string } | null;
    if (res.ok && body?.init_point) return { ok: true, url: body.init_point };
    if (res.status === 401) return { ok: false, error: PURCHASE_SESSION_EXPIRED };
    return { ok: false, error: body?.error ?? 'No se pudo iniciar el pago. Intentá nuevamente.' };
  } catch {
    return { ok: false, error: 'No se pudo conectar con el servidor de pagos. Intentá nuevamente.' };
  }
}

// ─── Vuelta del pago (BILLING-COMPRA-5.8) ────────────────────────────────────
// Antes de salir a Mercado Pago se guarda la pantalla desde donde se disparó la compra,
// para volver ahí al terminar. Es por pestaña (sessionStorage): si el pago termina en
// otro navegador (celular, app de Mercado Pago), no hay nada guardado y se usa el panel.
const CLAVE_VUELTA = 'compra_volver_a';

function rutaUsable(ruta: string | null): ruta is string {
  return !!ruta && ruta.startsWith('/') && !ruta.startsWith('//')
    && !ruta.startsWith('/payment/') && !ruta.startsWith('/login');
}

/** Guarda la pantalla actual (o la indicada) como destino al volver del pago. */
export function recordarPantallaDeVuelta(ruta?: string): void {
  try {
    const r = ruta ?? window.location.pathname + window.location.search;
    if (rutaUsable(r)) sessionStorage.setItem(CLAVE_VUELTA, r);
  } catch { /* sin sessionStorage: se usa el panel */ }
}

/** Devuelve la pantalla guardada (una sola vez) o el panel. */
export function pantallaDeVuelta(): string {
  try {
    const r = sessionStorage.getItem(CLAVE_VUELTA);
    sessionStorage.removeItem(CLAVE_VUELTA);
    if (rutaUsable(r)) return r;
  } catch { /* ignorar */ }
  return '/dashboard';
}
