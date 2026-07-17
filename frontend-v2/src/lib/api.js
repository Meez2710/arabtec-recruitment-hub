const TOKEN_KEY = 'arabtec_token';

export const api = {
  token: localStorage.getItem(TOKEN_KEY) || null,

  setToken(t) { this.token = t; t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },

  async call(path, { method = 'GET', body, raw } = {}) {
    const headers = { ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) };
    if (!raw) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api' + path, {
      method,
      headers,
      body: raw ? body : (body ? JSON.stringify(body) : undefined),
    });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Request failed'), { status: res.status, data });
    return data;
  },

  get(p) { return this.call(p); },
  post(p, body) { return this.call(p, { method: 'POST', body }); },
  put(p, body) { return this.call(p, { method: 'PUT', body }); },
  del(p) { return this.call(p, { method: 'DELETE' }); },

  async upload(p, file, fields = {}) {
    const fd = new FormData(); fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return this.call(p, { method: 'POST', body: fd, raw: true });
  },
};
