import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';
import { addMonthsStr, todayStr } from '../time.js';
import DatePicker from './DatePicker.jsx';

// Sujets proposés (liste fermée, obligatoire).
// ⚠ Dupliquée côté serveur (`LEAD_SUBJECTS` dans server/src/lib/prospects.js), qui
// la revalide : les deux listes doivent rester synchronisées, au caractère près.
export const LEAD_SUBJECTS = [
  'Informations sur les espaces',
  'Tarifs et offres',
  'Réservation et disponibilités',
  'Location du bureau privatif (longue durée)',
  'Location de la salle de réunion',
  'Autre demande',
];

// Sujet qui affiche le bloc « Votre besoin » à la place du champ « Votre demande ».
const OFFICE_SUBJECT = 'Location du bureau privatif (longue durée)';

// Durées proposées pour le bureau privatif (liste fermée, ordre d'affichage).
// ⚠ Dupliquée côté serveur (`OFFICE_DURATIONS` dans server/src/lib/prospects.js), qui
// la revalide : les deux listes doivent rester synchronisées, au caractère près.
export const OFFICE_DURATIONS = [
  '1 à 3 mois',
  '3 à 6 mois',
  '6 à 12 mois',
  '12 mois',
  "Plus d'un an",
  'Je ne sais pas encore',
];

// Valeur envoyée au serveur quand le visiteur veut commencer au plus tôt.
const OFFICE_START_ASAP = 'DES_QUE_POSSIBLE';

// Réponses du bloc « Votre besoin » (vides tant que le sujet n'est pas le bureau privatif).
const EMPTY_NEED = { office_seats: '', office_duration: '', office_start: '', office_asap: false };

/** Sujet à pré-sélectionner pour une demande de devis sur un espace donné. */
export function subjectForSpace(space) {
  if (space?.category === 'PRIVATE_OFFICE') return OFFICE_SUBJECT;
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
    ...EMPTY_NEED,
    consent: false,
    website: '', // honeypot
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [done, setDone] = useState(false);
  const [ackSent, setAckSent] = useState(false); // accusé réellement remis au fournisseur

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const isOffice = form.subject === OFFICE_SUBJECT;

  // Le titre et l'accroche décrivent le contexte d'ouverture (« Demander un devis »).
  // Si le visiteur change de sujet, ce contexte ne vaut plus : on repasse au texte
  // générique, pour ne pas annoncer un contrat longue durée au-dessus d'une question
  // sur les tarifs.
  const onContext = !initialSubject || form.subject === initialSubject;
  const heading = onContext ? title : 'Nous écrire';
  const lead = onContext ? intro : 'Une question, un projet ? Écrivez-nous, nous vous répondons par e-mail.';

  // Changer de sujet efface les réponses du bloc : on n'envoie jamais une durée
  // pour une demande « Tarifs et offres ».
  const changeSubject = (e) => {
    const subject = e.target.value;
    setForm((f) => ({ ...f, subject, ...(subject === OFFICE_SUBJECT ? {} : EMPTY_NEED) }));
  };

  // « Dès que possible » vide et désactive le champ de date.
  const toggleAsap = (e) => {
    const asap = e.target.checked;
    setForm((f) => ({ ...f, office_asap: asap, office_start: asap ? '' : f.office_start }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setFeedback(null);
    try {
      const { office_seats, office_duration, office_start, office_asap, ...rest } = form;
      const payload = { ...rest, source };
      if (isOffice) {
        payload.office_seats = Number(office_seats);
        payload.office_duration = office_duration;
        payload.office_start = office_asap ? OFFICE_START_ASAP : (office_start || '');
      }
      const r = await api.post('/leads', payload);
      setAckSent(r?.ack_sent === true);
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
          <h2 style={{ margin: 0 }}>{heading}</h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>

        {done ? (
          <div className="alert ok">
            Merci ! Votre demande a bien été envoyée.
            {ackSent
              ? " Un e-mail de confirmation vient de vous être adressé (pensez à vérifier vos courriers indésirables) ; nous vous répondrons dès que possible à l'adresse indiquée."
              : " Nous vous répondrons dès que possible à l'adresse indiquée."}
            <div style={{ marginTop: 12 }}><button onClick={onClose}>Fermer</button></div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0 }}>
              {lead}
            </p>
            {feedback && <div className="alert error">{feedback}</div>}
            <div className="row">
              <div className="field"><label>Prénom</label><input value={form.first_name} onChange={set('first_name')} required /></div>
              <div className="field"><label>Nom</label><input value={form.last_name} onChange={set('last_name')} required /></div>
            </div>
            <div className="field"><label>E-mail</label><input type="email" value={form.email} onChange={set('email')} required /></div>
            <div className="field"><label>Téléphone</label><input type="tel" value={form.phone} onChange={set('phone')} placeholder="06 12 34 56 78" required /></div>
            <div className="field"><label>Sujet</label>
              <select value={form.subject} onChange={changeSubject} required>
                <option value="" disabled>Choisissez un sujet</option>
                {LEAD_SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {isOffice ? (
              <fieldset className="need-block">
                <legend className="need-title">Votre besoin</legend>
                <div className="field">
                  <label htmlFor="office-seats">Nombre de postes</label>
                  <input id="office-seats" type="number" min="1" max="50" step="1" inputMode="numeric"
                    value={form.office_seats} onChange={set('office_seats')} required />
                  <span className="hint">
                    Ce bureau privatif comporte deux postes. Si vous en souhaitez davantage, indiquez-nous
                    tout de même votre besoin : nous étudierons ensemble la meilleure solution.
                  </span>
                </div>
                <div className="field" role="radiogroup" aria-labelledby="office-duration-label">
                  <label id="office-duration-label">Pour quelle durée envisagez-vous cette location ?</label>
                  <div className="need-chips">
                    {OFFICE_DURATIONS.map((d) => (
                      <label key={d} className="need-chip">
                        <input type="radio" name="office_duration" value={d} checked={form.office_duration === d}
                          onChange={set('office_duration')} required />
                        <span>{d}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="office-start">À partir de quand souhaitez-vous commencer ?</label>
                  <div className="row need-start">
                    <DatePicker
                      id="office-start"
                      value={form.office_start}
                      onChange={(d) => setForm((f) => ({ ...f, office_start: d }))}
                      min={todayStr()}
                      max={addMonthsStr(todayStr(), 36)}
                      disabled={form.office_asap}
                    />
                    <label className="consent need-asap">
                      <input type="checkbox" checked={form.office_asap} onChange={toggleAsap} />
                      <span>Dès que possible</span>
                    </label>
                  </div>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="office-message">Un besoin particulier à nous préciser ? (facultatif)</label>
                  <textarea id="office-message" rows={3} value={form.message} onChange={set('message')}
                    placeholder="Mobilier, accès en soirée, stationnement…" />
                </div>
              </fieldset>
            ) : (
              <div className="field"><label>Votre demande</label>
                <textarea rows={4} value={form.message} onChange={set('message')} placeholder="Décrivez votre demande (dates, effectif, question…)" required />
              </div>
            )}
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
              {busy ? 'Envoi…' : (isOffice ? 'Envoyer ma demande' : 'Envoyer mon message')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
