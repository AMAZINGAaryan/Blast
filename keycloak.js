// ============================================================
//  Keycloak login-page load scenario for stage.evidnt.io
//  Hits the SPA login route + the Keycloak auth-form render
//  (real server work) without credentials, so no account
//  lockout / brute-force triggers. Owner-authorized staging.
//
//  ENV: TARGET (e.g. https://stage.evidnt.io), MODE, VUS, RATE,
//       DURATION, SHARD, REALM (default tongadive),
//       CLIENT (default login)
// ============================================================
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const okC  = new Counter('blast_ok');
const fC   = new Counter('blast_fail');
const okR  = new Rate('blast_ok_rate');
const ttfb = new Trend('blast_ttfb_ms', true);

const TARGET = (__ENV.TARGET || 'https://stage.evidnt.io').replace(/\/+$/, '');
const REALM  = __ENV.REALM  || 'tongadive';
const CLIENT = __ENV.CLIENT || 'login';
const MODE   = (__ENV.MODE || 'max').toLowerCase();
const VUS    = parseInt(__ENV.VUS || '2000', 10);
const RATE   = parseInt(__ENV.RATE || '3000', 10);
const DURATION = __ENV.DURATION || '5m';
const SHARD  = __ENV.SHARD || '0';

const AUTH = `${TARGET}/auth/realms/${REALM}/protocol/openid-connect/auth`;

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

let scenarios;
if (MODE === 'rate') {
  scenarios = { blast: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s',
    duration: DURATION, preAllocatedVUs: Math.max(50, Math.floor(RATE / 4)), maxVUs: RATE * 2 } };
} else {
  scenarios = { blast: { executor: 'constant-vus', vus: VUS, duration: DURATION } };
}

export const options = {
  scenarios,
  discardResponseBodies: true,
  noConnectionReuse: false,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

function rstr(n) {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

export default function () {
  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
  };

  // 1) SPA login route
  const r1 = http.get(`${TARGET}/login`, { headers, timeout: '20s', redirects: 5 });

  // 2) Keycloak auth-form render (real server work: PKCE params, fresh state/nonce)
  const q = `client_id=${CLIENT}&response_type=code&scope=openid` +
    `&redirect_uri=${encodeURIComponent(TARGET + '/')}` +
    `&state=${rstr(24)}&nonce=${rstr(24)}` +
    `&code_challenge=${rstr(43)}&code_challenge_method=S256`;
  const r2 = http.get(`${AUTH}?${q}`, { headers, timeout: '20s', redirects: 5 });

  for (const res of [r1, r2]) {
    ttfb.add(res.timings.waiting);
    const good = res.status >= 200 && res.status < 400;
    okR.add(good);
    if (good) okC.add(1); else fC.add(1);
  }
  // no sleep
}

export function handleSummary(data) {
  const m = data.metrics;
  const o = (m.blast_ok && m.blast_ok.values.count) || 0;
  const f = (m.blast_fail && m.blast_fail.values.count) || 0;
  const t = o + f;
  const reqs = (m.http_reqs && m.http_reqs.values.count) || 0;
  const rps  = (m.http_reqs && m.http_reqs.values.rate) || 0;
  const d = (m.http_req_duration && m.http_req_duration.values) || {};
  const pct = t ? ((o / t) * 100).toFixed(1) : '0';
  const line = `[shard ${SHARD}] keycloak reqs:${reqs} rps:${rps.toFixed(0)} ok:${pct}% ` +
    `p50:${(d['p(50)']||0).toFixed(0)}ms p95:${(d['p(95)']||0).toFixed(0)}ms`;
  console.log(line);
  return { stdout: line + '\n' };
}
