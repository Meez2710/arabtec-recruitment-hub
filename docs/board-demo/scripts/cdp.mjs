// Minimal CDP helper: isolated headless Chrome, used for local evidence only.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
export async function openChrome(port = 9335) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ev-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); const events = [];
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method) events.push(d); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: `(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));const until=async(fn,ms=12000)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await wait(150);}throw new Error('timeout: '+fn)};${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
  const shot = async (file, clip) => { const s = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png' }); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); };
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(2500); };
  const close = async () => { ws.close(); chrome.kill('SIGTERM'); await sleep(400); fs.rmSync(profile, { recursive: true, force: true }); };
  return { send, ev, size, shot, go, close, events, sleep };
}
export async function tokenFor(base, email, password) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (await r.json()).token;
}
