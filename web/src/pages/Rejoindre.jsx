import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, msg } from '../api.js';
import BackLink from '../components/BackLink.jsx';

const ACTIVITIES = [
  ['independant', 'Indépendant·e / freelance'],
  ['salarie_teletravail', 'Salarié·e en télétravail'],
  ['etudiant', 'Étudiant·e'],
  ['entreprise', 'Entreprise / plusieurs postes'],
  ['autre', 'Autre'],
];

// Provenance éventuelle passée dans l'URL (?src=flyer, ?src=insta…).
function readSource() {
  try {
    return new URLSearchParams(window.location.search).get('src') || null;
  } catch {
    return null;
  }
}

export default function Rejoindre() {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', activity: '', consent: false, website: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.consent) { setError(msg('CONSENTEMENT_REQUIS')); return; }
    setBusy(true);
    try {
      await api.post('/leads', {
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        phone: form.phone,
        activity: form.activity || null,
        consent: true,
        website: form.website, // honeypot (doit rester vide)
        source: readSource(),
      });
      setDone(true);
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-wrap" style={{ maxWidth: 540 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <img src="/images/logo-cazalia.svg" className="login-logo" alt="CAZALIA — Coworking Boutonnet" />
          <h1 style={{ marginTop: 4 }}>Merci, c'est noté&nbsp;!</h1>
          <p className="subtitle" style={{ marginBottom: 6 }}>
            On garde vos coordonnées précieusement. Dès l'ouverture, on vous contacte pour vous offrir
            votre journée découverte gratuite chez CAZALIA.
          </p>
          <p className="muted" style={{ fontSize: 14 }}>À très vite&nbsp;!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap" style={{ maxWidth: 540 }}>
      <div className="card">
        <BackLink to="/" label="Retour à l'accueil" />
        <img src="/images/logo-cazalia.svg" className="login-logo" alt="CAZALIA — Coworking Boutonnet" />
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <span className="eyebrow">Ouverture prochaine</span>
        </div>
        <h1 style={{ textAlign: 'center' }}>Rejoignez la liste</h1>
        <p className="subtitle" style={{ textAlign: 'center' }}>
          Laissez-nous vos coordonnées&nbsp;: on vous prévient dès l'ouverture et on vous offre une
          journée découverte gratuite pour tester les espaces.
        </p>

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

          <label className="consent">
            <input type="checkbox" checked={form.consent} onChange={set('consent')} />
            <span>
              J'accepte d'être recontacté·e par CAZALIA au sujet de l'ouverture et de la journée
              découverte. Vos données ne servent qu'à cela et ne sont jamais transmises à des tiers
              (voir les <Link to="/cgu#confidentialite">CGU &amp; confidentialité</Link>).
            </span>
          </label>

          {error && <div className="alert error">{error}</div>}
          <button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? '…' : 'Je m’inscris'}
          </button>
        </form>
      </div>
    </div>
  );
}
