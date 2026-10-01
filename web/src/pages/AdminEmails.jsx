import { useEffect, useMemo, useState } from 'react';
import { api, msg } from '../api.js';

function Section({ title, children, aside }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="flex-between"><h2 style={{ margin: 0 }}>{title}</h2>{aside}</div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export default function AdminEmails() {
  const [smtp, setSmtp] = useState(null);
  const [arrival, setArrival] = useState(null);
  const [variables, setVariables] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [members, setMembers] = useState([]);
  const [feedback, setFeedback] = useState(null);

  const flash = (type, text) => { setFeedback({ type, text }); setTimeout(() => setFeedback(null), 4000); };

  const loadAll = async () => {
    const s = await api.get('/admin/email/settings');
    setSmtp(s.smtp); setArrival(s.arrival); setVariables(s.variables || []);
    setTemplates((await api.get('/admin/email/templates')).templates);
    api.get('/admin/members').then((r) => setMembers(r.members)).catch(() => {});
  };
  useEffect(() => { loadAll().catch(() => {}); }, []);

  if (!smtp) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1>E-mails</h1>
      <p className="subtitle">Configuration SMTP, templates et envois.</p>
      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      <SmtpSection smtp={smtp} setSmtp={setSmtp} flash={flash} />
      <ArrivalSection arrival={arrival} setArrival={setArrival} flash={flash} />
      <TemplatesSection templates={templates} variables={variables} flash={flash} onSaved={loadAll} />
      <ManualSection templates={templates} members={members} flash={flash} />
      <LogSection />
    </div>
  );
}

// ── SMTP ─────────────────────────────────────────────────────────────────────
function SmtpSection({ smtp, setSmtp, flash }) {
  const [f, setF] = useState({ ...smtp, pass: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((c) => ({ ...c, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put('/admin/email/settings', { smtp: f });
      setSmtp(r.smtp); setF({ ...r.smtp, pass: '' });
      flash('ok', 'Configuration SMTP enregistrée.');
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.post('/admin/email/test', {});
      if (r.ok) flash('ok', `E-mail de test envoyé à ${r.to}.`);
      else flash('error', `Échec : ${r.error || msg(r.reason)}`);
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  return (
    <Section title="Configuration SMTP" aside={<span className={`badge ${smtp.configured ? 'green' : 'red'}`}>{smtp.configured ? 'configuré' : 'non configuré'}</span>}>
      <div className="row">
        <div className="field" style={{ flex: 2 }}><label>Hôte SMTP</label><input value={f.host || ''} onChange={set('host')} placeholder="smtp.exemple.com" /></div>
        <div className="field"><label>Port</label><input type="number" value={f.port || ''} onChange={set('port')} /></div>
        <div className="field"><label>Sécurité</label>
          <select value={f.secure_mode || 'starttls'} onChange={set('secure_mode')}>
            <option value="starttls">STARTTLS</option>
            <option value="ssl">SSL/TLS</option>
            <option value="none">Aucune</option>
          </select>
        </div>
      </div>
      <div className="row">
        <div className="field"><label>Utilisateur</label><input value={f.user || ''} onChange={set('user')} /></div>
        <div className="field"><label>Mot de passe {smtp.has_pass && <span className="muted">(déjà défini)</span>}</label>
          <input type="password" value={f.pass} onChange={set('pass')} placeholder={smtp.has_pass ? '•••••• (laisser vide pour conserver)' : ''} /></div>
      </div>
      <div className="row">
        <div className="field"><label>Nom expéditeur</label><input value={f.from_name || ''} onChange={set('from_name')} placeholder="Cazalia" /></div>
        <div className="field"><label>E-mail expéditeur</label><input type="email" value={f.from_email || ''} onChange={set('from_email')} placeholder="no-reply@cazalia.fr" /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={save} disabled={busy}>Enregistrer</button>
        <button className="outline" onClick={test} disabled={busy}>Tester la connexion</button>
      </div>
    </Section>
  );
}

// ── Consignes d'arrivée ──────────────────────────────────────────────────────
function ArrivalSection({ arrival, setArrival, flash }) {
  const [f, setF] = useState(arrival);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put('/admin/email/settings', { arrival: f });
      setArrival(r.arrival); flash('ok', "Consignes enregistrées.");
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };
  return (
    <Section title="Consignes d'arrivée & réseau Wi-Fi">
      <div className="field"><label>Nom du réseau Wi-Fi (SSID)</label>
        <input value={f.wifi_ssid || ''} onChange={(e) => setF((c) => ({ ...c, wifi_ssid: e.target.value }))} style={{ maxWidth: 320 }} /></div>
      <div className="field"><label>Consignes d'arrivée (affichées sur l'espace client et dans l'e-mail de confirmation)</label>
        <textarea rows={3} value={f.instructions || ''} onChange={(e) => setF((c) => ({ ...c, instructions: e.target.value }))} /></div>
      <button onClick={save} disabled={busy}>Enregistrer</button>
    </Section>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────
function TemplatesSection({ templates, variables, flash, onSaved }) {
  const [code, setCode] = useState(templates[0]?.code || '');
  const [tpl, setTpl] = useState(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (code) api.get(`/admin/email/templates/${code}`).then((r) => setTpl(r.template)).catch(() => {}); }, [code]);

  const doPreview = async () => {
    try { const r = await api.post('/admin/email/preview', { subject: tpl.subject, body_html: tpl.body_html }); setPreview(r.html); }
    catch (err) { flash('error', msg(err.code)); }
  };
  const save = async () => {
    setBusy(true);
    try { await api.put(`/admin/email/templates/${code}`, { subject: tpl.subject, body_html: tpl.body_html }); flash('ok', 'Template enregistré.'); onSaved?.(); }
    catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  return (
    <Section title="Templates d'e-mails">
      <div className="field" style={{ maxWidth: 360 }}><label>Template</label>
        <select value={code} onChange={(e) => { setCode(e.target.value); setPreview(''); }}>
          {templates.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
        </select>
      </div>
      {tpl && (
        <>
          <div className="field"><label>Sujet</label><input value={tpl.subject} onChange={(e) => setTpl({ ...tpl, subject: e.target.value })} /></div>
          <div className="field"><label>Corps HTML</label>
            <textarea rows={12} value={tpl.body_html} onChange={(e) => setTpl({ ...tpl, body_html: e.target.value })} style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 }} /></div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Variables : {variables.map(([k]) => <code key={k} style={{ marginRight: 6 }}>{`{{${k}}}`}</code>)}
            {' '}· <code>{'{{wifi_block}}'}</code> (encart voucher)
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={save} disabled={busy}>Enregistrer</button>
            <button className="outline" onClick={doPreview}>Prévisualiser</button>
          </div>
          {preview && <iframe title="preview" srcDoc={preview} style={{ width: '100%', height: 460, border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} />}
        </>
      )}
    </Section>
  );
}

// ── Envoi manuel ─────────────────────────────────────────────────────────────
function ManualSection({ templates, members, flash }) {
  const [mode, setMode] = useState('user');       // 'user' | 'users' | 'all'
  const [selected, setSelected] = useState([]);    // [{id, display_name, email}]
  const [q, setQ] = useState('');
  const [useTemplate, setUseTemplate] = useState(true);
  const [code, setCode] = useState(templates.find((t) => t.code === 'manual')?.code || templates[0]?.code || '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return [];
    return members.filter((m) => `${m.display_name} ${m.email}`.toLowerCase().includes(qq) && !selected.some((s) => s.id === m.id)).slice(0, 8);
  }, [members, q, selected]);

  const add = (m) => { setSelected((s) => (mode === 'user' ? [m] : [...s, m])); setQ(''); };
  const remove = (id) => setSelected((s) => s.filter((x) => x.id !== id));

  const send = async () => {
    setBusy(true);
    try {
      const target = mode === 'all' ? { type: 'all' } : mode === 'user' ? { type: 'user', user_id: selected[0]?.id } : { type: 'users', user_ids: selected.map((s) => s.id) };
      const payload = useTemplate ? { code, target } : { subject, body_html: body, target };
      const r = await api.post('/admin/email/send', payload);
      flash('ok', `Envoi terminé : ${r.sent} envoyé(s), ${r.skipped} exclu(s) (opt-out), ${r.failed} échec(s).`);
      setSelected([]);
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  const canSend = (mode === 'all' || selected.length > 0) && (useTemplate ? !!code : subject && body);

  return (
    <Section title="Envoi manuel">
      <div className="field" style={{ maxWidth: 420 }}><label>Destinataires</label>
        <select value={mode} onChange={(e) => { setMode(e.target.value); setSelected([]); }}>
          <option value="user">Un client</option>
          <option value="users">Plusieurs clients</option>
          <option value="all">Tous les membres</option>
        </select>
      </div>

      {mode !== 'all' && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ position: 'relative', maxWidth: 420 }}>
            <input placeholder="Rechercher un client…" value={q} onChange={(e) => setQ(e.target.value)} />
            {filtered.length > 0 && (
              <div className="ac-menu">
                {filtered.map((m) => <button key={m.id} type="button" className="ac-item" onClick={() => add(m)}>{m.display_name} <span className="muted">· {m.email}</span></button>)}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {selected.map((s) => <span key={s.id} className="chip">{s.display_name} <button className="chip-x" onClick={() => remove(s.id)}>✕</button></span>)}
          </div>
        </div>
      )}
      {mode === 'all' && <p className="muted" style={{ fontSize: 13 }}>Envoi à tous les membres ayant accepté les communications.</p>}

      <div className="field"><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} /> Utiliser un template</label></div>

      {useTemplate ? (
        <div className="field" style={{ maxWidth: 360 }}><label>Template</label>
          <select value={code} onChange={(e) => setCode(e.target.value)}>{templates.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select>
        </div>
      ) : (
        <>
          <div className="field"><label>Sujet</label><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
          <div className="field"><label>Corps HTML</label><textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 }} /></div>
        </>
      )}

      <p className="muted" style={{ fontSize: 12 }}>Les clients ayant refusé les communications (opt-out) sont automatiquement exclus.</p>
      <button onClick={send} disabled={!canSend || busy}>{busy ? 'Envoi…' : 'Envoyer'}</button>
    </Section>
  );
}

// ── Journal ──────────────────────────────────────────────────────────────────
function LogSection() {
  const [log, setLog] = useState(null);
  useEffect(() => { api.get('/admin/email/log').then((r) => setLog(r.log)).catch(() => setLog([])); }, []);
  if (!log) return null;
  const STY = { sent: 'green', failed: 'red', skipped: 'amber' };
  return (
    <Section title="Journal des envois">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Destinataire</th><th>Template</th><th>Statut</th></tr></thead>
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.created_at + 'Z').toLocaleString('fr-FR')}</td>
                <td>{l.to_email}</td>
                <td className="muted">{l.template_code || '—'}</td>
                <td><span className={`badge ${STY[l.status] || ''}`}>{l.status}</span>{l.error && <span className="muted" style={{ fontSize: 11 }}> · {l.error}</span>}</td>
              </tr>
            ))}
            {log.length === 0 && <tr><td colSpan={4} className="muted">Aucun envoi.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
