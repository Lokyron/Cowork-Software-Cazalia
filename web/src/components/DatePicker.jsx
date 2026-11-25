import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, dataVersion } from '../api.js';
import { addDaysStr, addMonthsStr, todayStr } from '../time.js';
import { seatsRemaining } from '../seatsLabel.js';
import { MONTHS, daysIn, dayInfo, fmtFR, longLabel, mkIso, pad, parseFR, parseIso, weekday } from '../datePickerCore.js';

// Sélecteur de jour maison, en remplacement de <input type="date">.
//
// La valeur est une chaîne `YYYY-MM-DD` : un JOUR CIVIL de Paris. Aucune conversion
// de fuseau ici, jamais de `toISOString()` sur une date construite localement :
// tout le calcul de calendrier se fait sur des chaînes (cf. `datePickerCore.js`, qui
// porte la logique pure et ses tests). « Aujourd'hui » vient de `todayStr()` (Paris).
//
// Props :
//   value        'YYYY-MM-DD' ou ''
//   onChange     reçoit 'YYYY-MM-DD' ou ''
//   min, max     bornes 'YYYY-MM-DD' (inclusives). Par défaut : min = aujourd'hui
//                (aucun minimum si `permissive`), max = aujourd'hui + 36 mois.
//                `min=""` ou `max=""` supprime explicitement la borne.
//   disabled     désactive le champ
//   label, id    étiquette du champ et id de l'<input> (pour un <label htmlFor> externe)
//   availability { spaceId, seats, tarifType, slot, excludeReservationId, noun } : colore les jours
//                avec GET /api/availability/month (`excludeReservationId` : écran de
//                déplacement, la réservation déplacée ne compte pas contre elle-même ;
//                la route ne l'honore que pour un admin). Absent ou sans spaceId :
//                calendrier NEUTRE, seules `min` / `max` limitent le choix - aucune règle
//                de créneau (le dimanche n'y est pas « fermé » : une date de début de
//                location peut tomber un dimanche). Même repli propre si la route refuse
//                l'espace (non réservable en ligne). Tant que la réponse n'est pas là, les
//                jours sont « en chargement » (non choisissables) ; si elle ne vient pas
//                (erreur, limiteur, ou aucune réponse au bout de 12 s), un message le dit
//                avec « Réessayer » et les jours ne sont PAS présentés comme libres (le
//                serveur revalide à la réservation). Une écriture faite entre-temps
//                (panier, réservation : `dataVersion` d'api.js) périme le cache du mois.
//                `noun` (« poste » | « place », issu de `seatNoun`) : le mot de l'étiquette
//                vocale d'un jour (« 3 postes restants »). Absent : repli « place » (seatNoun(null)).
//   permissive   écrans administrateur : les jours fermés / complets restent marqués
//                mais restent sélectionnables (surbooking, hors horaires). Seules les
//                bornes min / max bloquent.
//
// Ordinateur : bulle ancrée sous le champ, un clic sur un jour valide et ferme.
// Téléphone (≤ 760 px) : feuille du bas, le choix attend « Valider », champ en lecture seule.
// La bulle et la feuille sont rattachées à document.body : une modale (`overflow:auto`)
// ne peut pas les tronquer, et leur z-index (110) passe au-dessus de `.modal-overlay` (100).

const MOBILE_QUERY = '(max-width: 760px)';
const WEEK_HEAD = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const WEEK_FROM_MONDAY = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const STATUSES = ['open', 'partial', 'full', 'closed', 'past'];
const MSG_UNAVAILABLE = 'Disponibilités indisponibles pour ce mois.';
// Fenêtre de mois que la route accepte, relative au mois courant (miroir de
// MONTH_MIN_OFFSET / MONTH_MAX_OFFSET côté serveur) : on n'émet jamais une requête
// qu'on sait refusée (400), car elle consommerait quand même le quota du limiteur.
const WINDOW_BACK = -1;
const WINDOW_AHEAD = 36;
// Une réponse reste valable 2 min : on ne requête pas à chaque ouverture ou retour
// sur un mois. Passé ce délai, elle reste affichée pendant qu'on la rafraîchit.
const FRESH_MS = 120000;
// Au-delà, une requête sans réponse est tenue pour échouée : l'état « Chargement »
// n'est jamais définitif, on retombe sur l'état d'échec, qui propose « Réessayer ».
const LOAD_TIMEOUT_MS = 12000;
// Gelé en profondeur : cet objet est la valeur initiale de TOUTES les instances. Toute
// écriture passe par une copie (`{ ...c.failed }`) ; si l'une l'oubliait, elle lèverait
// ici au lieu de corrompre silencieusement les autres sélecteurs.
const EMPTY_CACHE = Object.freeze({
  key: '', exclusive: false, unsupported: false, months: Object.freeze({}), failed: Object.freeze({}),
});
// Une réponse rangée n'est exploitable que si aucune écriture (panier, réservation,
// déplacement…) n'a eu lieu depuis qu'on l'a demandée : voir `dataVersion` (api.js).
const usable = (entry) => !!entry && entry.v === dataVersion();

const ICON_PREV = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
);
const ICON_NEXT = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);
const ICON_DOWN = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
const ICON_CAL = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);

export default function DatePicker({ value = '', onChange, min, max, disabled = false, label, id, availability, permissive = false }) {
  const autoId = useId().replace(/:/g, '');
  const inputId = id || `dp-${autoId}`;
  const hintId = `${inputId}-hint`;
  const bodyId = `${inputId}-body`;

  const today = todayStr();
  const lo = min !== undefined ? (min || '') : (permissive ? '' : today);
  const hi = max !== undefined ? (max || '') : addMonthsStr(today, 36);
  // Fenêtre de la route (mois -1 .. +36).
  const winLoKey = addMonthsStr(today, WINDOW_BACK).slice(0, 7);
  const winHiKey = addMonthsStr(today, WINDOW_AHEAD).slice(0, 7);

  const [text, setText] = useState(value ? fmtFR(value) : '');
  const [hint, setHint] = useState('');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('pop'); // 'pop' | 'sheet'
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [viewMode, setViewMode] = useState('days'); // 'days' | 'months'
  const [view, setView] = useState(() => { const p = parseIso(value || todayStr()); return { y: p.y, m: p.m }; });
  const [focusIso, setFocusIso] = useState('');
  const [pending, setPending] = useState('');
  const [live, setLive] = useState('');
  const [cache, setCache] = useState(EMPTY_CACHE);
  const [retry, setRetry] = useState(0);

  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const lastEmitted = useRef(value);
  const focusReq = useRef(false);
  const dragY = useRef(null);
  const inflight = useRef(new Set()); // requêtes en vol DE CETTE INSTANCE (voir l'effet de chargement)
  const liveTimer = useRef(0);
  const saidSinceOpen = useRef(false);
  const viewRef = useRef(null);

  // ── Disponibilités (GET /api/availability/month) ───────────────────────────
  const spaceId = availability?.spaceId ? String(availability.spaceId) : '';
  const seatsQ = Math.max(1, Number(availability?.seats) || 1);
  const tarifQ = availability?.tarifType || 'heure';
  const slotQ = tarifQ !== 'heure' ? (availability?.slot || '') : '';
  const exclQ = availability?.excludeReservationId ? String(availability.excludeReservationId) : '';
  const queryKey = spaceId ? [spaceId, seatsQ, tarifQ, slotQ, exclQ].join('|') : '';
  const monthKey = `${view.y}-${pad(view.m + 1)}`;
  // Écritures vues par api.js : une écriture qui survient calendrier ouvert périme le mois
  // affiché (`usable`) ; la changer ici relance l'effet de chargement, sinon le mois resterait
  // en « Chargement » sans requête pour le remplacer.
  const writes = dataVersion();
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  viewRef.current = view;

  // Navigation bornée à la fenêtre de la route, indépendamment de `min` / `max`
  // (sans minimum, `permissive` permettrait de reculer sans fin, une requête 400 par clic).
  // Sans disponibilités, aucune requête : seules `lo` / `hi` bornent.
  const winLoDay = `${winLoKey}-01`;
  const winHiDay = mkIso(Number(winHiKey.slice(0, 4)), Number(winHiKey.slice(5)) - 1, daysIn(Number(winHiKey.slice(0, 4)), Number(winHiKey.slice(5)) - 1));
  const navLo = queryKey ? (lo && lo > winLoDay ? lo : winLoDay) : lo;
  const navHi = queryKey ? (hi && hi < winHiDay ? hi : winHiDay) : hi;

  // Chargé quand le calendrier est ouvert sur un mois qu'on n'a pas (ou plus frais). Le
  // cache n'est PAS vidé à l'ouverture : il ne change que si les paramètres de
  // disponibilité changent (`queryKey`). Une réponse reçue est toujours rangée tant que
  // les paramètres sont les mêmes, même si l'on a changé de mois entre-temps.
  //
  // Dédoublonnage : `inflight` est PAR INSTANCE (useRef), jamais au niveau du module. Le
  // cache est par instance ; un ensemble partagé ferait sortir une 2e instance de
  // l'effet « parce qu'une requête est partie », alors que la réponse n'irait que dans
  // le cache de la 1re : la 2e resterait en « Chargement » sans issue. Coût assumé : deux
  // sélecteurs sur le même espace font chacun leur requête (60/min/IP côté serveur, une
  // requête par ouverture de mois : large marge).
  useEffect(() => {
    if (!open || !queryKey || viewMode !== 'days') return;
    if (monthKey < winLoKey || monthKey > winHiKey) return;
    if ((lo && monthKey < lo.slice(0, 7)) || (hi && monthKey > hi.slice(0, 7))) return;
    const same = cache.key === queryKey;
    if (same && cache.unsupported) return;
    const entry = same ? cache.months[monthKey] : undefined;
    if (usable(entry) && Date.now() - entry.at < FRESH_MS) return;
    const flight = `${queryKey}|${monthKey}`;
    if (inflight.current.has(flight)) return;
    inflight.current.add(flight);
    if (same && cache.failed[monthKey]) {
      setCache((c) => { const failed = { ...c.failed }; delete failed[monthKey]; return { ...c, failed }; });
    }
    const qs = new URLSearchParams({ space_id: spaceId, month: monthKey, seats: String(seatsQ), tarif_type: tarifQ });
    if (slotQ) qs.set('slot', slotQ);
    if (exclQ) qs.set('exclude_reservation_id', exclQ);
    const base = (c) => (c.key === queryKey ? c : { ...EMPTY_CACHE, key: queryKey });
    // Version des écritures AU DÉPART de la requête : si le panier bouge pendant le vol,
    // la réponse arrive déjà périmée et sera redemandée.
    const version = dataVersion();
    // « Je ne sais pas » : jamais présenté comme « libre ». Une réponse exploitable déjà
    // affichée est conservée.
    const markFailed = () => {
      setCache((c) => { const b = base(c); return usable(b.months[monthKey]) ? b : { ...b, failed: { ...b.failed, [monthKey]: true } }; });
      say(MSG_UNAVAILABLE);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      inflight.current.delete(flight); // libère la clé : « Réessayer » doit pouvoir repartir
      if (keyRef.current === queryKey) markFailed();
    }, LOAD_TIMEOUT_MS);
    api.get(`/availability/month?${qs.toString()}`)
      .then((r) => {
        if (keyRef.current !== queryKey) return;
        if (!Array.isArray(r?.days)) throw new Error('REPONSE_INVALIDE');
        const days = {};
        for (const d of r.days) {
          if (d && typeof d.date === 'string' && STATUSES.includes(d.status)) {
            days[d.date] = { status: d.status, left: Number.isFinite(d.seats_left) ? d.seats_left : null };
          }
        }
        // Réponse tardive après le délai : acceptée (elle efface l'échec affiché).
        setCache((c) => {
          const b = base(c);
          const failed = { ...b.failed }; delete failed[monthKey];
          return { ...b, exclusive: !!r.exclusive, failed, months: { ...b.months, [monthKey]: { days, at: Date.now(), v: version } } };
        });
      })
      .catch((err) => {
        if (keyRef.current !== queryKey) return;
        // Espace sans disponibilités publiques (non réservable en ligne) : calendrier neutre, sans erreur.
        if (err?.code === 'ESPACE_NON_RESERVABLE' || err?.code === 'ESPACE_INTROUVABLE') {
          setCache((c) => ({ ...base(c), unsupported: true }));
          return;
        }
        if (!timedOut) markFailed();
      })
      .finally(() => {
        clearTimeout(timer);
        // Après un délai dépassé la clé a déjà été libérée (et peut appartenir à une
        // requête plus récente) : on n'y touche pas.
        if (!timedOut) inflight.current.delete(flight);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queryKey, monthKey, viewMode, retry, writes]);

  // Ce que l'on sait d'un jour : voir `dayInfo` (datePickerCore.js) pour les quatre états.
  const dayCtx = (s, inView) => {
    const base = { lo, hi, permissive };
    if (!queryKey) return base;
    const same = cache.key === queryKey;
    if (same && cache.unsupported) return base;
    const mk = s.slice(0, 7);
    if (mk < winLoKey || mk > winHiKey) return base;
    const m = same && usable(cache.months[mk]) ? cache.months[mk] : undefined;
    if (m) {
      const rec = m.days[s];
      return rec ? { ...base, state: 'ready', rec, exclusive: cache.exclusive } : { ...base, state: 'unknown' };
    }
    if (!inView) return { ...base, state: 'unknown' }; // jour d'un mois voisin, non chargé
    return { ...base, state: same && cache.failed[mk] ? 'unknown' : 'loading' };
  };
  const dayInfoOf = (s, inView = true) => dayInfo(s, dayCtx(s, inView));
  const viewState = !queryKey ? 'neutral' : (cache.key === queryKey && cache.unsupported) ? 'neutral'
    : (monthKey < winLoKey || monthKey > winHiKey) ? 'neutral'
    : cache.key === queryKey && usable(cache.months[monthKey]) ? 'ready'
    : cache.key === queryKey && cache.failed[monthKey] ? 'unknown' : 'loading';
  const exclusiveNow = cache.key === queryKey && cache.exclusive;

  const clamp = (s) => (navLo && s < navLo ? navLo : navHi && s > navHi ? navHi : s);
  const shown = mode === 'sheet' ? pending : value;

  // ── Synchronisation du champ texte avec `value` ────────────────────────────
  // Un changement de `value` venu de ce composant (lastEmitted) ne réécrit pas le
  // texte, pour ne pas effacer une saisie en cours.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setText(value ? fmtFR(value) : '');
    setHint('');
  }, [value]);

  // Champ désactivé (ex. « Dès que possible ») : le texte suit la valeur, plus de saisie partielle.
  useEffect(() => {
    if (!disabled) return;
    setText(value ? fmtFR(value) : '');
    setHint('');
    setOpen(false);
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bascule ordinateur / téléphone : le champ devient en lecture seule, un calendrier ouvert se ferme.
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onMq = () => { setMobile(mql.matches); setOpen(false); setViewMode('days'); };
    if (mql.addEventListener) mql.addEventListener('change', onMq); else mql.addListener(onMq);
    return () => { if (mql.removeEventListener) mql.removeEventListener('change', onMq); else mql.removeListener(onMq); };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  // Annonce pour lecteur d'écran. La région est d'abord VIDÉE puis remplie au tick suivant :
  // réannoncer le même texte (cliquer deux fois le même jour indisponible) ne change pas le
  // contenu et ne redéclencherait rien. Toute annonce explicite prime sur celle d'ouverture.
  const say = (t) => {
    saidSinceOpen.current = true;
    clearTimeout(liveTimer.current);
    setLive('');
    liveTimer.current = setTimeout(() => setLive(t), 60);
  };
  const announce = say;
  const emit = (s) => { lastEmitted.current = s; if (s !== value) onChange?.(s); };
  const commit = (s) => { setText(s ? fmtFR(s) : ''); setHint(''); emit(s); };
  const showMonth = (s) => { const p = parseIso(s); setView({ y: p.y, m: p.m }); };

  const closeCal = (refocus) => {
    setOpen(false);
    setViewMode('days');
    if (refocus && inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
  };

  const openCal = (focusGrid) => {
    if (open || disabled) return;
    const m = window.matchMedia(MOBILE_QUERY).matches ? 'sheet' : 'pop';
    const f = clamp(value || today);
    setMode(m);
    setViewMode('days');
    setPending(value);
    setFocusIso(f);
    showMonth(f);
    focusReq.current = focusGrid || m === 'sheet';
    setOpen(true);
  };

  const moveTo = (s0) => {
    const s = clamp(s0);
    const before = view.y * 12 + view.m;
    const p = parseIso(s);
    setFocusIso(s);
    setView({ y: p.y, m: p.m });
    focusReq.current = true;
    if (p.y * 12 + p.m !== before) announce(`${MONTHS[p.m]} ${p.y}`);
  };

  const shift = (n) => {
    if (viewMode === 'days') {
      const t = view.y * 12 + view.m + n;
      const y = Math.floor(t / 12); const m = t % 12;
      setView({ y, m });
      setFocusIso(clamp(mkIso(y, m, Math.min(parseIso(focusIso).d, daysIn(y, m)))));
      announce(`${MONTHS[m]} ${y}`);
    } else {
      setView({ y: view.y + n, m: view.m });
      announce(String(view.y + n));
    }
  };

  const toggleView = () => {
    const next = viewMode === 'days' ? 'months' : 'days';
    setViewMode(next);
    announce(next === 'months' ? `Choisir un mois, ${view.y}` : `${MONTHS[view.m]} ${view.y}`);
  };

  const chooseMonth = (i) => {
    const f = clamp(mkIso(view.y, i, Math.min(parseIso(focusIso).d, daysIn(view.y, i))));
    setViewMode('days');
    setFocusIso(f);
    showMonth(f);
    focusReq.current = true;
    announce(`${MONTHS[parseIso(f).m]} ${parseIso(f).y}`);
  };

  const pick = (s) => {
    const info = dayInfoOf(s, s.slice(0, 7) === monthKey);
    if (!info.sel) { announce(`${longLabel(s)}. ${info.why}`); return; }
    setFocusIso(s);
    showMonth(s);
    if (mode === 'sheet') {
      setPending(s);
      focusReq.current = true;
      announce(`Date choisie : ${longLabel(s)}. Appuyez sur Valider pour confirmer.`);
    } else {
      commit(s);
      closeCal(true);
    }
  };

  const goToday = () => {
    const s = clamp(today);
    setViewMode('days');
    setFocusIso(s);
    showMonth(s);
    const info = dayInfoOf(s, true);
    if (info.sel) pick(s);
    else { focusReq.current = true; announce(`${longLabel(s)}. ${info.why}`); }
  };

  const clearVal = () => {
    if (mode === 'sheet') { setPending(''); announce('Sélection effacée'); return; }
    commit('');
    closeCal(true);
  };

  const validate = () => {
    commit(pending);
    closeCal(true);
  };

  // ── Clavier dans la grille ─────────────────────────────────────────────────
  const monthDisabled = (y, i) => !!((navLo && mkIso(y, i, daysIn(y, i)) < navLo) || (navHi && mkIso(y, i, 1) > navHi));

  const onKeyDown = (e) => {
    if (e.key === 'Tab' && rootRef.current) {
      const f = [...rootRef.current.querySelectorAll('button:not([disabled])')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      const atFirst = document.activeElement === first || !rootRef.current.contains(document.activeElement);
      const atLast = document.activeElement === last;
      if (mode === 'sheet') {
        // Feuille modale : le focus boucle.
        if (e.shiftKey && atFirst) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && atLast) { e.preventDefault(); first.focus(); }
      } else if ((e.shiftKey && atFirst) || (!e.shiftKey && atLast)) {
        // Bulle : sortir du calendrier le ferme et rend le focus au champ, pour ne pas
        // aller se poser sur les champs de la modale restés derrière une bulle ouverte.
        e.preventDefault();
        closeCal(true);
      }
      return;
    }
    const cell = e.target.closest?.('[data-day]');
    if (cell) {
      const cur = cell.dataset.day;
      const w = (weekday(cur) + 6) % 7; // 0 = lundi
      let t = null;
      // La cellule n'est plus un <button> : Entrée et Espace ne déclenchent plus de clic natif.
      if ((e.key === 'Enter' || e.key === ' ') && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        pick(cur);
        return;
      }
      switch (e.key) {
        case 'ArrowLeft': t = addDaysStr(cur, -1); break;
        case 'ArrowRight': t = addDaysStr(cur, 1); break;
        case 'ArrowUp': t = addDaysStr(cur, -7); break;
        case 'ArrowDown': t = addDaysStr(cur, 7); break;
        case 'Home': t = addDaysStr(cur, -w); break;
        case 'End': t = addDaysStr(cur, 6 - w); break;
        case 'PageUp': t = addMonthsStr(cur, e.shiftKey ? -12 : -1); break;
        case 'PageDown': t = addMonthsStr(cur, e.shiftKey ? 12 : 1); break;
        default: break;
      }
      if (t) { e.preventDefault(); moveTo(t); }
      return;
    }
    const mb = e.target.closest?.('[data-month]');
    if (mb) {
      const i = Number(mb.dataset.month);
      let n;
      if (e.key === 'ArrowLeft') n = i - 1;
      else if (e.key === 'ArrowRight') n = i + 1;
      else if (e.key === 'ArrowUp') n = i - 3;
      else if (e.key === 'ArrowDown') n = i + 3;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = 11;
      else return;
      e.preventDefault();
      n = Math.max(0, Math.min(11, n));
      if (!monthDisabled(view.y, n)) { setView({ y: view.y, m: n }); focusReq.current = true; }
    }
  };

  // ── Champ texte ────────────────────────────────────────────────────────────
  const onInput = (e) => {
    let v = e.target.value;
    if (!/^delete/.test(e.nativeEvent?.inputType || '')) {
      const d = v.replace(/\D/g, '').slice(0, 8); // barres obliques automatiques
      v = d.slice(0, 2) + (d.length > 2 ? `/${d.slice(2, 4)}` : '') + (d.length > 4 ? `/${d.slice(4)}` : '');
    }
    setText(v);
    setHint('');
    if (v.length === 10) {
      const s = parseFR(v);
      if (!s) { setHint("Cette date n'existe pas."); emit(''); return; }
      const info = dayInfoOf(s, s.slice(0, 7) === monthKey);
      // Disponibilités pas (encore) chargées : la saisie est acceptée, le serveur revalide à la réservation.
      if (!info.sel && info.k !== 'pending') { setHint(info.why); emit(''); return; }
      emit(s);
      setPending(s);
      if (open) { setFocusIso(s); showMonth(s); }
    } else if (value) {
      emit('');
      setPending('');
    }
  };

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openCal(true);
      else rootRef.current?.querySelector('[data-day][tabindex="0"]')?.focus();
    } else if (e.key === 'Enter' && open && mode === 'pop') {
      e.preventDefault(); // ne soumet pas le formulaire englobant
      closeCal(false);
    }
  };

  // ── Effets liés à l'ouverture ──────────────────────────────────────────────
  // Focus demandé par une action (flèches, ouverture au clavier…).
  useEffect(() => {
    if (!focusReq.current || !rootRef.current) return;
    focusReq.current = false;
    const sel = viewMode === 'days' ? '[data-day][tabindex="0"]' : '[data-month][tabindex="0"]';
    rootRef.current.querySelector(sel)?.focus();
  });

  // Bulle : position fixe sous le champ, recalculée à chaque rendu (la hauteur varie)
  // et quand la page ou la modale défile.
  const place = () => {
    const el = rootRef.current; const box = boxRef.current;
    if (!el || !box || mode !== 'pop') return;
    const r = box.getBoundingClientRect();
    // Le champ a défilé hors de l'écran (modale qui défile) : la bulle n'a plus d'ancre, on ferme.
    if (r.bottom <= 0 || r.top >= window.innerHeight) { setOpen(false); setViewMode('days'); return; }
    const w = Math.min(320, window.innerWidth - 16);
    el.style.width = `${w}px`;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = r.top - 8 - h > 8 ? r.top - 8 - h : Math.max(8, window.innerHeight - h - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  useLayoutEffect(() => { if (open) place(); });
  useEffect(() => {
    if (!open || mode !== 'pop') return undefined;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // Clic en dehors de la bulle : fermeture (sans reprendre le focus).
  useEffect(() => {
    if (!open || mode !== 'pop') return undefined;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target) || boxRef.current?.contains(e.target)) return;
      setOpen(false);
      setViewMode('days');
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [open, mode]);

  // Échap : revient de la grille des mois, sinon ferme.
  useEffect(() => {
    if (!open) return undefined;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // le calendrier consomme la touche : pas de fermeture en cascade (panneau d'aide…)
      if (viewMode === 'months') {
        setViewMode('days');
        rootRef.current?.querySelector('[data-act="toggle"]')?.focus();
      } else {
        setOpen(false);
        setViewMode('days');
        if (inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
      }
    };
    // Phase de CAPTURE : on passe avant les écouteurs `keydown` des autres composants sur
    // `document` (qu'un simple `stopPropagation` en phase de bulle n'atteindrait pas).
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [open, viewMode]);

  // Annonce d'ouverture DIFFÉRÉE : une région live n'annonce pas son contenu initial,
  // donc le message ne doit pas être posé au même rendu que le montage de la région.
  // Elle ne passe jamais devant un message plus important (échec de chargement, changement
  // de mois…) : si quoi que ce soit a été annoncé depuis l'ouverture, elle s'efface. Le mois
  // est relu au déclenchement (`viewRef`), pas à l'ouverture.
  useEffect(() => {
    if (!open) return undefined;
    saidSinceOpen.current = false;
    const t = setTimeout(() => {
      if (saidSinceOpen.current) return;
      const v = viewRef.current;
      setLive(`Calendrier, ${MONTHS[v.m]} ${v.y}`);
    }, 250);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => () => clearTimeout(liveTimer.current), []);

  // Feuille du bas : la page derrière ne défile pas.
  useEffect(() => {
    if (!open || mode !== 'sheet') return undefined;
    document.documentElement.classList.add('dp-lock');
    return () => document.documentElement.classList.remove('dp-lock');
  }, [open, mode]);

  // Poignée de la feuille : glisser vers le bas ferme.
  const onGrabDown = (e) => {
    dragY.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (rootRef.current) { rootRef.current.style.animation = 'none'; rootRef.current.style.transition = 'none'; }
  };
  const onGrabMove = (e) => {
    if (dragY.current === null || !rootRef.current) return;
    rootRef.current.style.transform = `translateY(${Math.max(0, e.clientY - dragY.current)}px)`;
  };
  const onGrabEnd = (e, cancel) => {
    if (dragY.current === null) return;
    const dy = e.clientY - dragY.current;
    dragY.current = null;
    if (!cancel && dy > 90) { closeCal(true); return; }
    if (rootRef.current) { rootRef.current.style.transition = 'transform .2s'; rootRef.current.style.transform = ''; }
  };

  // ── Rendu ──────────────────────────────────────────────────────────────────
  const prevDisabled = viewMode === 'days'
    ? !!navLo && mkIso(view.m === 0 ? view.y - 1 : view.y, (view.m + 11) % 12, daysIn(view.m === 0 ? view.y - 1 : view.y, (view.m + 11) % 12)) < navLo
    : !!navLo && mkIso(view.y - 1, 11, 31) < navLo;
  const nextDisabled = viewMode === 'days'
    ? !!navHi && mkIso(view.m === 11 ? view.y + 1 : view.y, (view.m + 1) % 12, 1) > navHi
    : !!navHi && mkIso(view.y + 1, 0, 1) > navHi;

  function renderDays() {
    const first = mkIso(view.y, view.m, 1);
    const lead = (weekday(first) + 6) % 7;
    const start = addDaysStr(first, -lead);
    const rows = [];
    for (let r = 0; r < 6; r++) {
      const cells = [];
      for (let c = 0; c < 7; c++) {
        const s = addDaysStr(start, r * 7 + c);
        const p = parseIso(s);
        const info = dayInfoOf(s, p.m === view.m);
        let cls = 'dp-day';
        let lab = longLabel(s);
        if (p.m !== view.m) cls += ' is-out';
        if (info.k === 'disabled') { cls += ' is-disabled'; lab += ', indisponible'; }
        if (info.k === 'closed') { cls += ' is-closed'; lab += ', fermé'; }
        if (info.k === 'full') { cls += ' is-full'; lab += exclusiveNow ? ', réservé' : ', complet'; }
        if (info.k === 'partial') {
          if (exclusiveNow) lab += ', partiellement réservé';
          else lab += info.left != null ? `, ${seatsRemaining(availability?.noun === 'poste' ? 'poste' : 'place', info.left)}` : ', quelques places';
        }
        if (info.k === 'open') lab += ', libre';
        if (info.k === 'pending') cls += ' is-pending';
        if (s === today) { cls += ' is-today'; lab += ", aujourd'hui"; }
        const sel = s === shown;
        if (sel) cls += ' is-selected';
        const dot = info.k === 'open' ? 'free' : info.k === 'partial' ? 'partial' : info.k === 'full' ? 'full' : '';
        cells.push(
          // Motif APG (sélecteur de date) : la CELLULE est l'élément focusable (`tabindex` itinérant)
          // et porte `aria-selected` / `aria-disabled`. Aucun <button> imbriqué : un rôle posé
          // sur un bouton écraserait son rôle natif. La pastille visuelle est un <div> interne.
          <td
            key={s}
            role="gridcell"
            data-day={s}
            tabIndex={s === focusIso ? 0 : -1}
            aria-label={lab}
            aria-selected={sel}
            aria-current={s === today ? 'date' : undefined}
            aria-disabled={!info.sel || undefined}
            onClick={() => pick(s)}
          >
            <div className={cls}>
              <span>{p.d}</span>
              {dot ? <i className={`dp-dot ${dot}`} /> : null}
            </div>
          </td>
        );
      }
      rows.push(<tr key={r} role="row">{cells}</tr>);
    }
    return (
      <table className="dp-grid" role="grid" aria-label={`${MONTHS[view.m]} ${view.y}`} aria-busy={viewState === 'loading' ? 'true' : undefined}>
        <thead>
          <tr role="row">
            {WEEK_HEAD.map((h, i) => (
              <th key={i} scope="col" role="columnheader" abbr={WEEK_FROM_MONDAY[i]}>
                <span aria-hidden="true">{h}</span><span className="dp-sr">{WEEK_FROM_MONDAY[i]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    );
  }

  function renderMonths() {
    const tp = parseIso(today);
    const sp = shown ? parseIso(shown) : null;
    return (
      <div className="dp-months" role="group" aria-label={`Mois de ${view.y}`}>
        {MONTHS.map((name, i) => {
          let cls = 'dp-month';
          if (tp.y === view.y && tp.m === i) cls += ' is-today';
          if (sp && sp.y === view.y && sp.m === i) cls += ' is-selected';
          return (
            <button key={name} type="button" className={cls} data-month={i} tabIndex={i === view.m ? 0 : -1}
              disabled={monthDisabled(view.y, i)} onClick={() => chooseMonth(i)}>
              {name}
            </button>
          );
        })}
      </div>
    );
  }

  const calendar = (
    <div
      ref={rootRef}
      className={`dp ${mode === 'sheet' ? 'dp-sheet' : 'dp-pop'}`}
      role="dialog"
      aria-modal={mode === 'sheet' ? 'true' : undefined}
      aria-label={label ? `Calendrier : ${label}` : 'Choisir une date'}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {mode === 'sheet' && (
        <div className="dp-grab" onPointerDown={onGrabDown} onPointerMove={onGrabMove}
          onPointerUp={(e) => onGrabEnd(e, false)} onPointerCancel={(e) => onGrabEnd(e, true)}>
          <span className="dp-handle" />
        </div>
      )}
      <div className="dp-head">
        <button type="button" className="dp-nav" data-act="prev" disabled={prevDisabled} onClick={() => shift(-1)}
          aria-label={viewMode === 'days' ? 'Mois précédent' : 'Année précédente'}>{ICON_PREV}</button>
        <button type="button" className="dp-title" data-act="toggle" aria-expanded={viewMode === 'months'} aria-controls={bodyId} onClick={toggleView}>
          <span>{viewMode === 'days' ? `${MONTHS[view.m]} ${view.y}` : String(view.y)}</span>
          <span className="dp-sr">, changer de mois ou d'année</span>
          {ICON_DOWN}
        </button>
        <button type="button" className="dp-nav" data-act="next" disabled={nextDisabled} onClick={() => shift(1)}
          aria-label={viewMode === 'days' ? 'Mois suivant' : 'Année suivante'}>{ICON_NEXT}</button>
      </div>
      <div id={bodyId}>{viewMode === 'days' ? renderDays() : renderMonths()}</div>
      {viewMode === 'days' && viewState === 'ready' && (
        <ul className="dp-legend">
          <li><i className="dp-dot free" />Libre</li>
          <li><i className="dp-dot partial" />{exclusiveNow ? 'Partiellement réservé' : 'Quelques places'}</li>
          <li><i className="dp-dot full" />{exclusiveNow ? 'Réservé' : 'Complet'}</li>
          <li><i className="dp-hatch" />Fermé</li>
        </ul>
      )}
      {viewMode === 'days' && viewState === 'loading' && <p className="dp-note">Chargement des disponibilités…</p>}
      {viewMode === 'days' && viewState === 'unknown' && (
        <p className="dp-note is-warn">
          Disponibilités indisponibles pour le moment, à vérifier à la réservation.{' '}
          <button type="button" className="dp-retry" onClick={() => setRetry((n) => n + 1)}>Réessayer</button>
        </p>
      )}
      {mode === 'sheet' && (
        <p className="dp-sel">
          {shown ? <>Sélection : <strong>{longLabel(shown)}</strong></> : 'Aucun jour sélectionné'}
        </p>
      )}
      <div className="dp-foot">
        <button type="button" className="outline small" onClick={goToday}>Aujourd'hui</button>
        <button type="button" className="outline small" onClick={clearVal}>Effacer</button>
      </div>
      {mode === 'sheet' && <button type="button" className="dp-ok" onClick={validate}>Valider</button>}
      <div className="dp-sr" role="status" aria-live="polite">{live}</div>
    </div>
  );

  return (
    <div className="field dp-field">
      {label ? <label htmlFor={inputId}>{label}</label> : null}
      <div className="dp-box" ref={boxRef}
        onKeyDown={(e) => { if (e.key === 'Tab' && open && mode === 'pop') closeCal(false); }}>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="jj/mm/aaaa"
          maxLength={10}
          value={text}
          readOnly={mobile}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-describedby={hintId}
          onChange={onInput}
          onClick={() => openCal(false)}
          onKeyDown={onInputKeyDown}
        />
        <button
          type="button"
          className="dp-cal-btn"
          aria-label="Ouvrir le calendrier"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => (open ? closeCal(true) : openCal(true))}
        >
          {ICON_CAL}
        </button>
      </div>
      <div className="dp-hint" id={hintId} role="status" aria-live="polite">
        {hint ? <span className="badge red">{hint}</span> : null}
      </div>
      {open && createPortal(
        mode === 'sheet' ? (
          <div className="dp-overlay"
            onPointerDown={(e) => { if (e.target === e.currentTarget) closeCal(true); }}
            onClick={(e) => e.stopPropagation()}>
            {calendar}
          </div>
        ) : calendar,
        document.body,
      )}
    </div>
  );
}
