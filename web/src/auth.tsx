import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { applyTheme } from './theme';
import type { Role, University, User } from './types';

interface AuthState {
  user: User | null;
  university: University | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  acceptSession: (session: { token: string; user: User; university: University | null }) => void;
  logout: () => void;
  refresh: () => Promise<void>;
  setUniversity: (u: University) => void;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [university, setUni] = useState<University | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const setUniversity = useCallback((u: University | null) => {
    setUni(u);
    applyTheme(u?.primary_color);
    document.title = u ? `${u.short_name || u.name} - Lecture Management` : 'Lecture Management System';
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setUniversity(null);
  }, [setUniversity]);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try {
      const me = await api<{ user: User; university: University | null }>('/api/auth/me');
      setUser(me.user);
      setUniversity(me.university);
    } catch {
      logout();
    } finally {
      setLoading(false);
    }
  }, [logout, setUniversity]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    applyTheme(null);
    refresh();
  }, [logout, refresh]);

  const acceptSession = useCallback(
    (s: { token: string; user: User; university: University | null }) => {
      setToken(s.token);
      setUser(s.user);
      setUniversity(s.university);
    },
    [setUniversity],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const s = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      acceptSession(s);
    },
    [acceptSession],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      university,
      loading,
      login,
      acceptSession,
      logout,
      refresh,
      setUniversity,
      hasRole: (...roles) => Boolean(user && roles.includes(user.role)),
    }),
    [user, university, loading, login, acceptSession, logout, refresh, setUniversity],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
