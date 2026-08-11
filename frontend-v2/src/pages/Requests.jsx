import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import RequestWizard from '../components/RequestWizard';

export default function Requests() {
  const { hasPerm } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => { api.get('/requests').then(setData); }, []);

  if (!data) return <div className="text-legibility-black/60">Loading…</div>;

  const requests = data.requests || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-legibility-black">Recruitment Requests</h1>
          <p className="text-sm text-legibility-black/60">{requests.length} requests</p>
        </div>
        {hasPerm('request.create') && (
          <button onClick={() => setShowWizard(true)}
            className="px-4 py-2 text-sm font-semibold text-workspace-white rounded-lg transition-colors bg-primary-green hover:opacity-90">
            + New Request
          </button>
        )}
      </div>

      {/* Data table */}
      <div className="bg-workspace-white rounded-lg border border-elevation-grey overflow-hidden">
        <table className="w-full text-sm text-legibility-black">
          <thead className="bg-elevation-grey text-left">
            <tr>
              <th className="px-4 py-3 font-medium text-legibility-black/60">Ticket</th>
              <th className="px-4 py-3 font-medium text-legibility-black/60">Position</th>
              <th className="px-4 py-3 font-medium text-legibility-black/60">Department</th>
              <th className="px-4 py-3 font-medium text-legibility-black/60">Location</th>
              <th className="px-4 py-3 font-medium text-legibility-black/60">Priority</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(r => (
              <tr key={r.id} onClick={() => nav('/requests/' + r.id)} className="border-t border-elevation-grey/50 hover:bg-elevation-grey/50 cursor-pointer">
                <td className="px-4 py-3 font-medium">{r.ticketNo}</td>
                <td className="px-4 py-3">{r.title}</td>
                <td className="px-4 py-3 text-legibility-black/70">{r.department?.name || '—'}</td>
                <td className="px-4 py-3 text-legibility-black/70">{r.location || r.site?.name || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${
                    r.priority === 'high' || r.priority === 'critical' ? 'bg-brand-red/10 text-brand-red' : 'bg-elevation-grey text-legibility-black/60'
                  }`}>{r.priority}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showWizard && <RequestWizard onClose={() => setShowWizard(false)} onCreated={() => { setShowWizard(false); api.get('/requests').then(setData); }} />}
    </div>
  );
}
