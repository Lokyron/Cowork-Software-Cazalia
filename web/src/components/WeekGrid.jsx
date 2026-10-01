import { useMemo, useRef, useState } from 'react';
import { parisDateKey, parisMinutes, parisTimeHM, weekdayLabel, dayNumLabel } from '../time.js';

const DAY_START = 7;   // 07:00
const DAY_END = 22;    // 22:00
const HOUR_PX = 46;
const START_MIN = DAY_START * 60;
const TOTAL_MIN = (DAY_END - DAY_START) * 60;
const SNAP = 15;       // pas d'accroche (minutes)

// Affecte des colonnes aux événements qui se chevauchent (packing par "cluster").
function layoutDay(events) {
  const sorted = [...events].sort((a, b) => a._s - b._s || a._e - b._e);
  const out = {};
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const colEnds = [];
    for (const ev of cluster) {
      let placed = -1;
      for (let i = 0; i < colEnds.length; i++) {
        if (colEnds[i] <= ev._s) { colEnds[i] = ev._e; placed = i; break; }
      }
      if (placed < 0) { colEnds.push(ev._e); placed = colEnds.length - 1; }
      out[ev.id] = { col: placed };
    }
    for (const ev of cluster) out[ev.id].cols = colEnds.length;
    cluster = []; clusterEnd = -1;
  };
  for (const ev of sorted) {
    if (cluster.length && ev._s >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev._e);
  }
  flush();
  return out;
}

const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Grille hebdomadaire réutilisable. `events` : réservations (avec start_at/end_at).
// `renderEvent(ev)` → { color, tooltip, main, sub }. `onSelectSlot({date,startHM,endHM})`
// est appelé au relâchement d'un drag (ou d'un clic simple = 1 h) si fourni.
export default function WeekGrid({ days, today, events, renderEvent, onEventClick, onSelectSlot }) {
  const [sel, setSel] = useState(null);   // { day, from, to } en minutes
  const drag = useRef(null);

  const hours = useMemo(() => Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i), []);
  const byDay = useMemo(() => {
    const map = {};
    for (const r of events) {
      const key = parisDateKey(r.start_at);
      const ev = { ...r, _s: parisMinutes(r.start_at), _e: parisMinutes(r.end_at) };
      if (ev._e <= ev._s) ev._e = ev._s + 30;
      (map[key] ||= []).push(ev);
    }
    return map;
  }, [events]);

  const yToMin = (clientY, colEl) => {
    const rect = colEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const min = Math.round((START_MIN + ratio * TOTAL_MIN) / SNAP) * SNAP;
    return Math.min(START_MIN + TOTAL_MIN, Math.max(START_MIN, min));
  };

  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const m = yToMin(e.clientY, d.colEl);
    setSel({ day: d.day, from: Math.min(d.anchor, m), to: Math.max(d.anchor, m) });
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const d = drag.current; drag.current = null;
    setSel((cur) => {
      if (d && cur) {
        let { day, from, to } = cur;
        if (to - from < SNAP) to = Math.min(START_MIN + TOTAL_MIN, from + 60); // clic simple → 1 h
        onSelectSlot?.({ date: day, startHM: hm(from), endHM: hm(to) });
      }
      return null;
    });
  };
  const onDown = (day, e) => {
    if (e.button !== 0 || !onSelectSlot) return;
    const colEl = e.currentTarget;
    const m = yToMin(e.clientY, colEl);
    drag.current = { day, colEl, anchor: m };
    setSel({ day, from: m, to: m });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="cal-scroll">
        <div className="cal-head">
          <div className="cal-gutter-h" />
          {days.map((d) => (
            <div key={d} className={`cal-dayhead ${d === today ? 'today' : ''}`}>
              <span className="cal-dow">{weekdayLabel(d)}</span>
              <span className="cal-dnum">{dayNumLabel(d)}</span>
            </div>
          ))}
        </div>

        <div className="cal-body" style={{ height: hours.length * HOUR_PX }}>
          <div className="cal-gutter">
            {hours.map((h) => (
              <div key={h} className="cal-hourlabel" style={{ height: HOUR_PX }}>{String(h).padStart(2, '0')}:00</div>
            ))}
          </div>

          {days.map((d) => {
            const evs = byDay[d] || [];
            const layout = layoutDay(evs);
            return (
              <div key={d} className={`cal-col ${onSelectSlot ? 'cal-col-book' : ''}`} onMouseDown={(e) => onDown(d, e)}>
                {hours.map((h) => <div key={h} className="cal-slot" style={{ height: HOUR_PX }} />)}

                {sel && sel.day === d && sel.to > sel.from && (
                  <div className="cal-sel" style={{
                    top: `${((sel.from - START_MIN) / TOTAL_MIN) * 100}%`,
                    height: `${((sel.to - sel.from) / TOTAL_MIN) * 100}%`,
                  }}>{hm(sel.from)}–{hm(sel.to)}</div>
                )}

                {evs.map((ev) => {
                  const top = ((Math.max(ev._s, START_MIN) - START_MIN) / TOTAL_MIN) * 100;
                  const height = ((Math.min(ev._e, START_MIN + TOTAL_MIN) - Math.max(ev._s, START_MIN)) / TOTAL_MIN) * 100;
                  const { col, cols } = layout[ev.id];
                  const width = 100 / cols;
                  const c = renderEvent(ev);
                  return (
                    <button
                      key={ev.id}
                      className="cal-event"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onEventClick?.(ev); }}
                      style={{
                        top: `${top}%`, height: `calc(${Math.max(height, 3)}% - 2px)`,
                        left: `calc(${col * width}% + 2px)`, width: `calc(${width}% - 4px)`,
                        background: c.color || 'var(--navy)',
                      }}
                      title={c.tooltip}
                    >
                      <span className="cal-ev-time">{parisTimeHM(ev.start_at)}</span>
                      <span className="cal-ev-title">{c.main}</span>
                      <span className="cal-ev-sub">{c.sub}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
