import { useState, useEffect } from 'react';
import { api } from '../lib/api';

export default function CandidateDrawer({ candidate, onClose, onRefresh }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { api.get('/candidates/' + candidate.id).then(r => setDetail(r.candidate)); }, [candidate.id]);

  const c = detail || candidate;

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-workspace-white border-l border-elevation-grey shadow-xl z-40 flex flex-col animate-[slideIn_0.2s_ease-out]">
      <div className="flex items-center justify-between px-5 py-4 border-b border-elevation-grey">
        <h2 className="font-semibold text-sm text-legibility-black">{c.fullName}</h2>
        <button onClick={onClose} className="text-legibility-black/60 hover:text-legibility-black text-lg">&times;</button>
      </div>

      <div className="flex-1 overflow-auto p-5 space-y-4">
        <div>
          <div className="text-xs font-medium text-legibility-black/60 uppercase tracking-wide mb-1">Contact</div>
          <div className="text-sm">{c.email || '—'}</div>
          <div className="text-sm text-legibility-black/70">{c.phone || '—'}</div>
          <div className="text-sm text-legibility-black/70">{c.location || '—'}</div>
        </div>

        <div>
          <div className="text-xs font-medium text-legibility-black/60 uppercase tracking-wide mb-1">Experience</div>
          <div className="text-sm">{c.currentPosition || '—'}{c.currentCompany ? ' at ' + c.currentCompany : ''}</div>
          <div className="text-sm text-legibility-black/70">{c.yearsExperience != null ? c.yearsExperience + ' years' : '—'}</div>
          <div className="text-sm text-legibility-black/70">Source: {c.source || '—'}</div>
        </div>

        {detail?.applications?.length > 0 && (
          <div>
            <div className="text-xs font-medium text-legibility-black/60 uppercase tracking-wide mb-1">Applications</div>
            {detail.applications.map(a => (
              <div key={a.id} className="text-sm flex justify-between py-1">
                <span>{a.ticketNo || a.applicationNo}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-elevation-grey">{a.status}</span>
              </div>
            ))}
          </div>
        )}

        {detail?.notes?.length > 0 && (
          <div>
            <div className="text-xs font-medium text-legibility-black/60 uppercase tracking-wide mb-1">Notes</div>
            {detail.notes.map(n => (
              <div key={n.id} className="text-sm text-legibility-black/80 py-1 border-b border-elevation-grey/50">{n.body}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
