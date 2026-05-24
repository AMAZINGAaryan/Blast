import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const okRate = new Rate('pages_ok');
const hits   = new Counter('pages_hit');

const BASE  = 'https://www.tongadive.com';
const PAGES = [
  '/',
  '/solutions/',
  '/industries-dpp/',
  '/contact-us-digital-product-passport-enquiry/',
  '/supply-chain-visibility-software-about-us/',
  '/gs1-serialisation-digital-product-passport/',
  '/ecosystem-partners/',
  '/sustainable-supply-chain-media/',
  '/technologies/',
];

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

const LANGS = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.8,fr;q=0.6',
  'en-AU,en;q=0.9',
  'en-CA,en;q=0.9,fr-CA;q=0.7',
  'en-IN,en;q=0.9',
];

const REFS = [
  'https://www.google.com/',
  'https://www.google.co.uk/',
  'https://www.bing.com/',
  'https://www.linkedin.com/',
  'https://duckduckgo.com/',
  '',
  '',
  '',
];

const VUS = parseInt(__ENV.VUS || '10000', 10);
const RAMP = __ENV.RAMP || '45s';
const HOLD = __ENV.HOLD || '5m';

export const options = {
  scenarios: {
    blast: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
      ],
      gracefulRampDown: '0s',
    },
  },
  noConnectionReuse: false,
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const ref  = REFS[Math.floor(Math.random() * REFS.length)];
  const headers = {
    'User-Agent': UAS[Math.floor(Math.random() * UAS.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': LANGS[Math.floor(Math.random() * LANGS.length)],
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': ref ? 'cross-site' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  if (ref) { headers['Referer'] = ref; }

  const res = http.get(BASE + page, { headers: headers, timeout: '30s', redirects: 5 });
  hits.add(1);
  okRate.add(res.status >= 200 && res.status < 400);
  sleep(0.1 + Math.random() * 0.4);
}

export function handleSummary(data) {
  const reqs = (data.metrics.http_reqs && data.metrics.http_reqs.values.count) || 0;
  const rate = (data.metrics.http_reqs && data.metrics.http_reqs.values.rate) || 0;
  const dur  = data.metrics.http_req_duration ? data.metrics.http_req_duration.values : {};
  const ok   = (data.metrics.pages_ok && data.metrics.pages_ok.values.rate) || 0;
  const line =
    'hits:' + (((data.metrics.pages_hit && data.metrics.pages_hit.values.count) || 0)) +
    ' reqs:' + reqs +
    ' rps:' + rate.toFixed(1) +
    ' ok:' + (ok * 100).toFixed(1) + '%' +
    ' p50:' + (dur['p(50)'] || 0).toFixed(0) + 'ms' +
    ' p95:' + (dur['p(95)'] || 0).toFixed(0) + 'ms' +
    ' p99:' + (dur['p(99)'] || 0).toFixed(0) + 'ms';
  console.log(line);
  return {};
}
