import { useState } from 'react';
import { api } from '../lib/api';

const STEPS = ['Position', 'Details', 'Review'];

export default function RequestWizard({ onClose, onCreated }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ title: '', departmentId: '', projectId: '', location: '', priority: 'medium', keyResponsibilities: '', keyRequirements: '' });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  async function submit() {
    setBusy(true);
    try { await api.post('/requests', f); onCreated(); } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        {/* Step indicators */}
        <div className="flex items-center px-6 pt-5 pb-3 gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i <= step ? 'text-white' : 'text-gray-400 bg-gray-100'}`}
                style={i <= step ? { backgroundColor: '#d2232a' } : {}}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-xs font-medium ${i <= step ? 'text-gray-800' : 'text-gray-300'}`}>{s}</span>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-200 mx-1" />}
            </div>
          ))}
        </div>

        <div className="p-6">
          {step === 0 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Position Details</h3>
              <input placeholder="Position title *" value={f.title} onChange={e => set('title', e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <select value={f.departmentId} onChange={e => set('departmentId', e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                <option value="">Department *</option>
              </select>
              <select value={f.projectId} onChange={e => set('projectId', e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                <option value="">Project *</option>
              </select>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Additional Details</h3>
              <input placeholder="Location" value={f.location} onChange={e => set('location', e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              <select value={f.priority} onChange={e => set('priority', e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                <option value="medium">Priority: Medium</option>
                <option value="low">Low</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <textarea placeholder="Key responsibilities" value={f.keyResponsibilities} onChange={e => set('keyResponsibilities', e.target.value)} rows={3} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Review</h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div><span className="text-gray-400">Position:</span> <strong>{f.title || '(not set)'}</strong></div>
                <div><span className="text-gray-400">Location:</span> {f.location || '(not set)'}</div>
                <div><span className="text-gray-400">Priority:</span> <span className="capitalize">{f.priority}</span></div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between px-6 pb-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          <div className="flex gap-2">
            {step > 0 && <button onClick={() => setStep(s => s - 1)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg">Back</button>}
            {step < 2 && <button onClick={() => setStep(s => s + 1)} className="px-4 py-2 text-sm text-white rounded-lg" style={{ backgroundColor: '#d2232a' }}>Next</button>}
            {step === 2 && <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm text-white rounded-lg" style={{ backgroundColor: busy ? '#e88' : '#d2232a' }}>{busy ? 'Creating…' : 'Create Request'}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
