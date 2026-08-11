import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await login(email, pass); nav('/'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={submit} className="bg-white p-8 rounded-xl shadow-sm w-full max-w-sm border border-gray-100">
        <div className="mb-6 text-center">
          <div className="font-bold text-2xl" style={{ color: '#d2232a' }}>Arabtec</div>
          <p className="text-sm text-gray-400 mt-1">Recruitment Hub</p>
        </div>
        {err && <div className="mb-4 p-3 text-sm text-red-700 bg-red-50 rounded-lg">{err}</div>}
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-200" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Password</label>
            <input type="password" value={pass} onChange={e => setPass(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-200" />
          </div>
          <button type="submit" disabled={busy}
            className="w-full py-2.5 text-sm font-semibold text-white rounded-lg transition-colors"
            style={{ backgroundColor: busy ? '#e88' : '#d2232a' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        <p className="mt-4 text-xs text-center text-gray-400">Use your Arabtec corporate account</p>
      </form>
    </div>
  );
}
