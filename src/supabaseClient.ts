import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

// Cargar variables de entorno desde .env
dotenv.config({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL no está definida en .env');
}

if (!SUPABASE_ANON_KEY) {
  throw new Error('SUPABASE_ANON_KEY no está definida en .env');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

