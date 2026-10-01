import { useEffect, useMemo, useRef, useState } from 'react';
import { api, msg } from '../api.js';
import { parisLocalToUtcIso } from '../time.js';
import TimeSelect from './TimeSelect.jsx';

// Panier de réservation multi-espaces réutilisable.
//   adapter : { list(), add(payload), remove(id), checkout() } — client ou admin.
//   admin   : affiche les droits bypass (hors-horaires / surbooking / tarif).
//   onDone  : appelé après un checkout réussi (result).
// Le formulaire ajoute une ligne (pose un verrou 10 min) ; chaque ligne affiche son
// compte à rebours ; à expiration, la ligne disparaît (rafraîchissement auto).
const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtSlot = (a, b) => `${dFmt.format(new Date(a))} · ${tFmt.format(new Date(a))}–${tFmt.format(new Date(b))}`;
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export default function CartBuilder({ adapter, admin = false, onDone }) {
  const [spaces, setSpaces] = useState([]);
  const [cart, setCart] = useState({ holds: [], total: 0, balance: null });
  const [spaceId, setSpaceId] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [seats, setSeats] = useState(1);
  const [avail, setAvail] = useState(null);
  const [ignoreHours, setIgnoreHours] = useState(false);
  const [overbook, setOverbook] = useState(false);
  const [customCost, setCustomCost] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const reload = () => adapter.list().then(setCart).catch(() => {});
  useEffect(() => { api.get('/spaces').then((r) => setSpaces(r.spaces)).catch(() => {}); }, []);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [adapter.key]);

  // Horloge 1s pour les comptes à rebours ; rafraîchit le panier quand un verrou expire.
  const expiredRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      const anyExpired = cart.holds.some((h) => new Date(h.expires_at).getTime() <= Date.now());
      if (anyExpired && !expiredRef.current) { expiredRef.current = true; reload().finally(() => { expiredRef.current = false; }); }
    }, 1000);
    return () => clearInterval(t);
  }, [cart.holds]);

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

  const cost = avail?.cost;
  const effectiveCost = admin && customCost !== '' ? Number(customCost) : cost;
  const full = avail && avail.seats_left < seats;

  const add = async () => {
    if (!space || !iso || !iso.valid) return;
    setBusy(true); setFeedback(null);
    try {
      const payload = { space_id: space.id, start_at: iso.s, end_at: iso.e, seats };
      if (admin) { payload.ignore_hours = ignoreHours; payload.allow_overbooking = overbook; payload.custom_cost = customCost === '' ? undefined : Number(customCost); }
      const r = await adapter.add(payload);
      setCart(r.cart);
      setFeedback({ type: 'ok', text: 'Ajouté au panier (verrou 10 min).' });
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    finally { setBusy(false); }
  };

  const remove = async (id) => {
    try { const r = await adapter.remove(id); if (r?.cart) setCart(r.cart); else reload(); }
    catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
  };

  const doCheckout = async () => {
    setBusy(true); setFeedback(null);
    try { const result = await adapter.checkout(); onDone?.(result); }
    catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); setBusy(false); reload(); }
  };

  const total = cart.total || 0;
  const insufficient = !admin && cart.balance != null && total > cart.balance;
  const canAdd = space && iso && iso.valid && !busy && (admin || !full);

  return (
    <div className="cart-grid">
      {/* Formulaire d'ajout */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Ajouter un créneau</h3>
        <div className="field">
          <label>Espace</label>
          <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
            <option value="">— Choisir —</option>
            {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="row">
          <div className="field"><label>Jour</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field"><label>Début</label><TimeSelect value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="field"><label>Fin</label><TimeSelect value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>

        {space && !space.exclusive && (
          <div className="field" style={{ maxWidth: 240 }}>
            <label>{space.privatizable ? 'Réservation' : 'Places'}</label>
            {space.privatizable ? (
              <select value={seats} onChange={(e) => setSeats(Number(e.target.value))}>
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
              </>}
        </div>

        {admin && (
          <div className="card" style={{ background: 'rgba(59,130,246,0.06)', padding: 12, marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>DROITS ADMIN (bypass)</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={ignoreHours} onChange={(e) => setIgnoreHours(e.target.checked)} /> Forcer hors horaires
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={overbook} onChange={(e) => setOverbook(e.target.checked)} /> Autoriser le surbooking
            </label>
            <div className="field" style={{ marginTop: 8, maxWidth: 240 }}>
              <label>Tarif personnalisé (crédits)</label>
              <input type="number" min="0" placeholder={cost != null ? `défaut ${cost}` : 'défaut'} value={customCost} onChange={(e) => setCustomCost(e.target.value)} />
            </div>
          </div>
        )}

        {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}
        <button disabled={!canAdd} onClick={add}>Ajouter au panier</button>
      </div>

      {/* Panier */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Panier {cart.holds.length > 0 && <span className="muted">· {cart.holds.length}</span>}</h3>
        {cart.holds.length === 0 && <p className="muted">Votre panier est vide. Ajoutez un ou plusieurs créneaux.</p>}
        <div className="stack">
          {cart.holds.map((h) => {
            const left = new Date(h.expires_at).getTime() - now;
            const soon = left < 120000;
            return (
              <div key={h.id} className="cart-line">
                <div>
                  <div><span className="dot" style={{ background: h.space_color }} /><strong>{h.space_name}</strong> <span className="muted seats">· {h.seats > 1 ? `${h.seats} places` : '1 place'}</span></div>
                  <div className="muted seats">{fmtSlot(h.start_at, h.end_at)} · {h.cost} cr.</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <span className={`cart-timer ${soon ? 'soon' : ''}`} title="Temps restant du verrou">⏱ {mmss(left)}</span>
                  <button className="ghost" onClick={() => remove(h.id)} aria-label="Retirer">✕</button>
                </div>
              </div>
            );
          })}
        </div>

        {cart.holds.length > 0 && (
          <>
            <div className="flex-between" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <strong>Total</strong>
              <strong>{total} crédits</strong>
            </div>
            {!admin && cart.balance != null && (
              <div className="muted seats" style={{ marginTop: 4 }}>
                Solde : {cart.balance} crédits {insufficient && <span className="badge red" style={{ marginLeft: 6 }}>Solde insuffisant</span>}
              </div>
            )}
            <button style={{ marginTop: 12, width: '100%' }} disabled={busy || insufficient} onClick={doCheckout}>
              Valider et payer ({total} cr.)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
