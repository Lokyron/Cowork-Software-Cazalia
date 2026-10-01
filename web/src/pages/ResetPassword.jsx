import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, msg } from '../api.js';
import PasswordInput from '../components/PasswordInput.jsx';
import BackLink from '../components/BackLink.jsx';
import { checkPassword, PASSWORD_RULE } from '../password.js';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [state, setState] = useState('checking'); // checking | valid | invalid | done
  const [email, setEmail] = useState('');
  const [form, setForm] = useState({ next: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    api.get(`/auth/reset-password/${encodeURIComponent(token)}`)
      .then((r) => { setEmail(r.email); setState('valid'); })
      .catch(() => setState('invalid'));
  }, [token]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const faiblesse = checkPassword(form.next);
    if (faiblesse) return setError(faiblesse);
    if (form.next !== form.confirm) return setError('La confirmation ne correspond pas.');
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, new_password: form.next });
      setState('done');
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card">
        <BackLink to="/" label="Retour à l'accueil" />
        <h1>Réinitialiser le mot de passe</h1>

        {state === 'checking' && <p className="muted">Vérification du lien…</p>}

        {state === 'invalid' && (
          <>
            <div className="alert error">Ce lien est invalide ou expiré.</div>
            <p className="muted" style={{ fontSize: 14 }}>
              Demandez un nouveau lien à l'accueil. <Link to="/login">Retour à la connexion</Link>
            </p>
          </>
        )}

        {state === 'valid' && (
          <>
            <p className="subtitle">Compte : <strong>{email}</strong></p>
            <form onSubmit={submit}>
              <div className="field">
                <label>Nouveau mot de passe</label>
                <PasswordInput value={form.next} onChange={set('next')} autoComplete="new-password" required />
                <small className="hint">{PASSWORD_RULE}</small>
              </div>
              <div className="field">
                <label>Confirmer</label>
                <PasswordInput value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
              </div>
              {error && <div className="alert error">{error}</div>}
              <button type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? '…' : 'Définir le mot de passe'}
              </button>
            </form>
          </>
        )}

        {state === 'done' && (
          <>
            <div className="alert ok">Mot de passe mis à jour. Vous pouvez vous connecter.</div>
            <button style={{ width: '100%' }} onClick={() => navigate('/login')}>Se connecter</button>
          </>
        )}
      </div>
    </div>
  );
}
