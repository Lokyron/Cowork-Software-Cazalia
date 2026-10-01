import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import MemberDetail from '../components/MemberDetail.jsx';
import CreateMemberModal from '../components/CreateMemberModal.jsx';
import AdminMemberBooking from '../components/AdminMemberBooking.jsx';

// Normalisation pour une recherche insensible à la casse et aux accents.
const norm = (s) =>
  (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export default function AdminMembers() {
  const [members, setMembers] = useState([]);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [booking, setBooking] = useState(null); // membre pour lequel on réserve
  const [flash, setFlash] = useState(null);
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    const r = await api.get('/admin/members');
    setMembers(r.members);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Passerelles depuis le tableau de bord : ?open=<id> (fiche) ou ?new=1 (création).
  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    const open = params.get('open');
    if (open) setOpenId(Number(open));
    if (params.get('new') || params.get('open')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return members;
    return members.filter((m) => {
      const hay = norm(`${m.first_name || ''} ${m.last_name || ''} ${m.display_name} ${m.email} ${m.phone || ''}`);
      return hay.includes(q);
    });
  }, [members, query]);

  return (
    <div>
      <div className="flex-between">
        <h1>Membres</h1>
        <button onClick={() => setCreating(true)}>＋ Nouveau membre</button>
      </div>
      <p className="subtitle">Recherchez un membre, puis cliquez sur sa fiche pour gérer son compte ou réserver un créneau.</p>

      {flash && <div className="alert ok">{flash}</div>}

      <div className="card" style={{ marginBottom: 16, padding: 14 }}>
        <input
          type="search"
          placeholder="🔍 Rechercher par prénom, nom, téléphone ou email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="card">
       <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Nom</th><th>Email</th><th>Téléphone</th><th>Rôle</th><th style={{ textAlign: 'right' }}>Solde</th></tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id} className="row-clickable" onClick={() => setOpenId(m.id)}>
                <td><strong>{m.display_name}</strong></td>
                <td className="muted">{m.email}</td>
                <td className="muted">{m.phone || '—'}</td>
                <td>{m.role === 'admin' ? <span className="badge grey">admin</span> : 'membre'}</td>
                <td style={{ textAlign: 'right' }}><strong>{m.balance}</strong></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="muted">Aucun membre ne correspond à « {query} ».</td></tr>
            )}
          </tbody>
        </table>
       </div>
      </div>

      {openId != null && (
        <MemberDetail
          memberId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onBook={(m) => { setOpenId(null); setBooking(m); }}
        />
      )}

      {booking && (
        <AdminMemberBooking
          member={booking}
          onClose={() => setBooking(null)}
          onDone={(text) => { setBooking(null); setFlash(text); load(); }}
        />
      )}

      {creating && (
        <CreateMemberModal
          onClose={() => setCreating(false)}
          onCreated={load}
        />
      )}
    </div>
  );
}
