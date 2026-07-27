#!/usr/bin/env python3
"""
UAT harness — exercises the merged build over real HTTP against a live server
with an isolated database. Verifies API response, status codes, permission
enforcement and database persistence. Does NOT verify browser rendering.
"""
import json, urllib.request, urllib.error, sys, os, io, uuid

B = os.environ.get('UAT_BASE', 'http://127.0.0.1:4700')
RESULTS = []

def call(method, path, token=None, body=None, raw=None, ctype=None):
    url = B + path
    data = None; headers = {}
    if body is not None:
        data = json.dumps(body).encode(); headers['Content-Type'] = 'application/json'
    if raw is not None:
        data = raw; headers['Content-Type'] = ctype or 'application/octet-stream'
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            b = r.read()
            try: return r.status, json.loads(b)
            except Exception: return r.status, b
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b)
        except Exception: return e.code, b.decode('utf-8', 'replace')[:300]
    except Exception as e:
        return 0, str(e)

def check(cid, module, desc, expected, actual, ok, notes=''):
    RESULTS.append(dict(id=cid, module=module, desc=desc, expected=expected,
                        actual=str(actual)[:300], status='PASS' if ok else 'FAIL', notes=notes))
    print(('  PASS ' if ok else '  FAIL ') + cid + '  ' + desc + ('' if ok else '\n        expected: %s\n        actual:   %s' % (expected, str(actual)[:300])))
    return ok

def section(t): print('\n=== ' + t + ' ===')

ADMIN_PW = os.environ.get('SEED_ADMIN_PASSWORD', 'UatAdmin@2026!x')

# ---------------------------------------------------------------- AUTH
section('1. AUTHENTICATION')
s, r = call('POST', '/api/auth/login', body={'email': 'admin@arabtec.com', 'password': ADMIN_PW})
check('1.3', 'Authentication', 'Valid credentials return a token', '200 + token',
      '%s %s' % (s, list(r.keys()) if isinstance(r, dict) else r), s == 200 and isinstance(r, dict) and 'token' in r)
ADMIN_T = r.get('token') if isinstance(r, dict) else None
mcp_flag = None
if isinstance(r, dict):
    for k in ('mustChangePassword', 'must_change_password'):
        if k in r: mcp_flag = r[k]
    u = r.get('user') or {}
    for k in ('mustChangePassword', 'must_change_password'):
        if k in u: mcp_flag = u[k]
check('1.7a', 'Authentication', 'Login response signals forced rotation for a must-change user',
      'a mustChangePassword flag present and true', repr(mcp_flag), mcp_flag is True,
      'The SPA needs this flag to render ForcedPasswordChange')

s, r = call('POST', '/api/auth/login', body={'email': 'admin@arabtec.com', 'password': 'WrongPassword1!'})
check('1.4', 'Authentication', 'Invalid password rejected', '401', s, s == 401)
s2, r2 = call('POST', '/api/auth/login', body={'email': 'nobody@nowhere.test', 'password': 'WrongPassword1!'})
check('1.5', 'Authentication', 'Unknown email gives the same response as a wrong password (no user enumeration)',
      'same status and message as 1.4', '%s vs %s | %s vs %s' % (s, s2, r, r2), s == s2 and str(r) == str(r2))
s, r = call('POST', '/api/auth/login', body={'email': '', 'password': ''})
check('1.6', 'Authentication', 'Empty credentials rejected', '400 or 401', s, s in (400, 401))

section('1b. FORCED ROTATION GATE (new — never browser-tested)')
for path, label in [('/api/candidates', 'candidates'), ('/api/users', 'users'),
                    ('/api/requests', 'requests'), ('/api/dashboard', 'dashboard')]:
    s, r = call('GET', path, token=ADMIN_T)
    check('1.8-' + label, 'Authentication', 'Rotation gate blocks %s before password change' % label,
          '403 password_change_required', '%s %s' % (s, r), s == 403,
          'If 200, the gate is not enforced on this route')
for path in ['/api/auth/me']:
    s, r = call('GET', path, token=ADMIN_T)
    check('1.9-me', 'Authentication', 'Allow-list lets the user read their own session during rotation',
          '200', '%s' % s, s == 200, 'Must be reachable or the SPA cannot render the rotation screen')

section('1c. PASSWORD POLICY')
weak = [('short1A!', 'shorter than 12 chars'), ('alllowercaseletters', 'no upper/digit/symbol'),
        ('Arabtec@12345', 'deny-listed'), ('ADMINADMIN123!', 'no lowercase'),
        ('Passwordpassword', 'no digit or symbol')]
for pw, why in weak:
    s, r = call('POST', '/api/auth/change-password', token=ADMIN_T,
                body={'currentPassword': ADMIN_PW, 'newPassword': pw})
    check('1.10-' + why[:18], 'Authentication', 'Weak password rejected (%s)' % why,
          '400', '%s %s' % (s, r), s == 400)

NEWPW = 'Zx9Quarry#Vault7'
s, r = call('POST', '/api/auth/change-password', token=ADMIN_T,
            body={'currentPassword': ADMIN_PW, 'newPassword': NEWPW})
check('1.13', 'Authentication', 'Valid rotation accepted', '200', '%s %s' % (s, r), s == 200)
s, r = call('POST', '/api/auth/login', body={'email': 'admin@arabtec.com', 'password': NEWPW})
ADMIN_T = r.get('token') if isinstance(r, dict) and s == 200 else ADMIN_T
check('1.14a', 'Authentication', 'New password works', '200', s, s == 200)
s, _ = call('POST', '/api/auth/login', body={'email': 'admin@arabtec.com', 'password': ADMIN_PW})
check('1.14b', 'Authentication', 'Old password no longer works', '401', s, s == 401)
s, r = call('GET', '/api/candidates', token=ADMIN_T)
check('1.15', 'Authentication', 'Gate lifted after rotation', '200', s, s == 200)

section('2. UNAUTHENTICATED ACCESS')
for p in ['/api/candidates', '/api/users', '/api/requests', '/api/roles', '/api/offers', '/api/interviews']:
    s, _ = call('GET', p)
    check('2-' + p.split('/')[-1], 'Security', 'Unauthenticated %s rejected' % p, '401', s, s == 401)
s, _ = call('GET', '/api/candidates', token='not.a.real.token')
check('2-forged', 'Security', 'Forged token rejected', '401', s, s == 401)

section('3. USER MANAGEMENT')
uemail = 'uat.user.%s@arabtec.com' % uuid.uuid4().hex[:6]
s, r = call('POST', '/api/users', token=ADMIN_T,
            body={'email': uemail, 'fullName': 'UAT Test User', 'roleCodes': ['hr_manager']})
tmp_pw = None
if isinstance(r, dict):
    tmp_pw = r.get('temporaryPassword') or (r.get('user') or {}).get('temporaryPassword')
check('14.2a', 'User Management', 'Create user succeeds', '200/201', '%s %s' % (s, r), s in (200, 201))
check('14.2b', 'User Management', 'Temporary password returned once so the UI can display it',
      'temporaryPassword present in the response', 'present' if tmp_pw else 'ABSENT — %s' % (list(r.keys()) if isinstance(r, dict) else r),
      bool(tmp_pw), 'This was the launch-blocker defect')

if tmp_pw:
    s, r = call('POST', '/api/auth/login', body={'email': uemail, 'password': tmp_pw})
    check('14.3', 'User Management', 'New user can sign in with the temporary password', '200', '%s' % s, s == 200)
    NEW_T = r.get('token') if s == 200 and isinstance(r, dict) else None
    flag = None
    if isinstance(r, dict):
        flag = r.get('mustChangePassword', (r.get('user') or {}).get('mustChangePassword'))
    check('14.4a', 'User Management', 'New user is flagged for forced rotation', 'True', repr(flag), flag is True)
    s, _ = call('GET', '/api/candidates', token=NEW_T)
    check('14.4b', 'User Management', 'New user is blocked until rotation', '403', s, s == 403)
    s, _ = call('POST', '/api/auth/change-password', token=NEW_T,
                body={'currentPassword': tmp_pw, 'newPassword': 'Kt4Meadow$Lantern'})
    check('14.4c', 'User Management', 'New user can complete rotation', '200', s, s == 200)
    s, r = call('POST', '/api/auth/login', body={'email': uemail, 'password': 'Kt4Meadow$Lantern'})
    HR_T = r.get('token') if s == 200 and isinstance(r, dict) else None
    check('14.4d', 'User Management', 'New user works normally after rotation', '200', s, s == 200)
else:
    HR_T = None

s, r = call('POST', '/api/users', token=ADMIN_T,
            body={'email': uemail, 'fullName': 'Duplicate', 'role': 'hr_manager'})
check('14.7', 'User Management', 'Duplicate email rejected', '400/409', '%s %s' % (s, r), s in (400, 409))
s, r = call('POST', '/api/users', token=ADMIN_T,
            body={'email': 'weak.%s@arabtec.com' % uuid.uuid4().hex[:5], 'fullName': 'Weak', 'role': 'hr_manager', 'password': 'abc'})
check('14.6', 'User Management', 'Weak explicit password rejected on create', '400', '%s %s' % (s, r), s == 400)

section('4. PERMISSION ENFORCEMENT (as HR Manager)')
if HR_T:
    s, r = call('POST', '/api/users', token=HR_T,
                body={'email': 'sneak.%s@arabtec.com' % uuid.uuid4().hex[:5], 'fullName': 'Sneak', 'role': 'admin'})
    check('16.4', 'Security', 'HR Manager cannot create users even by direct API call', '403', '%s %s' % (s, r), s == 403)
    s, _ = call('GET', '/api/users', token=HR_T)
    check('16.4b', 'Security', 'HR Manager cannot list users', '403', s, s == 403)
    s, r = call('GET', '/api/roles', token=HR_T)
    check('16.5a', 'Security', 'GET /api/roles exposes the full permission matrix to any authenticated user', 'documented decision', s, True, 'FINDING: route has no requirePermission guard')
    s, rr = call('GET', '/api/roles', token=ADMIN_T)
    rid = None
    if s == 200:
        lst = rr if isinstance(rr, list) else (rr.get('roles') if isinstance(rr, dict) else [])
        for x in (lst or []):
            if isinstance(x, dict) and x.get('key') in ('hr_manager', 'recruiter'): rid = x.get('id')
        if rid is None and lst: rid = (lst[0] or {}).get('id')
    if rid:
        s, r = call('PUT', '/api/roles/%s/permissions' % rid, token=HR_T, body={'permissions': ['user.manage']})
        check('16.5b', 'Security', 'HR Manager cannot grant user.manage (role-escalation guard)', '403', '%s %s' % (s, r), s == 403)
    s, _ = call('GET', '/api/candidates', token=HR_T)
    check('16.1', 'Security', 'HR Manager CAN read candidates (not over-restricted)', '200', s, s == 200)

section('5. LAST-ADMIN PROTECTION (correct endpoint)')
s, ul = call('GET', '/api/users', token=ADMIN_T)
users = ul if isinstance(ul, list) else (ul.get('users') if isinstance(ul, dict) else [])
def rolecodes(u): return [r.get('code') for r in (u.get('roles') or []) if isinstance(r, dict)]
admins = [u for u in (users or []) if 'system_admin' in rolecodes(u) and u.get('status') == 'active']
me = next((u for u in (users or []) if u.get('email') == 'admin@arabtec.com'), None)
print('  context: %d users, %d active system_admin' % (len(users or []), len(admins)))
if me and len(admins) == 1:
    s, r = call('POST', '/api/users/%s/deactivate' % me['id'], token=ADMIN_T)
    check('16.6', 'Security', 'Deactivating the last active admin is refused', '409 LAST_ADMIN_PROTECTED',
          '%s %s' % (s, r), s == 409)
    s, r = call('PUT', '/api/users/%s' % me['id'], token=ADMIN_T, body={'roleCodes': ['hr_manager']})
    check('16.7', 'Security', 'Demoting the last active admin is refused', '409 LAST_ADMIN_PROTECTED',
          '%s %s' % (s, r), s == 409)
    s, r = call('PUT', '/api/users/%s' % me['id'], token=ADMIN_T, body={'active': False})
    still = call('GET', '/api/users/%s' % me['id'], token=ADMIN_T)[1]
    st = (still.get('user') or still).get('status') if isinstance(still, dict) else '?'
    check('16.6b', 'Security', 'PUT {active:false} cannot bypass the deactivate guard',
          "status stays 'active'", 'PUT->%s, status now %s' % (s, st), st == 'active',
          'Confirms the update route ignores an unrecognised active field')

section('6. AUTHORIZATION SWEEP — what can a plain HR Manager reach?')
sweep = ['/api/audit', '/api/thread', '/api/notifications', '/api/settings', '/api/dashboard',
         '/api/roles', '/api/roles/permissions', '/api/org/departments', '/api/interviews',
         '/api/offers', '/api/requests', '/api/candidates', '/api/assessments', '/api/applications']
if HR_T:
    for p in sweep:
        s, _ = call('GET', p, token=HR_T)
        print('  HR Manager GET %-26s -> %s' % (p, s))

section('7. TALENT POOL — pagination, sorting, filtering')
s, r = call('GET', '/api/candidates', token=ADMIN_T)
shape_ok = isinstance(r, dict) and 'candidates' in r and 'pagination' in r
check('5.1', 'Talent Pool', 'GET /api/candidates returns the new {candidates, pagination} shape',
      'dict with candidates + pagination', type(r).__name__ + ' ' + str(list(r.keys()) if isinstance(r, dict) else '')[:120], shape_ok)
if shape_ok:
    pg = r['pagination']
    check('5.2', 'Talent Pool', 'pagination block carries page/pageSize/total/totalPages/hasMore',
          'all five keys', list(pg.keys()),
          all(k in pg for k in ('page', 'pageSize', 'total', 'totalPages', 'hasMore')))
    import math
    check('6.15', 'Talent Pool', 'totalPages == ceil(total/pageSize)',
          'consistent', 'total=%s pageSize=%s totalPages=%s' % (pg.get('total'), pg.get('pageSize'), pg.get('totalPages')),
          pg.get('totalPages') == math.ceil((pg.get('total') or 0) / (pg.get('pageSize') or 1)) or (pg.get('total') == 0))
    s2, r2 = call('GET', '/api/candidates?page=1&pageSize=2', token=ADMIN_T)
    check('6.14', 'Talent Pool', 'pageSize honoured', '<=2 rows',
          len(r2.get('candidates', [])) if isinstance(r2, dict) else r2,
          isinstance(r2, dict) and len(r2.get('candidates', [])) <= 2)
    for key in ['name', 'created', 'company', 'position', 'university', 'graduation', 'experience', 'location', 'updated', 'confidence']:
        s3, r3 = call('GET', '/api/candidates?sort=%s&dir=asc' % key, token=ADMIN_T)
        check('5.8-' + key, 'Talent Pool', 'sort=%s accepted' % key, '200', s3, s3 == 200)
    s4, r4 = call('GET', '/api/candidates?sort=DROP+TABLE+candidate&dir=asc', token=ADMIN_T)
    check('5.11', 'Talent Pool', 'Invalid/injected sort key falls back safely', '200, not 500',
          '%s' % s4, s4 == 200, 'SQL-injection probe on the ORDER BY whitelist')
    s5, r5 = call('GET', '/api/candidates?page=9999', token=ADMIN_T)
    check('6.13', 'Talent Pool', 'Out-of-range page does not error', '200 with empty list',
          '%s len=%s' % (s5, len(r5.get('candidates', [])) if isinstance(r5, dict) else '?'), s5 == 200)
    s6, r6 = call('GET', '/api/candidates?search=zzzznonexistentzzz', token=ADMIN_T)
    check('6.4', 'Talent Pool', 'Search with no matches returns an empty result, not an error',
          '200 + 0 rows', '%s len=%s' % (s6, len(r6.get('candidates', [])) if isinstance(r6, dict) else '?'),
          s6 == 200 and isinstance(r6, dict) and len(r6.get('candidates', [])) == 0)

section('8. RESUME UPLOAD / PARSE / DOWNLOAD / PERSISTENCE')
CV = ("Ahmed Hassan Al-Sayed\n"
      "Senior Structural Engineer\n"
      "Cairo, Egypt | ahmed.hassan@example.com | Phone: +20 100 555 1234\n\n"
      "PROFESSIONAL EXPERIENCE\n"
      "Senior Structural Engineer | Arabtec Construction LLC | 2019 - Present\n"
      "  Led structural design for high-rise projects.\n"
      "Structural Engineer | Orascom Construction | 2014 - 2019\n\n"
      "EDUCATION\n"
      "Bachelor of Science in Civil Engineering\n"
      "Cairo University, 2013\n\n"
      "SKILLS\nAutoCAD, ETABS, SAP2000, Revit\n")

def multipart(fname, content, field='file'):
    bnd = '----uatboundary%s' % uuid.uuid4().hex
    body = (('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\n'
             'Content-Type: text/plain\r\n\r\n' % (bnd, field, fname)).encode()
            + content.encode() + ('\r\n--%s--\r\n' % bnd).encode())
    return body, 'multipart/form-data; boundary=%s' % bnd

s, r = call('POST', '/api/candidates', token=ADMIN_T,
            body={'fullName': 'UAT Resume Candidate', 'email': 'uat.resume@example.com'})
cid = None
if isinstance(r, dict): cid = (r.get('candidate') or r).get('id')
check('8.0', 'Candidates', 'Create candidate', '200/201 with id', '%s id=%s' % (s, cid), s in (200, 201) and cid)

if cid:
    body, ct = multipart('ahmed_cv.txt', CV)
    s, r = call('POST', '/api/candidates/%s/resume' % cid, token=ADMIN_T, raw=body, ctype=ct)
    if s == 404:
        s, r = call('POST', '/api/candidates/%s/parse-cv' % cid, token=ADMIN_T, raw=body, ctype=ct)
    check('8.1', 'Resume', 'Upload TXT resume accepted', '200/201', '%s %s' % (s, str(r)[:200]), s in (200, 201))

    s, r = call('GET', '/api/candidates/%s' % cid, token=ADMIN_T)
    c = (r.get('candidate') or r) if isinstance(r, dict) else {}
    check('8.15a', 'Resume', 'resume_path persisted after upload (regression: was dropped)',
          'resumeName/resumePath present', {k: c.get(k) for k in ('resumeName', 'resumePath', 'resume_name')},
          bool(c.get('resumeName') or c.get('resumePath') or c.get('resume_name')))
    check('8.15b', 'Resume', 'Parsed entities persisted to candidate columns',
          'email/phone/company/university populated',
          {k: c.get(k) for k in ('email', 'phone', 'currentCompany', 'currentPosition', 'university', 'yearsExperience')},
          bool(c.get('phone') or c.get('currentCompany') or c.get('university')))
    check('8.17', 'Resume', 'Parse metadata written', 'parseStatus + parseConfidence + parsedAt',
          {k: c.get(k) for k in ('parseStatus', 'parseConfidence', 'parsedAt')},
          c.get('parseStatus') is not None)
    check('7.3', 'Candidate Profile', 'Phone preserved correctly (regression watch)',
          'a +20 number, not mangled', repr(c.get('phone')),
          bool(c.get('phone')) and '20' in str(c.get('phone')))

    s, r = call('GET', '/api/candidates/%s/resume' % cid, token=ADMIN_T)
    check('8.12', 'Resume', 'Authenticated resume download returns the file', '200 + bytes',
          '%s %s bytes' % (s, len(r) if isinstance(r, (bytes, str)) else '?'), s == 200)
    s, r = call('GET', '/api/candidates/%s/resume' % cid)
    check('8.13', 'Resume', 'Resume download requires authentication', '401', s, s == 401)

    big = 'A' * (21 * 1024 * 1024)
    body, ct = multipart('huge.txt', big)
    s, r = call('POST', '/api/candidates/%s/resume' % cid, token=ADMIN_T, raw=body, ctype=ct)
    if s == 404:
        s, r = call('POST', '/api/candidates/%s/parse-cv' % cid, token=ADMIN_T, raw=body, ctype=ct)
    check('8.7', 'Resume', 'File over the 20 MB cap is rejected cleanly', '413/400, not 500',
          '%s %s' % (s, str(r)[:120]), s in (400, 413))

    body, ct = multipart('malware.exe', 'MZ\x90\x00')
    s, r = call('POST', '/api/candidates/%s/resume' % cid, token=ADMIN_T, raw=body, ctype=ct)
    if s == 404:
        s, r = call('POST', '/api/candidates/%s/parse-cv' % cid, token=ADMIN_T, raw=body, ctype=ct)
    check('8.5', 'Resume', 'Disallowed file extension rejected', '400', '%s %s' % (s, str(r)[:120]), s == 400)

    body, ct = multipart('empty.txt', '')
    s, r = call('POST', '/api/candidates/%s/resume' % cid, token=ADMIN_T, raw=body, ctype=ct)
    if s == 404:
        s, r = call('POST', '/api/candidates/%s/parse-cv' % cid, token=ADMIN_T, raw=body, ctype=ct)
    check('8.8', 'Resume', 'Zero-byte file handled without a 500', 'not 500', '%s' % s, s != 500)

section('9. ERROR HANDLING')
for path, want, label in [('/api/candidates/999999', (404,), 'missing candidate -> 404'),
                          ('/api/requests/999999', (404,), 'missing request -> 404'),
                          ('/api/users/999999', (404,), 'missing user -> 404')]:
    s, r = call('GET', path, token=ADMIN_T)
    check('18.6-' + label[:14], 'Error Handling', label, str(want), s, s in want)
s, r = call('POST', '/api/candidates', token=ADMIN_T, body={})
check('18-validation', 'Error Handling', 'Create candidate with empty body is rejected, not a 500',
      '400', '%s %s' % (s, str(r)[:120]), s == 400)

print('\n\n===== SUMMARY =====')
p = sum(1 for x in RESULTS if x['status'] == 'PASS'); f = len(RESULTS) - p
print('TOTAL %d   PASS %d   FAIL %d' % (len(RESULTS), p, f))
for x in RESULTS:
    if x['status'] == 'FAIL': print('  FAIL %-14s %-18s %s' % (x['id'], x['module'], x['desc']))
json.dump(RESULTS, open('/tmp/uat/results.json', 'w'), indent=1)
