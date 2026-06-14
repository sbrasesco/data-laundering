import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session, AuthError, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface Profile {
  id: string;
  organization_id: string;
  onboarding_completed: boolean;
  is_superadmin: boolean;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  organizationId: string | null;
  isSuperadmin: boolean;
  orgBlocked: boolean;
  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [orgBlocked, setOrgBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (userId: string): Promise<Profile | null> => {
    try {
      const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((resolve) => {
        setTimeout(() => resolve({ data: null, error: { message: 'Timeout' } }), 5000);
      });

      const profilePromise = supabase
        .from('profiles')
        .select('id, organization_id, onboarding_completed, is_superadmin')
        .eq('id', userId)
        .single();

      const result = await Promise.race([profilePromise, timeoutPromise]);

      if ('error' in result && result.error) {
        return null;
      }

      const { data, error } = result as { data: Profile | null; error: any };

      if (error) {
        return null;
      }

      setProfile(data ?? null);

      // Verificar si la org está activa (superadmins siempre pasan)
      if (data?.organization_id && !data?.is_superadmin) {
        const { data: org } = await supabase.from('organizations').select('is_active').eq('id', data.organization_id).single();
        setOrgBlocked(org?.is_active === false);
      } else {
        setOrgBlocked(false);
      }

      return data ?? null;
    } catch (err: any) {
      console.warn('Exception fetching profile (non-blocking):', err);
      return null;
    }
  };

  // Crea org + profile cuando el usuario confirma el email y vuelve al app
  const createOrgPostConfirmation = async (userId: string): Promise<void> => {
    const pendingOrgName = localStorage.getItem('dl_pending_org');
    if (!pendingOrgName) return;
    try {
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({ name: pendingOrgName })
        .select()
        .single();
      if (orgError || !org) return;
      await supabase.from('profiles').insert({ id: userId, organization_id: org.id });
      localStorage.removeItem('dl_pending_org');
      await fetchProfile(userId);
    } catch (err) {
      console.warn('Error creando org post-confirmación:', err);
    }
  };

  useEffect(() => {
    let mounted = true;

    const timeoutId = setTimeout(() => {
      if (mounted) {
        console.warn('Auth loading timeout - forzando fin del loading');
        setLoading(false);
      }
    }, 10000);

    supabase.auth.getSession().then(async ({ data: { session }, error: sessionError }) => {
      if (!mounted) {
        clearTimeout(timeoutId);
        return;
      }

      clearTimeout(timeoutId);

      if (sessionError) {
        console.error('Error getting session:', sessionError);
        if (mounted) setLoading(false);
        return;
      }

      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        await fetchProfile(session.user.id).catch(() => {});
      } else {
        setProfile(null);
      }

      if (mounted) setLoading(false);
    }).catch((err) => {
      console.error('Error in getSession promise:', err);
      if (mounted) {
        clearTimeout(timeoutId);
        setLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) {
        clearTimeout(timeoutId);
        return;
      }

      clearTimeout(timeoutId);

      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        const existingProfile = await fetchProfile(session.user.id);
        // Si el usuario confirmó el email y no tiene org todavía, crearla ahora
        if (!existingProfile && event === 'SIGNED_IN') {
          await createOrgPostConfirmation(session.user.id);
        }
      } else {
        setProfile(null);
      }

      if (mounted) setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, []);

  const signInWithPassword = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setUser(null);
  };

  const value = {
    session,
    user,
    profile,
    organizationId: profile?.organization_id ?? null,
    isSuperadmin: profile?.is_superadmin ?? false,
    orgBlocked,
    loading,
    signInWithPassword,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuthContext debe ser usado dentro de un AuthProvider');
  }
  return context;
}
