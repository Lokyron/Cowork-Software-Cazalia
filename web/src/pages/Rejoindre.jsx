import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { msg } from '../api.js';
import PasswordInput from '../components/PasswordInput.jsx';
import BackLink from '../components/BackLink.jsx';
import { checkPassword, PASSWORD_RULE } from '../password.js';

const ACTIVITIES = [
  ['independant', 'Indépendant·e / freelance'],
  ['salarie_teletravail', 'Salarié·e en télétravail'],
  ['etudiant', 'Étudiant·e'],
  ['entreprise', 'Entreprise / plusieurs postes'],
  ['autre', 'Autre'],
];

// Code promo offert à l'inscription. Constante provisoire : le code définitif
// (créé côté admin, cf. /admin/codes-promo) sera branché ici ultérieurement.
const PROMO_CODE = 'JOURNEE-CAZALIA';

export default function Rejoindre() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', activity: '',
    password: '', optin: false, website: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    // Contrôle local du mot de passe avant l'appel réseau (le serveur applique
    // la même politique et reste seul juge).
    const faiblesse = checkPassword(form.password);
    if (faiblesse) { setError(faiblesse); return; }
    setBusy(true);
    try {
      await register({
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        phone: form.phone,
        password: form.password,
        activity: form.activity || null,
        // La création de compte vaut acceptation des CGU (mention affichée sous
        // le bouton). La case cochable ne pilote que l'opt-in marketing.
        cgu_accepted: true,
        notify_marketing: form.optin,
      });
      setDone(true); // register a connecté l'utilisateur (session posée) → vue confirmation
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(PROMO_CODE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* presse-papier indisponible : on ignore */ }
  };

  // ── Vue de confirmation (après inscription, utilisateur déjà connecté) ───────
  if (done) {
    return (
      <div className="auth-wrap" style={{ maxWidth: 540 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <img src="/images/logo-cazalia.svg" className="login-logo" alt="CAZALIA — Coworking Boutonnet" />
          <h1 style={{ marginTop: 4 }}>Bienvenue chez Cazalia&nbsp;! 🎉</h1>
          <p className="subtitle">
            Votre compte est créé. Voici votre code pour profiter de votre journée découverte offerte.
          </p>

          <div className="voucher" style={{ textAlign: 'left', marginTop: 8 }}>
            <div className="voucher-label">Votre code promo</div>
            <div className="voucher-row">
              <code className="voucher-code">{PROMO_CODE}</code>
              <button type="button" className="outline small" onClick={copyCode}>
                {copied ? '✓ Copié' : 'Copier'}
              </button>
            </div>
          </div>

          <p className="muted" style={{ fontSize: 14, textAlign: 'left', lineHeight: 1.6 }}>
            Pour l'utiliser, réservez comme d'habitude&nbsp;: choisissez la <strong>formule Journée</strong>,
            puis saisissez ce code dans le champ <em>Code promo</em> du panier avant de payer, pour que la
            journée soit offerte. Ce code est valable <strong>uniquement sur la formule Journée</strong> —
            les formules à l'heure et à la demi-journée n'y donnent pas droit.
          </p>

          <button type="button" style={{ width: '100%', marginTop: 8 }} onClick={() => navigate('/mon-espace')}>
            Accéder à mon espace
          </button>
        </div>
      </div>
    );
  }

  // ── Vue formulaire ───────────────────────────────────────────────────────────
  return (
    <div className="auth-wrap" style={{ maxWidth: 540 }}>
      <div className="card">
        <BackLink to="/" label="Retour à l'accueil" />
        <img src="/images/logo-cazalia.svg" className="login-logo" alt="CAZALIA — Coworking Boutonnet" />
        <h1 style={{ textAlign: 'center' }}>Rejoignez Cazalia. Nous vous offrons une journée gratuite.</h1>
        <p className="subtitle" style={{ textAlign: 'center' }}>
          Et si vous changiez d'environnement de travail le temps d'une journée&nbsp;? Inscrivez-vous
          gratuitement et profitez d'une journée offerte pour découvrir notre open space.
        </p>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <span className="badge green">100&nbsp;% gratuit et sans engagement</span>
        </div>

        <form onSubmit={submit}>
          <div className="row">
            <div className="field">
              <label>Prénom</label>
              <input value={form.first_name} onChange={set('first_name')} autoComplete="given-name" required />
            </div>
            <div className="field">
              <label>Nom</label>
              <input value={form.last_name} onChange={set('last_name')} autoComplete="family-name" required />
            </div>
          </div>
          <div className="field">
            <label>E-mail</label>
            <input type="email" value={form.email} onChange={set('email')} autoComplete="email" placeholder="nom@exemple.fr" required />
          </div>
          <div className="field">
            <label>Téléphone</label>
            <input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="06 12 34 56 78" required />
          </div>
          <div className="field">
            <label>Vous êtes… <span className="muted" style={{ fontWeight: 400 }}>(facultatif)</span></label>
            <select value={form.activity} onChange={set('activity')}>
              <option value="">— Je préfère ne pas préciser</option>
              {ACTIVITIES.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Mot de passe</label>
            <PasswordInput value={form.password} onChange={set('password')} autoComplete="new-password" required />
            <small className="hint">{PASSWORD_RULE}</small>
          </div>

          {/* Champ piège anti-robot : masqué aux humains, doit rester vide. */}
          <input
            type="text"
            name="website"
            value={form.website}
            onChange={set('website')}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
          />

          <div className="alert ok" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.3 }}>🎁</span>
            <span>
              Votre journée découverte vous attend. Offre valable du <strong>9&nbsp;novembre au
              27&nbsp;novembre 2026</strong>, dans la limite des places disponibles.
            </span>
          </div>

          <label className="consent">
            <input type="checkbox" checked={form.optin} onChange={set('optin')} />
            <span>J'accepte de recevoir des actualités et offres de Cazalia (facultatif)</span>
          </label>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 6 }}>
            En créant un compte, vous acceptez les <Link to="/cgu" target="_blank">CGU</Link> et la{' '}
            <Link to="/cgu#confidentialite" target="_blank">politique de confidentialité</Link>. Vos
            données ne sont jamais transmises à des tiers.
          </p>

          {error && <div className="alert error">{error}</div>}
          <button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? '…' : 'Je crée mon compte et je profite de ma journée offerte'}
          </button>
        </form>
      </div>
    </div>
  );
}
