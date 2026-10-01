// Lien « Ajouter à Google Agenda » : ouvre Google Calendar avec un événement
// pré-rempli (titre, dates UTC, lieu, détails). Les dates des réservations sont
// déjà en ISO UTC (…Z), parfait pour le format attendu par Google.

// "2026-06-28T08:00:00.000Z" -> "20260628T080000Z"
const toGCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');

export function googleCalendarUrl(r) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Cazalia — ${r.space_name}`,
    dates: `${toGCalDate(r.start_at)}/${toGCalDate(r.end_at)}`,
    details: `Réservation — ${r.space_name} (${r.credits_cost} crédits) chez Cazalia.`,
    location: 'Cazalia',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export default function GoogleCalendarLink({ reservation }) {
  return (
    <a
      className="gcal-link"
      href={googleCalendarUrl(reservation)}
      target="_blank"
      rel="noopener noreferrer"
      title="Ajouter cette réservation à Google Agenda"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <line x1="12" y1="14" x2="12" y2="18" />
        <line x1="10" y1="16" x2="14" y2="16" />
      </svg>
      <span>Agenda</span>
    </a>
  );
}
