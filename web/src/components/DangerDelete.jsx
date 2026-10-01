import { useState } from 'react';
import { msg } from '../api.js';

// Zone de suppression réutilisable : avertissement + confirmation en tapant
// SUPPRIMER. `onConfirm` est une fonction async qui effectue la suppression.
export default function DangerDelete({ title, warning, buttonLabel, onConfirm }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const armed = text === 'SUPPRIMER';

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(msg(err.code));
      setBusy(false);
    }
  };

  return (
    <div className="card danger-zone">
      <h2>{title}</h2>
      <div className="alert error">{warning}</div>
      <label>Pour confirmer, tapez <strong>SUPPRIMER</strong></label>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="SUPPRIMER"
        style={{ maxWidth: 260 }}
      />
      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
      <div style={{ marginTop: 12 }}>
        <button className="danger" disabled={!armed || busy} onClick={run}>
          {busy ? '…' : buttonLabel}
        </button>
      </div>
    </div>
  );
}
