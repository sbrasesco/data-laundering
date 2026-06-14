import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error('VITE_SUPABASE_URL no está definida en las variables de entorno');
}

if (!supabaseAnonKey) {
  throw new Error('VITE_SUPABASE_ANON_KEY no está definida en las variables de entorno');
}

// Usa el fetch nativo guardado en index.html antes de que extensiones lo parcheen.
// Protege las llamadas a Supabase de SDKs externos (Amplitude, etc.) que monkey-patchean window.fetch.
const safeFetch: typeof fetch =
  (window as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: safeFetch },
});

