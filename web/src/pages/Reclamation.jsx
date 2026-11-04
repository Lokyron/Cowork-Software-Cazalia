import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, msg } from '../api.js';
import BackLink from '../components/BackLink.jsx';

const KINDS = [
  ['annulation', 'Annulation de réservation'],
  ['remboursement', 'Demande de remboursement / avoir'],
  ['autre', 'Autre réclamation'],
];

// Formulaire public de réclamation / demande de remboursement (art. L612-1 s.
// C. conso.). Envoie vers POST /api/claims : trace en base + e-mail à la gérante.
export default function Reclamation() {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', reservation_ref: '', kind: 'annulation', message: '', website: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (form.message.trim().length < 10) { setError('Merci de détailler votre demande (au moins 10 caractères).'); return; }
    setBusy(true);
    try {
      await api.post('/claims', {
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        reservation_ref: form.reservation_ref || null,
        kind: form.kind,
        message: form.message,
        website: form.website, // honeypot (doit rester vide)
      });
      setDone(true);
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-wrap" style={{ maxWidth: 560 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <img src="/images/logo-cazalia.svg" className="login-logo" alt="CAZALIA — Coworking Boutonnet" />
          <h1 style={{ marginTop: 4 }}>Réclamation envoyée</h1>
          <p className="subtitle" style={{ marginBottom: 6 }}>
            Nous avons bien reçu votre demande et reviendrons vers vous dans les meilleurs délais à
            l'adresse e-mail indiquée.
          </p>
          <p className="muted" style={{ fontSize: 14 }}>
            <BackLink to="/" label="Retour à l'accueil" />
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="legal">
      <BackLink to="/" label="Retour à l'accueil" />
      <img src="/images/logo-cazalia.svg" className="legal-logo" alt="CAZALIA — Coworking Boutonnet" />
      <h1>Réclamation & remboursement</h1>

      <p>
        Une question sur une réservation, une annulation ou un remboursement&nbsp;? Utilisez ce formulaire.
        Nous recherchons toujours une solution amiable en priorité. Les conditions complètes figurent dans
        nos <Link to="/cgv">conditions générales de vente</Link>.
      </p>

      <h2>Rappel de la politique d'annulation</h2>
      <ul>
        <li><strong>Plus de 48&nbsp;h avant</strong> le créneau&nbsp;: recréditation intégrale des crédits.</li>
        <li><strong>Entre 48&nbsp;h et 24&nbsp;h avant</strong>&nbsp;: recréditation des crédits (sauf salle
          privatisée).</li>
        <li><strong>Moins de 24&nbsp;h avant ou absence (no-show)</strong>&nbsp;: crédits dus.</li>
        <li><strong>Annulation par CAZALIA</strong>&nbsp;: recréditation intégrale.</li>
      </ul>
      <p className="muted" style={{ fontSize: 14 }}>
        Remboursement en numéraire (paiement en ligne) traité via Stripe sous 5 à 10 jours ouvrés.
      </p>

      <h2>Votre demande</h2>
      <form onSubmit={submit} className="card" style={{ padding: 20 }}>
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
          <label>E-mail</label>
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" placeholder="nom@exemple.fr" required />
        </div>
        <div className="row">
          <div className="field">
            <label>N° de réservation <span className="muted" style={{ fontWeight: 400 }}>(facultatif)</span></label>
            <input value={form.reservation_ref} onChange={set('reservation_ref')} placeholder="ex. 1234" />
          </div>
          <div className="field">
            <label>Motif</label>
            <select value={form.kind} onChange={set('kind')}>
              {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Message</label>
          <textarea rows={5} value={form.message} onChange={set('message')} required
            placeholder="Décrivez votre demande (dates, montant, justificatif éventuel…)." />
        </div>

        {/* Champ piège anti-robot : masqué aux humains, doit rester vide. */}
        <input
          type="text"
          name="website"
          value={form.website}
          onChange={set('website')}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
        />

        <p className="muted" style={{ fontSize: 13 }}>
          Pour transmettre un justificatif, vous pouvez le joindre par retour d'e-mail une fois votre
          demande enregistrée. Vos données ne servent qu'au traitement de la réclamation (voir les{' '}
          <Link to="/cgu#confidentialite">CGU &amp; confidentialité</Link>).
        </p>

        {error && <div className="alert error">{error}</div>}
        <button type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? '…' : 'Envoyer ma réclamation'}
        </button>
      </form>

      <p className="muted" style={{ marginTop: 24 }}>
        <BackLink to="/" label="Retour à l'accueil" />
      </p>
    </div>
  );
}
