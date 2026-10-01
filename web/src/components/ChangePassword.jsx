import { useState } from 'react';
import { api, msg } from '../api.js';
import PasswordInput from './PasswordInput.jsx';
import { checkPassword, PASSWORD_RULE } from '../password.js';

// Bloc « changer mon mot de passe » — utilisable par tout utilisateur (admin inclus).
// `forced` : 1re connexion (libellés adaptés). `onDone` : appelé après succès.
export default function ChangePassword({ forced = false, onDone }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setFeedback(null);
    const faiblesse = checkPassword(form.next);
    if (faiblesse) return setFeedback({ type: 'error', text: faiblesse });
    if (form.next !== form.confirm) {
      return setFeedback({ type: 'error', text: 'La confirmation ne correspond pas.' });
    }
    setBusy(true);
    try {
      await api.post('/auth/change-password', {
        current_password: form.current,
        new_password: form.next,
      });
      setForm({ current: '', next: '', confirm: '' });
      setFeedback({ type: 'ok', text: 'Mot de passe modifié. Vos autres appareils ont été déconnectés.' });
      onDone?.();
    } catch (err) {
      setFeedback({ type: 'error', text: msg(err.code) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>{forced ? 'Définissez votre mot de passe' : 'Changer mon mot de passe'}</h2>
      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}
      <form onSubmit={submit} style={{ maxWidth: 420 }}>
        <div className="field">
          <label>{forced ? 'Mot de passe actuel (celui qui vous a été communiqué)' : 'Mot de passe actuel'}</label>
          <PasswordInput value={form.current} onChange={set('current')} autoComplete="current-password" required />
        </div>
        <div className="field">
          <label>Nouveau mot de passe</label>
          <PasswordInput value={form.next} onChange={set('next')} autoComplete="new-password" required />
          <small className="hint">{PASSWORD_RULE}</small>
        </div>
        <div className="field">
          <label>Confirmer le nouveau mot de passe</label>
          <PasswordInput value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        </div>
        <button type="submit" disabled={busy}>{busy ? '…' : 'Mettre à jour'}</button>
      </form>
    </div>
  );
}
