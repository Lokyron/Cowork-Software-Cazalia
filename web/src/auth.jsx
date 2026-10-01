import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = chargement, null = déconnecté

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.get('/auth/me');
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Renvoie la réponse brute : { user } si connecté, ou { mfa_required: true }
  // si un code 2FA est attendu. `token` = code OTP (2e étape).
  const login = async (email, password, token) => {
    const res = await api.post('/auth/login', { email, password, token });
    if (res && res.user) setUser(res.user);
    return res;
  };

  const register = async (payload) => {
    const { user } = await api.post('/auth/register', payload);
    setUser(user);
    return user;
  };

  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, login, register, logout, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
