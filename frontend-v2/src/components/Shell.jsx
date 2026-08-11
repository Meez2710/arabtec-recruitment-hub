import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/requests', label: 'Requests' },
  { to: '/talent-pool', label: 'Talent Pool' },
  { to: '/interviews', label: 'Interviews' },
];

export default function Shell({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-screen">
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="font-bold text-lg" style={{ color: '#d2232a' }}>Arabtec</div>
          <div className="text-xs text-gray-400">Recruitment Hub</div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => `block px-3 py-2 rounded text-sm font-medium transition-colors ${isActive ? 'bg-red-50 text-red-700' : 'text-gray-600 hover:bg-gray-50'}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-100">
          <p className="text-sm font-medium truncate">{user?.fullName}</p>
          <p className="text-xs text-gray-400 capitalize">{user?.roles?.[0]?.replace(/_/g, ' ')}</p>
          <button onClick={logout} className="mt-2 text-xs text-gray-400 hover:text-red-600">Sign out</button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
