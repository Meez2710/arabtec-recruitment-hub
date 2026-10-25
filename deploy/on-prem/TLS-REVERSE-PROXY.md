# TLS in front of the on-prem Recruitment Hub (audit F2, 25 Oct 2026)

**Today:** Node listens on `*:4001` over plain HTTP (`DIRECT_HTTP=true`, set in
September so the app would load at all on an HTTP host). Bearer tokens, CVs
and salary figures cross the office LAN unencrypted, and the
`Strict-Transport-Security` header the app sends is ignored by browsers over
HTTP.

**Target:** `https://hub.arabtec.local` (or the hostname IT picks) terminated by
a reverse proxy on the same box; Node bound to `127.0.0.1:4001` only; HTTP on
port 80 redirecting to HTTPS; `DIRECT_HTTP` removed so the CSP's
`upgrade-insecure-requests` and HSTS do their jobs.

Everything below runs as root (`ats` has no sudo). Plan ~45 minutes, with a
5-minute user-visible switch at step 5.

## 1. Certificate (pick one)

| Option | When | Notes |
|---|---|---|
| **A. Internal CA (recommended)** | IT runs an AD CS / internal CA and office PCs trust it | Issue a server cert for the hostname (SAN: hostname + `10.20.0.9`); 1–2 year validity; export `fullchain.pem` + `privkey.pem` |
| B. Public cert via DNS | the hostname is a real public DNS name (e.g. `hub.arabtec.com`) you control | `certbot --dns-<provider>` or Caddy's built-in ACME with a DNS plugin; no inbound internet needed |
| C. Self-signed | nothing else is available | browsers warn until the cert is installed on each PC; acceptable only as a stop-gap |

Put the files at `/etc/arabtec-ats/tls/fullchain.pem` and `/etc/arabtec-ats/tls/privkey.pem`, mode `0640 root:www-data`.

## 2. Install the proxy

Caddy is the smallest change (automatic HTTP→HTTPS redirect, sane TLS defaults). nginx is fine if IT standardises on it; its equivalent is at the end.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
hub.arabtec.local {
    tls /etc/arabtec-ats/tls/fullchain.pem /etc/arabtec-ats/tls/privkey.pem
    encode zstd gzip
    request_body { max_size 25MB }        # CV uploads are capped at 20 MB by the app
    reverse_proxy 127.0.0.1:4001 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-For {remote_host}
    }
    log { output file /var/log/caddy/hub.log }
}
http://hub.arabtec.local, http://10.20.0.9 {
    redir https://hub.arabtec.local{uri} permanent
}
```

`sudo systemctl enable --now caddy && sudo caddy validate --config /etc/caddy/Caddyfile`.

## 3. Bind Node to localhost and trust exactly one proxy

In `/etc/arabtec-ats/ats.env` (root-only) set:

```
HOST=127.0.0.1
TRUST_PROXY=1
```

and remove `DIRECT_HTTP=true`. `TRUST_PROXY=1` means "trust exactly one hop":
the app's rate limiter and account lockout then see the real client IP from
`X-Forwarded-For` set by the local proxy, and a forged header from a client
is ignored because the proxy overwrites it. (Today `TRUST_PROXY` is set on the
box with no proxy in front, which is the condition under which the
`proxy-addr` advisory mattered; that package is now patched too.)

`HOST` is honoured by `backend/src/server.js` from the 25 Oct 2026 audit
release onwards; unset, the app keeps listening on all interfaces.

## 4. Firewall

```bash
sudo ufw allow from 10.20.0.0/16 to any port 443 proto tcp
sudo ufw allow from 10.20.0.0/16 to any port 80  proto tcp
sudo ufw deny 4001
sudo ufw allow from <IT admin subnet> to any port 22 proto tcp
sudo ufw enable && sudo ufw status numbered
```

(Confirm the office ranges with IT first; the audit could not read the current firewall state.)

## 5. Switch (the only user-visible minute)

1. Announce the new address to staff; old bookmarks to `http://10.20.0.9:4001` will redirect.
2. `sudo systemctl restart arabtec-ats` (picks up `HOST`/`TRUST_PROXY`, drops `DIRECT_HTTP`).
3. `curl -sI https://hub.arabtec.local/api/health/ready` → `200`; `curl -sI http://10.20.0.9:4001/` from another machine → connection refused.
4. Sign in once from a staff PC; open a CV; check the browser padlock.
5. In the app's `08-redeploy.sh` readiness check, replace `http://127.0.0.1:4001` with the same (it still works — Node is on loopback).

## 6. After

- M365 OAuth callback: update the redirect URI in the Azure app registration to `https://hub.arabtec.local/api/integrations/microsoft/callback`.
- Notification emails already use `APP_URL` for links — set it to the HTTPS address.
- Remove `DIRECT_HTTP` handling from the CSP code once no plain-HTTP host remains (`backend/src/lib/security-headers.js`, test `csp_direct_http_test.mjs`).
- Certificate expiry: calendar reminder 30 days before; Caddy reloads on `systemctl reload caddy`.

## nginx equivalent (if preferred)

```nginx
server { listen 80; server_name hub.arabtec.local 10.20.0.9; return 301 https://hub.arabtec.local$request_uri; }
server {
  listen 443 ssl http2; server_name hub.arabtec.local;
  ssl_certificate /etc/arabtec-ats/tls/fullchain.pem; ssl_certificate_key /etc/arabtec-ats/tls/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3; client_max_body_size 25m;
  location / {
    proxy_pass http://127.0.0.1:4001; proxy_http_version 1.1;
    proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 120s;
  }
}
```

## Rollback

`sudo systemctl stop caddy`, restore `DIRECT_HTTP=true` and remove `HOST` in `ats.env`, `sudo systemctl restart arabtec-ats`, `sudo ufw allow 4001`. The app is back on `http://10.20.0.9:4001` within a minute.
