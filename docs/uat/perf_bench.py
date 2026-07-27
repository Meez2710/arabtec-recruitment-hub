#!/usr/bin/env python3
"""Performance benchmark — real PDFs, real HTTP, measured not estimated."""
import json, os, time, uuid, urllib.request, urllib.error, threading, statistics, io, random
B = 'http://127.0.0.1:4700'
SRV_PID = int(os.environ.get('SRV_PID', '0'))

CV_TEXT = """Ahmed Hassan Al-Sayed
Senior Structural Engineer
Cairo, Egypt | ahmed.hassan@example.com | Phone: +20 100 555 1234

PROFESSIONAL EXPERIENCE
Senior Structural Engineer | Arabtec Construction LLC | 2019 - Present
Structural Engineer | Orascom Construction | 2014 - 2019

EDUCATION
Bachelor of Science in Civil Engineering
Cairo University, 2013

SKILLS
AutoCAD, ETABS, SAP2000, Revit"""


def make_pdf(path, target_bytes):
    """Real CV text on page 1, then noise-image pages to reach the target size —
    mirrors a scanned/photo-heavy CV, which is how real files get large."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    from PIL import Image
    c = canvas.Canvas(path, pagesize=A4)
    y = 800
    for line in CV_TEXT.split('\n'):
        c.drawString(50, y, line); y -= 14
    c.showPage()
    if target_bytes > 60_000:
        # incompressible noise so file size is predictable
        img = Image.frombytes('RGB', (900, 1200),
                              bytes(random.getrandbits(8) for _ in range(900 * 1200 * 3)))
        buf = io.BytesIO(); img.save(buf, format='JPEG', quality=95); buf.seek(0)
        per_page = len(buf.getvalue())
        pages = max(1, int(target_bytes / per_page))
        for _ in range(pages):
            buf.seek(0)
            c.drawImage(ImageReader(buf), 0, 0, width=595, height=842)
            c.showPage()
    c.save()
    return os.path.getsize(path)


def multipart(fname, data):
    bnd = '----bench%s' % uuid.uuid4().hex
    head = ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
            'Content-Type: application/pdf\r\n\r\n' % (bnd, fname)).encode()
    return head + data + ('\r\n--%s--\r\n' % bnd).encode(), 'multipart/form-data; boundary=%s' % bnd


def call(method, path, token=None, body=None, raw=None, ctype=None, timeout=300):
    headers = {}; data = None
    if body is not None:
        data = json.dumps(body).encode(); headers['Content-Type'] = 'application/json'
    if raw is not None:
        data = raw; headers['Content-Type'] = ctype
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(B + path, data=data, headers=headers, method=method)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read(); dt = (time.perf_counter() - t0) * 1000
            try: return r.status, json.loads(b), dt
            except Exception: return r.status, b, dt
    except urllib.error.HTTPError as e:
        dt = (time.perf_counter() - t0) * 1000
        return e.code, e.read()[:200], dt
    except Exception as e:
        return 0, str(e), (time.perf_counter() - t0) * 1000


def proc_stats(pid):
    """RSS in MB and cumulative CPU seconds for the server process."""
    if not pid: return None, None
    try:
        with open('/proc/%d/status' % pid) as f:
            rss = next(int(l.split()[1]) / 1024 for l in f if l.startswith('VmRSS'))
        with open('/proc/%d/stat' % pid) as f:
            p = f.read().split()
        cpu = (int(p[13]) + int(p[14])) / os.sysconf('SC_CLK_TCK')
        return rss, cpu
    except Exception:
        return None, None


def db_writes():
    import sqlite3
    try:
        con = sqlite3.connect('file:/tmp/perf/perf.db?mode=ro', uri=True)
        n = con.execute('SELECT COUNT(*) FROM candidate').fetchone()[0]
        con.close(); return n
    except Exception: return None

# ------------------------------------------------------------------ setup
PW = os.environ.get('SEED_ADMIN_PASSWORD', 'UatAdmin@2026!x')
s, r, _ = call('POST', '/api/auth/login', body={'email': 'admin@arabtec.com', 'password': PW})
T = r['token']
call('POST', '/api/auth/change-password', token=T, body={'currentPassword': PW, 'newPassword': 'Zx9Quarry#Vault7'})
s, r, _ = call('POST', '/api/auth/login', body={'email': 'admin@arabtec.com', 'password': 'Zx9Quarry#Vault7'})
T = r['token']
print('auth ready\n')

REPORT = {'uploads': [], 'stress': {}, 'env': {}}
r0, c0 = proc_stats(SRV_PID)
REPORT['env'] = {'baseline_rss_mb': r0, 'cpus': os.cpu_count()}
print('baseline server RSS: %.1f MB' % (r0 or 0))

# ------------------------------------------------------- PART 2: PDF sizes
print('\n=== PART 2: UPLOAD + PARSE BY FILE SIZE (real PDFs) ===')
print('%-8s %10s %12s %12s %10s %10s' % ('target', 'actual', 'total ms', 'parse ms', 'RSS MB', 'CPU s'))
os.makedirs('/tmp/perf/pdf', exist_ok=True)
for mb in (1, 5, 10, 20):
    path = '/tmp/perf/pdf/cv_%dmb.pdf' % mb
    if not os.path.exists(path):
        make_pdf(path, mb * 1024 * 1024)
    size = os.path.getsize(path)
    data = open(path, 'rb').read()

    s, r, _ = call('POST', '/api/candidates', token=T,
                   body={'fullName': 'Perf %dMB' % mb, 'email': 'perf%d@example.com' % mb})
    cid = (r.get('candidate') or r)['id']

    rss_b, cpu_b = proc_stats(SRV_PID)
    body, ct = multipart('cv_%dmb.pdf' % mb, data)
    st, resp, total_ms = call('POST', '/api/candidates/%s/resume' % cid, token=T, raw=body, ctype=ct)
    rss_a, cpu_a = proc_stats(SRV_PID)

    # isolate parse cost: re-parse reads the stored file, no network transfer
    st2, r2, parse_ms = call('POST', '/api/candidates/%s/reparse?overwrite=true' % cid, token=T)

    row = dict(target_mb=mb, actual_bytes=size, status=st, total_ms=round(total_ms, 1),
               parse_ms=round(parse_ms, 1) if st2 == 200 else None,
               rss_mb=round(rss_a or 0, 1), rss_delta_mb=round((rss_a or 0) - (rss_b or 0), 1),
               cpu_s=round((cpu_a or 0) - (cpu_b or 0), 2))
    fields = call('GET', '/api/candidates/%s' % cid, token=T)[1]
    c = fields.get('candidate') or fields
    row['parsed_ok'] = bool(c.get('phone') or c.get('currentCompany'))
    row['parse_status'] = c.get('parseStatus')
    REPORT['uploads'].append(row)
    print('%-8s %9.1fMB %11.0f %11s %9.1f %9.2f  http=%s parsed=%s' % (
        '%dMB' % mb, size / 1048576, total_ms,
        ('%.0f' % parse_ms) if st2 == 200 else 'n/a', row['rss_mb'], row['cpu_s'], st, row['parsed_ok']))

# --------------------------------------------------- PART 2b: large pool
print('\n=== PART 2b: LARGE TALENT POOL ===')
import sqlite3
con = sqlite3.connect('/tmp/perf/perf.db')
n0 = con.execute('SELECT COUNT(*) FROM candidate').fetchone()[0]
cols = [r[1] for r in con.execute('PRAGMA table_info(candidate)')]
rows = []
COMPANIES = ['Arabtec', 'Orascom', 'Hassan Allam', 'ACC', 'Besix', 'Consolidated Contractors']
UNIS = ['Cairo University', 'Ain Shams University', 'Alexandria University', 'AUC']
for i in range(5000):
    rows.append((
        'CAN-P%05d' % i, 'Perf Candidate %d' % i, 'perf.cand%d@example.com' % i,
        '+20 100 %07d' % i, COMPANIES[i % len(COMPANIES)], 'Site Engineer',
        UNIS[i % len(UNIS)], 2000 + (i % 25), i % 30,
        ['done', 'review', 'partial', 'failed'][i % 4], round((i % 100) / 100, 2),
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'))
con.executemany(
    'INSERT INTO candidate (candidate_no,full_name,email,phone,current_company,current_position,'
    'university,graduation_year,years_experience,parse_status,parse_confidence,created_at,updated_at) '
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
con.commit()
n1 = con.execute('SELECT COUNT(*) FROM candidate').fetchone()[0]
con.close()
print('  candidates: %d -> %d' % (n0, n1))

def timed(path, n=5):
    ts = []
    for _ in range(n):
        st, _r, ms = call('GET', path, token=T)
        ts.append(ms)
    return dict(status=st, p50=round(statistics.median(ts), 1),
                min=round(min(ts), 1), max=round(max(ts), 1))

scen = {
    'first page (25)':            '/api/candidates?page=1&pageSize=25',
    'deep page 100':              '/api/candidates?page=100&pageSize=25',
    'deep page 200 (last)':       '/api/candidates?page=200&pageSize=25',
    'large page size 200':        '/api/candidates?page=1&pageSize=200',
    'sort by name':               '/api/candidates?sort=name&dir=asc&pageSize=25',
    'sort by confidence':         '/api/candidates?sort=confidence&dir=desc&pageSize=25',
    'sort by experience':         '/api/candidates?sort=experience&dir=desc&pageSize=25',
    'broad search (many hits)':   '/api/candidates?search=Perf&pageSize=25',
    'narrow search (one hit)':    '/api/candidates?search=perf.cand4321&pageSize=25',
    'no-match search':            '/api/candidates?search=zzzznope&pageSize=25',
    'filter by company':          '/api/candidates?company=Arabtec&pageSize=25',
    'filter by university':       '/api/candidates?university=Cairo%20University&pageSize=25',
}
print('%-28s %8s %8s %8s' % ('scenario', 'p50 ms', 'min', 'max'))
for label, path in scen.items():
    m = timed(path)
    REPORT['stress'][label] = m
    print('%-28s %8.1f %8.1f %8.1f  (http %s)' % (label, m['p50'], m['min'], m['max'], m['status']))
