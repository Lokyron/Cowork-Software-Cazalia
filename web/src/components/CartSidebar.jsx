import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../cart.jsx';

// Sidebar persistante du panier affichée sur « Mon espace ». Lecture + retrait de
// lignes ; la finalisation (CGV, paiement) se fait sur la page « Réserver ».
const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtSlot = (a, b) => `${dFmt.format(new Date(a))} · ${tFmt.format(new Date(a))}–${tFmt.format(new Date(b))}`;
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const eur = (cents) => (cents == null ? '—' : (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));

export default function CartSidebar() {
  const { cart, refresh, remove } = useCart();
  const [now, setNow] = useState(Date.now());
  const holds = cart.holds || [];

  // Décompte des verrous + purge paresseuse à l'expiration (resynchro serveur).
  const expiredRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      const anyExpired = holds.some((h) => new Date(h.expires_at).getTime() <= Date.now());
      if (anyExpired && !expiredRef.current) { expiredRef.current = true; Promise.resolve(refresh()).finally(() => { expiredRef.current = false; }); }
    }, 1000);
    return () => clearInterval(t);
  }, [holds, refresh]);

  const onRemove = async (id) => { try { await remove(id); } catch { /* resynchro au prochain tick */ } };

  return (
    <aside className="card cart-aside" aria-label="Panier de réservation">
      <h3 style={{ marginTop: 0 }}>
        🛒 Mon panier {holds.length > 0 && <span className="muted">· {holds.length}</span>}
      </h3>

      {holds.length === 0 ? (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>Votre panier est vide.</p>
          <Link to="/reserver"><button className="outline small" style={{ width: '100%' }}>Réserver un espace</button></Link>
        </>
      ) : (
        <>
          <div className="stack">
            {holds.map((h) => {
              const left = new Date(h.expires_at).getTime() - now;
              const soon = left < 120000;
              return (
                <div key={h.id} className="cart-line">
                  <div style={{ minWidth: 0 }}>
                    <div><span className="dot" style={{ background: h.space_color }} /><strong>{h.space_name}</strong></div>
                    <div className="muted seats">{fmtSlot(h.start_at, h.end_at)} · {eur(h.cost)}</div>
                    <span className={`cart-timer ${soon ? 'soon' : ''}`} title="Temps restant du verrou" style={{ marginTop: 4, display: 'inline-block' }}>⏱ {mmss(left)}</span>
                  </div>
                  <button className="cart-remove" onClick={() => onRemove(h.id)} aria-label="Retirer du panier" title="Retirer du panier">✕</button>
                </div>
              );
            })}
          </div>

          <div className="cart-aside-total">
            <strong>Total</strong>
            <strong>{eur(cart.total)}</strong>
          </div>
          <Link to="/reserver"><button style={{ width: '100%', marginTop: 12 }}>Finaliser ma réservation</button></Link>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Places tenues 10 min. Le paiement se fait sur la page « Réserver ».</p>
        </>
      )}
    </aside>
  );
}
