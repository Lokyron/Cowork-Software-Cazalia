import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import Avatar from '../components/Avatar.jsx';
import ChangePassword from '../components/ChangePassword.jsx';
import TwoFactor from '../components/TwoFactor.jsx';
import DangerDelete from '../components/DangerDelete.jsx';

export default function AccountSettings() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/auth/profile').then((r) => setP(r.profile)).catch(() => {}); }, []);

  const set = (k) => (e) => setP((cur) => ({ ...cur, [k]: e.target.value }));
  const setBool = (k) => (e) => setP((cur) => ({ ...cur, [k]: e.target.checked }));

  const save = async () => {
    setBusy(true); setFeedback(null);
    try {
      const r = await api.patch('/auth/me', {
        first_name: p.first_name, last_name: p.last_name, email: p.email, phone: p.phone,
        company_name: p.company_name, vat_number: p.vat_number, billing_address: p.billing_address,
        notify_booking: p.notify_booking, notify_marketing: p.notify_marketing,
      });
      setP(r.profile);
      await refresh();
      setFeedback({ type: 'ok', text: 'Modifications enregistrées.' });
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    finally { setBusy(false); }
  };

  if (!p) return <p className="muted">Chargement…</p>;
  const fullName = `${p.first_name || ''} ${p.last_name || ''}`.trim();

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 4 }}>
        <div className="flex" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Avatar name={fullName} size={52} />
          <div>
            <h1 style={{ margin: 0 }}>Mon compte</h1>
            <p className="subtitle" style={{ margin: 0 }}>{p.email}</p>
          </div>
        </div>
      </div>

      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      {/* INFOS PERSONNELLES */}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Informations personnelles</h2>
        <div className="row">
          <div className="field"><label>Prénom</label><input value={p.first_name || ''} onChange={set('first_name')} /></div>
          <div className="field"><label>Nom</label><input value={p.last_name || ''} onChange={set('last_name')} /></div>
        </div>
        <div className="row">
          <div className="field"><label>E-mail</label><input type="email" value={p.email || ''} onChange={set('email')} /></div>
          <div className="field"><label>Téléphone</label><input value={p.phone || ''} onChange={set('phone')} /></div>
        </div>
      </div>

      {/* FACTURATION */}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Facturation & entreprise</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>Optionnel — utilisé sur vos reçus et factures.</p>
        <div className="row">
          <div className="field"><label>Raison sociale</label><input value={p.company_name || ''} onChange={set('company_name')} placeholder="Nom de l'entreprise" /></div>
          <div className="field"><label>N° TVA intracommunautaire</label><input value={p.vat_number || ''} onChange={set('vat_number')} placeholder="FR..." /></div>
        </div>
        <div className="field"><label>Adresse de facturation</label>
          <textarea rows={3} value={p.billing_address || ''} onChange={set('billing_address')} placeholder="Adresse complète" />
        </div>
      </div>

      {/* PRÉFÉRENCES */}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Préférences de notification</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!p.notify_booking} onChange={setBool('notify_booking')} />
          Recevoir les e-mails liés à mes réservations (confirmation, modification, annulation)
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!p.notify_marketing} onChange={setBool('notify_marketing')} />
          Recevoir les actualités et offres de Cazalia
        </label>
      </div>

      <div style={{ marginTop: 16 }}>
        <button onClick={save} disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer les modifications'}</button>
      </div>

      {/* SÉCURITÉ */}
      <h2 style={{ marginTop: 28 }}>Sécurité</h2>
      <div style={{ marginTop: 8 }}><ChangePassword /></div>
      <div style={{ marginTop: 16 }}><TwoFactor /></div>

      <div style={{ marginTop: 24 }}>
        <DangerDelete
          title="Supprimer mon compte"
          warning="Cette action est définitive et irréversible. Tous vos crédits non utilisés seront perdus, ainsi que vos réservations et votre historique."
          buttonLabel="Supprimer définitivement mon compte"
          onConfirm={async () => { await api.del('/auth/me', { confirm: 'SUPPRIMER' }); await refresh(); navigate('/'); }}
        />
      </div>
    </div>
  );
}
