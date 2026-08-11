import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import CandidateDrawer from '../components/CandidateDrawer';

export default function TalentPool() {
  const [candidates, setCandidates] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => { api.get('/candidates').then(r => setCandidates(r.candidates)); }, []);

  const filtered = (candidates || []).filter(c =>
    !search || c.fullName.toLowerCase().includes(search.toLowerCase()) ||
    (c.currentCompany || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full">
      <div className={`flex-1 transition-all ${selected ? 'mr-[420px]' : ''}`}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-legibility-black">Talent Pool</h1>
            <p className="text-sm text-legibility-black/60">{candidates?.length ?? 0} candidates</p>
          </div>
          <input placeholder="Search name or company…" value={search} onChange={e => setSearch(e.target.value)}
            className="px-3 py-2 border border-elevation-grey rounded-lg text-sm w-64 bg-workspace-white text-legibility-black" />
        </div>

        {/* Directory list */}
        <div className="bg-workspace-white rounded-lg border border-elevation-grey divide-y divide-elevation-grey/50">
          {!candidates ? <div className="p-6 text-legibility-black/60">Loading…</div> : filtered.length === 0 ? (
            <div className="p-6 text-legibility-black/60">No candidates found.</div>
          ) : filtered.map(c => (
            <div key={c.id} onClick={() => setSelected(c)}
              className="flex items-center gap-4 px-5 py-3 hover:bg-elevation-grey/50 cursor-pointer transition-colors">
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-workspace-white text-xs font-bold bg-brand-red">
                {(c.fullName || '?')[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate text-legibility-black">{c.fullName}</div>
                <div className="text-xs text-legibility-black/60 truncate">{c.currentPosition}{c.currentCompany ? ' at ' + c.currentCompany : ''}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-legibility-black/60">{c.location || '—'}</div>
                <div className="text-xs text-legibility-black/60">{c.yearsExperience != null ? c.yearsExperience + 'y exp' : ''}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Off-canvas candidate drawer */}
      {selected && (
        <CandidateDrawer candidate={selected} onClose={() => setSelected(null)}
          onRefresh={() => api.get('/candidates').then(r => setCandidates(r.candidates))} />
      )}
    </div>
  );
}
