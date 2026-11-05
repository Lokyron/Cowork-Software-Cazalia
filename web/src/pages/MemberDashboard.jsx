import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime } from '../time.js';
import VoucherBlock from '../components/VoucherBlock.jsx';
import AccessPinBlock from '../components/AccessPinBlock.jsx';
import GoogleCalendarLink from '../components/GoogleCalendarLink.jsx';
import CartSidebar from '../components/CartSidebar.jsx';

const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const longDate = (iso) => dFmt.format(new Date(iso));
const range = (a, b) => `${tFmt.format(new Date(a))} – ${tFmt.format(new Date(b))}`;
const eur = (cents) => ((Number(cents) || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Badge de statut d'une réservation passée / en cours (cf. audit M3).
function HistoryBadge({ r, now }) {
  if (r.status !== 'confirmed') return <span className="badge red">Annulée</span>;
  if (new Date(r.start_at).getTime() <= now && new Date(r.end_at).getTime() > now) {
    return <span className="badge green">En cours</span>;
  }
  if (r.payment_status === 'refunded') return <span className="badge red">Remboursée</span>;
  return <span className="badge">Terminée</span>;
}

export default function MemberDashboard() {
  const { user } = useAuth();
  const [reservations, setReservations] = useState([]);
  const [processing, setProcessing] = useState([]);
  const [arrival, setArrival] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    const r = await api.get('/reservations/me');
    setReservations(r.reservations);
    setProcessing(r.processing || []);
    setLoading(false);
    return r;
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); api.get('/config').then(setArrival).catch(() => {}); }, [load]);

  // Horloge basse fréquence : garde le statut « en cours » à jour sans recharger.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  // Filet post-paiement (audit M2) : tant qu'un paiement est « en cours de
  // traitement » (commande payée, webhook pas encore arrivé), on recharge à
  // cadence décroissante, borné, jusqu'à ce que la réservation apparaisse.
  const pollRef = useRef(null);
  useEffect(() => {
    if (processing.length === 0) return undefined;
    let tries = 0;
    const tick = () => {
      tries += 1;
      load().catch(() => {}).finally(() => {
        if (tries < 10) pollRef.current = setTimeout(tick, Math.min(2000 + tries * 1000, 8000));
      });
    };
    pollRef.current = setTimeout(tick, 2500);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [processing.length, load]);

  // Retour depuis Stripe Checkout.
  useEffect(() => {
    const status = searchParams.get('reservation');
    if (!status) return;
    if (status === 'success') {
      setFeedback({ type: 'ok', text: 'Paiement reçu ! Votre réservation apparaît dès sa confirmation (quelques secondes).' });
      load().catch(() => {});
      searchParams.delete('reservation'); setSearchParams(searchParams, { replace: true });
    }
    if (status === 'cancel') {
      setFeedback({ type: 'error', text: 'Paiement annulé. Aucun montant n’a été débité et la réservation n’a pas été prise.' });
      searchParams.delete('reservation'); setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, load]);

  const { current, next, upcoming, past } = useMemo(() => {
    const confirmed = reservations.filter((r) => r.status === 'confirmed');
    const inProgress = confirmed
      .filter((r) => new Date(r.start_at).getTime() <= now && new Date(r.end_at).getTime() > now)
      .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    const fut = confirmed.filter((r) => new Date(r.start_at).getTime() > now).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    // Historique : annulées + terminées (fin passée). Les « en cours » en sont exclues.
    const pastOnes = reservations
      .filter((r) => r.status !== 'confirmed' || new Date(r.end_at).getTime() <= now)
      .sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
    return { current: inProgress, next: fut[0] || null, upcoming: fut.slice(1), past: pastOnes };
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
    <div className="espace-layout">
      <div className="espace-main">
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Bonjour {user?.display_name?.split(' ')[0] || ''} 👋</h1>
          <p className="subtitle" style={{ margin: 0 }}>Votre espace client Cazalia.</p>
        </div>
        <Link to="/reserver"><button>＋ Réserver un espace</button></Link>
      </div>

      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      {/* Paiement en cours de traitement (webhook Stripe pas encore arrivé) */}
      {processing.length > 0 && (
        <div className="alert" style={{ marginBottom: 16, background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.3)' }}>
          ⏳ Paiement en cours de traitement… Votre réservation s’affiche dès la confirmation de la banque
          (quelques secondes). Inutile de payer à nouveau.
        </div>
      )}

      {/* EN COURS */}
      {current.map((r) => (
        <div key={r.id} className="card hero-card" style={{ marginBottom: 20 }}>
          <div className="hero-tag">En ce moment</div>
          <div className="hero-main">
            <div>
              <h2 style={{ margin: '4px 0 2px' }}>
                <span className="dot" style={{ background: r.space_color }} />{r.space_name}
              </h2>
              <div className="hero-when">{longDate(r.start_at)} · {range(r.start_at, r.end_at)}</div>
              <div className="muted seats" style={{ marginTop: 4 }}>{eur(r.price_cents)}</div>
            </div>
            <div className="hero-actions"><GoogleCalendarLink reservation={r} /></div>
          </div>
          <AccessPinBlock reservation={r} />
          <VoucherBlock reservation={r} />
        </div>
      ))}

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
      ) : current.length === 0 && (
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
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/reserver"><button className="outline small">Réserver un espace</button></Link>
            <Link to="/mes-paiements"><button className="outline small">Mes paiements</button></Link>
          </div>
        </div>
      </div>

      {/* HISTORIQUE */}
      <div className="card">
        <div className="flex-between"><h2>Historique des réservations</h2><Link to="/mes-paiements" style={{ fontSize: 13 }}>Mes paiements →</Link></div>
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
                  <td><HistoryBadge r={r} now={now} /></td>
                  <td style={{ textAlign: 'right' }}>{eur(r.price_cents)}</td>
                </tr>
              ))}
              {past.length === 0 && <tr><td colSpan={4} className="muted">Aucune session passée.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      </div>

      <CartSidebar />
    </div>
  );
}
