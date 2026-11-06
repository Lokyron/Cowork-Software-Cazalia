import { useState } from 'react';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';

// Modale « Demander un devis » pour le Bureau Privé longue durée.
// Enregistre un prospect (source 'devis_bureau_prive') et notifie la gérante par
// e-mail. Pré-remplie depuis le compte connecté le cas échéant.
export default function DevisModal({ onClose }) {
  const { user } = useAuth();
  // Scinde "Prénom Nom" si disponible pour pré-remplir les deux champs.
  const [fn = '', ...rest] = (user?.display_name || '').trim().split(' ');
  const [form, setForm] = useState({
    first_name: user?.first_name || fn || '',
    last_name: user?.last_name || rest.join(' ') || '',
    email: user?.email || '',
    phone: user?.phone || '',
    message: '',
    consent: false,
    website: '', // honeypot
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [done, setDone] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setFeedback(null);
    try {
      await api.post('/leads', { ...form, source: 'devis_bureau_prive' });
      setDone(true);
    } catch (err) {
      setFeedback(msg(err.code));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 100%)' }}>
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Demander un devis</h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>

        {done ? (
          <div className="alert ok">
            Merci ! Votre demande de devis pour le <strong>Bureau Privé longue durée</strong> a bien été envoyée.
            Nous vous recontacterons très vite.
            <div style={{ marginTop: 12 }}><button onClick={onClose}>Fermer</button></div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0 }}>
              Bureau privatisé, contrat longue durée personnalisé. Laissez-nous vos coordonnées :
            </p>
            {feedback && <div className="alert error">{feedback}</div>}
            <div className="row">
              <div className="field"><label>Prénom</label><input value={form.first_name} onChange={set('first_name')} required /></div>
              <div className="field"><label>Nom</label><input value={form.last_name} onChange={set('last_name')} required /></div>
            </div>
            <div className="field"><label>E-mail</label><input type="email" value={form.email} onChange={set('email')} required /></div>
            <div className="field"><label>Téléphone</label><input type="tel" value={form.phone} onChange={set('phone')} placeholder="06 12 34 56 78" required /></div>
            <div className="field"><label>Votre projet <span className="muted" style={{ fontWeight: 400 }}>(facultatif)</span></label>
              <textarea rows={3} value={form.message} onChange={set('message')} placeholder="Nombre de postes, durée souhaitée…" />
            </div>
            {/* Honeypot anti-robot : invisible pour un humain. */}
            <input type="text" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off"
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }} aria-hidden="true" />
            <label className="consent">
              <input type="checkbox" checked={form.consent} onChange={set('consent')} required />
              <span>J'accepte d'être recontacté(e) au sujet de ma demande.</span>
            </label>
            <button type="submit" disabled={busy} style={{ marginTop: 12, width: '100%' }}>
              {busy ? 'Envoi…' : 'Envoyer ma demande'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
