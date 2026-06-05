import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session, AuthError, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface Profile {
  id: string;
  organization_id: string;
  onboarding_completed: boolean;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  organizationId: string | null;
  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (userId: string): Promise<void> => {
    try {
      const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((resolve) => {
        setTimeout(() => resolve({ data: null, error: { message: 'Timeout' } }), 5000);
      });

      const profilePromise = supabase
        .from('profiles')
        .select('id, organization_id, onboarding_completed')
        .eq('id', userId)
        .single();

      const result = await Promise.race([profilePromise, timeoutPromise]);

      if ('error' in result && result.error) {
        if (result.error.message === 'Timeout') {
          console.warn('Profile fetch timeout after 5 seconds - continuing without profile');
        } else if ('code' in result.error && result.error.code === 'PGRST116') {
          console.log('Profile not found for user - this is OK');
        } else {
          console.warn('Error fetching profile (non-blocking):', result.error.message);
        }
        setProfile(null);
        return;
      }

      const { data, error } = result as { data: Profile | null; error: any };

      if (error) {
        if (error.code === 'PGRST116') {
          console.log('Profile not found for user - this is OK');
        } else {
          console.warn('Error fetching profile (non-blocking):', error.message);
        }
        setProfile(null);
        return;
      }

      if (data) {
        setProfile(data);
      } else {
        setProfile(null);
      }
    } catch (err: any) {
      console.warn('Exception fetching profile (non-blocking):', err);
      setProfile(null);
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
        fetchProfile(session.user.id).catch(() => {});
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
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mounted) {
        clearTimeout(timeoutId);
        return;
      }

      clearTimeout(timeoutId);

      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        fetchProfile(session.user.id).catch(() => {});
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
