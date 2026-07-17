import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (api.token) {
      api.get('/auth/me').then(r => setUser(r.user)).catch(() => api.setToken(null)).finally(() => setLoading(false));
    } else { setLoading(false); }
  }, []);

  const login = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    api.setToken(r.token);
    setUser(r.user);
    return r.user;
  }, []);

  const logout = useCallback(() => { api.setToken(null); setUser(null); }, []);

  const hasPerm = useCallback((perm) => user?.permissions?.includes(perm), [user]);

  return <AuthCtx.Provider value={{ user, loading, login, logout, hasPerm }}>{children}</AuthCtx.Provider>;
}

export function useAuth() { return useContext(AuthCtx); }
