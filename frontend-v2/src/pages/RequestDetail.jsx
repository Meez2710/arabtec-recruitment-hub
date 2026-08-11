import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

// Hardcoded pipeline columns — Objective 1
const PIPELINE = [
  { key: 'sourced', label: 'Sourced' },
  { key: 'screening', label: 'Screening' },
  { key: 'interview_hr', label: '1st Interview (HR)' },
  { key: 'interview_technical', label: '2nd Interview (Technical)' },
  { key: 'offer', label: 'Offer' },
  { key: 'hired', label: 'Hired' },
];

const STAGE_MAP = {
  sourced: 'sourced', new: 'sourced', applied: 'sourced',
  screening: 'screening', matched: 'screening', screened: 'screening', shortlisted: 'screening',
  interview_hr: 'interview_hr', interviewing: 'interview_hr', interview_1: 'interview_hr', waiting_feedback: 'interview_hr',
  interview_technical: 'interview_technical', interview_2: 'interview_technical', technical_interview: 'interview_technical',
  offer: 'offer', issuing_offer: 'offer', offer_sent: 'offer', offer_preparation: 'offer',
  hired: 'hired', joined: 'hired',
};

function toColumn(status) { return STAGE_MAP[status] || 'sourced'; }
const DISQUALIFIED = ['rejected', 'offer_declined', 'on_hold'];

export default function RequestDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user, hasPerm } = useAuth();
  const [req, setReq] = useState(null);
  const [tab, setTab] = useState('pipeline');
  const [apps, setApps] = useState(null);
  const [posts, setPosts] = useState([]);
  const [newPost, setNewPost] = useState('');

  const load = useCallback(async () => {
    const r = await api.get('/requests/' + id);
    setReq(r.request);
    const a = await api.get('/applications/request/' + id);
    setApps(a.applications);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Load thread posts when Conversation tab is active
  useEffect(() => {
    if (tab === 'thread') {
      api.get('/thread/' + id).then(r => setPosts(r.posts || [])).catch(() => {});
    }
  }, [tab, id]);

  async function sendPost() {
    if (!newPost.trim()) return;
    await api.post('/thread/' + id, { body: newPost });
    setNewPost('');
    const r = await api.get('/thread/' + id);
    setPosts(r.posts || []);
  }

  async function moveCandidate(appId, stage) {
    await api.post('/applications/' + appId + '/move', { status: stage });
    load();
  }

  async function disqualify(appId) {
    await api.post('/applications/' + appId + '/move', { status: 'rejected' });
    load();
  }

  if (!req) return <div className="flex items-center justify-center h-64 text-gray-400">Loading request…</div>;

  const activeApps = (apps || []).filter(a => !DISQUALIFIED.includes(a.status));
  const disqualifiedCount = (apps || []).filter(a => DISQUALIFIED.includes(a.status)).length;

  return (
    <div>
      {/* Header */}
      <button onClick={() => nav('/requests')} className="text-sm text-gray-400 hover:text-gray-600 mb-3">&larr; Back to Requests</button>
      <div className="bg-white rounded-lg border border-gray-100 p-5 mb-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs text-gray-400 font-medium uppercase tracking-wide">Recruitment Request</div>
            <h1 className="text-lg font-bold mt-0.5">{req.title}</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
              <span className="font-medium">{req.ticketNo}</span>
              <span>&middot;</span>
              <span>{req.department?.name || '—'}</span>
              <span>&middot;</span>
              <span className="capitalize">{req.priority} priority</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {[
          ['pipeline', 'Pipeline'],
          ['thread', 'Conversation'],
          ['details', 'Details'],
        ].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === k ? 'border-red-600 text-red-700' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >{label}{k === 'pipeline' && apps ? ` (${activeApps.length})` : ''}</button>
        ))}
      </div>

      {/* Pipeline Tab */}
      {tab === 'pipeline' && (
        <div>
          <div className="flex items-center gap-3 mb-4 text-sm">
            <span className="px-2 py-0.5 bg-green-50 text-green-700 rounded text-xs font-medium">Active {activeApps.length}</span>
            {disqualifiedCount > 0 && <span className="px-2 py-0.5 bg-red-50 text-red-700 rounded text-xs font-medium">Disqualified {disqualifiedCount}</span>}
          </div>

          <div className="flex gap-3 overflow-x-auto pb-4">
            {PIPELINE.map(col => {
              const items = activeApps.filter(a => toColumn(a.status) === col.key);
              return (
                <div key={col.key} className="flex-shrink-0 w-60">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{col.label}</span>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map(a => (
                      <div key={a.id} className="bg-white border border-gray-100 rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium truncate">{a.candidate?.fullName}</span>
                        </div>
                        <div className="text-xs text-gray-400 truncate mb-2">
                          {a.candidate?.currentPosition}{a.candidate?.currentCompany ? ' · ' + a.candidate?.currentCompany : ''}
                        </div>
                        <div className="flex items-center gap-1">
                          {hasPerm('candidate.move_stage') && !DISQUALIFIED.includes(a.status) && a.status !== 'hired' && (
                            <select
                              value={a.status}
                              onChange={(e) => { if (e.target.value) moveCandidate(a.id, e.target.value); }}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 flex-1"
                            >
                              <option value="">Move…</option>
                              {PIPELINE.map(s => (
                                <option key={s.key} value={s.key} disabled={PIPELINE.findIndex(p => p.key === s.key) <= PIPELINE.findIndex(p => p.key === toColumn(a.status))}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          )}
                          {hasPerm('candidate.move_stage') && !DISQUALIFIED.includes(a.status) && (
                            <button onClick={() => disqualify(a.id)}
                              className="text-xs text-red-500 hover:text-red-700 border border-red-200 rounded px-2 py-0.5"
                            >Disqualify</button>
                          )}
                        </div>
                      </div>
                    ))}
                    {items.length === 0 && (
                      <div className="text-xs text-gray-300 text-center py-4 border border-dashed border-gray-100 rounded-lg">No candidates</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conversation Tab — Ticket Thread */}
      {tab === 'thread' && (
        <div>
          <div className="bg-white rounded-lg border border-gray-100 divide-y divide-gray-50 mb-4">
            {posts.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">No conversation yet. Start the discussion below.</div>
            ) : posts.map(p => (
              <div key={p.id} className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium">{p.author_name || 'System'}</span>
                  <span className="text-xs text-gray-400">{new Date(p.created_at).toLocaleString()}</span>
                  {p.post_type === 'system' && <span className="text-xs px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">System</span>}
                </div>
                <div className="text-sm text-gray-700 whitespace-pre-wrap">{p.body}</div>
              </div>
            ))}
          </div>

          {/* New post input */}
          <div className="flex gap-2">
            <textarea
              value={newPost}
              onChange={e => setNewPost(e.target.value)}
              placeholder="Write a message to the hiring team…"
              rows={2}
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-200"
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPost(); } }}
            />
            <button onClick={sendPost}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg self-end"
              style={{ backgroundColor: '#d2232a' }}
            >Send</button>
          </div>
        </div>
      )}

      {/* Details Tab */}
      {tab === 'details' && (
        <div className="bg-white rounded-lg border border-gray-100 p-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-gray-400">Position:</span> <span className="font-medium">{req.title}</span></div>
            <div><span className="text-gray-400">Department:</span> {req.department?.name || '—'}</div>
            <div><span className="text-gray-400">Project:</span> {req.project?.name || '—'}</div>
            <div><span className="text-gray-400">Location:</span> {req.location || req.site?.name || '—'}</div>
            <div><span className="text-gray-400">Priority:</span> <span className="capitalize">{req.priority}</span></div>
            <div><span className="text-gray-400">Recruiter:</span> {req.owner?.name || 'Unassigned'}</div>
          </div>
          {req.keyResponsibilities && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="text-xs font-medium text-gray-400 uppercase mb-2">Key Responsibilities</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">{req.keyResponsibilities}</div>
            </div>
          )}
          {req.keyRequirements && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="text-xs font-medium text-gray-400 uppercase mb-2">Key Requirements</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">{req.keyRequirements}</div>
            </div>
          )}
          {/* Activity timeline */}
          {req.activity?.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="text-xs font-medium text-gray-400 uppercase mb-2">Activity</div>
              <div className="space-y-2">
                {req.activity.slice(0, 10).map(a => (
                  <div key={a.id} className="flex items-start gap-2 text-sm">
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium capitalize">{a.type?.replace(/_/g, ' ')}</span>
                      {a.note && <span className="text-gray-500"> — {a.note}</span>}
                      <span className="text-xs text-gray-300 ml-2">{a.actor_name} · {new Date(a.occurred_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
