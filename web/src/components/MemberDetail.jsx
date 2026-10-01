import { useEffect, useState, useCallback } from 'react';
import { api, msg } from '../api.js';
import { fmtDateTime } from '../time.js';
import DangerDelete from './DangerDelete.jsx';
import InvoiceExport from './InvoiceExport.jsx';
import PasswordInput from './PasswordInput.jsx';
import { checkPassword, PASSWORD_MIN_LENGTH, PASSWORD_RULE } from '../password.js';

const eur = (cents) => (cents == null ? null : `${(cents / 100).toFixed(2)} €`);

// Libellé lisible d'une transaction du grand-livre.
function describe(t) {
  const slot = t.start_at ? `${fmtDateTime(t.start_at)}` : null;
  switch (t.reason) {
    case 'topup': {
      const e = eur(t.amount_eur_cents);
      return `Recharge de crédits${e ? ` (payé ${e})` : ''}${t.note ? ` — ${t.note}` : ''}`;
    }
    case 'booking':
      return `Réservation${t.space_name ? ` — ${t.space_name}` : ''}${slot ? `, ${slot}` : ''}`;
    case 'refund':
      return `Remboursement${t.space_name ? ` — ${t.space_name}` : ''}${slot ? `, ${slot}` : ''}`;
    case 'adjust':
      return `Ajustement${t.note ? ` — ${t.note}` : ''}`;
    default:
      return t.note || t.reason;
  }
}

export default function MemberDetail({ memberId, onClose, onChanged, onBook }) {
  const [data, setData] = useState(null); // { member, transactions }
  const [info, setInfo] = useState(null); // formulaire infos
  const [topup, setTopup] = useState({ credits: '', euros: '', note: '' });
  const [pwd, setPwd] = useState('');
  const [resetLink, setResetLink] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const load = useCallback(async () => {
    const r = await api.get(`/admin/members/${memberId}`);
    setData(r);
    setInfo({
      first_name: r.member.first_name || '',
      last_name: r.member.last_name || '',
      email: r.member.email || '',
      phone: r.member.phone || '',
      role: r.member.role || 'member',
    });
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  const flash = (type, text) => setFeedback({ type, text });
  const refresh = () => { load(); onChanged?.(); };

  const saveInfo = async (e) => {
    e.preventDefault();
    setFeedback(null);
    try {
      await api.put(`/admin/users/${memberId}`, info);
      flash('ok', 'Informations mises à jour.');
      refresh();
    } catch (err) { flash('error', msg(err.code)); }
  };

  const doTopup = async () => {
    setFeedback(null);
    const credits = Number(topup.credits);
    if (!credits || credits <= 0) return flash('error', 'Nombre de crédits invalide.');
    try {
      await api.post('/admin/wallet/topup', {
        user_id: memberId,
        amount: credits,
        euros: topup.euros ? Number(topup.euros) : undefined,
        note: topup.note || null,
      });
      setTopup({ credits: '', euros: '', note: '' });
      flash('ok', `${credits} crédits ajoutés.`);
      refresh();
    } catch (err) { flash('error', msg(err.code)); }
  };

  const setPassword = async () => {
    setFeedback(null);
    const faiblesse = checkPassword(pwd);
    if (faiblesse) return flash('error', faiblesse);
    try {
      await api.post(`/admin/users/${memberId}/password`, { new_password: pwd });
      setPwd('');
      flash('ok', 'Mot de passe défini. Le membre a été déconnecté.');
    } catch (err) { flash('error', msg(err.code)); }
  };

  const sendResetLink = async () => {
    setFeedback(null); setResetLink(null);
    try {
      const res = await api.post(`/admin/users/${memberId}/reset-link`);
      if (res.email_sent) flash('ok', `Email de réinitialisation envoyé à ${res.email}.`);
      else { setResetLink(res.reset_url); flash('ok', 'Lien généré (SMTP non configuré — à transmettre manuellement).'); }
    } catch (err) { flash('error', msg(err.code)); }
  };

  if (!data) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}><p className="muted">Chargement…</p></div>
      </div>
    );
  }

  const m = data.member;
  const setI = (k) => (e) => setInfo((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 100%)' }}>
        <div className="flex-between" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{m.display_name} {m.role === 'admin' && <span className="badge grey">admin</span>}</h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>
        <div className="flex-between" style={{ marginBottom: 16, gap: 12 }}>
          <p className="subtitle" style={{ margin: 0 }}>Solde actuel : <strong>{m.balance} crédits</strong></p>
          {onBook && <button className="small" onClick={() => onBook(m)}>＋ Réserver un créneau</button>}
        </div>

        {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

        {/* Informations */}
        <form onSubmit={saveInfo} className="card" style={{ background: 'rgba(255,255,255,0.5)', marginBottom: 14 }}>
          <h2>Informations</h2>
          <div className="row">
            <div className="field"><label>Prénom</label><input value={info.first_name} onChange={setI('first_name')} required /></div>
            <div className="field"><label>Nom</label><input value={info.last_name} onChange={setI('last_name')} required /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field"><label>Email</label><input type="email" value={info.email} onChange={setI('email')} required /></div>
            <div className="field"><label>Téléphone</label><input type="tel" value={info.phone} onChange={setI('phone')} required /></div>
            <div className="field" style={{ maxWidth: 150 }}>
              <label>Rôle</label>
              <select value={info.role} onChange={setI('role')}>
                <option value="member">Membre</option>
                <option value="admin">Administrateur</option>
              </select>
            </div>
          </div>
          <button type="submit" style={{ marginTop: 14 }}>Enregistrer les informations</button>
        </form>

        {/* Recharge + sécurité */}
        <div className="grid cols-2" style={{ marginBottom: 14 }}>
          <div className="card" style={{ background: 'rgba(255,255,255,0.5)' }}>
            <h2>Recharger des crédits</h2>
            <div className="row">
              <div className="field"><label>Crédits</label><input type="number" min="1" value={topup.credits} onChange={(e) => setTopup((t) => ({ ...t, credits: e.target.value }))} /></div>
              <div className="field"><label>Euros payés</label><input type="number" min="0" step="0.01" placeholder="(optionnel)" value={topup.euros} onChange={(e) => setTopup((t) => ({ ...t, euros: e.target.value }))} /></div>
            </div>
            <div className="field" style={{ marginTop: 12 }}><label>Note</label><input value={topup.note} onChange={(e) => setTopup((t) => ({ ...t, note: e.target.value }))} /></div>
            <button onClick={doTopup}>Créditer</button>
          </div>

          <div className="card" style={{ background: 'rgba(255,255,255,0.5)' }}>
            <h2>Mot de passe</h2>
            <div className="field"><label>Définir un nouveau mot de passe</label>
              <PasswordInput placeholder={`≥ ${PASSWORD_MIN_LENGTH} caractères`} title={PASSWORD_RULE} value={pwd} onChange={(e) => setPwd(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={setPassword}>Définir</button>
              <button className="outline" onClick={sendResetLink}>✉︎ Lien reset</button>
            </div>
            {resetLink && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input readOnly value={resetLink} style={{ fontSize: 12 }} onFocus={(e) => e.target.select()} />
                <button className="small outline" onClick={() => navigator.clipboard?.writeText(resetLink)}>Copier</button>
              </div>
            )}
          </div>
        </div>

        {/* Historique des transactions */}
        <div className="card" style={{ background: 'rgba(255,255,255,0.5)' }}>
          <h2>Historique des transactions</h2>
          {data.transactions.length === 0 && <p className="muted">Aucune transaction.</p>}
          {data.transactions.length > 0 && (
           <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Opération</th><th style={{ textAlign: 'right' }}>Crédits</th></tr></thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(t.created_at)}</td>
                    <td>{describe(t)}</td>
                    <td style={{ textAlign: 'right' }} className={t.amount >= 0 ? 'pos' : 'neg'}>
                      {t.amount >= 0 ? '+' : ''}{t.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
           </div>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <InvoiceExport baseUrl={`/admin/members/${memberId}/invoice`} filenamePrefix={`releve-${m.display_name}`} />
        </div>

        <div style={{ marginTop: 14 }}>
          <DangerDelete
            title="Supprimer ce compte"
            warning={`Action définitive et irréversible. Tous les crédits non utilisés de ${m.display_name} seront perdus, ainsi que ses réservations et son historique.`}
            buttonLabel="Supprimer ce membre"
            onConfirm={async () => {
              await api.del(`/admin/users/${memberId}`, { confirm: 'SUPPRIMER' });
              onChanged?.();
              onClose?.();
            }}
          />
        </div>
      </div>
    </div>
  );
}
