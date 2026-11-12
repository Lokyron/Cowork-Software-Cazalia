import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import DevisModal from '../components/DevisModal.jsx';
import PublicHeader from '../components/PublicHeader.jsx';
import ReservationNotice from '../components/ReservationNotice.jsx';

// Les montants viennent de GET /api/pricing, c'est-à-dire de la source de vérité
// du moteur de facturation (config.pricing). Ces valeurs ne servent que de repli
// si l'appel échoue : la page affiche alors la grille connue plutôt que du vide.
const DEFAULTS = {
  open_space: { demi_journee: 1200, journee: 2000 },
  meeting_room: { heure: 2000, demi_journee: 3500, journee: 5000 },
  subscriptions: { ESSENTIEL: 16000, CONFORT: 22000, PREMIUM: 30000 },
  confort_meeting_discount: 0.5,
  essentiel_quota_days: 12,
  samedi: { demi_journee: true, journee: false },
};

// Les tarifs de la vitrine sont des montants ronds : on évite « 20,00 € » et on
// ne montre les centimes que s'il y en a réellement.
const eurc = (cents) => {
  const v = (Number(cents) || 0) / 100;
  return Number.isInteger(v) ? `${v} €` : v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
};

const CONFIDENTIELLE = 'En libre accès pour toute réservation dans l\'open space';

// Formules d'abonnement. Le montant réellement prélevé vient des Prices Stripe
// configurés dans l'administration ; celui affiché ici est indicatif.
const plansFrom = (t) => [
  {
    tier: 'ESSENTIEL', name: 'Essentiel', price: t.subscriptions.ESSENTIEL,
    features: [
      ['Open Space', `${t.essentiel_quota_days} jours / mois inclus`],
      ['Salle de réunion', 'Tarif standard'],
      ['Salle confidentielle', CONFIDENTIELLE],
    ],
  },
  {
    tier: 'CONFORT', name: 'Confort', price: t.subscriptions.CONFORT, popular: true,
    features: [
      ['Open Space', 'Illimité'],
      ['Salle de réunion', `−${Math.round((1 - t.confort_meeting_discount) * 100)} % sur chaque réservation`],
      ['Salle confidentielle', CONFIDENTIELLE],
    ],
  },
  {
    tier: 'PREMIUM', name: 'Premium', price: t.subscriptions.PREMIUM,
    features: [
      ['Open Space', 'Illimité'],
      ['Salle de réunion', 'Illimitée incluse'],
      ['Salle confidentielle', CONFIDENTIELLE],
    ],
  },
];

// Accès ponctuel : une carte par espace, au même format que les formules.
const ponctuelFrom = (t) => [
  {
    name: 'Open Space',
    price: eurc(t.open_space.journee), unit: '/ journée',
    lines: [`${eurc(t.open_space.demi_journee)} la demi-journée`, 'Poste de travail en espace partagé'],
  },
  {
    name: 'Salle de réunion',
    price: eurc(t.meeting_room.heure), unit: "/ heure",
    lines: [
      `${eurc(t.meeting_room.demi_journee)} la demi-journée · ${eurc(t.meeting_room.journee)} la journée`,
      'Salle privative, réservée pour vous seul',
    ],
  },
  {
    name: 'Salle confidentielle',
    price: 'Incluse', unit: null,
    lines: [CONFIDENTIELLE, 'Aucune réservation à faire'],
  },
];

// Tableau comparatif. Colonnes : Sans abonnement / Essentiel / Confort / Premium.
const compareFrom = (t) => [
  ['Open Space',
    `${eurc(t.open_space.demi_journee)} ½j · ${eurc(t.open_space.journee)} j`,
    `${t.essentiel_quota_days} j/mois inclus`, 'Illimité', 'Illimité'],
  ['Salle de réunion',
    `${eurc(t.meeting_room.heure)}/h · ${eurc(t.meeting_room.demi_journee)} ½j · ${eurc(t.meeting_room.journee)} j`,
    'Tarif standard', `−${Math.round((1 - t.confort_meeting_discount) * 100)} %`, 'Illimitée incluse'],
  // La même longue phrase répétée quatre fois ne se lisait plus : la mention
  // part en note sous le tableau, les cases disent simplement l'essentiel.
  ['Salle confidentielle *', 'Incluse', 'Incluse', 'Incluse', 'Incluse'],
  ['Abonnement mensuel', '—',
    eurc(t.subscriptions.ESSENTIEL), eurc(t.subscriptions.CONFORT), eurc(t.subscriptions.PREMIUM)],
];

const COLS = ['Sans abonnement', 'Essentiel', 'Confort', 'Premium'];

// Univers du sélecteur segmenté. L'ordre fixe l'ordre d'affichage et la position
// du surligné glissant. « Abonnement » est au centre et affiché par défaut.
const SEGMENTS = [
  { id: 'ponctuel', label: 'Ponctuel' },
  { id: 'abonnement', label: 'Abonnement' },
  { id: 'privatisation', label: 'Privatisation' },
];

export default function Pricing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [devis, setDevis] = useState(false);
  const [busyTier, setBusyTier] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [tarifs, setTarifs] = useState(DEFAULTS);
  // Univers affiché via le sélecteur segmenté. Vue par défaut : l'abonnement.
  const [tab, setTab] = useState('abonnement');
  const tabIndex = SEGMENTS.findIndex((s) => s.id === tab);

  // Grille tarifaire servie par l'API. En cas d'échec, on garde DEFAULTS.
  useEffect(() => {
    api.get('/pricing').then((r) => setTarifs({ ...DEFAULTS, ...r })).catch(() => {});
  }, []);

  // Retour d'un Checkout d'abonnement annulé.
  useEffect(() => {
    if (searchParams.get('abonnement') === 'cancel') {
      setFeedback({ type: 'error', text: "Souscription annulée - aucun montant n'a été prélevé." });
      searchParams.delete('abonnement'); setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const subscribe = async (tier) => {
    setFeedback(null);
    // Non connecté : on mémorise l'intention et on envoie vers la connexion ;
    // l'espace client reprend la souscription à l'arrivée.
    if (!user) {
      try { sessionStorage.setItem('pendingTier', tier); } catch { /* stockage indisponible */ }
      navigate('/login');
      return;
    }
    setBusyTier(tier);
    try {
      const { url } = await api.post('/subscriptions/checkout', { tier });
      if (url) { window.location.assign(url); return; }
    } catch (err) {
      setFeedback({ type: 'error', text: msg(err.code) });
      setBusyTier(null);
    }
  };

  const plans = plansFrom(tarifs);
  const ponctuel = ponctuelFrom(tarifs);
  const compare = compareFrom(tarifs);
  const goReserver = () => navigate(user ? '/reserver' : '/login');

  return (
    <>
      <PublicHeader solid />
      <main className="container">
      <div className="pricing-page">
      <div className="section-head" style={{ marginTop: 8 }}>
        <span className="eyebrow dark">Nos formules</span>
        <h1 className="big">Un abonnement, ou à la carte.</h1>
        <p className="lead" style={{ maxWidth: 620, margin: '0 auto' }}>
          Choisissez l'abonnement mensuel qui vous ressemble, ou réservez ponctuellement sans engagement.
        </p>
      </div>

      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`} style={{ maxWidth: 720, margin: '0 auto 16px' }}>{feedback.text}</div>}

      {/* ── Sélecteur segmenté « slidable » (surligné glissant) ───────────── */}
      <div className="tarif-seg" role="tablist" aria-label="Type d'offre">
        <span className="tarif-seg-hl" style={{ transform: `translateX(${tabIndex * 100}%)` }} aria-hidden="true" />
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={tab === s.id}
            className={`tarif-seg-btn ${tab === s.id ? 'active' : ''}`}
            onClick={() => setTab(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ── Abonnement : les 3 cartes ─────────────────────────────────────── */}
      {tab === 'abonnement' && (
      <>
      <div className="plan-grid">
        {plans.map((p) => (
          <div key={p.tier} className={`card plan-card ${p.popular ? 'popular' : ''}`}>
            {p.popular && <div className="plan-badge">Le plus populaire</div>}
            <h2 className="plan-name">{p.name}</h2>
            <div className="plan-price"><strong>{eurc(p.price)}</strong><span className="muted"> / mois</span></div>
            <ul className="plan-features">
              {p.features.map(([k, v]) => (
                <li key={k}><span className="plan-check">✓</span> <span><strong>{k} :</strong> {v}</span></li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: 12, margin: '0 0 12px', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <span aria-hidden="true">📌</span>
              <span>Réservation du créneau à faire sur votre espace avant chaque venue.</span>
            </p>
            <button
              className={p.popular ? '' : 'outline'}
              style={{ width: '100%', marginTop: 'auto' }}
              disabled={busyTier === p.tier}
              onClick={() => subscribe(p.tier)}
            >
              {busyTier === p.tier ? '…' : "S'abonner"}
            </button>
          </div>
        ))}
      </div>
      <ReservationNotice variant="abonnement" style={{ maxWidth: 720, margin: '16px auto 0' }} />
      </>
      )}

      {/* ── Ponctuel : une carte par espace, au format des formules ───────── */}
      {tab === 'ponctuel' && (
      <>
      <div className="plan-grid">
        {ponctuel.map((o) => (
          <div key={o.name} className="card plan-card">
            <h2 className="plan-name">{o.name}</h2>
            <div className="plan-price">
              <strong>{o.price}</strong>
              {o.unit && <span className="muted"> {o.unit}</span>}
            </div>
            <ul className="plan-features">
              {o.lines.map((l) => (
                <li key={l}><span className="plan-check">✓</span> <span>{l}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="card ponctuel-foot">
        <div>
          <strong>Accès ponctuel - sans abonnement</strong>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
            Réservez à la séance, payez en ligne au moment de réserver.
            {!tarifs.samedi.journee && tarifs.samedi.demi_journee
              && ' Le samedi, seule la demi-journée du matin est ouverte.'}
          </p>
        </div>
        <button className="outline" onClick={goReserver}>Réserver une session ponctuelle →</button>
      </div>
      </>
      )}

      {/* ── Privatisation : Bureau Privé sur devis ────────────────────────── */}
      {tab === 'privatisation' && (
      <div className="card bureau-card">
        <div>
          <span className="badge grey">Entreprises & indépendants</span>
          <h3 style={{ margin: '8px 0 4px' }}>Bureau Privé - Longue durée</h3>
          <p className="muted" style={{ margin: '0 0 10px' }}>Un espace privatisé, un contrat sur mesure au trimestre ou à l'année.</p>
          <ul className="features">
            <li>Espace entièrement privatisé</li>
            <li>Contrat longue durée personnalisé</li>
            <li>Accès complet aux espaces communs</li>
          </ul>
        </div>
        <div className="bureau-cta">
          <div className="plan-price"><strong>Sur devis</strong></div>
          <button onClick={() => setDevis(true)}>Demander un devis</button>
        </div>
      </div>
      )}

      {/* ── Tableau comparatif (toujours visible) ─────────────────────────── */}
      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>Comparatif complet</h3>
        <div className="table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th></th>
                {COLS.map((c) => (
                  <th key={c} className={c === 'Confort' ? 'col-pop' : undefined}>
                    {c}
                    {c === 'Confort' && <span className="compare-pop"> Le plus populaire</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.map((row) => (
                <tr key={row[0]}>
                  <th scope="row">{row[0]}</th>
                  {COLS.map((c, i) => (
                    <td key={c} data-col={c} className={c === 'Confort' ? 'col-pop' : undefined}>{row[i + 1]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="compare-cta">
                <th scope="row"></th>
                <td data-col="Sans abonnement">
                  <button className="outline small" onClick={goReserver}>Réserver</button>
                </td>
                {plans.map((p) => (
                  <td key={p.tier} data-col={p.name} className={p.popular ? 'col-pop' : undefined}>
                    <button
                      className={p.popular ? 'small' : 'outline small'}
                      disabled={busyTier === p.tier}
                      onClick={() => subscribe(p.tier)}
                    >
                      {busyTier === p.tier ? '…' : "S'abonner"}
                    </button>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: '12px 0 0' }}>
          * {CONFIDENTIELLE}, quelle que soit la formule.
        </p>
      </div>

      <p className="muted" style={{ textAlign: 'center', marginTop: 18 }}>
        <Link to="/">← Retour à l'accueil</Link>
      </p>

      {devis && <DevisModal onClose={() => setDevis(false)} />}
      </div>
      </main>
    </>
  );
}
