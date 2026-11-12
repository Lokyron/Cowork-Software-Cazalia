import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime } from '../time.js';
import VoucherBlock from '../components/VoucherBlock.jsx';
import AccessPinBlock from '../components/AccessPinBlock.jsx';
import GoogleCalendarLink from '../components/GoogleCalendarLink.jsx';
import CartSidebar from '../components/CartSidebar.jsx';
import ReservationNotice from '../components/ReservationNotice.jsx';

const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const longDate = (iso) => dFmt.format(new Date(iso));
const range = (a, b) => `${tFmt.format(new Date(a))} - ${tFmt.format(new Date(b))}`;
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

const TIER_LABEL = { NONE: 'Aucun', ESSENTIEL: 'Essentiel', CONFORT: 'Confort', PREMIUM: 'Premium' };
const periodFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });

// Encart abonnement : formule active, période, jauge de quota (Essentiel), accès
// au portail Stripe. Invite à s'abonner si aucun abonnement actif.
function SubscriptionCard({ sub, tarifs, onManage, onCancel, onResume, busy }) {
  // Confirmation en deux temps : résilier ne doit pas tenir en un seul clic,
  // mais sans imposer une fenêtre modale pour autant.
  const [confirming, setConfirming] = useState(false);
  if (!sub) return null;
  const active = sub.status === 'active' || sub.status === 'past_due';
  if (!active || sub.tier === 'NONE') {
    return (
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ margin: '0 0 4px' }}>Aucun abonnement actif</h2>
            <p className="muted" style={{ margin: 0 }}>Économisez avec une formule mensuelle, ou continuez à la carte.</p>
          </div>
          <Link to="/tarifs"><button>Voir les tarifs</button></Link>
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((sub.quota_used / sub.quota_total) * 100));
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="hero-tag" style={{ marginBottom: 6 }}>Mon abonnement</div>
          <h2 style={{ margin: '0 0 2px' }}>
            Formule {TIER_LABEL[sub.tier] || sub.tier}
            {sub.status === 'past_due' && <span className="badge red" style={{ marginLeft: 8 }}>Paiement en attente</span>}
          </h2>
          {sub.current_period_end && (
            <div className="muted seats">Période en cours jusqu'au {periodFmt.format(new Date(sub.current_period_end))}</div>
          )}
        </div>
        <button className="outline" onClick={onManage} disabled={busy}>Gérer mon abonnement</button>
      </div>

      {sub.tier === 'ESSENTIEL' && (
        <div style={{ marginTop: 14 }}>
          <div className="flex-between seats" style={{ marginBottom: 6 }}>
            <span>Jours Open Space utilisés ce mois-ci</span>
            <strong>{Number(sub.quota_used).toLocaleString('fr-FR')} / {sub.quota_total}</strong>
          </div>
          <div className="quota-bar"><div className="quota-fill" style={{ width: `${pct}%` }} /></div>
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            Au-delà de {sub.quota_total} jours, les réservations Open Space passent au tarif ponctuel
            {tarifs ? ` (${eur(tarifs.open_space.demi_journee)} la demi-journée, ${eur(tarifs.open_space.journee)} la journée)` : ''}.
          </p>
        </div>
      )}
      {(sub.tier === 'CONFORT' || sub.tier === 'PREMIUM') && (
        <p className="muted" style={{ fontSize: 13, margin: '12px 0 0' }}>
          ✓ Open Space illimité inclus{sub.tier === 'PREMIUM' ? ' · Salle de réunion illimitée incluse' : ' · −50 % sur la salle de réunion'}.
        </p>
      )}
      <ReservationNotice variant="abonnement" compact style={{ marginTop: 14 }} />

      {/* ── Résiliation : effet au terme de la période déjà payée ─────────── */}
      {sub.cancel_at_period_end ? (
        <div className="sub-cancel-notice">
          <div>
            <strong>Résiliation programmée.</strong>{' '}
            Votre accès reste actif jusqu'au {sub.current_period_end ? periodFmt.format(new Date(sub.current_period_end)) : 'terme de la période en cours'}.
            Aucun prélèvement ne sera effectué ensuite.
          </div>
          <button className="outline small" onClick={onResume} disabled={busy}>Reprendre mon abonnement</button>
        </div>
      ) : confirming ? (
        <div className="alert error" style={{ marginTop: 14 }}>
          <strong>Résilier la formule {TIER_LABEL[sub.tier] || sub.tier} ?</strong>
          <p style={{ margin: '6px 0 10px' }}>
            Votre accès et votre quota restent actifs jusqu'au{' '}
            {sub.current_period_end ? periodFmt.format(new Date(sub.current_period_end)) : 'terme de la période en cours'}.
            La période déjà réglée n'est pas remboursée, même partiellement. Vous pourrez revenir
            sur cette décision jusqu'à cette date.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="danger small" onClick={onCancel} disabled={busy}>Confirmer la résiliation</button>
            <button className="outline small" onClick={() => setConfirming(false)} disabled={busy}>Garder mon abonnement</button>
          </div>
        </div>
      ) : (
        <button className="ghost small" style={{ marginTop: 12, padding: 0 }} onClick={() => setConfirming(true)}>
          Résilier mon abonnement
        </button>
      )}
    </div>
  );
}

export default function MemberDashboard() {
  const { user, refresh: refreshUser } = useAuth();
  const [reservations, setReservations] = useState([]);
  const [processing, setProcessing] = useState([]);
  const [arrival, setArrival] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [sub, setSub] = useState(null);
  const [tarifs, setTarifs] = useState(null);
  const [subBusy, setSubBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    const r = await api.get('/reservations/me');
    setReservations(r.reservations);
    setProcessing(r.processing || []);
    setLoading(false);
    return r;
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); api.get('/config').then(setArrival).catch(() => {}); }, [load]);

  const loadSub = useCallback(() => api.get('/subscriptions/me').then(setSub).catch(() => {}), []);
  useEffect(() => { loadSub(); }, [loadSub]);

  // Grille tarifaire : les montants cités dans l'encart d'abonnement étaient
  // écrits en dur et ne suivaient pas ceux réellement appliqués.
  useEffect(() => { api.get('/pricing').then(setTarifs).catch(() => {}); }, []);

  // Reprise de souscription : l'utilisateur a cliqué « S'abonner » sans être
  // connecté ; après connexion, on relance le Checkout Stripe de la formule choisie.
  useEffect(() => {
    let pending = null;
    try { pending = sessionStorage.getItem('pendingTier'); } catch { pending = null; }
    if (!pending) return;
    try { sessionStorage.removeItem('pendingTier'); } catch { /* ignore */ }
    api.post('/subscriptions/checkout', { tier: pending })
      .then((r) => { if (r?.url) window.location.assign(r.url); })
      .catch(() => { /* déjà abonné / indisponible : on ignore silencieusement */ });
  }, []);

  // Résiliation en fin de période payée (sans remboursement au prorata), et
  // retour en arrière tant que le terme n'est pas atteint.
  const setSubCancellation = async (cancel) => {
    setSubBusy(true);
    try {
      await api.post(cancel ? '/subscriptions/cancel' : '/subscriptions/resume');
      await loadSub();
      setFeedback({
        type: 'ok',
        text: cancel
          ? 'Résiliation enregistrée. Votre accès reste actif jusqu\u2019au terme de la période en cours.'
          : 'Abonnement repris : il se renouvellera normalement.',
      });
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    setSubBusy(false);
  };

  // Ouvre le portail Stripe (gestion CB, factures, résiliation).
  const managePortal = async () => {
    setSubBusy(true);
    try { const { url } = await api.post('/subscriptions/portal'); if (url) { window.location.assign(url); return; } }
    catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    setSubBusy(false);
  };

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

  // Retour depuis le Checkout d'ABONNEMENT.
  useEffect(() => {
    const status = searchParams.get('abonnement');
    if (!status) return;
    if (status === 'success') {
      setFeedback({ type: 'ok', text: 'Abonnement activé ! Il apparaît ici dès sa confirmation (quelques secondes).' });
      // Recharge le profil (tier) + le résumé d'abonnement, à cadence décroissante
      // le temps que le webhook mette la base à jour.
      let tries = 0;
      const tick = () => { tries += 1; refreshUser?.(); loadSub(); if (tries < 6) setTimeout(tick, 2000); };
      setTimeout(tick, 1500);
    }
    if (status === 'cancel') {
      setFeedback({ type: 'error', text: "Souscription annulée - aucun montant n'a été prélevé." });
    }
    searchParams.delete('abonnement'); setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams, refreshUser, loadSub]);

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
          ? `Réservation annulée - un remboursement de ${eur(r.amount)} vous sera effectué sous quelques jours.`
          : 'Réservation annulée - hors délai, pas de remboursement.',
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

      {/* ABONNEMENT */}
      <SubscriptionCard
            sub={sub}
            tarifs={tarifs}
            onManage={managePortal}
            onCancel={() => setSubCancellation(true)}
            onResume={() => setSubCancellation(false)}
            busy={subBusy}
          />

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

      {/* HERO - prochaine réservation */}
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
            À l'heure ou au forfait (demi-journée, journée) - le plus avantageux est indiqué.
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
