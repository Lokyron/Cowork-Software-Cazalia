import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ResendVerification } from '../components/EmailVerifyBanner.jsx';
import { useCart } from '../cart.jsx';
import CartBuilder from '../components/CartBuilder.jsx';
import ReservationNotice from '../components/ReservationNotice.jsx';

// Parcours de réservation client = panier multi-espaces (verrous 10 min + paiement crédits groupé).
export default function Booking() {
  const navigate = useNavigate();
  const { refresh: refreshCart } = useCart();
  const { user } = useAuth();
  // Adresse e-mail non confirmée : le serveur refuse toute réservation (EMAIL_NON_VERIFIE).
  const blocked = user?.role !== 'admin' && user?.email_verified === false;
  const [done, setDone] = useState(null);

  // Garde l'icône panier du header en phase avec les ajouts/retraits faits ici.
  const adapter = useMemo(() => ({
    key: 'client',
    list: () => api.get('/cart'),
    add: (payload) => api.post('/cart', payload).then((r) => { refreshCart(); return r; }),
    remove: (id) => api.del(`/cart/${id}`).then((r) => { refreshCart(); return r; }),
    previewPromo: (code) => api.post('/cart/promo/preview', { code }),
    // Confirmation directe (panier offert ou couvert par l'abonnement) : le panier
    // est vidé côté serveur, l'icône du header doit suivre. Sur le chemin Stripe,
    // la page est quittée aussitôt, donc le rafraîchissement est sans effet.
    checkout: (promoCode) => api.post('/cart/checkout', promoCode ? { promo_code: promoCode } : {})
      .then((r) => { refreshCart(); return r; }),
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

      {blocked && (
        <div className="alert error" style={{ marginBottom: 16 }}>
          <strong>Validez votre adresse e-mail pour pouvoir réserver.</strong>{' '}
          Cliquez sur le lien que nous vous avons envoyé à l'inscription ({user.email}).
          <div style={{ marginTop: 8 }}><ResendVerification /></div>
        </div>
      )}

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
        <CartBuilder adapter={adapter} blocked={blocked} onDone={setDone} />
      )}
    </div>
  );
}
