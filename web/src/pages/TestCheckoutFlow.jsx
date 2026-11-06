// ─────────────────────────────────────────────────────────────────────────────
// MAQUETTE ISOLÉE - Tunnel d'achat unifié  (route : /test-checkout-flow)
//
// ⚠️ Prototype de travail, NON branché sur la production :
//   • aucun appel aux API de réservation / abonnement / paiement ;
//   • état 100 % local (pas de verrou serveur, pas de session) ;
//   • l'étape de paiement SIMULE la redirection Stripe (aucun prélèvement).
//
// Objectif : valider le cheminement complet (récap engageant → identification
// inline → réassurance → paiement) pour les 3 familles de produits
// (abonnement, open space, salle de réunion) avant tout portage en prod.
//
// Les montants reprennent config.pricing côté serveur (TTC) :
//   Open Space  : 12 € ½j · 20 € j
//   Salle réu.  : 20 €/h · 35 € ½j · 50 € j   (−50 % avec l'abo Confort/Premium)
//   Abonnements : Essentiel 160 € · Confort 220 € · Premium 300 € / mois
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PasswordInput from '../components/PasswordInput.jsx';
import ReservationNotice from '../components/ReservationNotice.jsx';
import { checkPassword, PASSWORD_RULE } from '../password.js';

const TVA = 0.20; // hypothèse d'affichage - à confirmer selon le paramétrage Stripe

const eur = (n) => Number(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const htFromTtc = (ttc) => ttc / (1 + TVA);

// ── Données produit (alignées sur le serveur) ───────────────────────────────
const PLANS = [
  {
    tier: 'ESSENTIEL', name: 'Essentiel', price: 160,
    tagline: 'Pour venir quelques jours par mois.',
    features: [
      ['Open Space', '12 jours / mois inclus'],
      ['Salle de réunion', 'Tarif standard'],
      ['Salle confidentielle', 'Libre-service inclus'],
      ['Café & thé', 'À volonté'],
    ],
  },
  {
    tier: 'CONFORT', name: 'Confort', price: 220, popular: true,
    tagline: 'Le bon équilibre pour un usage régulier.',
    features: [
      ['Open Space', 'Illimité'],
      ['Salle de réunion', '−50 % sur chaque réservation'],
      ['Salle confidentielle', 'Libre-service inclus'],
      ['Café & thé', 'À volonté'],
    ],
  },
  {
    tier: 'PREMIUM', name: 'Premium', price: 300,
    tagline: 'Tout compris, sans compter.',
    features: [
      ['Open Space', 'Illimité'],
      ['Salle de réunion', 'Illimitée incluse'],
      ['Salle confidentielle', 'Libre-service inclus'],
      ['Café & thé', 'À volonté'],
    ],
  },
];

// Formules ponctuelles par famille d'espace. `ttc` en euros.
const OPEN_SPACE_FORMULES = [
  { id: 'matin', label: 'Demi-journée - matin', horaire: '08:30 - 14:00', ttc: 12 },
  { id: 'aprem', label: 'Demi-journée - après-midi', horaire: '14:00 - 19:30', ttc: 12 },
  { id: 'journee', label: 'Journée complète', horaire: '08:30 - 19:30', ttc: 20 },
];
const MEETING_FORMULES = [
  { id: 'heure', label: "À l'heure", horaire: 'Créneau au choix', ttc: 20, perHour: true },
  { id: 'demi', label: 'Demi-journée', horaire: '4 h consécutives', ttc: 35 },
  { id: 'journee', label: 'Journée complète', horaire: "Toute la journée", ttc: 50 },
];

const OPEN_SPACE_INCLUS = ['Café & thé à volonté', 'Wi-Fi fibre dédié', 'Imprimante', 'Espace détente'];
const MEETING_INCLUS = ['Écran / TV', 'Visioconférence', 'Paperboard', 'Café & thé'];

const PRODUCTS = [
  { id: 'abonnement', label: 'Abonnement', icon: '🗓️', sub: 'Mensuel, sans engagement' },
  { id: 'open_space', label: 'Open space', icon: '💻', sub: 'À la demi-journée ou journée' },
  { id: 'salle', label: 'Salle de réunion', icon: '👥', sub: "À l'heure ou au forfait" },
];

// Prochaine date ouvrée au format input date (confort de démo).
function defaultDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const frDate = (iso) => {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
      .format(new Date(`${iso}T12:00:00`));
  } catch { return iso; }
};

// ── Bloc réassurance (partagé par tous les produits) ─────────────────────────
function Reassurance({ product }) {
  const annulation = product === 'abonnement'
    ? 'Abonnement sans engagement : résiliable à tout moment avant la date de renouvellement, depuis votre espace.'
    : 'Annulation gratuite jusqu’à 24 h avant le créneau. Au-delà, la séance reste due.';
  return (
    <div className="tcf-reassure">
      <div className="tcf-reassure-item">
        <span className="tcf-reassure-ico" aria-hidden="true">↩️</span>
        <div><strong>Annulation</strong><p>{annulation}</p></div>
      </div>
      <div className="tcf-reassure-item">
        <span className="tcf-reassure-ico" aria-hidden="true">📍</span>
        <div>
          <strong>Accès au lieu</strong>
          <p>99 rue du Faubourg Boutonnet, 34090 Montpellier. Code d’accès &amp; Wi-Fi envoyés par e-mail juste après le paiement.</p>
        </div>
      </div>
      <div className="tcf-reassure-item">
        <span className="tcf-reassure-ico" aria-hidden="true">💬</span>
        <div>
          <strong>Une question&nbsp;?</strong>
          <p><a href="mailto:contact@cazalia.fr">contact@cazalia.fr</a> · <a href="tel:+33766211483">07 66 21 14 83</a></p>
        </div>
      </div>
      <div className="tcf-reassure-item">
        <span className="tcf-reassure-ico" aria-hidden="true">🔒</span>
        <div><strong>Paiement sécurisé</strong><p>Carte bancaire via Stripe. Vos données ne sont jamais stockées par Cazalia.</p></div>
      </div>
    </div>
  );
}

// ── Identification inline (connexion / création avec double mot de passe) ─────
// `registerFirst` : met l'inscription en avant (lead) et relègue la connexion en
// lien secondaire. Vrai pour l'abonnement, où l'immense majorité des personnes
// non connectées sont de nouveaux clients : on leur propose la création de compte
// en priorité plutôt que de buter sur un écran de connexion.
function InlineAuth({ onAuthed, registerFirst = false }) {
  const [mode, setMode] = useState('register');
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    password: '', password2: '', cgu: false,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const [touched, setTouched] = useState({});
  const touch = (k) => () => setTouched((t) => ({ ...t, [k]: true }));

  const pwError = form.password ? checkPassword(form.password) : null;
  const matchError = form.password2 && form.password !== form.password2
    ? 'Les deux mots de passe ne correspondent pas.' : null;
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email);

  const canRegister = form.first_name && form.last_name && emailOk && form.phone
    && !pwError && form.password2 && !matchError && form.cgu;
  const canLogin = emailOk && form.password.length > 0;

  const submit = (e) => {
    e.preventDefault();
    if (mode === 'register' ? canRegister : canLogin) {
      onAuthed({ display_name: `${form.first_name} ${form.last_name}`.trim() || form.email, email: form.email });
    } else {
      setTouched({ first_name: true, last_name: true, email: true, phone: true, password: true, password2: true, cgu: true });
    }
  };

  return (
    <div className="card tcf-auth">
      {registerFirst ? (
        /* Abonnement : l'inscription est le chemin principal ; la connexion est
           un simple lien secondaire, pour ne pas freiner les nouveaux clients. */
        <div className="tcf-auth-lead">
          <h3 style={{ margin: 0 }}>
            {mode === 'register' ? 'Créez votre compte pour vous abonner' : 'Connexion à votre espace'}
          </h3>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {mode === 'register'
              ? <>C'est rapide (30 s) et votre formule est conservée. Déjà client&nbsp;? <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); }}>Se connecter</a>.</>
              : <>On reprend votre sélection là où vous en étiez. Pas encore de compte&nbsp;? <a href="#" onClick={(e) => { e.preventDefault(); setMode('register'); }}>Créer un compte</a>.</>}
          </p>
        </div>
      ) : (
        <>
          <div className="tcf-auth-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'register'}
              className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Créer un compte</button>
            <button type="button" role="tab" aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>J'ai déjà un compte</button>
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            {mode === 'register'
              ? 'Un compte en 30 secondes - votre sélection est conservée.'
              : 'Connectez-vous, on reprend votre sélection là où vous en étiez.'}
          </p>
        </>
      )}

      <form onSubmit={submit} noValidate>
        {mode === 'register' && (
          <>
            <div className="row">
              <div className="field">
                <label>Prénom</label>
                <input value={form.first_name} onChange={set('first_name')} onBlur={touch('first_name')} autoComplete="given-name" />
                {touched.first_name && !form.first_name && <small className="tcf-err">Requis.</small>}
              </div>
              <div className="field">
                <label>Nom</label>
                <input value={form.last_name} onChange={set('last_name')} onBlur={touch('last_name')} autoComplete="family-name" />
                {touched.last_name && !form.last_name && <small className="tcf-err">Requis.</small>}
              </div>
            </div>
            <div className="field">
              <label>Téléphone</label>
              <input type="tel" value={form.phone} onChange={set('phone')} onBlur={touch('phone')} autoComplete="tel" placeholder="06 12 34 56 78" />
              {touched.phone && !form.phone && <small className="tcf-err">Requis.</small>}
            </div>
          </>
        )}
        <div className="field">
          <label>E-mail</label>
          <input type="email" value={form.email} onChange={set('email')} onBlur={touch('email')} autoComplete="email" placeholder="nom@exemple.fr" />
          {touched.email && !emailOk && <small className="tcf-err">Adresse e-mail invalide.</small>}
        </div>
        <div className="field">
          <label>Mot de passe</label>
          <PasswordInput value={form.password} onChange={set('password')} onBlur={touch('password')}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'register' && (
            touched.password && pwError
              ? <small className="tcf-err">{pwError}</small>
              : form.password && !pwError
                ? <small className="tcf-ok">✓ Mot de passe robuste</small>
                : <small className="hint">{PASSWORD_RULE}</small>
          )}
        </div>
        {mode === 'register' && (
          <div className="field">
            <label>Confirmer le mot de passe</label>
            <PasswordInput value={form.password2} onChange={set('password2')} onBlur={touch('password2')} autoComplete="new-password" />
            {matchError
              ? <small className="tcf-err">{matchError}</small>
              : form.password2 && !matchError
                ? <small className="tcf-ok">✓ Les mots de passe correspondent</small>
                : null}
          </div>
        )}
        {mode === 'register' && (
          <label className="consent">
            <input type="checkbox" checked={form.cgu} onChange={set('cgu')} />
            <span>J'ai lu et j'accepte les <Link to="/cgu" target="_blank">CGU</Link> et la <Link to="/cgu#confidentialite" target="_blank">politique de confidentialité</Link>.</span>
          </label>
        )}
        <button type="submit" style={{ width: '100%', marginTop: 10 }}
          disabled={mode === 'register' ? !canRegister : !canLogin}>
          {mode === 'register' ? 'Créer mon compte et continuer' : 'Me connecter et continuer'}
        </button>
      </form>
    </div>
  );
}

export default function TestCheckoutFlow() {
  const [product, setProduct] = useState(null);
  const [step, setStep] = useState('produit'); // produit · config · recap · identification · paiement
  const [user, setUser] = useState(null); // null = non connecté (simulé)

  // Sélections par produit
  const [tier, setTier] = useState('CONFORT');
  const [date, setDate] = useState(defaultDate());
  const [osFormule, setOsFormule] = useState('journee');
  const [seats, setSeats] = useState(1);
  const [salleFormule, setSalleFormule] = useState('heure');
  const [startH, setStartH] = useState(9);
  const [endH, setEndH] = useState(11);

  const reset = () => { setProduct(null); setStep('produit'); setUser(null); };

  // ── Calcul du récap courant ────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (product === 'abonnement') {
      const plan = PLANS.find((p) => p.tier === tier);
      return {
        title: `Abonnement ${plan.name}`,
        lines: plan.features,
        recurrence: 'Prélevé chaque mois - sans engagement',
        ttc: plan.price,
        unit: '/ mois',
        inclus: plan.features.map(([k, v]) => `${k} : ${v}`),
      };
    }
    if (product === 'open_space') {
      const f = OPEN_SPACE_FORMULES.find((x) => x.id === osFormule);
      const ttc = f.ttc * seats;
      return {
        title: 'Open Space',
        lines: [['Date', frDate(date)], ['Formule', f.label], ['Horaire', f.horaire], ['Postes', `${seats} poste${seats > 1 ? 's' : ''}`]],
        ttc, unit: '',
        inclus: OPEN_SPACE_INCLUS,
      };
    }
    if (product === 'salle') {
      const f = MEETING_FORMULES.find((x) => x.id === salleFormule);
      const hours = Math.max(1, endH - startH);
      const ttc = f.perHour ? f.ttc * hours : f.ttc;
      const horaire = f.perHour ? `${String(startH).padStart(2, '0')}:00 - ${String(endH).padStart(2, '0')}:00 (${hours} h)` : f.horaire;
      return {
        title: 'Salle de réunion',
        lines: [['Date', frDate(date)], ['Formule', f.label], ['Créneau', horaire], ['Capacité', "jusqu'à 8 personnes"]],
        ttc, unit: '',
        inclus: MEETING_INCLUS,
      };
    }
    return null;
  }, [product, tier, date, osFormule, seats, salleFormule, startH, endH]);

  const ht = summary ? htFromTtc(summary.ttc) : 0;
  const tva = summary ? summary.ttc - ht : 0;

  // Étapes affichées dans la barre de progression (identification masquée si connecté).
  const steps = useMemo(() => {
    const base = [['config', 'Votre sélection'], ['recap', 'Récapitulatif']];
    if (!user) base.push(['identification', 'Identification']);
    base.push(['paiement', 'Paiement']);
    return base;
  }, [user]);
  const stepIndex = steps.findIndex(([id]) => id === step);

  // Après le récap : si connecté → paiement, sinon → identification.
  const afterRecap = () => setStep(user ? 'paiement' : 'identification');
  const onAuthed = (u) => { setUser(u); setStep('paiement'); };

  return (
    <div className="tcf-root">
      <TcfStyles />

      <div className="tcf-banner">
        🧪 <strong>Maquette isolée</strong> - parcours d'achat unifié. Aucune donnée réelle, aucun paiement.
        <button className="tcf-banner-reset" onClick={reset}>Recommencer</button>
      </div>

      {/* Barre de progression (sauf écran de choix du produit) */}
      {step !== 'produit' && (
        <ol className="tcf-steps">
          {steps.map(([id, label], i) => (
            <li key={id} className={i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''}>
              <span className="tcf-step-num">{i < stepIndex ? '✓' : i + 1}</span>
              <span className="tcf-step-label">{label}</span>
            </li>
          ))}
        </ol>
      )}

      {/* ── Étape 0 : choix du produit ─────────────────────────────────────── */}
      {step === 'produit' && (
        <div className="tcf-hero">
          <h1>Que souhaitez-vous réserver&nbsp;?</h1>
          <p className="lead">Un seul tunnel, chaleureux et transparent, pour tous nos produits.</p>
          <div className="tcf-product-grid">
            {PRODUCTS.map((p) => (
              <button key={p.id} className="tcf-product-card" onClick={() => { setProduct(p.id); setStep('config'); }}>
                <span className="tcf-product-ico" aria-hidden="true">{p.icon}</span>
                <strong>{p.label}</strong>
                <span className="muted">{p.sub}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Étapes avec panier latéral ─────────────────────────────────────── */}
      {step !== 'produit' && summary && (
        <div className="tcf-layout">
          <div className="tcf-main">

            {/* Étape 1 : configuration */}
            {step === 'config' && (
              <div className="card">
                <h2 style={{ marginTop: 0 }}>Votre sélection</h2>

                {product === 'abonnement' && (
                  <div className="tcf-plan-grid">
                    {PLANS.map((p) => (
                      <button key={p.tier} type="button"
                        className={`tcf-plan ${tier === p.tier ? 'sel' : ''} ${p.popular ? 'pop' : ''}`}
                        onClick={() => setTier(p.tier)}>
                        {p.popular && <span className="tcf-plan-badge">Le plus choisi</span>}
                        <strong className="tcf-plan-name">{p.name}</strong>
                        <span className="tcf-plan-price">{eur(p.price)}<small> / mois</small></span>
                        <span className="muted tcf-plan-tag">{p.tagline}</span>
                        <ul>{p.features.map(([k, v]) => <li key={k}><strong>{k} :</strong> {v}</li>)}</ul>
                        <span className={`tcf-radio ${tier === p.tier ? 'on' : ''}`}>{tier === p.tier ? '✓ Sélectionné' : 'Choisir'}</span>
                      </button>
                    ))}
                  </div>
                )}

                {product === 'open_space' && (
                  <>
                    <div className="field"><label>Jour</label>
                      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                    <div className="field"><label>Formule</label>
                      <div className="tcf-opts">
                        {OPEN_SPACE_FORMULES.map((f) => (
                          <button key={f.id} type="button" className={`tcf-opt ${osFormule === f.id ? 'sel' : ''}`} onClick={() => setOsFormule(f.id)}>
                            <strong>{f.label}</strong><span className="muted">{f.horaire}</span><span className="tcf-opt-price">{eur(f.ttc)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field" style={{ maxWidth: 180 }}><label>Nombre de postes</label>
                      <input type="number" min={1} max={10} value={seats} onChange={(e) => setSeats(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} /></div>
                  </>
                )}

                {product === 'salle' && (
                  <>
                    <div className="field"><label>Jour</label>
                      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                    <div className="field"><label>Formule</label>
                      <div className="tcf-opts">
                        {MEETING_FORMULES.map((f) => (
                          <button key={f.id} type="button" className={`tcf-opt ${salleFormule === f.id ? 'sel' : ''}`} onClick={() => setSalleFormule(f.id)}>
                            <strong>{f.label}</strong><span className="muted">{f.horaire}</span>
                            <span className="tcf-opt-price">{eur(f.ttc)}{f.perHour ? ' / h' : ''}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {salleFormule === 'heure' && (
                      <div className="row">
                        <div className="field"><label>Début</label>
                          <select value={startH} onChange={(e) => { const v = Number(e.target.value); setStartH(v); if (endH <= v) setEndH(v + 1); }}>
                            {Array.from({ length: 11 }, (_, i) => 8 + i).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                          </select></div>
                        <div className="field"><label>Fin</label>
                          <select value={endH} onChange={(e) => setEndH(Number(e.target.value))}>
                            {Array.from({ length: 12 }, (_, i) => 9 + i).filter((h) => h > startH).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                          </select></div>
                      </div>
                    )}
                  </>
                )}

                <div className="tcf-actions">
                  <button className="outline" onClick={() => setStep('produit')}>← Changer de produit</button>
                  <button onClick={() => setStep('recap')}>Continuer →</button>
                </div>
              </div>
            )}

            {/* Étape 2 : récapitulatif engageant + réassurance */}
            {step === 'recap' && (
              <div className="card">
                <h2 style={{ marginTop: 0 }}>On y est presque&nbsp;!</h2>
                <p className="muted" style={{ marginTop: -4 }}>Vérifiez votre {product === 'abonnement' ? 'formule' : 'réservation'} avant de continuer.</p>

                <div className="tcf-recap">
                  <div className="tcf-recap-head">
                    <strong>{summary.title}</strong>
                    <span>{eur(summary.ttc)} <small>{summary.unit}</small></span>
                  </div>
                  <dl className="tcf-recap-lines">
                    {summary.lines.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
                  </dl>
                  {summary.recurrence && <p className="tcf-recap-rec">🔁 {summary.recurrence}</p>}
                  <div className="tcf-inclus">
                    <span className="tcf-inclus-title">Inclus</span>
                    <ul>{summary.inclus.map((x) => <li key={x}>✓ {x}</li>)}</ul>
                  </div>
                </div>

                <ReservationNotice
                  variant={product === 'abonnement' ? 'abonnement' : product === 'salle' ? 'salle' : 'open_space'}
                  style={{ marginTop: 16 }}
                />

                <h3 style={{ margin: '22px 0 6px' }}>En toute sérénité</h3>
                <Reassurance product={product} />

                <div className="tcf-actions">
                  <button className="outline" onClick={() => setStep('config')}>← Modifier</button>
                  <button onClick={afterRecap}>{user ? 'Aller au paiement →' : 'Continuer →'}</button>
                </div>
              </div>
            )}

            {/* Étape 3 : identification inline (si non connecté) */}
            {step === 'identification' && (
              <div>
                <div className="card tcf-keep">
                  ✓ Votre sélection <strong>{summary.title}</strong> à <strong>{eur(summary.ttc)}{summary.unit ? ` ${summary.unit}` : ''}</strong> est conservée.
                </div>
                <InlineAuth onAuthed={onAuthed} registerFirst={product === 'abonnement'} />
                <p className="tcf-actions" style={{ justifyContent: 'flex-start' }}>
                  <button className="outline" onClick={() => setStep('recap')}>← Revenir au récapitulatif</button>
                </p>
              </div>
            )}

            {/* Étape 4 : paiement (simulation) */}
            {step === 'paiement' && (
              <div className="card">
                <h2 style={{ marginTop: 0 }}>Paiement</h2>
                {user && <p className="muted">Connecté·e en tant que <strong>{user.display_name}</strong>.</p>}
                <div className="tcf-pay-sim">
                  <span className="tcf-pay-ico" aria-hidden="true">💳</span>
                  <div>
                    <strong>Simulation - aucune redirection Stripe réelle.</strong>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      En production, ce bouton appellerait {product === 'abonnement' ? <code>/api/subscriptions/checkout</code> : <code>/api/cart/checkout</code>} puis
                      redirigerait vers Stripe Checkout pour {eur(summary.ttc)}{summary.unit ? ` ${summary.unit}` : ''}.
                    </p>
                  </div>
                </div>
                <label className="consent" style={{ marginTop: 14 }}>
                  <input type="checkbox" defaultChecked />
                  <span>J'accepte les <Link to="/cgv" target="_blank">CGV</Link>{product !== 'abonnement' && <> et renonce à mon droit de rétractation pour une prestation exécutée immédiatement</>}.</span>
                </label>
                <button style={{ width: '100%', marginTop: 12 }} onClick={() => setStep('fin')}>
                  {product === 'abonnement' ? `Souscrire - ${eur(summary.ttc)} / mois` : `Payer ${eur(summary.ttc)}`}
                </button>
              </div>
            )}

            {step === 'fin' && (
              <div className="card tcf-done">
                <div className="tcf-done-ico">🎉</div>
                <h2>C'est tout bon&nbsp;!</h2>
                <p className="muted">
                  {product === 'abonnement'
                    ? `Votre abonnement ${summary.title.replace('Abonnement ', '')} serait actif. `
                    : `Votre réservation ${summary.title} serait confirmée. `}
                  (Simulation - rien n'a été prélevé.)
                </p>
                <button onClick={reset}>Tester un autre parcours</button>
              </div>
            )}
          </div>

          {/* Panier latéral persistant */}
          <aside className="tcf-aside">
            <div className="card tcf-cart">
              <h3>Votre panier</h3>
              <div className="tcf-cart-line"><span>{summary.title}</span><span>{eur(summary.ttc)}{summary.unit}</span></div>
              <div className="tcf-cart-detail">
                {summary.lines.slice(0, 3).map(([k, v]) => <div key={k}><span>{k}</span><span>{v}</span></div>)}
              </div>
              <div className="tcf-cart-split">
                <div><span>Dont HT</span><span>{eur(ht)}</span></div>
                <div><span>TVA ({Math.round(TVA * 100)} %)</span><span>{eur(tva)}</span></div>
              </div>
              <div className="tcf-cart-total">
                <span>Total {summary.unit ? summary.unit.replace('/', 'par') : 'TTC'}</span>
                <strong>{eur(summary.ttc)}</strong>
              </div>
              {product === 'abonnement'
                ? <p className="muted tcf-cart-note">Sans engagement · résiliable à tout moment.</p>
                : <p className="muted tcf-cart-note">☕ Café &amp; thé inclus · annulation gratuite 24 h avant.</p>}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

// Styles scopés au prototype (injectés dans la page, aucune modif de styles.css).
function TcfStyles() {
  return (
    <style>{`
.tcf-root { max-width: 100%; margin: 0 auto; }
.tcf-banner { display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:rgba(180,83,9,.1); border:1px solid rgba(180,83,9,.3); color:var(--amber); padding:10px 14px; border-radius:12px; font-size:14px; margin-bottom:18px; }
.tcf-banner-reset { margin-left:auto; background:transparent; border:1px solid currentColor; color:inherit; padding:4px 10px; font-size:13px; }
.tcf-steps { display:flex; gap:6px; list-style:none; padding:0; margin:0 0 20px; counter-reset:s; flex-wrap:wrap; }
.tcf-steps li { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:14px; padding:6px 12px; border-radius:999px; background:var(--glass); border:1px solid var(--line); }
.tcf-steps li.current { color:var(--navy); border-color:var(--accent); background:rgba(59,130,246,.08); font-weight:700; }
.tcf-steps li.done { color:var(--green); }
.tcf-step-num { display:inline-flex; width:22px; height:22px; align-items:center; justify-content:center; border-radius:50%; background:var(--line); font-size:12px; font-weight:700; }
.tcf-steps li.current .tcf-step-num { background:var(--accent); color:#fff; }
.tcf-steps li.done .tcf-step-num { background:var(--green); color:#fff; }
.tcf-hero { text-align:center; padding:20px 0; }
.tcf-hero h1 { margin:0 0 6px; }
.tcf-product-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-top:28px; }
.tcf-product-card { display:flex; flex-direction:column; align-items:center; gap:6px; padding:28px 16px; border-radius:var(--radius); border:1px solid var(--line); background:var(--glass-strong); cursor:pointer; transition:.15s; text-align:center; color:var(--ink); }
.tcf-product-card:hover { border-color:var(--accent); transform:translateY(-3px); box-shadow:var(--glass-shadow); }
.tcf-product-ico { font-size:34px; }
.tcf-product-card strong { font-size:18px; color:var(--ink); }
.tcf-layout { display:grid; grid-template-columns:1fr 320px; gap:22px; align-items:start; }
.tcf-main { min-width:0; }
.tcf-actions { display:flex; justify-content:space-between; gap:10px; margin-top:22px; }
.tcf-plan-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.tcf-plan { position:relative; text-align:left; display:flex; flex-direction:column; gap:4px; padding:16px; border-radius:14px; border:1.5px solid var(--line); background:#fff; cursor:pointer; color:var(--ink); }
.tcf-plan.sel { border-color:var(--accent); box-shadow:0 0 0 3px rgba(59,130,246,.15); }
.tcf-plan.pop { border-color:var(--accent-2); }
.tcf-plan-badge { position:absolute; top:-10px; right:12px; background:var(--accent-2); color:#fff; font-size:11px; padding:3px 8px; border-radius:999px; }
.tcf-plan-name { font-size:17px; }
.tcf-plan-price { font-size:22px; font-weight:800; color:var(--navy); }
.tcf-plan-price small { font-size:12px; font-weight:500; color:var(--muted); }
.tcf-plan-tag { font-size:13px; }
.tcf-plan ul { list-style:none; padding:0; margin:8px 0; font-size:13px; display:flex; flex-direction:column; gap:3px; color:var(--ink); }
.tcf-plan ul li strong { color:var(--navy); }
.tcf-radio { margin-top:auto; font-size:13px; font-weight:700; color:var(--muted); padding-top:8px; }
.tcf-radio.on { color:var(--accent); }
.tcf-opts { display:flex; flex-direction:column; gap:8px; }
.tcf-opt { display:flex; align-items:center; gap:10px; text-align:left; padding:12px 14px; border-radius:12px; border:1.5px solid var(--line); background:#fff; cursor:pointer; color:var(--ink); }
.tcf-opt.sel { border-color:var(--accent); box-shadow:0 0 0 3px rgba(59,130,246,.12); }
.tcf-opt strong { flex:0 0 auto; }
.tcf-opt .muted { flex:1; font-size:13px; }
.tcf-opt-price { font-weight:800; color:var(--navy); }
.tcf-recap { border:1px solid var(--line); border-radius:14px; overflow:hidden; }
.tcf-recap-head { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; background:var(--navy); color:#fff; }
.tcf-recap-head span { font-size:20px; font-weight:800; }
.tcf-recap-head small { font-size:12px; font-weight:500; opacity:.8; }
.tcf-recap-lines { margin:0; padding:12px 16px; display:flex; flex-direction:column; gap:8px; }
.tcf-recap-lines > div { display:flex; justify-content:space-between; gap:12px; font-size:14px; }
.tcf-recap-lines dt { color:var(--muted); margin:0; }
.tcf-recap-lines dd { margin:0; font-weight:600; text-align:right; }
.tcf-recap-rec { margin:0; padding:10px 16px; background:rgba(59,130,246,.07); color:var(--navy); font-size:13px; font-weight:600; }
.tcf-inclus { padding:12px 16px; border-top:1px solid var(--line); }
.tcf-inclus-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.tcf-inclus ul { list-style:none; padding:0; margin:8px 0 0; display:grid; grid-template-columns:1fr 1fr; gap:4px; font-size:14px; color:var(--green); }
.tcf-reassure { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.tcf-reassure-item { display:flex; gap:10px; align-items:flex-start; }
.tcf-reassure-ico { font-size:20px; flex:0 0 auto; }
.tcf-reassure-item strong { display:block; font-size:14px; }
.tcf-reassure-item p { margin:2px 0 0; font-size:13px; color:var(--muted); line-height:1.5; }
.tcf-keep { background:rgba(21,128,61,.08); border-color:rgba(21,128,61,.3); color:var(--green); margin-bottom:14px; }
.tcf-auth-tabs { display:flex; gap:6px; margin-bottom:6px; }
.tcf-auth-tabs button { flex:1; background:var(--glass); border:1px solid var(--line); color:var(--muted); padding:10px; border-radius:10px; font-weight:600; }
.tcf-auth-tabs button.active { background:var(--navy); color:#fff; border-color:var(--navy); }
.tcf-err { color:var(--red); font-size:12.5px; }
.tcf-ok { color:var(--green); font-size:12.5px; }
.tcf-pay-sim { display:flex; gap:12px; align-items:flex-start; padding:16px; border:1px dashed var(--accent); border-radius:12px; background:rgba(59,130,246,.05); }
.tcf-pay-ico { font-size:26px; }
.tcf-pay-sim code { background:rgba(28,49,85,.08); padding:1px 5px; border-radius:5px; font-size:12px; }
.tcf-done { text-align:center; padding:40px 20px; }
.tcf-done-ico { font-size:54px; }
.tcf-aside { position:sticky; top:16px; }
.tcf-cart h3 { margin:0 0 12px; }
.tcf-cart-line { display:flex; justify-content:space-between; font-weight:700; font-size:16px; }
.tcf-cart-detail { margin:10px 0; display:flex; flex-direction:column; gap:5px; font-size:13px; color:var(--muted); }
.tcf-cart-detail > div { display:flex; justify-content:space-between; gap:10px; }
.tcf-cart-detail > div span:last-child { color:var(--ink); text-align:right; }
.tcf-cart-split { border-top:1px solid var(--line); padding-top:10px; display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted); }
.tcf-cart-split > div { display:flex; justify-content:space-between; }
.tcf-cart-total { display:flex; justify-content:space-between; align-items:baseline; border-top:1px solid var(--line); margin-top:10px; padding-top:10px; font-size:15px; }
.tcf-cart-total strong { font-size:20px; color:var(--navy); }
.tcf-cart-note { font-size:12px; margin:10px 0 0; }
@media (max-width:860px) {
  .tcf-layout { grid-template-columns:1fr; }
  .tcf-aside { position:static; order:-1; }
  .tcf-product-grid, .tcf-plan-grid, .tcf-reassure, .tcf-inclus ul { grid-template-columns:1fr; }
}
`}</style>
  );
}
