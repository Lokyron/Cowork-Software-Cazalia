import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, msg } from '../api.js';
import { parisLocalToUtcIso } from '../time.js';
import TimeSelect from './TimeSelect.jsx';

// Panier de réservation multi-espaces réutilisable (client ou admin).
//   adapter : { list(), add(payload), remove(id), checkout() }.
//   admin   : affiche les droits bypass (hors-horaires / surbooking / tarif).
//   onDone  : appelé après un checkout qui crée directement les réservations
//             (admin). Côté client, le checkout renvoie une URL Stripe : on y
//             redirige (le retour se fait sur /mon-espace).
const dFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtSlot = (a, b) => `${dFmt.format(new Date(a))} · ${tFmt.format(new Date(a))}–${tFmt.format(new Date(b))}`;
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const eur = (cents) => (cents == null ? '—' : (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));

// Formules de réservation. Les demi-journées / journées sont des forfaits à
// créneau fixe (cf. config.forfaitSlots côté serveur). Samedi : seul le matin.
const FORMULES = [
  { id: 'heure', label: "À l'heure", tarif: 'heure' },
  { id: 'matin', label: 'Demi-journée (matin)', tarif: 'demi_journee' },
  { id: 'aprem', label: 'Demi-journée (après-midi)', tarif: 'demi_journee' },
  { id: 'journee', label: 'Journée', tarif: 'journee' },
];
function formuleTimes(id, date) {
  const wd = date ? new Date(`${date}T12:00:00`).getDay() : 1; // 0=dim … 6=sam
  const sat = wd === 6;
  if (id === 'matin') return sat ? { start: '09:00', end: '13:00' } : { start: '08:30', end: '14:00' };
  if (id === 'aprem') return sat ? null : { start: '14:00', end: '19:30' };
  if (id === 'journee') return sat ? null : { start: '08:30', end: '19:30' };
  return null; // 'heure' : plage libre
}

export default function CartBuilder({ adapter, admin = false, onDone }) {
  const [spaces, setSpaces] = useState([]);
  const [cart, setCart] = useState({ holds: [], total: 0 });
  const [spaceId, setSpaceId] = useState('');
  const [date, setDate] = useState('');
  const [formule, setFormule] = useState('heure');
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
  const [cgvAccepted, setCgvAccepted] = useState(false);
  const [retractationAck, setRetractationAck] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(null); // aperçu validé {code, discount_cents, ...}
  const [promoError, setPromoError] = useState(null);
  const [promoBusy, setPromoBusy] = useState(false);

  const reload = () => adapter.list().then(setCart).catch(() => {});
  useEffect(() => { api.get('/spaces').then((r) => setSpaces(r.spaces)).catch(() => {}); }, []);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [adapter.key]);

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

  const tarifType = FORMULES.find((f) => f.id === formule)?.tarif || 'heure';
  // Créneau effectif : plage libre à l'heure, sinon fenêtre du forfait choisi.
  const times = formule === 'heure' ? { start, end } : formuleTimes(formule, date);
  const forfaitUnavailable = formule !== 'heure' && date && !times;

  const iso = useMemo(() => {
    if (!date || !times) return null;
    const s = parisLocalToUtcIso(date, times.start);
    const e = parisLocalToUtcIso(date, times.end);
    return { s, e, valid: e > s };
  }, [date, times?.start, times?.end]);

  useEffect(() => {
    if (!space || !iso || !iso.valid) { setAvail(null); return; }
    let cancelled = false;
    api.get(`/availability?space_id=${space.id}&from=${encodeURIComponent(iso.s)}&to=${encodeURIComponent(iso.e)}&seats=${seats}&tarif_type=${tarifType}`)
      .then((r) => { if (!cancelled) setAvail(r); }).catch(() => { if (!cancelled) setAvail(null); });
    return () => { cancelled = true; };
  }, [space, iso, seats, tarifType]);

  const costCents = avail?.cost;
  const customCents = customCost !== '' ? Math.round(Number(customCost) * 100) : null;
  const effectiveCents = admin && customCents != null ? customCents : costCents;
  const full = avail && avail.seats_left < seats;

  const add = async () => {
    if (!space || !iso || !iso.valid) return;
    setBusy(true); setFeedback(null);
    try {
      const payload = { space_id: space.id, start_at: iso.s, end_at: iso.e, seats, tarif_type: tarifType };
      if (admin) { payload.ignore_hours = ignoreHours; payload.allow_overbooking = overbook; payload.custom_cost = customCost === '' ? undefined : Number(customCost); }
      const r = await adapter.add(payload);
      setCart(r.cart);
      clearPromo(); // le panier a changé : l'aperçu de remise n'est plus valable
      setFeedback({ type: 'ok', text: 'Ajouté au panier (place tenue 10 min).' });
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
    finally { setBusy(false); }
  };

  const remove = async (id) => {
    try { const r = await adapter.remove(id); if (r?.cart) setCart(r.cart); else reload(); clearPromo(); }
    catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); }
  };

  // ── Code promo (aperçu AVANT paiement ; aucune utilisation comptée ici) ───────
  const clearPromo = () => { setPromoApplied(null); setPromoError(null); };
  const onPromoInput = (e) => { setPromoCode(e.target.value); if (promoApplied) clearPromo(); };
  const applyPromo = async () => {
    const code = promoCode.trim();
    if (!code || !adapter.previewPromo) return;
    setPromoBusy(true); setPromoError(null);
    try {
      const r = await adapter.previewPromo(code);
      setPromoApplied(r);
    } catch (err) {
      setPromoApplied(null);
      setPromoError(msg(err.code));
    } finally { setPromoBusy(false); }
  };

  const doCheckout = async () => {
    setBusy(true); setFeedback(null);
    try {
      const result = await adapter.checkout(promoApplied?.code || promoCode.trim() || undefined);
      if (result?.url) { window.location.assign(result.url); return; } // paiement Stripe (client)
      onDone?.(result); // création directe (admin)
    } catch (err) { setFeedback({ type: 'error', text: msg(err.code) }); setBusy(false); reload(); }
  };

  const total = cart.total || 0;
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

        <div className="field">
          <label>Formule</label>
          <select value={formule} onChange={(e) => setFormule(e.target.value)}>
            {FORMULES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>

        <div className="row">
          <div className="field"><label>Jour</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          {formule === 'heure' ? (
            <>
              <div className="field"><label>Début</label><TimeSelect value={start} onChange={(e) => setStart(e.target.value)} /></div>
              <div className="field"><label>Fin</label><TimeSelect value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            </>
          ) : (
            <div className="field" style={{ alignSelf: 'end' }}>
              <label>Horaire</label>
              <div className="muted" style={{ paddingTop: 8 }}>{times ? `${times.start} – ${times.end}` : 'Indisponible ce jour'}</div>
            </div>
          )}
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
          {forfaitUnavailable ? <span className="badge red">Cette formule n'est pas disponible ce jour</span>
            : !iso || !iso.valid ? <span className="badge red">Créneau invalide</span>
            : !space ? <span className="muted">Choisissez un espace.</span>
            : avail == null ? <span className="muted">…</span>
            : <>
                {avail.exclusive
                  ? <span className={`badge ${full ? 'red' : 'green'}`}>{full ? 'Réservé' : 'Disponible'}</span>
                  : <span className={`badge ${full ? 'red' : 'green'}`}>{avail.seats_left} place{avail.seats_left > 1 ? 's' : ''} restante{avail.seats_left > 1 ? 's' : ''}</span>}
                {' '}<span className="muted">{effectiveCents != null ? eur(effectiveCents) : 'tarif indisponible'}</span>
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
              <label>Tarif personnalisé (euros)</label>
              <input type="number" min="0" step="0.01" placeholder={costCents != null ? `défaut ${(costCents / 100).toFixed(2)}` : 'défaut'} value={customCost} onChange={(e) => setCustomCost(e.target.value)} />
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
                  <div className="muted seats">{fmtSlot(h.start_at, h.end_at)} · {eur(h.cost)}</div>
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
            {!admin && (
              <div className="field" style={{ marginTop: 12 }}>
                <label>Code promo <span className="muted" style={{ fontWeight: 400 }}>(facultatif)</span></label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={promoApplied ? promoApplied.code : promoCode}
                    onChange={onPromoInput}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!promoApplied) applyPromo(); } }}
                    placeholder="Ex. JOURNEE-CAZALIA"
                    autoComplete="off"
                    disabled={!!promoApplied || promoBusy}
                    style={{ textTransform: 'uppercase', flex: 1 }}
                  />
                  {promoApplied ? (
                    <button type="button" className="ghost" onClick={clearPromo}>Retirer</button>
                  ) : (
                    <button type="button" className="outline" onClick={applyPromo} disabled={promoBusy || !promoCode.trim()}>
                      {promoBusy ? '…' : 'Valider'}
                    </button>
                  )}
                </div>
                {promoError && <div className="alert error" style={{ marginTop: 8 }}>{promoError}</div>}
                {promoApplied && (
                  <div className="alert ok" style={{ marginTop: 8 }}>
                    Code appliqué{promoApplied.new_total_cents === 0 ? ' — c\'est offert ! 🎉' : ` : −${eur(promoApplied.discount_cents)}`}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              {promoApplied && (
                <>
                  <div className="flex-between">
                    <span className="muted">Sous-total</span>
                    <span className="muted" style={{ textDecoration: 'line-through' }}>{eur(promoApplied.total_cents)}</span>
                  </div>
                  <div className="flex-between" style={{ marginTop: 4 }}>
                    <span style={{ color: 'var(--green)' }}>Remise ({promoApplied.code})</span>
                    <span style={{ color: 'var(--green)' }}>− {eur(promoApplied.discount_cents)}</span>
                  </div>
                </>
              )}
              <div className="flex-between" style={{ marginTop: promoApplied ? 6 : 0 }}>
                <strong>Total</strong>
                <strong>{eur(promoApplied ? promoApplied.new_total_cents : total)}</strong>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>☕ Café &amp; thé inclus dans toutes les réservations.</p>
            {!admin && (
              <div style={{ marginTop: 12 }}>
                <label className="consent">
                  <input type="checkbox" checked={cgvAccepted} onChange={(e) => setCgvAccepted(e.target.checked)} />
                  <span>J'accepte les <Link to="/cgv" target="_blank">conditions générales de vente</Link>.</span>
                </label>
                <label className="consent">
                  <input type="checkbox" checked={retractationAck} onChange={(e) => setRetractationAck(e.target.checked)} />
                  <span>
                    Je demande l'exécution immédiate de la prestation et reconnais perdre mon droit de
                    rétractation pour les prestations pleinement exécutées (art. L221-25 C. conso.).
                  </span>
                </label>
              </div>
            )}
            <button
              style={{ marginTop: 12, width: '100%' }}
              disabled={busy || (!admin && (!cgvAccepted || !retractationAck))}
              onClick={doCheckout}
            >
              {admin
                ? `Valider (${eur(total)})`
                : promoApplied && promoApplied.new_total_cents === 0
                  ? 'Confirmer ma réservation (offerte)'
                  : `Payer ${eur(promoApplied ? promoApplied.new_total_cents : total)}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
