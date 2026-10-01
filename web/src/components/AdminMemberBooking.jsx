import { useEffect, useState } from 'react';
import { api, msg } from '../api.js';
import { parisLocalToUtcIso, todayStr } from '../time.js';
import TimeSelect from './TimeSelect.jsx';

let _id = 0;
const newSlot = (date) => ({ id: ++_id, date: date || todayStr(), start: '09:00', end: '12:00', seats: 1 });

// Réservation d'un ou plusieurs créneaux POUR un membre, depuis l'admin.
export default function AdminMemberBooking({ member, onClose, onDone }) {
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState('');
  const [slots, setSlots] = useState([newSlot()]);
  const [avail, setAvail] = useState({});
  const [feedback, setFeedback] = useState(null);
  const [badSlot, setBadSlot] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/spaces').then((r) => { setSpaces(r.spaces); if (r.spaces[0]) setSpaceId(String(r.spaces[0].id)); }).catch(() => {});
  }, []);

  const space = spaces.find((s) => String(s.id) === String(spaceId));
  const slotIso = (s) => {
    const startIso = parisLocalToUtcIso(s.date, s.start);
    const endIso = parisLocalToUtcIso(s.date, s.end);
    return { startIso, endIso, valid: endIso > startIso };
  };

  useEffect(() => {
    if (!space) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(slots.map(async (s) => {
        const { startIso, endIso, valid } = slotIso(s);
        if (!valid) return [s.id, 'invalid'];
        try {
          const r = await api.get(`/availability?space_id=${space.id}&from=${encodeURIComponent(startIso)}&to=${encodeURIComponent(endIso)}&seats=${s.seats}`);
          return [s.id, r];
        } catch { return [s.id, null]; }
      }));
      if (!cancelled) setAvail(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, slots, spaces]);

  const setField = (id, k, v) => setSlots((ss) => ss.map((s) => (s.id === id ? { ...s, [k]: v } : s)));
  const addSlot = () => setSlots((ss) => [...ss, newSlot(ss[ss.length - 1]?.date)]);
  const removeSlot = (id) => setSlots((ss) => (ss.length > 1 ? ss.filter((s) => s.id !== id) : ss));

  const total = slots.reduce((sum, s) => { const a = avail[s.id]; return sum + (a && a.cost ? a.cost : 0); }, 0);
  const allValid = slots.every((s) => slotIso(s).valid);
  const anyFull = slots.some((s) => { const a = avail[s.id]; return a && a !== 'invalid' && a.seats_left < s.seats; });
  const insufficient = total > member.balance;

  const reserve = async () => {
    setFeedback(null); setBadSlot(null); setBusy(true);
    const payload = {
      space_id: space.id,
      slots: slots.map((s) => { const { startIso, endIso } = slotIso(s); return { start_at: startIso, end_at: endIso, seats: s.seats }; }),
    };
    try {
      const r = await api.post(`/admin/members/${member.id}/reservations`, payload);
      onDone?.(`${r.count} réservation${r.count > 1 ? 's' : ''} créée${r.count > 1 ? 's' : ''} pour ${member.display_name} — ${r.total} crédits débités.`);
    } catch (err) {
      const idx = err.data?.slot_index;
      if (idx != null) setBadSlot(idx);
      setFeedback({ type: 'error', text: msg(err.code) + (idx != null ? ` (créneau n°${idx + 1})` : '') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(660px, 100%)' }}>
        <div className="flex-between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Réserver pour {member.display_name}</h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>
        <p className="subtitle" style={{ marginBottom: 14 }}>Solde du membre : <strong>{member.balance} crédits</strong></p>

        {feedback && <div className="alert error">{feedback.text}</div>}

        <div className="field">
          <label>Espace</label>
          <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.credits_per_hour} cr/h {s.exclusive ? '(salle, forfait)' : s.privatizable ? '(focus, /poste)' : '(open-space, /place)'}
              </option>
            ))}
          </select>
        </div>

        <div className="stack" style={{ marginTop: 8 }}>
          {slots.map((s, i) => {
            const a = avail[s.id];
            const { valid } = slotIso(s);
            const full = a && a !== 'invalid' && a.seats_left < s.seats;
            return (
              <div key={s.id} className={`slot-row ${badSlot === i ? 'slot-bad' : ''}`}>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div className="field"><label>Jour</label><input type="date" min={todayStr()} value={s.date} onChange={(e) => setField(s.id, 'date', e.target.value)} /></div>
                  <div className="field"><label>Début</label><TimeSelect value={s.start} onChange={(e) => setField(s.id, 'start', e.target.value)} /></div>
                  <div className="field"><label>Fin</label><TimeSelect value={s.end} onChange={(e) => setField(s.id, 'end', e.target.value)} /></div>
                  {space && !space.exclusive && (space.privatizable ? (
                    <div className="field" style={{ flex: '0 0 auto' }}>
                      <label>Réservation</label>
                      <select value={s.seats} onChange={(e) => setField(s.id, 'seats', Number(e.target.value))}>
                        <option value={1}>1 poste</option>
                        <option value={space.capacity}>Privatiser</option>
                      </select>
                    </div>
                  ) : (
                    <div className="field" style={{ flex: '0 0 74px' }}>
                      <label>Places</label>
                      <input type="number" min="1" max={space.capacity} value={s.seats}
                        onChange={(e) => setField(s.id, 'seats', Math.max(1, Math.min(space.capacity, Number(e.target.value) || 1)))} />
                    </div>
                  ))}
                  <div className="field" style={{ flex: '1 1 130px' }}>
                    <label>Disponibilité</label>
                    <div className="seats" style={{ paddingTop: 4 }}>
                      {!valid ? <span className="badge red">Invalide</span>
                        : a == null || a === 'invalid' ? <span className="muted">…</span>
                        : full ? <span className="badge red">{space?.exclusive ? 'Réservé' : 'Complet'}</span>
                        : <><span className="badge green">{space?.exclusive ? 'Dispo' : `${a.seats_left} pl.`}</span> <span className="muted">≈ {a.cost} cr.</span></>}
                    </div>
                  </div>
                  <div className="field" style={{ flex: '0 0 auto' }}><label>&nbsp;</label><button className="outline small" onClick={() => removeSlot(s.id)} disabled={slots.length <= 1}>✕</button></div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12 }}><button className="outline" onClick={addSlot}>+ Ajouter un créneau</button></div>

        <div className="flex-between" style={{ marginTop: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="muted seats">Total</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--navy)' }}>{total} crédits</div>
            {insufficient && <div className="seats" style={{ color: 'var(--red)' }}>Solde insuffisant — rechargez le compte d'abord.</div>}
          </div>
          <button onClick={reserve} disabled={busy || !allValid || anyFull || insufficient}>
            Réserver {slots.length} créneau{slots.length > 1 ? 'x' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
