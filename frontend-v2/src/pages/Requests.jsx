import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import RequestWizard from '../components/RequestWizard';

export default function Requests() {
  const { hasPerm } = useAuth();
  const [data, setData] = useState(null);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => { api.get('/requests').then(setData); }, []);

  if (!data) return <div className="text-gray-400">Loading…</div>;

  const requests = data.requests || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Recruitment Requests</h1>
          <p className="text-sm text-gray-400">{requests.length} requests</p>
        </div>
        {hasPerm('request.create') && (
          <button onClick={() => setShowWizard(true)}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg transition-colors"
            style={{ backgroundColor: '#d2232a' }}>
            + New Request
          </button>
        )}
      </div>

      {/* Data table */}
      <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium text-gray-500">Ticket</th>
              <th className="px-4 py-3 font-medium text-gray-500">Position</th>
              <th className="px-4 py-3 font-medium text-gray-500">Department</th>
              <th className="px-4 py-3 font-medium text-gray-500">Location</th>
              <th className="px-4 py-3 font-medium text-gray-500">Priority</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(r => (
              <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50 cursor-pointer">
                <td className="px-4 py-3 font-medium">{r.ticketNo}</td>
                <td className="px-4 py-3">{r.title}</td>
                <td className="px-4 py-3 text-gray-500">{r.department?.name || '—'}</td>
                <td className="px-4 py-3 text-gray-500">{r.location || r.site?.name || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${
                    r.priority === 'high' || r.priority === 'critical' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
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
