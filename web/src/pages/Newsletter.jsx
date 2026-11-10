import { useState } from 'react';
import { api, msg } from '../api.js';
import BackLink from '../components/BackLink.jsx';

// Inscription publique à la newsletter. Le contact est ajouté à la liste Brevo
// configurée en admin. Les membres connectés gèrent plutôt leur abonnement
// depuis « Mon compte » (case à cocher), mais cette page reste accessible à tous.
export default function Newsletter() {
  const [form, setForm] = useState({ email: '', first_name: '', consent: false, website: '' });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.consent) { setError('Merci de confirmer votre consentement.'); return; }
    setBusy(true);
    try {
      await api.post('/newsletter/subscribe', {
        email: form.email.trim(), first_name: form.first_name.trim(), consent: true, website: form.website,
      });
      setSent(true);
    } catch (err) {
      setError(err.code === 'NEWSLETTER_INDISPONIBLE'
        ? "L'inscription à la newsletter est momentanément indisponible. Merci de réessayer plus tard."
        : msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card">
        <BackLink to="/" label="Retour à l'accueil" />
        <h1 style={{ marginTop: 8 }}>Newsletter Cazalia</h1>
        {sent ? (
          <div className="alert ok">
            Merci&nbsp;! Votre inscription est prise en compte. Vous pourrez vous désinscrire à tout moment
            (lien en bas de chaque e-mail, ou depuis votre espace « Mon compte » si vous êtes membre).
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              Recevez les actualités et les offres de Cazalia. Pas de spam, désinscription en un clic.
            </p>
            <div className="field">
              <label>Prénom <span className="muted" style={{ fontWeight: 400 }}>(facultatif)</span></label>
              <input value={form.first_name} onChange={set('first_name')} autoComplete="given-name" maxLength={80} />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required autoFocus />
            </div>
            {/* Champ piège anti-robots : masqué, laissé vide par un humain. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-5000px' }}>
              <label>Ne pas remplir<input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} /></label>
            </div>
            <label className="consent" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '12px 0' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={form.consent} onChange={set('consent')} />
              <span style={{ fontSize: 14 }}>
                J'accepte de recevoir la newsletter de Cazalia et le traitement de mon e-mail à cette fin.
              </span>
            </label>
            {error && <div className="alert error">{error}</div>}
            <button type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? '…' : "S'inscrire"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
