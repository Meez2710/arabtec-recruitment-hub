import { useState } from 'react';
import ScorecardPanel from '../components/ScorecardPanel';

// Mock data — in production this comes from /api/interviews
const MOCK_CANDIDATE = {
  id: 1, fullName: "Ahmed Hassan", currentPosition: "Senior Site Engineer",
  currentCompany: "Orascom", yearsExperience: 8, location: "Cairo",
  email: "ahmed.hassan@email.com", phone: "+20101234567",
};

export default function InterviewHub() {
  const [candidate] = useState(MOCK_CANDIDATE);
  const [hrScores, setHrScores] = useState({});
  const [techScores, setTechScores] = useState({});

  const avg = (scores) => {
    const vals = Object.values(scores).filter(v => typeof v === 'number');
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
  };

  const hrAvg = avg(hrScores);
  const techAvg = avg(techScores);
  const overall = (parseFloat(hrAvg) + parseFloat(techAvg)) / 2 || '—';
  const recommendation = overall >= 4 ? 'Move to Offer' : overall >= 3 ? 'Move to 2nd Interview' : overall >= 2 ? 'Hold / Review' : 'Reject';

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Interview Hub</h1>

      <div className="grid grid-cols-3 gap-4 h-[calc(100vh-120px)]">
        {/* Left: Candidate CV */}
        <div className="bg-white rounded-lg border border-gray-100 p-5 overflow-auto">
          <h2 className="font-semibold text-sm mb-4">Candidate CV</h2>
          <div className="space-y-4">
            <div>
              <div className="text-lg font-bold">{candidate.fullName}</div>
              <div className="text-sm text-gray-500">{candidate.currentPosition} at {candidate.currentCompany}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-gray-400">Email:</span> {candidate.email}</div>
              <div><span className="text-gray-400">Phone:</span> {candidate.phone}</div>
              <div><span className="text-gray-400">Experience:</span> {candidate.yearsExperience} years</div>
              <div><span className="text-gray-400">Location:</span> {candidate.location}</div>
            </div>
            <div>
              <div className="text-xs font-medium text-gray-400 uppercase mb-2">Resume</div>
              <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-500 italic">
                Resume content loaded from candidate document…
              </div>
            </div>
          </div>
        </div>

        {/* Center: HR Scorecard */}
        <div className="bg-white rounded-lg border border-gray-100 p-5 overflow-auto">
          <ScorecardPanel title="HR Assessment" criteria={[
            'Communication', 'Cultural Fit', 'Leadership Potential', 'Teamwork', 'Stability'
          ]} scores={hrScores} onChange={setHrScores} />
          <div className="mt-4 pt-3 border-t border-gray-100 text-center">
            <span className="text-xs text-gray-400">HR Average</span>
            <div className="text-xl font-bold">{hrAvg}</div>
          </div>
        </div>

        {/* Right: Technical Scorecard */}
        <div className="bg-white rounded-lg border border-gray-100 p-5 overflow-auto">
          <ScorecardPanel title="Technical Assessment" criteria={[
            'Technical Knowledge', 'Problem Solving', 'Industry Experience', 'Tools & Software', 'Project Complexity'
          ]} scores={techScores} onChange={setTechScores} />
          <div className="mt-4 pt-3 border-t border-gray-100 text-center">
            <span className="text-xs text-gray-400">Technical Average</span>
            <div className="text-xl font-bold">{techAvg}</div>
          </div>
        </div>
      </div>

      {/* Submit bar */}
      <div className="fixed bottom-0 left-56 right-0 bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-between z-30">
        <div>
          <span className="text-sm text-gray-400">Overall Score: </span>
          <span className="text-lg font-bold">{isNaN(overall) ? '—' : overall}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">Suggested: <strong>{recommendation}</strong></span>
          <button className="px-4 py-2 text-sm text-white rounded-lg" style={{ backgroundColor: '#d2232a' }}>
            Submit & Advance
          </button>
        </div>
      </div>
    </div>
  );
}
