// Ticket thread — email-style conversation on a recruitment request.
// The request details are the "subject"; posts below form a chronological feed
// (messages, file attachments, CV uploads, structured feedback, system entries),
// with one level of replies. Everyone who can view the request can post.
import { Router } from 'express';
import { Posts, Requests, Candidates, Applications, Users } from '../lib/models.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { multipart, uploadPath, fileExists } from '../lib/upload.js';
import { run as dbRun } from '../lib/db.js';
import fs from 'node:fs';

const router = Router();
router.use(requireAuth);

// The ticket is a shared hiring conversation. Reading is open to everyone involved
// (request.view_all holders incl. read-only viewers, owner/requester/creator, the
// assigned hiring manager, and interviewers). Posting requires an active participant
// role — viewers (read-only) can follow the thread but cannot contribute.
function isParticipant(user, r) {
  if (r.hiring_manager_id && r.hiring_manager_id === user.id) return true;
  if (user.permissions.includes('request.view_own') &&
      (r.owner_id === user.id || r.requester_id === user.id || r.created_by === user.id)) return true;
  if (user.permissions.includes('request.create')) return true;       // recruiters / HR / HM
  if (user.permissions.includes('interview.feedback')) return true;   // interviewers
  if (user.permissions.includes('request.assign_recruiter')) return true; // recruitment managers
  return false;
}
function canView(user, r) {
  if (user.permissions.includes('request.view_all')) return true;
  return isParticipant(user, r);
}
function loadRequest(req, res, { post = false } = {}) {
  const r = Requests.byId(Number(req.params.requestId));
  if (!r) { res.status(404).json({ error: 'Request not found.' }); return null; }
  if (!canView(req.user, r)) { res.status(403).json({ error: 'You cannot view this request.' }); return null; }
  if (post && !isParticipant(req.user, r)) { res.status(403).json({ error: 'You can read this ticket but cannot post in it.' }); return null; }
  return r;
}

const PRIMARY_ROLE = (u) => (u.roles && u.roles[0]) || null;

function out(p) {
  return {
    id: p.id, requestId: p.request_id, parentPostId: p.parent_post_id,
    type: p.post_type, body: p.body,
    author: { id: p.author_id, name: p.author_name, role: p.author_role },
    fileName: p.file_name, hasFile: !!p.file_path,
    candidateId: p.candidate_id, applicationId: p.application_id,
    payload: p.payload ? JSON.parse(p.payload) : null,
    edited: p.edited === 1, createdAt: p.created_at, updatedAt: p.updated_at,
  };
}
// Build a nested tree: top-level posts (parent null) with their replies in order.
function tree(requestId) {
  const all = Posts.forRequest(requestId).map(out);
  const byParent = new Map();
  for (const p of all) { if (p.parentPostId) { if (!byParent.has(p.parentPostId)) byParent.set(p.parentPostId, []); byParent.get(p.parentPostId).push(p); } }
  return all.filter((p) => !p.parentPostId).map((p) => ({ ...p, replies: byParent.get(p.id) || [] }));
}

/* ---------------- GET thread ---------------- */
router.get('/request/:requestId', (req, res) => {
  const r = loadRequest(req, res); if (!r) return;
  res.json({ posts: tree(r.id) });
});

/* ---------------- POST message / reply ---------------- */
router.post('/request/:requestId', (req, res) => {
  const r = loadRequest(req, res, { post: true }); if (!r) return;
  const { body, parentPostId } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required.' });
  if (parentPostId) { const parent = Posts.byId(Number(parentPostId)); if (!parent || parent.request_id !== r.id) return res.status(400).json({ error: 'Invalid parent post.' }); }
  const post = Posts.create({
    requestId: r.id, parentPostId: parentPostId ? Number(parentPostId) : null, postType: 'message',
    authorId: req.user.id, authorName: req.user.fullName, authorRole: PRIMARY_ROLE(req.user), body: body.trim(),
  });
  writeAudit(req, { action: 'ticket.post_created', entityType: 'recruitment_request', entityId: r.id, newValue: { postType: 'message', parent: parentPostId || null } });
  res.status(201).json({ post: out(post) });
});

/* ---------------- POST file attachment ---------------- */
router.post('/request/:requestId/file', multipart, (req, res) => {
  const r = loadRequest(req, res, { post: true }); if (!r) return;
  if (!req.uploadedFile) return res.status(400).json({ error: 'No file uploaded.' });
  const { body, parentPostId } = req.fields || {};
  const post = Posts.create({
    requestId: r.id, parentPostId: parentPostId ? Number(parentPostId) : null, postType: 'file',
    authorId: req.user.id, authorName: req.user.fullName, authorRole: PRIMARY_ROLE(req.user),
    body: body || null, filePath: req.uploadedFile.storedName, fileName: req.uploadedFile.originalName,
  });
  writeAudit(req, { action: 'ticket.file_attached', entityType: 'recruitment_request', entityId: r.id, newValue: { fileName: req.uploadedFile.originalName } });
  res.status(201).json({ post: out(post) });
});

/* ---------------- Download a post's file ---------------- */
router.get('/post/:postId/file', (req, res) => {
  const post = Posts.byId(Number(req.params.postId));
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const r = Requests.byId(post.request_id);
  if (!r || !canView(req.user, r)) return res.status(403).json({ error: 'Not allowed.' });
  if (!post.file_path || !fileExists(post.file_path)) return res.status(404).json({ error: 'No file on this post.' });
  res.setHeader('Content-Disposition', `inline; filename="${(post.file_name || 'file').replace(/"/g, '')}"`);
  fs.createReadStream(uploadPath(post.file_path)).pipe(res);
});

/* ---------------- POST a CV (creates/links a candidate + application, then posts) ---------------- */
router.post('/request/:requestId/cv', multipart, (req, res) => {
  const r = loadRequest(req, res, { post: true }); if (!r) return;
  if (!req.user.permissions.includes('candidate.add') && !req.user.permissions.includes('candidate.link'))
    return res.status(403).json({ error: 'You cannot add candidates.' });
  if (!req.uploadedFile) return res.status(400).json({ error: 'No CV file uploaded.' });
  const f = req.fields || {};
  const fullName = (f.fullName || '').trim();
  if (!fullName) return res.status(400).json({ error: 'Candidate name is required.' });

  // Create the candidate, store the CV as the résumé, then link to this request.
  const cand = Candidates.create({
    candidateNo: Candidates.nextNo(), fullName, email: f.email || null, phone: f.phone || null,
    currentPosition: f.currentPosition || null, employer: f.employer || null,
    yearsExperience: f.yearsExperience ? Number(f.yearsExperience) : null,
    createdBy: req.user.id,
  });
  dbRun('UPDATE candidate SET resume_path=?, resume_name=?, updated_at=? WHERE id=?',
    [req.uploadedFile.storedName, req.uploadedFile.originalName, new Date().toISOString(), cand.id]);
  let application = null;
  if (!Applications.existing(cand.id, r.id)) {
    application = Applications.create({
      applicationNo: Applications.nextNo(), candidateId: cand.id, requestId: r.id, status: 'new',
      matchScore: f.matchScore ? Number(f.matchScore) : null, source: f.source || 'ticket', createdBy: req.user.id,
    });
  }

  const post = Posts.create({
    requestId: r.id, postType: 'cv', authorId: req.user.id, authorName: req.user.fullName, authorRole: PRIMARY_ROLE(req.user),
    body: f.body || null, filePath: req.uploadedFile.storedName, fileName: req.uploadedFile.originalName,
    candidateId: cand.id, applicationId: application ? application.id : null,
    payload: { candidateName: fullName, currentPosition: f.currentPosition || null, employer: f.employer || null },
  });
  writeAudit(req, { action: 'ticket.cv_posted', entityType: 'recruitment_request', entityId: r.id, newValue: { candidate: fullName } });
  res.status(201).json({ post: out(post), candidateId: cand.id, applicationId: application ? application.id : null });
});

/* ---------------- POST structured feedback into the thread ---------------- */
router.post('/request/:requestId/feedback', (req, res) => {
  const r = loadRequest(req, res, { post: true }); if (!r) return;
  if (!req.user.permissions.includes('interview.feedback'))
    return res.status(403).json({ error: 'You cannot submit feedback.' });
  const { applicationId, candidateId, recommendation, rating, body, parentPostId } = req.body || {};
  if (!body && !recommendation) return res.status(400).json({ error: 'Feedback needs a summary or recommendation.' });
  let appId = applicationId ? Number(applicationId) : null;
  if (appId) { const a = Applications.byId(appId); if (!a || a.request_id !== r.id) return res.status(400).json({ error: 'Application not on this request.' }); }
  const post = Posts.create({
    requestId: r.id, parentPostId: parentPostId ? Number(parentPostId) : null, postType: 'feedback',
    authorId: req.user.id, authorName: req.user.fullName, authorRole: PRIMARY_ROLE(req.user),
    body: body || null, candidateId: candidateId ? Number(candidateId) : null, applicationId: appId,
    payload: { recommendation: recommendation || null, rating: rating != null ? Number(rating) : null },
  });
  writeAudit(req, { action: 'ticket.feedback_posted', entityType: 'recruitment_request', entityId: r.id, newValue: { recommendation: recommendation || null } });
  res.status(201).json({ post: out(post) });
});

/* ---------------- Edit / delete own post ---------------- */
router.put('/post/:postId', (req, res) => {
  const post = Posts.byId(Number(req.params.postId));
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own posts.' });
  if (post.post_type === 'system') return res.status(400).json({ error: 'System posts cannot be edited.' });
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Body is required.' });
  const updated = Posts.update(post.id, { body: body.trim() });
  res.json({ post: out(updated) });
});

router.delete('/post/:postId', (req, res) => {
  const post = Posts.byId(Number(req.params.postId));
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const isAdmin = req.user.permissions.includes('audit.view') || (req.user.roles || []).includes('system_admin');
  if (post.author_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'You can only delete your own posts.' });
  Posts.remove(post.id);
  writeAudit(req, { action: 'ticket.post_deleted', entityType: 'recruitment_request', entityId: post.request_id, oldValue: { postId: post.id } });
  res.json({ ok: true });
});

export default router;
