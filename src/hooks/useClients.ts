import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthContext } from '../contexts/AuthContext';

export interface Client {
  id: string;
  name: string;
  tax_id: string | null;
  external_code: string | null;
  email: string | null;
  is_active: boolean;
  created_at: string;
}

export function useClients() {
  const { organizationId } = useAuthContext();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchClients = async () => {
    try {
      setLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from('clients')
        .select('id, name, tax_id, external_code, email, is_active, created_at')
        .order('created_at', { ascending: false });

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
  };

  useEffect(() => {
    fetchClients();
  }, []);

  const createClient = async (clientData: {
    name: string;
    tax_id?: string;
    external_code?: string;
    email?: string;
  }) => {
    try {
      const { data, error: createError } = await supabase
        .from('clients')
        .insert({
          name: clientData.name,
          tax_id: clientData.tax_id || null,
          external_code: clientData.external_code || null,
          email: clientData.email || null,
          is_active: true,
          organization_id: organizationId,
        })
        .select()
        .single();

      if (createError) {
        throw createError;
      }

      // Refrescar listado
      await fetchClients();
      return { data, error: null };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error desconocido al crear cliente';
      return { data: null, error: errorMessage };
    }
  };

  const updateClient = async (
    id: string,
    data: Partial<Pick<Client, 'name' | 'tax_id' | 'external_code' | 'email' | 'is_active'>>
  ) => {
    setLoading(true);
    setError(null);
    const { error } = await supabase
      .from('clients')
      .update(data)
      .eq('id', id);
    if (error) {
      setError(error.message);
    } else {
      await fetchClients();
    }
    setLoading(false);
  };

  const toggleClientActive = async (id: string, current: boolean) => {
    // soft delete / reactivar
    await updateClient(id, { is_active: !current });
  };

  return {
    clients,
    loading,
    error,
    createClient,
    updateClient,
    toggleClientActive,
  };
}

