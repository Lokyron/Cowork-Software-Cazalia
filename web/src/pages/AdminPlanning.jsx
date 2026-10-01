import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { parisLocalToUtcIso, addDaysStr, startOfWeekStr, todayStr, dayNumLabel } from '../time.js';
import ReservationDetail from '../components/ReservationDetail.jsx';
import WeekGrid from '../components/WeekGrid.jsx';
import BookingModal from '../components/BookingModal.jsx';
import AdminCartModal from '../components/AdminCartModal.jsx';

export default function AdminPlanning() {
  const [weekStart, setWeekStart] = useState(() => startOfWeekStr(todayStr()));
  const [reservations, setReservations] = useState([]);
  const [selected, setSelected] = useState(null);   // réservation ouverte (détail)
  const [booking, setBooking] = useState(null);      // { date, startHM, endHM } | {} pour la modale
  const [cart, setCart] = useState(false);           // modale panier multi-espaces

  const load = useCallback(async () => {
    const from = parisLocalToUtcIso(weekStart, '00:00');
    const to = parisLocalToUtcIso(addDaysStr(weekStart, 7), '00:00');
    const r = await api.get(`/admin/planning?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    setReservations(r.reservations);
  }, [weekStart]);
  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i)), [weekStart]);
  const today = todayStr();

  const goToday = () => setWeekStart(startOfWeekStr(todayStr()));
  const prev = () => setWeekStart((w) => addDaysStr(w, -7));
  const next = () => setWeekStart((w) => addDaysStr(w, 7));
  const rangeLabel = `${dayNumLabel(weekStart)} – ${dayNumLabel(addDaysStr(weekStart, 6))}`;

  const renderEvent = (ev) => ({
    color: ev.space_color,
    tooltip: `${ev.space_name}, ${ev.member_name}`,
    main: ev.space_name,
    sub: `${ev.member_name}${ev.note ? ' 📝' : ''}`,
  });

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Planning</h1>
          <p className="subtitle" style={{ margin: 0 }}>Semaine du {rangeLabel} · glissez sur la grille pour réserver</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="small" onClick={() => setBooking({})}>＋ Réserver</button>
          <button className="outline small" onClick={() => setCart(true)}>＋ Panier</button>
          <button className="outline small" onClick={prev}>‹</button>
          <button className="outline small" onClick={goToday}>Aujourd'hui</button>
          <button className="outline small" onClick={next}>›</button>
        </div>
      </div>

      <WeekGrid
        days={days}
        today={today}
        events={reservations}
        renderEvent={renderEvent}
        onEventClick={setSelected}
        onSelectSlot={(slot) => setBooking(slot)}
      />

      {reservations.length === 0 && (
        <p className="muted" style={{ marginTop: 14 }}>Aucune réservation cette semaine.</p>
      )}

      {selected && (
        <ReservationDetail
          reservation={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { load(); setSelected(null); }}
        />
      )}

      {booking && (
        <BookingModal
          mode="admin"
          initial={booking.date ? booking : undefined}
          onClose={() => setBooking(null)}
          onCreated={() => { setBooking(null); load(); }}
        />
      )}

      {cart && (
        <AdminCartModal onClose={() => setCart(false)} onCreated={() => load()} />
      )}
    </div>
  );
}
