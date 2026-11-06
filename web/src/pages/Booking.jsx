import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import CartBuilder from '../components/CartBuilder.jsx';
import ReservationNotice from '../components/ReservationNotice.jsx';

// Parcours de réservation client = panier multi-espaces (verrous 10 min + paiement crédits groupé).
export default function Booking() {
  const navigate = useNavigate();
  const { refresh: refreshCart } = useCart();
  const [done, setDone] = useState(null);

  // Garde l'icône panier du header en phase avec les ajouts/retraits faits ici.
  const adapter = useMemo(() => ({
    key: 'client',
    list: () => api.get('/cart'),
    add: (payload) => api.post('/cart', payload).then((r) => { refreshCart(); return r; }),
    remove: (id) => api.del(`/cart/${id}`).then((r) => { refreshCart(); return r; }),
    previewPromo: (code) => api.post('/cart/promo/preview', { code }),
    checkout: (promoCode) => api.post('/cart/checkout', promoCode ? { promo_code: promoCode } : {}),
  }), [refreshCart]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1>Réserver</h1>
        <p className="subtitle" style={{ margin: 0 }}>
          Composez votre panier (plusieurs espaces et créneaux), puis validez en une seule fois.
        </p>
      </div>

      <ReservationNotice variant="generic" style={{ marginBottom: 16 }} />

      {done ? (
        <div className="alert ok">
          {done.count} réservation{done.count > 1 ? 's' : ''} confirmée{done.count > 1 ? 's' : ''}.
          Le code Wi-Fi et les consignes sont disponibles sur votre espace.
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button onClick={() => navigate('/mon-espace')}>Voir mon espace</button>
            <button className="outline" onClick={() => setDone(null)}>Réserver à nouveau</button>
          </div>
        </div>
      ) : (
        <CartBuilder adapter={adapter} onDone={setDone} />
      )}
    </div>
  );
}
