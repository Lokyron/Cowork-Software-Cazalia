import { useEffect, useMemo, useState } from 'react';
import { api, msg } from '../api.js';
import { parisLocalToUtcIso } from '../time.js';
import TimeSelect from './TimeSelect.jsx';
import CreateMemberModal from './CreateMemberModal.jsx';

// Modale de réservation depuis le planning.
//  - mode 'admin'  : choix du client (autocomplete + création rapide) + droits bypass.
//  - mode 'client' : le client courant est assigné automatiquement, règles strictes.
// `initial` = { date, startHM, endHM } préremplis par le drag/clic. `presetSpaceId`
// verrouille l'espace (réservation depuis un espace précis).
export default function BookingModal({ mode, presetSpaceId, initial, onClose, onCreated }) {
  const isAdmin = mode === 'admin';
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState(presetSpaceId ? String(presetSpaceId) : '');
  const [date, setDate] = useState(initial?.date || '');
  const [start, setStart] = useState(initial?.startHM || '09:00');
  const [end, setEnd] = useState(initial?.endHM || '10:00');
  const [seats, setSeats] = useState(1);
  const [avail, setAvail] = useState(null);
  const [balance, setBalance] = useState(null); // client courant
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);

  // Admin : client + bypass
  const [members, setMembers] = useState([]);
  const [q, setQ] = useState('');
  const [client, setClient] = useState(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [ignoreHours, setIgnoreHours] = useState(false);
  const [overbook, setOverbook] = useState(false);
  const [customCost, setCustomCost] = useState('');

  useEffect(() => { api.get('/spaces').then((r) => setSpaces(r.spaces)).catch(() => {}); }, []);
  useEffect(() => { if (isAdmin) api.get('/admin/members').then((r) => setMembers(r.members)).catch(() => {}); }, [isAdmin]);
  useEffect(() => { if (!isAdmin) api.get('/wallet/me').then((r) => setBalance(r.balance)).catch(() => {}); }, [isAdmin]);

  const space = spaces.find((s) => String(s.id) === String(spaceId));
  useEffect(() => { setSeats(1); }, [spaceId]);

  const iso = useMemo(() => {
    if (!date) return null;
    const s = parisLocalToUtcIso(date, start);
    const e = parisLocalToUtcIso(date, end);
    return { s, e, valid: e > s };
  }, [date, start, end]);

  useEffect(() => {
    if (!space || !iso || !iso.valid) { setAvail(null); return; }
    let cancelled = false;
    api.get(`/availability?space_id=${space.id}&from=${encodeURIComponent(iso.s)}&to=${encodeURIComponent(iso.e)}&seats=${seats}`)
      .then((r) => { if (!cancelled) setAvail(r); }).catch(() => { if (!cancelled) setAvail(null); });
    return () => { cancelled = true; };
  }, [space, iso, seats]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return [];
    return members.filter((m) => `${m.display_name} ${m.email} ${m.phone || ''}`.toLowerCase().includes(qq)).slice(0, 8);
  }, [members, q]);

  const cost = avail?.cost;
  const effectiveCost = isAdmin && customCost !== '' ? Number(customCost) : cost;
  const full = avail && avail.seats_left < seats;
  const clientInsufficient = !isAdmin && balance != null && effectiveCost != null && effectiveCost > balance;

  const canSubmit = () => {
    if (!space || !iso || !iso.valid || busy) return false;
    if (isAdmin && !client) return false;
    if (!isAdmin && (full || clientInsufficient)) return false; // règles strictes côté client
    return true;
  };

  const submit = async () => {
    setFeedback(null); setBusy(true);
    try {
      if (isAdmin) {
        await api.post('/admin/reservations', {
          user_id: client.id, space_id: space.id, start_at: iso.s, end_at: iso.e, seats,
          ignore_hours: ignoreHours, allow_overbooking: overbook,
          custom_cost: customCost === '' ? undefined : Number(customCost),
        });
        onCreated?.(`Réservation créée pour ${client.display_name}.`);
      } else {
        await api.post('/reservations', { space_id: space.id, start_at: iso.s, end_at: iso.e, seats });
        onCreated?.('Réservation confirmée.');
      }
    } catch (err) {
      setFeedback({ type: 'error', text: msg(err.code) });
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)' }}>
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Nouvelle réservation</h2>
            <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
          </div>

          {feedback && <div className="alert error">{feedback.text}</div>}

          <div className="field">
            <label>Espace</label>
            <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={!!presetSpaceId}>
              <option value="">— Choisir —</option>
              {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {isAdmin && (
            <div className="field">
              <label>Client</label>
              {client ? (
                <div className="flex-between" style={{ gap: 8 }}>
                  <span><span className="dot" style={{ background: 'var(--accent)' }} />{client.display_name} · <span className="muted">{client.balance} cr.</span></span>
                  <button className="outline small" onClick={() => { setClient(null); setQ(''); }}>Changer</button>
                </div>
              ) : (
                <>
                  <div style={{ position: 'relative' }}>
                    <input placeholder="Rechercher un client (nom, email, tél)…" value={q} onChange={(e) => setQ(e.target.value)} />
                    {filtered.length > 0 && (
                      <div className="ac-menu">
                        {filtered.map((m) => (
                          <button key={m.id} type="button" className="ac-item" onClick={() => { setClient(m); setQ(''); }}>
                            {m.display_name} <span className="muted">· {m.email} · {m.balance} cr.</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button className="outline small" onClick={() => setShowNewClient(true)}>＋ Nouveau client</button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="row">
            <div className="field"><label>Jour</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="field"><label>Début</label><TimeSelect value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label>Fin</label><TimeSelect value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>

          {space && !space.exclusive && (
            <div className="field" style={{ marginTop: 6 }}>
              <label>{space.privatizable ? 'Réservation' : 'Places'}</label>
              {space.privatizable ? (
                <select value={seats} onChange={(e) => setSeats(Number(e.target.value))} style={{ maxWidth: 240 }}>
                  <option value={1}>1 poste</option>
                  <option value={space.capacity}>Privatiser ({space.capacity} postes)</option>
                </select>
              ) : (
                <input type="number" min="1" max={space.capacity} value={seats} style={{ maxWidth: 100 }}
                  onChange={(e) => setSeats(Math.max(1, Math.min(space.capacity, Number(e.target.value) || 1)))} />
              )}
            </div>
          )}

          <div className="seats" style={{ margin: '10px 0' }}>
            {!iso || !iso.valid ? <span className="badge red">Créneau invalide</span>
              : !space ? <span className="muted">Choisissez un espace.</span>
              : avail == null ? <span className="muted">…</span>
              : <>
                  {avail.exclusive
                    ? <span className={`badge ${full ? 'red' : 'green'}`}>{full ? 'Réservé' : 'Disponible'}</span>
                    : <span className={`badge ${full ? 'red' : 'green'}`}>{avail.seats_left} place{avail.seats_left > 1 ? 's' : ''} restante{avail.seats_left > 1 ? 's' : ''}</span>}
                  {' '}<span className="muted">≈ {effectiveCost} crédits</span>
                  {clientInsufficient && <span className="badge red" style={{ marginLeft: 8 }}>Solde insuffisant</span>}
                </>}
          </div>

          {isAdmin && (
            <div className="card" style={{ background: 'rgba(59,130,246,0.06)', padding: 12, marginBottom: 12 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>DROITS ADMIN (bypass)</div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={ignoreHours} onChange={(e) => setIgnoreHours(e.target.checked)} />
                Forcer hors horaires d'ouverture
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={overbook} onChange={(e) => setOverbook(e.target.checked)} />
                Autoriser le surbooking (dépasser la capacité)
              </label>
              <div className="field" style={{ marginTop: 8, maxWidth: 240 }}>
                <label>Tarif personnalisé / remise (crédits)</label>
                <input type="number" min="0" placeholder={cost != null ? `défaut ${cost}` : 'défaut'} value={customCost}
                  onChange={(e) => setCustomCost(e.target.value)} />
              </div>
            </div>
          )}

          <div className="flex-between">
            <div className="muted seats">
              Coût : <strong>{effectiveCost ?? '—'} crédits</strong>
              {!isAdmin && balance != null && <> · solde {balance}</>}
            </div>
            <button disabled={!canSubmit()} onClick={submit}>Réserver</button>
          </div>
        </div>
      </div>

      {showNewClient && (
        <CreateMemberModal
          onClose={() => setShowNewClient(false)}
          onCreated={(u) => { if (u) setClient({ ...u, balance: 0 }); }}
        />
      )}
    </>
  );
}
