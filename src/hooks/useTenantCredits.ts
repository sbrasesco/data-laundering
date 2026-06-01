import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthContext } from '../contexts/AuthContext';

interface UseTenantCreditsResult {
  balance: number | null;
  loading: boolean;
}

export function useTenantCredits(): UseTenantCreditsResult {
  const { organizationId } = useAuthContext();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organizationId) {
      setBalance(null);
      setLoading(false);
      return;
    }

    // Carga inicial
    supabase
      .from('organization_credits')
      .select('balance')
      .eq('organization_id', organizationId)
      .single()
      .then(({ data, error }) => {
        if (!error && data) {
          setBalance(Math.max(0, data.balance));
        } else {
          setBalance(0);
        }
        setLoading(false);
      });

    // Suscripción Realtime
    const channel = supabase
      .channel(`credits-${organizationId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'organization_credits',
          filter: `organization_id=eq.${organizationId}`,
        },
        (payload) => {
          const newBalance = payload.new?.balance ?? 0;
          setBalance(Math.max(0, newBalance));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [organizationId]);

  return { balance, loading };
}
