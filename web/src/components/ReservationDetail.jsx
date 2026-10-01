import { useState } from 'react';
import { api, msg } from '../api.js';
import { fmtDateTime, parisDateKey, parisTimeHM, parisLocalToUtcIso } from '../time.js';
import TimeSelect from './TimeSelect.jsx';
import VoucherBlock from './VoucherBlock.jsx';

// Panneau (modale) de détail d'une réservation côté admin.
// onChanged(reload) est appelé après chaque action réussie ; onClose ferme.
export default function ReservationDetail({ reservation, onClose, onChanged }) {
  const r = reservation;
  const [note, setNote] = useState(r.note || '');
  const [date, setDate] = useState(parisDateKey(r.start_at));
  const [start, setStart] = useState(parisTimeHM(r.start_at));
  const [end, setEnd] = useState(parisTimeHM(r.end_at));
  const [notify, setNotify] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);

  const notifySuffix = (res) => {
    if (!notify) return '';
    if (res?.notify?.sent) return ' Email envoyé au membre.';
    return ' (Email non envoyé — SMTP non configuré.)';
  };

  const saveNote = async () => {
    setBusy(true); setFeedback(null);
    try {
      const out = await api.patch(`/admin/reservations/${r.id}`, { note, notify });
      setFeedback({ type: 'ok', text: 'Note enregistrée.' + notifySuffix(out) });
      onChanged?.();
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    finally { setBusy(false); }
  };

  const move = async () => {
    setBusy(true); setFeedback(null);
    try {
      const start_at = parisLocalToUtcIso(date, start);
      const end_at = parisLocalToUtcIso(date, end);
      const out = await api.patch(`/admin/reservations/${r.id}`, { start_at, end_at, notify });
      setFeedback({ type: 'ok', text: 'Réservation déplacée.' + notifySuffix(out) });
      onChanged?.();
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm('Supprimer cette réservation ? Le membre sera remboursé.')) return;
    setBusy(true); setFeedback(null);
    try {
      const out = await api.post(`/admin/reservations/${r.id}/cancel`, { notify });
      setFeedback({ type: 'ok', text: 'Réservation supprimée et remboursée.' + notifySuffix(out) });
      onChanged?.();
      onClose?.();
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>
            <span className="dot" style={{ background: r.space_color }} />
            {r.space_name}
          </h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>

        <table style={{ marginBottom: 14 }}>
          <tbody>
            <tr><td className="muted">Membre</td><td><strong>{r.member_name}</strong> · {r.member_email}</td></tr>
            <tr><td className="muted">Début</td><td>{fmtDateTime(r.start_at)}</td></tr>
            <tr><td className="muted">Fin</td><td>{fmtDateTime(r.end_at)}</td></tr>
            <tr><td className="muted">Coût</td><td>{r.credits_cost} crédits</td></tr>
          </tbody>
        </table>

        <VoucherBlock reservation={r} />

        {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

        <div className="field">
          <label>Note</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note interne / commentaire…" />
        </div>

        <div className="card" style={{ background: 'rgba(255,255,255,0.5)', padding: 14, marginBottom: 14 }}>
          <label style={{ marginBottom: 8 }}>Déplacer le créneau</label>
          <div className="row">
            <div className="field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="field"><label>Début</label><TimeSelect value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label>Fin</label><TimeSelect value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          Notifier l'utilisateur par email de cette action
        </label>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={saveNote} disabled={busy}>Enregistrer la note</button>
          <button className="outline" onClick={move} disabled={busy}>Déplacer</button>
          <button className="danger" onClick={remove} disabled={busy} style={{ marginLeft: 'auto' }}>Supprimer</button>
        </div>
      </div>
    </div>
  );
}
