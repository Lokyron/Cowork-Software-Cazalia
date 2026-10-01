import { useState } from 'react';
import { api } from '../api.js';
import BackLink from '../components/BackLink.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    // Réponse volontairement identique quel que soit le compte (anti-énumération).
    try { await api.post('/auth/forgot-password', { email }); } catch { /* ignore */ }
    setSent(true); setBusy(false);
  };

  return (
    <div className="auth-wrap">
      <div className="card">
        <BackLink to="/login" label="Retour à la connexion" />
        <h1 style={{ marginTop: 8 }}>Mot de passe oublié</h1>
        {sent ? (
          <div className="alert ok">
            Si un compte est associé à cette adresse, un e-mail de réinitialisation vient d'être envoyé.
            Pensez à vérifier vos spams.
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              Indiquez votre adresse e-mail : nous vous enverrons un lien pour choisir un nouveau mot de passe.
            </p>
            <div className="field">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
            </div>
            <button type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? '…' : 'Envoyer le lien'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
