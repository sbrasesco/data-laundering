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

// Normaliza un CUIT / Tax ID para comparar y guardar de forma consistente:
// elimina espacios, guiones y puntos para que "20-12345678-9" y "20123456789"
// se traten como el mismo valor. Preserva caracteres alfanuméricos (Tax IDs extranjeros).
const normalizeTaxId = (value?: string | null): string =>
  (value ?? '').replace(/[\s.\-]/g, '').trim();

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
    // Validar duplicados contra el listado ya cargado
    const taxIdNorm = normalizeTaxId(clientData.tax_id);
    const emailTrim = clientData.email?.trim().toLowerCase();
    if (taxIdNorm) {
      const dup = clients.find(c => normalizeTaxId(c.tax_id) === taxIdNorm);
      if (dup) return { data: null, error: `Ya existe un cliente con el CUIT ${clientData.tax_id?.trim()} (${dup.name}).` };
    }
    if (emailTrim) {
      const dup = clients.find(c => c.email?.trim().toLowerCase() === emailTrim);
      if (dup) return { data: null, error: `Ya existe un cliente con el email ${clientData.email} (${dup.name}).` };
    }

    try {
      const { data, error: createError } = await supabase
        .from('clients')
        .insert({
          name: clientData.name,
          tax_id: taxIdNorm || null,
          external_code: clientData.external_code || null,
          email: clientData.email || null,
          is_active: true,
          organization_id: organizationId,
        })
        .select()
        .single();

      if (createError) {
        // Convertir errores de constraint a mensajes amigables
        if (createError.code === '23505') {
          if (createError.message.includes('tax_id')) return { data: null, error: 'Ya existe un cliente con ese CUIT.' };
          if (createError.message.includes('email')) return { data: null, error: 'Ya existe un cliente con ese email.' };
        }
        throw createError;
      }

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
    // Validar duplicados excluyendo el cliente que se está editando
    const taxIdNorm = data.tax_id !== undefined ? normalizeTaxId(data.tax_id) : undefined;
    const emailTrim = data.email?.trim().toLowerCase();
    if (taxIdNorm) {
      const dup = clients.find(c => c.id !== id && normalizeTaxId(c.tax_id) === taxIdNorm);
      if (dup) return { error: `Ya existe un cliente con el CUIT ${data.tax_id?.trim()} (${dup.name}).` };
    }
    if (emailTrim) {
      const dup = clients.find(c => c.id !== id && c.email?.trim().toLowerCase() === emailTrim);
      if (dup) return { error: `Ya existe un cliente con el email ${data.email} (${dup.name}).` };
    }

    // Guardar el CUIT normalizado (sin guiones/espacios/puntos) cuando viene en el update
    const updatePayload = taxIdNorm !== undefined ? { ...data, tax_id: taxIdNorm || null } : data;

    setLoading(true);
    setError(null);
    const { error } = await supabase
      .from('clients')
      .update(updatePayload)
      .eq('id', id);
    if (error) {
      setLoading(false);
      if (error.code === '23505') {
        if (error.message.includes('tax_id')) return { error: 'Ya existe un cliente con ese CUIT.' };
        if (error.message.includes('email')) return { error: 'Ya existe un cliente con ese email.' };
      }
      return { error: error.message };
    }
    await fetchClients();
    setLoading(false);
    return { error: null };
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

