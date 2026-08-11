import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

export default function Dashboard() {
  const { user, hasPerm } = useAuth();
  const [data, setData] = useState(null);

  useEffect(() => { api.get('/dashboard').then(setData); }, []);

  if (!data) return <div className="text-gray-400">Loading…</div>;

  const kpis = [
    { label: 'Open Requests', value: data.requests?.open ?? 0, color: '#d2232a' },
    { label: 'Candidates in Pipeline', value: data.applications?.total ?? 0, color: '#1b1f24' },
    { label: 'Upcoming Interviews', value: data.interviews?.upcoming ?? 0, color: '#2563eb' },
    { label: 'Avg Time-to-Fill (days)', value: data.requests?.avgTimeToFill ?? '—', color: '#059669' },
  ];

  const myTasks = [];
  if (hasPerm('candidate.move_stage')) myTasks.push({ label: 'Candidates to Screen', count: data.myWork?.myCandidatesToScreen ?? 0, href: '/talent-pool' });
  if (hasPerm('interview.view_assigned')) myTasks.push({ label: 'My Upcoming Interviews', count: data.myWork?.myInterviews ?? 0, href: '/interviews' });
  if (hasPerm('offer.create')) myTasks.push({ label: 'Offers to Send', count: data.myWork?.myPendingOffers ?? 0, href: '/offers' });
  myTasks.push({ label: 'My Open Requests', count: data.myWork?.myOpenRequests ?? 0, href: '/requests' });

  return (
    <div>
      <h1 className="text-xl font-bold mb-1">Dashboard</h1>
      <p className="text-sm text-gray-400 mb-6">Welcome back, {user?.fullName}</p>

      {/* KPI cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {kpis.map(k => (
          <div key={k.label} className="bg-white rounded-lg border border-gray-100 p-5">
            <div className="text-2xl font-bold" style={{ color: k.color }}>{k.value}</div>
            <div className="text-xs text-gray-400 mt-1">{k.label}</div>
          </div>
        ))}
      </div>

      {/* My Tasks widget */}
      <div className="bg-white rounded-lg border border-gray-100 p-5">
        <h2 className="font-semibold text-sm mb-4">My Tasks</h2>
        <div className="grid grid-cols-2 gap-3">
          {myTasks.map(t => (
            <a key={t.label} href={t.href} className="flex items-center justify-between p-3 rounded-lg border border-gray-50 hover:bg-gray-50 transition-colors">
              <span className="text-sm text-gray-700">{t.label}</span>
              <span className="text-sm font-bold text-red-600">{t.count}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
