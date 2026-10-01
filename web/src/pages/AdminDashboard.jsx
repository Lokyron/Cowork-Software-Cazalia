import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { fmtTime, toDate } from '../time.js';

const eur = (n) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const daysAgo = (created) => {
  const n = Math.floor((Date.now() - toDate(created).getTime()) / 86_400_000);
  return n <= 0 ? "aujourd'hui" : n === 1 ? 'hier' : `il y a ${n} j`;
};

function Delta({ value, unit = '', invert = false }) {
  if (!value) return <span className="kpi-d mut">= stable</span>;
  const up = invert ? value < 0 : value > 0;
  return (
    <span className={`kpi-d ${up ? 'up' : 'down'}`}>
      {value > 0 ? '+' : ''}{value}{unit}
    </span>
  );
}

export default function AdminDashboard() {
  const [d, setD] = useState(null);

  useEffect(() => { api.get('/admin/dashboard').then(setD).catch(() => {}); }, []);

  if (!d) return <p className="muted">Chargement du tableau de bord…</p>;
  const k = d.kpis;
  const maxBar = Math.max(1, ...d.bookings14.map((b) => b.count));

  return (
    <div>
      <div className="flex-between">
        <div>
          <h1>Tableau de bord</h1>
          <p className="subtitle" style={{ margin: 0 }}>Vue d'ensemble de votre espace</p>
        </div>
      </div>

      {/* Actions rapides (passerelles) */}
      <div className="qa-row">
        <Link className="qa primary" to="/admin/membres?new=1">＋ Nouveau membre</Link>
        <Link className="qa" to="/admin/membres">Recharger des crédits</Link>
        <Link className="qa" to="/admin/planning">Voir le planning</Link>
        <Link className="qa" to="/admin/espaces">Gérer les espaces</Link>
        <Link className="qa" to="/admin/prospects">Prospects</Link>
      </div>

      {/* Indicateurs clés */}
      <div className="dash-kpis">
        <Link className="card kpi" to="/admin/planning">
          <div className="kpi-l">Réservations aujourd'hui</div>
          <div className="kpi-v">{k.reservations_today}</div>
          <Delta value={k.reservations_today - k.reservations_yesterday} unit=" vs hier" />
        </Link>
        <Link className="card kpi" to="/admin/planning">
          <div className="kpi-l">Taux d'occupation (7 j)</div>
          <div className="kpi-v">{k.occupancy7}%</div>
          <Delta value={k.occupancy7 - k.occupancy_prev7} unit=" pts" />
        </Link>
        <Link className="card kpi" to="/admin/membres">
          <div className="kpi-l">Membres actifs (30 j)</div>
          <div className="kpi-v">{k.active_members}</div>
          <span className="kpi-d mut">{k.total_members} au total · +{k.new_members_month} ce mois</span>
        </Link>
        <div className="card kpi">
          <div className="kpi-l">Encaissé ce mois</div>
          <div className="kpi-v">{eur(k.revenue_month_eur)}</div>
          <span className="kpi-d mut">{k.credits_sold_month} crédits vendus</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        Crédits en circulation : <strong>{k.credits_outstanding}</strong> (dette envers les membres).
      </p>

      {/* Réservations 14 j + occupation par espace */}
      <div className="dash-row2" style={{ marginTop: 16 }}>
        <Link className="card" to="/admin/planning" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h2>Réservations — 14 derniers jours</h2>
          <div className="bars">
            {d.bookings14.map((b, i) => (
              <div key={i} className="bar-wrap" title={`${b.count} réservation(s)`}>
                <div className="bar" style={{ height: `${(b.count / maxBar) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="xaxis">
            {d.bookings14.map((b, i) => <span key={i} className="xt">{b.label}</span>)}
          </div>
        </Link>

        <Link className="card" to="/admin/planning" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h2>Occupation par espace (7 j)</h2>
          <div className="occ">
            {d.occupancy_by_space.map((s) => (
              <div key={s.id} className="occ-row">
                <span className="occ-name"><span className="dot" style={{ background: s.color }} />{s.name}</span>
                <span className="track"><span className="fill" style={{ width: `${s.pct}%` }} /></span>
                <span className="pct">{s.pct}%</span>
              </div>
            ))}
            {d.occupancy_by_space.length === 0 && <p className="muted">Aucun espace actif.</p>}
          </div>
        </Link>
      </div>

      {/* Prochaines réservations + membres */}
      <div className="dash-row2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Prochaines réservations aujourd'hui</h2>
          {d.upcoming_today.length === 0 && <p className="muted">Aucune réservation à venir aujourd'hui.</p>}
          {d.upcoming_today.map((r) => (
            <Link key={r.id} className="li" to="/admin/planning">
              <span className="li-time">{fmtTime(r.start_at)}</span>
              <span className="dot" style={{ background: r.space_color }} />
              <span className="li-main">{r.space_name}</span>
              <span className="li-sub">{r.member_name}</span>
            </Link>
          ))}
        </div>

        <div className="card">
          <h2>Nouveaux membres &amp; à surveiller</h2>
          {d.recent_members.map((m) => (
            <Link key={m.id} className="mem" to={`/admin/membres?open=${m.id}`}>
              <span>{m.display_name}</span>
              <span className="muted" style={{ fontSize: 12 }}>{daysAgo(m.created_at)}</span>
              <span className={`chip ${m.balance < 5 ? 'warn' : ''}`}>{m.balance} crédit{m.balance > 1 ? 's' : ''}</span>
            </Link>
          ))}
          {d.low_credit_members.length > 0 && (
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              À relancer (crédits bas) : {d.low_credit_members.map((m) => m.display_name).join(', ')}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
