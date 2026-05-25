// ============================================================
//  STRESS ENGINE - domain-agnostic k6 load core
//  Works for ANY domain. Auto-discovers all pages from the
//  site's sitemap.xml (falls back to common paths + homepage
//  link crawl). Same file runs local + GitHub + any VM.
//
//  ENV:
//    TARGET   base URL (required)         e.g. https://example.com
//    MODE     'max' (closed hammer, default) | 'rate' (open arrival)
//    VUS      VUs per process (max mode)  default 3000
//    RATE     req/s (rate mode)           default 4000
//    DURATION test length                 default 24h (local runs til you stop)
//    PATHS    override discovery (csv)    default '' = auto-discover
//    SHARD    label                       default 0
//    MAXPATHS cap discovered paths        default 150
// ============================================================
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const okC   = new Counter('blast_ok');
const failC = new Counter('blast_fail');
const okR   = new Rate('blast_ok_rate');
const ttfb  = new Trend('blast_ttfb_ms', true);

const TARGET = (__ENV.TARGET || '').replace(/\/+$/, '');
if (!TARGET) { throw new Error('TARGET env var required, e.g. https://example.com'); }

const MODE     = (__ENV.MODE || 'max').toLowerCase();
const VUS      = parseInt(__ENV.VUS || '3000', 10);
const RATE     = parseInt(__ENV.RATE || '4000', 10);
const DURATION = __ENV.DURATION || '24h';
const SHARD    = __ENV.SHARD || '0';
const MAXPATHS = parseInt(__ENV.MAXPATHS || '150', 10);
const PATHS_ENV= (__ENV.PATHS || '').trim();

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];
const LANGS = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-AU,en;q=0.9', 'en-IN,en;q=0.9'];
const REFS  = ['https://www.google.com/', 'https://www.bing.com/', 'https://www.linkedin.com/', '', ''];

const COMMON = ['/', '/about/', '/about-us/', '/contact/', '/contact-us/', '/services/',
  '/products/', '/solutions/', '/blog/', '/news/', '/pricing/', '/faq/', '/team/',
  '/careers/', '/industries/', '/technologies/', '/products-services/', '/privacy/', '/terms/'];

// ---- discover all pages from sitemap (runs once) -----------
function toPath(u) {
  try { const x = new URL(u); return x.pathname + (x.search || ''); }
  catch { return null; }
}

function discover() {
  if (PATHS_ENV) {
    return PATHS_ENV.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => (p.startsWith('/') ? p : '/' + p));
  }
  const found = {};
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml'];
  const subSitemaps = [];

  for (const c of candidates) {
    const r = http.get(TARGET + c, { timeout: '15s' });
    if (r.status !== 200 || !r.body) continue;
    const locs = String(r.body).match(/<loc>\s*([^<]+?)\s*<\/loc>/gi) || [];
    for (const m of locs) {
      const url = m.replace(/<\/?loc>/gi, '').trim();
      if (/\.xml(\?|$)/i.test(url)) { subSitemaps.push(url); }
      else { const p = toPath(url); if (p) found[p] = 1; }
    }
    if (Object.keys(found).length || subSitemaps.length) break;
  }

  // one level of sitemap-index expansion
  let n = 0;
  for (const sm of subSitemaps) {
    if (n++ >= 10) break;
    const r = http.get(sm, { timeout: '15s' });
    if (r.status !== 200 || !r.body) continue;
    const locs = String(r.body).match(/<loc>\s*([^<]+?)\s*<\/loc>/gi) || [];
    for (const m of locs) {
      const url = m.replace(/<\/?loc>/gi, '').trim();
      const p = toPath(url);
      if (p) found[p] = 1;
    }
  }

  let paths = Object.keys(found);
  if (paths.length === 0) {
    // fallback: crawl homepage for internal links
    const r = http.get(TARGET + '/', { timeout: '15s' });
    if (r.status >= 200 && r.status < 400 && r.body) {
      const hrefs = String(r.body).match(/href\s*=\s*["']([^"'#]+)["']/gi) || [];
      for (const h of hrefs) {
        const raw = h.replace(/^href\s*=\s*["']/i, '').replace(/["']$/, '');
        let p = null;
        if (raw.startsWith('/')) p = raw;
        else if (raw.startsWith(TARGET)) p = toPath(raw);
        if (p && !/\.(png|jpe?g|gif|svg|css|js|ico|woff2?|pdf|zip)(\?|$)/i.test(p)) found[p] = 1;
      }
      paths = Object.keys(found);
    }
  }
  if (paths.length === 0) paths = COMMON.slice();
  if (paths.length > MAXPATHS) paths = paths.slice(0, MAXPATHS);
  return paths;
}

export function setup() {
  const paths = discover();
  console.log(`[shard ${SHARD}] discovered ${paths.length} pages on ${TARGET}`);
  return { paths };
}

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
  noVUConnectionReuse: false,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function (data) {
  const paths = (data && data.paths && data.paths.length) ? data.paths : ['/'];
  const path = paths[Math.floor(Math.random() * paths.length)];
  const ref  = REFS[Math.floor(Math.random() * REFS.length)];
  const headers = {
    'User-Agent':      UAS[Math.floor(Math.random() * UAS.length)],
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': LANGS[Math.floor(Math.random() * LANGS.length)],
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
    'Cache-Control':   'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };
  if (ref) headers['Referer'] = ref;
  // cache-bust: unique query per request so the CDN can't serve from edge
  // cache -> forces every request through to the origin server.
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  const url = TARGET + path + sep + '_cb=' + Math.random().toString(36).slice(2) + Date.now();
  const res = http.get(url, { headers, timeout: '20s', redirects: 5 });
  ttfb.add(res.timings.waiting);
  const good = res.status >= 200 && res.status < 400;
  okR.add(good);
  if (good) okC.add(1); else failC.add(1);
  // no sleep - max throughput
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
  const line = `[shard ${SHARD}] ${MODE} reqs:${reqs} rps:${rps.toFixed(0)} ok:${pct}% ` +
    `p50:${(d['p(50)']||0).toFixed(0)}ms p95:${(d['p(95)']||0).toFixed(0)}ms p99:${(d['p(99)']||0).toFixed(0)}ms`;
  console.log(line);
  return { stdout: line + '\n' };
}
