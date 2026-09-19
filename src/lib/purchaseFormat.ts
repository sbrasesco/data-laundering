// Formato y lectura de montos en dólares para la compra de saldo (BILLING-COMPRA-5.2).

/** US$ 105 · US$ 157,50 · US$ 2.000 */
export function usd(n: number): string {
  const hasCents = Math.round(n * 100) % 100 !== 0;
  return 'US$ ' + n.toLocaleString('es-AR', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Lee lo que escribe el usuario: "25", "25,50", "25.50", "1.000", "1.000,50", "US$ 25".
 * Devuelve null si está vacío y NaN si no es un monto válido o tiene más de 2 decimales.
 * No aplica mínimo ni máximo: eso se controla aparte, al confirmar.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/^(US)?\$\s*/i, '').replace(/\s/g, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Number(s);
}
