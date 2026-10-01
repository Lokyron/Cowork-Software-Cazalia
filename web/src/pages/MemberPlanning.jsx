import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api, msg } from '../api.js';
import { parisTimeHM, fmtDateTime, addDaysStr, startOfWeekStr, todayStr, dayNumLabel } from '../time.js';
import GoogleCalendarLink from '../components/GoogleCalendarLink.jsx';
import WeekGrid from '../components/WeekGrid.jsx';
import BookingModal from '../components/BookingModal.jsx';
import VoucherBlock from '../components/VoucherBlock.jsx';

export default function MemberPlanning() {
  const [weekStart, setWeekStart] = useState(() => startOfWeekStr(todayStr()));
  const [reservations, setReservations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [booking, setBooking] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const load = useCallback(async () => {
    const r = await api.get('/reservations/me');
    setReservations(r.reservations.filter((x) => x.status === 'confirmed'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i)), [weekStart]);
  const today = todayStr();

  const goToday = () => setWeekStart(startOfWeekStr(todayStr()));
  const prev = () => setWeekStart((w) => addDaysStr(w, -7));
  const next = () => setWeekStart((w) => addDaysStr(w, 7));
  const rangeLabel = `${dayNumLabel(weekStart)} – ${dayNumLabel(addDaysStr(weekStart, 6))}`;

  const renderEvent = (ev) => ({
    color: ev.space_color,
    tooltip: `${ev.space_name}, ${parisTimeHM(ev.start_at)}`,
    main: ev.space_name,
    sub: `${ev.credits_cost} cr.`,
  });

  const cancel = async (id) => {
    setFeedback(null);
    try {
      const r = await api.del(`/reservations/${id}`);
      setFeedback({
        type: 'ok',
        text: r.refunded ? `Annulée. ${r.amount} crédits remboursés.` : 'Annulée. Hors délai, pas de remboursement.',
      });
      setSelected(null);
      load();
    } catch (err) {
      setFeedback({ type: 'error', text: msg(err.code) });
    }
  };

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Mon planning</h1>
          <p className="subtitle" style={{ margin: 0 }}>Semaine du {rangeLabel} · glissez sur la grille pour réserver</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="small" onClick={() => setBooking({})}>＋ Réserver</button>
          <button className="outline small" onClick={prev} aria-label="Semaine précédente">‹</button>
          <button className="outline small" onClick={goToday}>Aujourd'hui</button>
          <button className="outline small" onClick={next} aria-label="Semaine suivante">›</button>
        </div>
      </div>

      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      <WeekGrid
        days={days}
        today={today}
        events={reservations}
        renderEvent={renderEvent}
        onEventClick={setSelected}
        onSelectSlot={(slot) => setBooking(slot)}
      />

      <p className="muted" style={{ marginTop: 14 }}>
        {reservations.length === 0 ? 'Aucune réservation à venir. ' : ''}
        <Link to="/reserver">Réserver plusieurs créneaux →</Link>
      </p>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>
                <span className="dot" style={{ background: selected.space_color }} />
                {selected.space_name}
              </h2>
              <button className="ghost" onClick={() => setSelected(null)} aria-label="Fermer">✕</button>
            </div>
            <table style={{ marginBottom: 14 }}>
              <tbody>
                <tr><td className="muted">Début</td><td style={{ textAlign: 'right' }}>{fmtDateTime(selected.start_at)}</td></tr>
                <tr><td className="muted">Fin</td><td style={{ textAlign: 'right' }}>{fmtDateTime(selected.end_at)}</td></tr>
                <tr><td className="muted">Coût</td><td style={{ textAlign: 'right' }}>{selected.credits_cost} crédits</td></tr>
              </tbody>
            </table>
            <VoucherBlock reservation={selected} />
            <div className="flex-between">
              <GoogleCalendarLink reservation={selected} />
              {new Date(selected.start_at).getTime() > Date.now() && (
                <button className="outline small" onClick={() => cancel(selected.id)}>Annuler la réservation</button>
              )}
            </div>
          </div>
        </div>
      )}

      {booking && (
        <BookingModal
          mode="client"
          initial={booking.date ? booking : undefined}
          onClose={() => setBooking(null)}
          onCreated={() => { setBooking(null); load(); }}
        />
      )}
    </div>
  );
}
