// État partagé du panier de réservation : alimente l'icône du header et la
// sidebar de « Mon espace ». La source de vérité reste le serveur (/api/cart,
// verrous de 10 min) ; on rafraîchit à l'ouverture, au focus de l'onglet et à
// cadence modérée pour refléter l'expiration des verrous sans sur-solliciter l'API.
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';

const CartCtx = createContext(null);

const EMPTY = { holds: [], total: 0, count: 0 };

export function CartProvider({ children }) {
  const { user } = useAuth();
  const [cart, setCart] = useState(EMPTY);
  const enabled = !!user; // inutile d'appeler /cart tant qu'on n'est pas connecté

  const refresh = useCallback(async () => {
    if (!enabled) { setCart(EMPTY); return EMPTY; }
    try {
      const r = await api.get('/cart');
      const next = { holds: r.holds || [], total: r.total || 0, count: r.count ?? (r.holds || []).length };
      setCart(next);
      return next;
    } catch {
      return cart;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Retrait d'une ligne (anti-IDOR côté serveur) + mise à jour optimiste.
  const remove = useCallback(async (id) => {
    const r = await api.del(`/cart/${id}`);
    if (r?.cart) setCart({ holds: r.cart.holds || [], total: r.cart.total || 0, count: r.cart.count ?? (r.cart.holds || []).length });
    else refresh();
    return r;
  }, [refresh]);

  // Chargement initial + rechargement quand l'état de connexion change.
  useEffect(() => { refresh(); }, [refresh]);

  // Rafraîchissement périodique (verrous qui expirent) + au retour sur l'onglet.
  const tickRef = useRef(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    tickRef.current = setInterval(refresh, 20000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [enabled, refresh]);

  return (
    <CartCtx.Provider value={{ cart, refresh, remove }}>
      {children}
    </CartCtx.Provider>
  );
}

export const useCart = () => useContext(CartCtx) || { cart: EMPTY, refresh: () => {}, remove: async () => {} };
