import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime } from '../time.js';
import VoucherBlock from '../components/VoucherBlock.jsx';
import GoogleCalendarLink from '../components/GoogleCalendarLink.jsx';
import InvoiceExport from '../components/InvoiceExport.jsx';

const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const longDate = (iso) => dFmt.format(new Date(iso));
const range = (a, b) => `${tFmt.format(new Date(a))} – ${tFmt.format(new Date(b))}`;

// Libellé lisible d'un mouvement de crédits (grand-livre du portefeuille).
// Côté membre, seuls amount/reason/note/created_at sont servis par l'API.
function movementLabel(t) {
  switch (t.reason) {
    case 'topup': return t.note || 'Recharge de crédits';
    case 'booking': return 'Réservation';
    case 'refund': return 'Remboursement';
    case 'adjust': return t.note ? `Ajustement — ${t.note}` : 'Ajustement';
    default: return t.note || t.reason;
  }
}

export default function MemberDashboard() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [arrival, setArrival] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [packs, setPacks] = useState([]);           // formules de recharge (vide = paiement en ligne indispo)
  const [showPacks, setShowPacks] = useState(false);
  const [paying, setPaying] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    const [w, r] = await Promise.all([api.get('/wallet/me'), api.get('/reservations/me')]);
    setWallet(w);
    setReservations(r.reservations);
  }, []);
  useEffect(() => { load(); api.get('/config').then(setArrival).catch(() => {}); }, [load]);

  // Formules de recharge (affichées seulement si le paiement en ligne est actif).
  useEffect(() => {
    api.get('/wallet/packs').then((r) => { if (r.enabled) setPacks(r.packs || []); }).catch(() => {});
  }, []);

  // Retour depuis Stripe Checkout : le crédit réel arrive par webhook, on relit
  // donc le solde peu après et on informe le membre.
  useEffect(() => {
    const status = searchParams.get('recharge');
    if (!status) return;
    if (status === 'success') {
      setFeedback({ type: 'ok', text: 'Paiement reçu ! Vos crédits apparaissent dès la confirmation (quelques secondes).' });
      const t1 = setTimeout(load, 1500);
      const t2 = setTimeout(load, 5000);
      searchParams.delete('recharge'); setSearchParams(searchParams, { replace: true });
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (status === 'cancel') {
      setFeedback({ type: 'error', text: 'Recharge annulée. Aucun montant n’a été débité.' });
      searchParams.delete('recharge'); setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, load]);

  const buyPack = async (packId) => {
    setPaying(true); setFeedback(null);
    try {
      const { url } = await api.post('/wallet/checkout', { pack_id: packId });
      window.location.assign(url); // redirection vers la page de paiement Stripe
    } catch (err) {
      setFeedback({ type: 'error', text: msg(err.code) });
      setPaying(false);
    }
  };

  const now = Date.now();
  const { next, upcoming, past } = useMemo(() => {
    const confirmed = reservations.filter((r) => r.status === 'confirmed');
    const fut = confirmed.filter((r) => new Date(r.start_at).getTime() > now).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    const pastOnes = reservations.filter((r) => r.status !== 'confirmed' || new Date(r.start_at).getTime() <= now)
      .sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
    return { next: fut[0] || null, upcoming: fut.slice(1), past: pastOnes };
  }, [reservations, now]);

  const cancel = async (id) => {
    setFeedback(null);
    try {
      const r = await api.del(`/reservations/${id}`);
      setFeedback({ type: 'ok', text: r.refunded ? `Annulée — ${r.amount} crédits remboursés.` : 'Annulée — hors délai, pas de remboursement.' });
      load();
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
  };

  if (!wallet) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Bonjour {user?.display_name?.split(' ')[0] || ''} 👋</h1>
          <p className="subtitle" style={{ margin: 0 }}>Votre espace client Cazalia.</p>
        </div>
        <Link to="/reserver"><button>＋ Réserver un espace</button></Link>
      </div>

      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      {/* HERO — prochaine réservation */}
      {next ? (
        <div className="card hero-card" style={{ marginBottom: 20 }}>
          <div className="hero-tag">Prochaine réservation</div>
          <div className="hero-main">
            <div>
              <h2 style={{ margin: '4px 0 2px' }}>
                <span className="dot" style={{ background: next.space_color }} />{next.space_name}
              </h2>
              <div className="hero-when">{longDate(next.start_at)} · {range(next.start_at, next.end_at)}</div>
              <div className="muted seats" style={{ marginTop: 4 }}>{next.credits_cost} crédits</div>
            </div>
            <div className="hero-actions">
              <GoogleCalendarLink reservation={next} />
              <button className="outline small" onClick={() => cancel(next.id)}>Annuler</button>
            </div>
          </div>

          <VoucherBlock reservation={next} />

          {arrival?.arrival_instructions && (
            <div className="hero-notes">
              <div className="hero-notes-title">Consignes d'arrivée</div>
              <p style={{ margin: 0, lineHeight: 1.6 }}>{arrival.arrival_instructions}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 20, textAlign: 'center', padding: 28 }}>
          <p className="muted" style={{ margin: '0 0 12px' }}>Aucune réservation à venir.</p>
          <Link to="/reserver"><button>Réserver un espace</button></Link>
        </div>
      )}

      <div className="grid cols-2" style={{ marginBottom: 20 }}>
        {/* À VENIR */}
        <div className="card">
          <div className="flex-between"><h2>Réservations à venir</h2><Link to="/mon-planning" style={{ fontSize: 13 }}>Calendrier →</Link></div>
          {upcoming.length === 0 && <p className="muted">Rien d'autre de prévu.</p>}
          <div className="stack">
            {upcoming.map((r) => (
              <div key={r.id} className="flex-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                <div>
                  <div><span className="dot" style={{ background: r.space_color }} /><strong>{r.space_name}</strong></div>
                  <div className="muted seats">{fmtDateTime(r.start_at)} → {fmtDateTime(r.end_at)} · {r.credits_cost} cr.</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <GoogleCalendarLink reservation={r} />
                  <button className="outline small" onClick={() => cancel(r.id)}>Annuler</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* SOLDE */}
        <div className="card">
          <h2>Solde de crédits</h2>
          <div className="balance">{wallet.balance} <span style={{ fontSize: 16, fontWeight: 500 }} className="muted">crédits</span></div>

          {packs.length > 0 ? (
            <>
              {!showPacks ? (
                <button className="small" style={{ marginTop: 10 }} onClick={() => setShowPacks(true)}>
                  ＋ Recharger en ligne
                </button>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>Choisissez une formule :</p>
                  <div className="stack">
                    {packs.map((p) => (
                      <button
                        key={p.id}
                        className="outline small"
                        disabled={paying}
                        style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}
                        onClick={() => buyPack(p.id)}
                      >
                        <span>{p.label}</span>
                        <span>{(p.eur_cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}</span>
                      </button>
                    ))}
                  </div>
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    Paiement sécurisé par Stripe. Les crédits n'ont pas de valeur monétaire
                    (voir les <Link to="/cgv">CGV</Link>).
                  </p>
                  <button className="ghost small" style={{ marginTop: 4 }} onClick={() => setShowPacks(false)}>Annuler</button>
                </div>
              )}
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Rechargez vos crédits à l'accueil (virement / CB).</p>
          )}

          <div style={{ marginTop: 10 }}>
            <Link to="/reserver"><button className="outline small">Réserver un espace</button></Link>
          </div>
        </div>
      </div>

      {/* HISTORIQUE */}
      <div className="card">
        <h2>Historique des réservations</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Espace</th><th>Statut</th><th style={{ textAlign: 'right' }}>Crédits</th></tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.start_at)}</td>
                  <td><span className="dot" style={{ background: r.space_color }} />{r.space_name}</td>
                  <td>{r.status === 'confirmed' ? <span className="badge green">Terminée</span> : <span className="badge red">Annulée</span>}</td>
                  <td style={{ textAlign: 'right' }}>{r.credits_cost}</td>
                </tr>
              ))}
              {past.length === 0 && <tr><td colSpan={4} className="muted">Aucune session passée.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 14 }}>
          <InvoiceExport baseUrl="/invoice" filenamePrefix="releve-cazalia" />
        </div>
      </div>

      {/* MOUVEMENTS DE CRÉDITS (recharges, réservations, remboursements) */}
      <div className="card" style={{ marginTop: 20 }}>
        <h2>Mouvements de crédits</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Opération</th><th style={{ textAlign: 'right' }}>Crédits</th></tr>
            </thead>
            <tbody>
              {(wallet.history || []).map((t) => (
                <tr key={t.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(t.created_at)}</td>
                  <td>{movementLabel(t)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`badge ${t.amount >= 0 ? 'green' : 'red'}`}>
                      {t.amount >= 0 ? `+${t.amount}` : t.amount}
                    </span>
                  </td>
                </tr>
              ))}
              {(!wallet.history || wallet.history.length === 0) && (
                <tr><td colSpan={3} className="muted">Aucun mouvement pour le moment.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
