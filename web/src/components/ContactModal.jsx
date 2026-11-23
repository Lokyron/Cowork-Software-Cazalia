import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';

// Sujets proposés (liste fermée, obligatoire).
// ⚠ Dupliquée côté serveur (`LEAD_SUBJECTS` dans server/src/lib/prospects.js), qui
// la revalide : les deux listes doivent rester synchronisées, au caractère près.
export const LEAD_SUBJECTS = [
  'Informations sur les espaces',
  'Tarifs et offres',
  'Réservation et disponibilités',
  'Location du bureau privatif',
  'Location de la salle de réunion',
  'Autre demande',
];

/** Sujet à pré-sélectionner pour une demande de devis sur un espace donné. */
export function subjectForSpace(space) {
  if (space?.category === 'PRIVATE_OFFICE') return 'Location du bureau privatif';
  if (space?.category === 'MEETING_ROOM') return 'Location de la salle de réunion';
  return 'Autre demande';
}

// Formulaire unique « Nous écrire » / « Demander un devis ».
// Enregistre un prospect et notifie la gérante par e-mail (Reply-To = auteur).
// Pré-remplie depuis le compte connecté le cas échéant.
//   initialSubject : sujet pré-sélectionné (sinon le visiteur choisit) ;
//   source         : origine transmise au serveur (traçabilité en admin) ;
//   title / intro  : variantes de texte selon le contexte.
export default function ContactModal({
  onClose,
  initialSubject = '',
  source = 'aide_contact',
  title = 'Nous écrire',
  intro = 'Une question, un projet ? Écrivez-nous, nous vous répondons par e-mail.',
}) {
  const { user } = useAuth();
  // Scinde "Prénom Nom" si disponible pour pré-remplir les deux champs.
  const [fn = '', ...rest] = (user?.display_name || '').trim().split(' ');
  const [form, setForm] = useState({
    first_name: user?.first_name || fn || '',
    last_name: user?.last_name || rest.join(' ') || '',
    email: user?.email || '',
    phone: user?.phone || '',
    subject: LEAD_SUBJECTS.includes(initialSubject) ? initialSubject : '',
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
      await api.post('/leads', { ...form, source });
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
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>

        {done ? (
          <div className="alert ok">
            Merci ! Votre demande a bien été envoyée. Un e-mail de confirmation vient de vous être adressé (pensez à vérifier vos courriers indésirables) ; nous vous répondrons dès que possible à l'adresse indiquée.
            <div style={{ marginTop: 12 }}><button onClick={onClose}>Fermer</button></div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0 }}>
              {intro}
            </p>
            {feedback && <div className="alert error">{feedback}</div>}
            <div className="row">
              <div className="field"><label>Prénom</label><input value={form.first_name} onChange={set('first_name')} required /></div>
              <div className="field"><label>Nom</label><input value={form.last_name} onChange={set('last_name')} required /></div>
            </div>
            <div className="field"><label>E-mail</label><input type="email" value={form.email} onChange={set('email')} required /></div>
            <div className="field"><label>Téléphone</label><input type="tel" value={form.phone} onChange={set('phone')} placeholder="06 12 34 56 78" required /></div>
            <div className="field"><label>Sujet</label>
              <select value={form.subject} onChange={set('subject')} required>
                <option value="" disabled>Choisissez un sujet</option>
                {LEAD_SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Votre demande</label>
              <textarea rows={4} value={form.message} onChange={set('message')} placeholder="Décrivez votre demande (nombre de postes, durée souhaitée, dates, question…)" required />
            </div>
            {/* Honeypot anti-robot : invisible pour un humain. */}
            <input type="text" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off"
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }} aria-hidden="true" />
            <p className="muted" style={{ fontSize: 13 }}>
              Vos données ne servent qu'au traitement de votre demande (voir les{' '}
              <Link to="/cgu#confidentialite">CGU &amp; confidentialité</Link>).
            </p>
            <label className="consent">
              <input type="checkbox" checked={form.consent} onChange={set('consent')} required />
              <span>J'accepte d'être recontacté(e) au sujet de ma demande.</span>
            </label>
            <button type="submit" disabled={busy} style={{ marginTop: 12, width: '100%' }}>
              {busy ? 'Envoi…' : 'Envoyer mon message'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
