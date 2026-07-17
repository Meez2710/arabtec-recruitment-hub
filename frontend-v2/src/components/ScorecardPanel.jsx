export default function ScorecardPanel({ title, criteria, scores, onChange }) {
  function setScore(key, val) {
    onChange(s => ({ ...s, [key]: val }));
  }

  return (
    <div>
      <h3 className="font-semibold text-sm mb-4">{title}</h3>
      <div className="space-y-4">
        {criteria.map(c => (
          <div key={c}>
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm text-gray-700">{c}</span>
              <span className="text-xs font-bold text-gray-400">
                {scores[c] != null ? scores[c] + '/5' : '—'}
              </span>
            </div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => setScore(c, n)}
                  className={`flex-1 h-7 rounded text-xs font-medium transition-colors ${
                    scores[c] === n
                      ? 'text-white'
                      : scores[c] >= n
                        ? 'bg-red-100 text-red-600'
                        : 'bg-gray-100 text-gray-300 hover:bg-gray-200'
                  }`}
                  style={scores[c] === n ? { backgroundColor: '#d2232a' } : {}}
                >{n}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
