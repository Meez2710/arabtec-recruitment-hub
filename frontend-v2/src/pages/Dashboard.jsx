import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

export default function Dashboard() {
  const { user, hasPerm } = useAuth();
  const [data, setData] = useState(null);

  useEffect(() => { api.get('/dashboard').then(setData); }, []);

  if (!data) return <div className="text-legibility-black/60">Loading…</div>;

  const kpis = [
    { label: 'Open Requests', value: data.requests?.open ?? 0, colorClass: 'text-brand-red' },
    { label: 'Candidates in Pipeline', value: data.applications?.total ?? 0, colorClass: 'text-legibility-black' },
    { label: 'Upcoming Interviews', value: data.interviews?.upcoming ?? 0, colorClass: 'text-info-blue' },
    { label: 'Avg Time-to-Fill (days)', value: data.requests?.avgTimeToFill ?? '—', colorClass: 'text-primary-green' },
  ];

  const myTasks = [];
  if (hasPerm('candidate.move_stage')) myTasks.push({ label: 'Candidates to Screen', count: data.myWork?.myCandidatesToScreen ?? 0, href: '/talent-pool' });
  if (hasPerm('interview.view_assigned')) myTasks.push({ label: 'My Upcoming Interviews', count: data.myWork?.myInterviews ?? 0, href: '/interviews' });
  if (hasPerm('offer.create')) myTasks.push({ label: 'Offers to Send', count: data.myWork?.myPendingOffers ?? 0, href: '/offers' });
  myTasks.push({ label: 'My Open Requests', count: data.myWork?.myOpenRequests ?? 0, href: '/requests' });

  return (
    <div>
      <h1 className="text-xl font-bold mb-1 text-legibility-black">Dashboard</h1>
      <p className="text-sm text-legibility-black/60 mb-6">Welcome back, {user?.fullName}</p>

      {/* KPI cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {kpis.map(k => (
          <div key={k.label} className="bg-workspace-white rounded-lg border border-elevation-grey p-5">
            <div className={`text-2xl font-bold ${k.colorClass}`}>{k.value}</div>
            <div className="text-xs text-legibility-black/60 mt-1">{k.label}</div>
          </div>
        ))}
      </div>

      {/* My Tasks widget */}
      <div className="bg-workspace-white rounded-lg border border-elevation-grey p-5">
        <h2 className="font-semibold text-sm mb-4 text-legibility-black">My Tasks</h2>
        <div className="grid grid-cols-2 gap-3">
          {myTasks.map(t => (
            <a key={t.label} href={t.href} className="flex items-center justify-between p-3 rounded-lg border border-elevation-grey/50 hover:bg-elevation-grey transition-colors">
              <span className="text-sm text-legibility-black/80">{t.label}</span>
              <span className="text-sm font-bold text-brand-red">{t.count}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
