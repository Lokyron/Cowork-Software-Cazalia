import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { msg } from '../api.js';
import PasswordInput from '../components/PasswordInput.jsx';
import BackLink from '../components/BackLink.jsx';
import { checkPassword, PASSWORD_RULE } from '../password.js';

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({
    email: '', password: '', first_name: '', last_name: '', phone: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(false); // étape code 2FA
  const [code, setCode] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        const res = await login(form.email, form.password, mfa ? code : undefined);
        if (res?.mfa_required) { setMfa(true); return; } // demande le code
        navigate(res?.user?.role === 'admin' ? '/admin' : '/mon-espace');
        return;
      }
      // Contrôle local avant l'appel réseau : le serveur applique la même
      // politique (`assertStrongPassword`) et reste seul juge.
      const faiblesse = checkPassword(form.password);
      if (faiblesse) { setError(faiblesse); return; }
      await register(form);
      navigate('/mon-espace');
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  const cancelMfa = () => { setMfa(false); setCode(''); setError(null); };

  return (
    <div className="auth-wrap">
      <div className="card">
        <BackLink to="/" label="Retour à l'accueil" />
        <img src="/images/logo-cazalia.svg" className="login-logo" alt="Cazalia" />
        <p className="subtitle" style={{ textAlign: 'center' }}>
          {mfa
            ? 'Vérification en deux étapes.'
            : mode === 'login' ? 'Connexion à votre espace.' : 'Créer un compte membre.'}
        </p>

        {mfa ? (
          <form onSubmit={submit}>
            <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>
              Saisissez le code à 6 chiffres de votre application d'authentification.
            </p>
            <div className="field">
              <label>Code de vérification</label>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                autoFocus
                required
                style={{ letterSpacing: '4px', textAlign: 'center', fontSize: 20 }}
              />
            </div>
            {error && <div className="alert error">{error}</div>}
            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? '…' : 'Vérifier'}
            </button>
            <p className="muted" style={{ marginTop: 14, fontSize: 14, textAlign: 'center' }}>
              <a href="#" onClick={(e) => { e.preventDefault(); cancelMfa(); }}>← Revenir à la connexion</a>
            </p>
          </form>
        ) : (
        <>
        <form onSubmit={submit}>
          {mode === 'register' && (
            <>
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
                <label>Téléphone</label>
                <input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="06 12 34 56 78" required />
              </div>
            </>
          )}
          <div className="field">
            <label>Email</label>
            <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
          </div>
          <div className="field">
            <label>Mot de passe</label>
            <PasswordInput value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
            {mode !== 'login' && <small className="hint">{PASSWORD_RULE}</small>}
          </div>
          {error && <div className="alert error">{error}</div>}
          <button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer le compte'}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16, fontSize: 14 }}>
          {mode === 'login' ? 'Pas encore de compte ? ' : 'Déjà inscrit ? '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setError(null);
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {mode === 'login' ? "S'inscrire" : 'Se connecter'}
          </a>
        </p>
        {mode === 'login' && (
          <p className="muted" style={{ marginTop: 4, fontSize: 14 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); navigate('/mot-de-passe-oublie'); }}>Mot de passe oublié ?</a>
          </p>
        )}
        </>
        )}
      </div>
    </div>
  );
}
