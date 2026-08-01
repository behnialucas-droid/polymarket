# RUNBOOK-04 — Dashboard run and deploy

## Purpose

Run the read-only Next.js dashboard locally, build it for production, and optionally install it as a 24/7 systemd service. Governance boundary lives in `05-DASHBOARD-DEPLOY.md`.

## Preconditions

- RUNBOOK-01 complete (`dashboard/ npm ci` done).
- `dashboard/.env` populated with `DATABASE_URL` (name only here; read-only queries).
- The dashboard is a READ-ONLY view over Postgres. It never runs the cycle, owns no lock, mutates no rules, and exposes no mutation endpoint.

## Steps — local dev

```sh
cd hermes-polybot/dashboard
npm run dev          # serves http://localhost:4000
```

## Steps — production build

```sh
cd hermes-polybot/dashboard
npm run build
npm run start        # serves the production build on port 4000
```

## Steps — systemd for 24/7 local serving

```sh
cd hermes-polybot
bash docs/install-service.sh   # copies docs/hermes-dashboard.service, enables + starts it
```

Note: the shipped unit runs `npm run dev` with `NODE_ENV=development` from `dashboard/` and reads `dashboard/.env`. For a hardened box, edit the unit's `ExecStart` to `npm run start` after `npm run build`, then `sudo systemctl daemon-reload && sudo systemctl restart hermes-dashboard`.

## Verify

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:4000/   # expect 200
sudo systemctl status hermes-dashboard                             # expect active (running)
sudo journalctl -u hermes-dashboard -n 50 --no-pager               # no crash loop
```

In the browser, confirm each simulation/performance view carries the required disclosure set from `05-DASHBOARD-DEPLOY.md` (period UTC, versions, denominators, costs, `paper-only exploratory simulation` label) and that empty/error query states render as errors, not zeros.

## Production boundary — hard rule

- The dashboard is presentation only. Deploying it anywhere public (Vercel, any internet-reachable host) requires explicit operator approval per `05-DASHBOARD-DEPLOY.md`. Do not deploy on your own authority.
- No dashboard control may trigger a cycle, sign anything, or place orders. If you find one, stop and report — do not ship.
- Scheduler/worker ownership is decided in RUNBOOK-05, never by the dashboard host.

## Failure handling

- Port 4000 busy — find the holder (`ss -ltnp | grep 4000`); do not silently move the port, the systemd unit and operator tooling assume 4000.
- `npm run build` fails — fix type/build errors in the dashboard tree only; `runtime/` is authoritative over mirrored dashboard libraries, so mirror drift is fixed by re-mirroring from runtime, not by editing the mirror.
- Blank pages with DB configured — check `dashboard/.env` `DATABASE_URL` name is set and reachable; DB outage must render an error state. If it renders zeros, that is a bug per `05-DASHBOARD-DEPLOY.md`.
- Service crash loop — `journalctl -u hermes-dashboard -e`; usual causes are missing `.env` or Node < 22.6 at `/usr/local/bin/node`.
