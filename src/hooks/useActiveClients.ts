import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export interface ActiveClient {
  id: string;
  name: string;
  tax_id: string | null;
}

export function useActiveClients() {
  const [clients, setClients] = useState<ActiveClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchClients() {
      try {
        setLoading(true);
        setError(null);

        const { data, error: fetchError } = await supabase
          .from('clients')
          .select('id, name, tax_id')
          .eq('is_active', true)
          .order('name', { ascending: true });

        if (fetchError) {
          setError(fetchError.message);
          setClients([]);
        } else {
          setClients(data || []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido al cargar clientes');
        setClients([]);
      } finally {
        setLoading(false);
      }
    }

    fetchClients();
  }, []);

  return { clients, loading, error };
}

