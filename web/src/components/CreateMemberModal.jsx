import { useState } from 'react';
import { api, msg } from '../api.js';

// Création d'un compte membre par l'admin (mot de passe par défaut + changement forcé).
export default function CreateMemberModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', role: 'member' });
  const [created, setCreated] = useState(null); // { user, default_password }
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setFeedback(null);
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim()) {
      return setFeedback({ type: 'error', text: 'Tous les champs sont obligatoires.' });
    }
    setBusy(true);
    try {
      const res = await api.post('/admin/users', form);
      setCreated(res);
      onCreated?.(res.user);
    } catch (err) {
      setFeedback({ type: 'error', text: msg(err.code) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>Nouveau membre</h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>

        {created ? (
          <>
            <div className="alert ok">Compte créé pour <strong>{created.user.display_name}</strong>.</div>
            <p>Communiquez-lui ces identifiants. Il devra changer le mot de passe à sa première connexion :</p>
            <table style={{ marginBottom: 16 }}>
              <tbody>
                <tr><td className="muted">Email</td><td><strong>{created.user.email}</strong></td></tr>
                <tr><td className="muted">Mot de passe provisoire</td><td><strong>{created.default_password}</strong></td></tr>
              </tbody>
            </table>
            <button onClick={onClose}>Fermer</button>
          </>
        ) : (
          <>
            {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}
            <form onSubmit={submit}>
              <div className="row">
                <div className="field"><label>Prénom</label><input value={form.first_name} onChange={set('first_name')} required /></div>
                <div className="field"><label>Nom</label><input value={form.last_name} onChange={set('last_name')} required /></div>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} required /></div>
                <div className="field"><label>Téléphone</label><input type="tel" value={form.phone} onChange={set('phone')} required /></div>
              </div>
              <div className="field" style={{ marginTop: 12, maxWidth: 200 }}>
                <label>Rôle</label>
                <select value={form.role} onChange={set('role')}>
                  <option value="member">Membre</option>
                  <option value="admin">Administrateur</option>
                </select>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                Un mot de passe provisoire sera attribué automatiquement ; l'utilisateur devra le changer à sa première connexion.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" disabled={busy}>{busy ? '…' : 'Créer le compte'}</button>
                <button type="button" className="outline" onClick={onClose}>Annuler</button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
