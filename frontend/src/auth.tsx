import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, AUTH, clearAuth, post, refreshSession, setAuth, setSessionListener, type Role, type User } from './api';

interface AuthState {
  user: User | null;
  ready: boolean;
  login(email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}
const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSessionListener(setUser);
    // refreshSession() de-duplicates, so React StrictMode's double effect does not rotate the token twice
    refreshSession().finally(() => setReady(true));
  }, []);

  const value: AuthState = {
    user, ready,
    async login(email, password) {
      const data = await api(`${AUTH}/login`, { method: 'POST', body: { email, password }, auth: false });
      setAuth(data.accessToken, data.user);
      return data.user;
    },
    async logout() {
      try { await post(`${AUTH}/logout`); } finally { clearAuth(); }
    },
    async reload() {
      // roles/storeId live in the JWT: a refresh issues a new token after e.g. seller approval
      await refreshSession();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function RequireRole({ role, children }: { role?: Role; children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (role && !user.roles.includes(role)) return <p className="error box">This area is for {role.toLowerCase()} accounts.</p>;
  return <>{children}</>;
}
