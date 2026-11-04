import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime } from '../time.js';
import VoucherBlock from '../components/VoucherBlock.jsx';
import AccessPinBlock from '../components/AccessPinBlock.jsx';
import GoogleCalendarLink from '../components/GoogleCalendarLink.jsx';

const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const longDate = (iso) => dFmt.format(new Date(iso));
const range = (a, b) => `${tFmt.format(new Date(a))} – ${tFmt.format(new Date(b))}`;
const eur = (cents) => ((Number(cents) || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

export default function MemberDashboard() {
  const { user } = useAuth();
  const [reservations, setReservations] = useState([]);
  const [arrival, setArrival] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    const r = await api.get('/reservations/me');
    setReservations(r.reservations);
    setLoading(false);
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); api.get('/config').then(setArrival).catch(() => {}); }, [load]);

  // Retour depuis Stripe Checkout : la réservation est créée par le webhook, on
  // relit donc la liste peu après et on informe le membre.
  useEffect(() => {
    const status = searchParams.get('reservation');
    if (!status) return;
    if (status === 'success') {
      setFeedback({ type: 'ok', text: 'Paiement reçu ! Votre réservation apparaît dès la confirmation (quelques secondes).' });
      const t1 = setTimeout(() => load().catch(() => {}), 1500);
      const t2 = setTimeout(() => load().catch(() => {}), 5000);
      searchParams.delete('reservation'); setSearchParams(searchParams, { replace: true });
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (status === 'cancel') {
      setFeedback({ type: 'error', text: 'Paiement annulé. Aucun montant n’a été débité et la réservation n’a pas été prise.' });
      searchParams.delete('reservation'); setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, load]);

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
      setFeedback({
        type: 'ok',
        text: r.refunded
          ? `Réservation annulée — un remboursement de ${eur(r.amount)} vous sera effectué sous quelques jours.`
          : 'Réservation annulée — hors délai, pas de remboursement.',
      });
      load().catch(() => {});
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
  };

  if (loading) return <p className="muted">Chargement…</p>;

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
              <div className="muted seats" style={{ marginTop: 4 }}>{eur(next.price_cents)}</div>
            </div>
            <div className="hero-actions">
              <GoogleCalendarLink reservation={next} />
              <button className="outline small" onClick={() => cancel(next.id)}>Annuler</button>
            </div>
          </div>

          <AccessPinBlock reservation={next} />
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
                  <div className="muted seats">{fmtDateTime(r.start_at)} → {fmtDateTime(r.end_at)} · {eur(r.price_cents)}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <GoogleCalendarLink reservation={r} />
                  <button className="outline small" onClick={() => cancel(r.id)}>Annuler</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* BON À SAVOIR */}
        <div className="card">
          <h2>Bon à savoir</h2>
          <p style={{ lineHeight: 1.7, margin: '6px 0' }}>☕ <strong>Café &amp; thé inclus</strong> dans toutes les réservations.</p>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
            Vous payez chaque réservation en ligne par carte, au moment de réserver.
            À l'heure ou au forfait (demi-journée, journée) — le plus avantageux est indiqué.
          </p>
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
              <tr><th>Date</th><th>Espace</th><th>Statut</th><th style={{ textAlign: 'right' }}>Montant</th></tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.start_at)}</td>
                  <td><span className="dot" style={{ background: r.space_color }} />{r.space_name}</td>
                  <td>{r.status === 'confirmed' ? <span className="badge green">Terminée</span> : <span className="badge red">Annulée</span>}</td>
                  <td style={{ textAlign: 'right' }}>{eur(r.price_cents)}</td>
                </tr>
              ))}
              {past.length === 0 && <tr><td colSpan={4} className="muted">Aucune session passée.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
