import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import CartBuilder from './CartBuilder.jsx';
import CreateMemberModal from './CreateMemberModal.jsx';

// Panier multi-espaces côté admin : on choisit d'abord un client, puis on compose
// le panier pour lui (droits bypass par ligne). Le checkout débite ses crédits.
export default function AdminCartModal({ onClose, onCreated }) {
  const [members, setMembers] = useState([]);
  const [q, setQ] = useState('');
  const [client, setClient] = useState(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => { api.get('/admin/members').then((r) => setMembers(r.members)).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return [];
    return members.filter((m) => `${m.display_name} ${m.email} ${m.phone || ''}`.toLowerCase().includes(qq)).slice(0, 8);
  }, [members, q]);

  const adapter = useMemo(() => client && ({
    key: `admin-${client.id}`,
    list: () => api.get(`/admin/cart?user_id=${client.id}`),
    add: (payload) => api.post('/admin/cart', { ...payload, user_id: client.id }),
    remove: (id) => api.del(`/admin/cart/${id}`),
    checkout: () => api.post('/admin/cart/checkout', { user_id: client.id }),
  }), [client]);

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(900px, 100%)' }}>
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Panier multi-espaces</h2>
            <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
          </div>

          {/* Sélection du client */}
          <div className="field">
            <label>Client</label>
            {client ? (
              <div className="flex-between" style={{ gap: 8 }}>
                <span><span className="dot" style={{ background: 'var(--accent)' }} />{client.display_name} · <span className="muted">{client.balance} cr.</span></span>
                {!done && <button className="outline small" onClick={() => { setClient(null); setQ(''); }}>Changer</button>}
              </div>
            ) : (
              <>
                <div style={{ position: 'relative' }}>
                  <input placeholder="Rechercher un client (nom, email, tél)…" value={q} onChange={(e) => setQ(e.target.value)} />
                  {filtered.length > 0 && (
                    <div className="ac-menu">
                      {filtered.map((m) => (
                        <button key={m.id} type="button" className="ac-item" onClick={() => { setClient(m); setQ(''); }}>
                          {m.display_name} <span className="muted">· {m.email} · {m.balance} cr.</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button className="outline small" onClick={() => setShowNewClient(true)}>＋ Nouveau client</button>
                </div>
              </>
            )}
          </div>

          {client && !done && (
            <div style={{ marginTop: 12 }}>
              <CartBuilder adapter={adapter} admin onDone={setDone} />
            </div>
          )}

          {done && (
            <div className="alert ok" style={{ marginTop: 12 }}>
              {done.count} réservation{done.count > 1 ? 's' : ''} créée{done.count > 1 ? 's' : ''} pour {client.display_name} — {done.total} crédits débités.
              <div style={{ marginTop: 10 }}>
                <button onClick={() => { onCreated?.(); onClose?.(); }}>Terminer</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showNewClient && (
        <CreateMemberModal onClose={() => setShowNewClient(false)} onCreated={(u) => { if (u) setClient({ ...u, balance: 0 }); }} />
      )}
    </>
  );
}
