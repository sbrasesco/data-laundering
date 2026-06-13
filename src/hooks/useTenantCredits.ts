import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthContext } from '../contexts/AuthContext';

interface UseTenantCreditsResult {
  balance: number | null;
  loading: boolean;
}

export function useTenantCredits(): UseTenantCreditsResult {
  const { organizationId, loading: authLoading } = useAuthContext();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const orgIdRef = useRef(organizationId);
  orgIdRef.current = organizationId;

  const fetchBalance = useCallback(async () => {
    const orgId = orgIdRef.current;
    if (!orgId) return;
    const { data, error } = await supabase
      .from('organization_credits')
      .select('balance')
      .eq('organization_id', orgId)
      .single();
    if (!error && data) {
      setBalance(Math.max(0, Number(data.balance)));
    }
  }, []);

  useEffect(() => {
    // Mientras auth resuelve, no marcar loading=false con balance=null
    // (evita el flash "Sin saldo" antes de saber el saldo real)
    if (authLoading) return;

    if (!organizationId) {
      setBalance(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchBalance().finally(() => setLoading(false));

    // Realtime: actualización inmediata si llega el evento
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
          setBalance(Math.max(0, Number(newBalance)));
        }
      )
      .subscribe();

    // Polling fallback cada 15s por si Realtime no entrega el evento
    const pollId = setInterval(fetchBalance, 15_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollId);
    };
  }, [organizationId, authLoading, fetchBalance]);

  return { balance, loading: loading || authLoading };
}
