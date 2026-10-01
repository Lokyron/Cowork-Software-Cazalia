import { useState } from 'react';
import { parisLocalToUtcIso, addDaysStr, todayStr } from '../time.js';

const firstOfMonth = () => todayStr().slice(0, 8) + '01';

// Sélecteur de période + téléchargement du relevé PDF.
// `baseUrl` : route API ('/invoice' ou `/admin/members/:id/invoice`).
export default function InvoiceExport({ baseUrl, filenamePrefix = 'releve-cowork' }) {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const download = async () => {
    setError(null);
    if (to < from) return setError('La date de fin doit être après la date de début.');
    setBusy(true);
    try {
      const fromIso = parisLocalToUtcIso(from, '00:00');
      const toIso = parisLocalToUtcIso(addDaysStr(to, 1), '00:00'); // jour de fin inclus
      const url = `/api${baseUrl}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${filenamePrefix}-${from}_${to}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch {
      setError('Échec de la génération du PDF.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Relevé / Facture (PDF)</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Choisissez une période, puis téléchargez le relevé des transactions au format PDF.
      </p>
      <div className="row">
        <div className="field"><label>Du</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>Au</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field" style={{ flex: '0 0 auto' }}>
          <label>&nbsp;</label>
          <button onClick={download} disabled={busy}>{busy ? '…' : '⤓ Télécharger le PDF'}</button>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}
