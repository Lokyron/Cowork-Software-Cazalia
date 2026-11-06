import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import DevisModal from '../components/DevisModal.jsx';
import PublicHeader from '../components/PublicHeader.jsx';

// Formules d'abonnement (affichage). Les montants réels sont prélevés par Stripe
// selon les Prices configurés ; ces valeurs doivent rester en phase avec
// config.pricing.SUBSCRIPTIONS côté serveur.
const PLANS = [
  {
    tier: 'ESSENTIEL', name: 'Essentiel', price: 160,
    features: [
      ['Open Space', '12 jours / mois inclus'],
      ['Salle de réunion', 'Tarif standard'],
      ['Salle confidentielle', 'Libre-service inclus'],
    ],
  },
  {
    tier: 'CONFORT', name: 'Confort', price: 220, popular: true,
    features: [
      ['Open Space', 'Illimité'],
      ['Salle de réunion', '−50 % sur chaque réservation'],
      ['Salle confidentielle', 'Libre-service inclus'],
    ],
  },
  {
    tier: 'PREMIUM', name: 'Premium', price: 300,
    features: [
      ['Open Space', 'Illimité'],
      ['Salle de réunion', 'Illimitée incluse'],
      ['Salle confidentielle', 'Libre-service inclus'],
    ],
  },
];

// Tableau comparatif (lignes). Colonnes : Sans abo / Essentiel / Confort / Premium.
const COMPARE = [
  ['Open Space', '12 € ½j · 20 € j', '12 j/mois inclus', 'Illimité', 'Illimité'],
  ['Salle de réunion', '20 €/h · 35 € ½j · 50 € j', 'Tarif standard', '−50 %', 'Illimitée incluse'],
  ['Salle confidentielle', 'Libre-service', 'Libre-service', 'Libre-service', 'Libre-service'],
  ['Abonnement mensuel', '-', '160 €', '220 €', '300 €'],
];

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
  // Univers affiché via le sélecteur segmenté. Vue par défaut : l'abonnement.
  const [tab, setTab] = useState('abonnement');
  const tabIndex = SEGMENTS.findIndex((s) => s.id === tab);

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

  const eur = (n) => `${n} €`;

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
      <div className="plan-grid">
        {PLANS.map((p) => (
          <div key={p.tier} className={`card plan-card ${p.popular ? 'popular' : ''}`}>
            {p.popular && <div className="plan-badge">Le plus populaire</div>}
            <h2 className="plan-name">{p.name}</h2>
            <div className="plan-price"><strong>{eur(p.price)}</strong><span className="muted"> / mois</span></div>
            <ul className="plan-features">
              {p.features.map(([k, v]) => (
                <li key={k}><span className="plan-check">✓</span> <span><strong>{k} :</strong> {v}</span></li>
              ))}
            </ul>
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
      )}

      {/* ── Ponctuel : la grille à la carte ───────────────────────────────── */}
      {tab === 'ponctuel' && (
      <div className="card ponctuel-card">
        <div>
          <h3 style={{ marginTop: 0 }}>Accès ponctuel - sans abonnement</h3>
          <p className="muted" style={{ margin: '4px 0 10px' }}>Réservez à la séance, payez en ligne au moment de réserver.</p>
          <div className="ponctuel-grid">
            <div><strong>Open Space</strong><div className="muted">12 € la demi-journée · 20 € la journée</div></div>
            <div><strong>Salle de réunion</strong><div className="muted">20 €/h · 35 € ½ journée · 50 € journée</div></div>
            <div><strong>Salle confidentielle</strong><div className="muted">Libre-service sur place, sans réservation</div></div>
          </div>
        </div>
        <button className="outline" onClick={() => navigate(user ? '/reserver' : '/login')}>Réserver une session ponctuelle →</button>
      </div>
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
                <th></th><th>Sans abonnement</th><th>Essentiel</th><th className="col-pop">Confort</th><th>Premium</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((row) => (
                <tr key={row[0]}>
                  <th scope="row">{row[0]}</th>
                  <td>{row[1]}</td><td>{row[2]}</td><td className="col-pop">{row[3]}</td><td>{row[4]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
