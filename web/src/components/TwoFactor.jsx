import { useState } from 'react';
import { api, msg } from '../api.js';
import { useAuth } from '../auth.jsx';

// Carte de gestion de la double authentification (2FA / TOTP) dans « Mon compte ».
export default function TwoFactor() {
  const { user, refresh } = useAuth();
  const [setup, setSetup] = useState(null); // { secret, qr } pendant la configuration
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);

  const flash = (type, text) => setFeedback({ type, text });
  const onCode = (e) => setCode(e.target.value.replace(/\D/g, ''));

  const run = async (fn) => { setBusy(true); setFeedback(null); try { await fn(); } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); } };

  const startSetup = () => run(async () => { setSetup(await api.post('/auth/2fa/setup')); });
  const enable = () => run(async () => {
    await api.post('/auth/2fa/enable', { token: code });
    setSetup(null); setCode(''); await refresh(); flash('ok', 'Double authentification activée.');
  });
  const disable = () => run(async () => {
    await api.post('/auth/2fa/disable', { token: code });
    setCode(''); await refresh(); flash('ok', 'Double authentification désactivée.');
  });

  return (
    <div className="card">
      <h2>Double authentification (2FA)</h2>
      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      {user?.totp_enabled ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            <span className="badge green">Activée</span> Un code de votre application est demandé à chaque connexion.
          </p>
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Pour désactiver, saisissez un code</label>
            <input inputMode="numeric" maxLength={6} value={code} onChange={onCode} placeholder="123456" />
          </div>
          <button className="outline" onClick={disable} disabled={busy || code.length < 6}>Désactiver la 2FA</button>
        </>
      ) : setup ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Scannez ce QR code avec une appli d'authentification (Google Authenticator, Authy, Microsoft Authenticator…),
            ou saisissez la clé manuellement, puis entrez un code pour activer.
          </p>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <img src={setup.qr} alt="QR code 2FA" style={{ width: 180, height: 180, borderRadius: 12, background: '#fff' }} />
            <div>
              <div className="muted seats">Clé (saisie manuelle) :</div>
              <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{setup.secret}</code>
            </div>
          </div>
          <div className="field" style={{ maxWidth: 260, marginTop: 14 }}>
            <label>Code de vérification</label>
            <input inputMode="numeric" maxLength={6} value={code} onChange={onCode} placeholder="123456" autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={enable} disabled={busy || code.length < 6}>Activer</button>
            <button className="outline" onClick={() => { setSetup(null); setCode(''); }}>Annuler</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Renforcez la sécurité de votre compte : en plus du mot de passe, un code temporaire sera demandé à la connexion.
          </p>
          <button onClick={startSetup} disabled={busy}>Activer la double authentification</button>
        </>
      )}
    </div>
  );
}
