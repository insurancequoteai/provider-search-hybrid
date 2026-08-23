/**
 * debug-phcs4.js
 * Pure API approach — no browser.
 * Uses 2captcha to get a valid reCAPTCHA v3 token,
 * then calls MultiPlan's API directly.
 *
 * Setup:
 *   npm install axios          (if not already installed)
 *   export CAPTCHA_KEY=<your-2captcha-api-key>
 *   node debug-phcs4.js
 *
 * Get a 2captcha API key at https://2captcha.com  (~$3 per 1000 solves)
 * Fund with $3-5 to start. Each PHCS search costs ~$0.003.
 *
 * NOTE: If you don't have a key yet, set CAPTCHA_KEY=TEST to see
 * what the API calls look like without actually solving anything.
 */

const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────
const CAPTCHA_KEY     = process.env.CAPTCHA_KEY || 'TEST';
const SITE_KEY        = '6LefJUoaAAAAABlTt0WgwOh01Q1tLp9EYk_Dv8Pu';
const PAGE_URL        = 'https://providersearch.multiplan.com/';
const SUBSCRIPTION    = 'd76df4a5c71a4ae18b6a46a22de5bd6c';  // static — never changes
const MULTIPLAN_BASE  = 'https://api-ext-az.multiplan.com/provider-ps-search/v1';

const ZIP       = '77041';
const SPECIALTY = 'Cardiologist';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Simple fetch wrapper ─────────────────────────────────────────────────────
function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(opts.headers || {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ── Step 1: Get reCAPTCHA token from 2captcha ─────────────────────────────
async function getRecaptchaToken() {
  if (CAPTCHA_KEY === 'TEST') {
    console.log('[2captcha] TEST MODE — skipping real solve, will use dummy token');
    return 'DUMMY_TOKEN_FOR_TESTING';
  }

  console.log('[2captcha] Submitting reCAPTCHA v3 task...');
  const submitUrl = `https://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=userrecaptcha&googlekey=${SITE_KEY}&pageurl=${encodeURIComponent(PAGE_URL)}&version=v3&action=verify&min_score=0.5&json=1`;

  const submit = await fetchJSON(submitUrl);
  console.log('[2captcha] Submit response:', submit.raw.slice(0, 200));

  if (!submit.body || submit.body.status !== 1) {
    throw new Error('2captcha submit failed: ' + submit.raw);
  }
  const taskId = submit.body.request;
  console.log('[2captcha] Task ID:', taskId, '— waiting 25s for solve...');

  await sleep(25000);

  for (let i = 0; i < 12; i++) {
    const result = await fetchJSON(
      `https://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${taskId}&json=1`
    );
    console.log(`[2captcha] Poll ${i+1}:`, result.raw.slice(0, 100));

    if (result.body?.status === 1) {
      const token = result.body.request;
      console.log('[2captcha] ✅ Got token! Length:', token.length);
      return token;
    }
    if (result.body?.request === 'ERROR_CAPTCHA_UNSOLVABLE') {
      throw new Error('2captcha: unsolvable');
    }
    await sleep(5000);
  }
  throw new Error('2captcha timeout');
}

// ── Step 2: Get JWT from MultiPlan /validate ─────────────────────────────
async function getJWT(recaptchaToken) {
  console.log('\n[MultiPlan] Calling /validate...');
  const res = await fetchJSON(`${MULTIPLAN_BASE}/validate`, {
    method: 'POST',
    headers: {
      'recaptcha-token': recaptchaToken,
      'ocp-apim-subscription-key': SUBSCRIPTION,
      'referer': 'https://providersearch.multiplan.com/',
      'origin': 'https://providersearch.multiplan.com',
    },
    body: { type: 'recaptcha3' },
  });
  console.log('[validate] Status:', res.status);
  console.log('[validate] Response:', JSON.stringify(res.body, null, 2));
  return res.body?.jwttoken || null;
}

// ── Step 3: Try getNetworkConfigData (learn PHCS network ID) ─────────────
async function getNetworkConfig(jwt) {
  console.log('\n[MultiPlan] Calling /getNetworkConfigData...');
  const res = await fetchJSON(`${MULTIPLAN_BASE}/getNetworkConfigData`, {
    method: 'GET',
    headers: {
      'ocp-apim-subscription-key': SUBSCRIPTION,
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
      'referer': 'https://providersearch.multiplan.com/',
    },
  });
  console.log('[getNetworkConfig] Status:', res.status);
  console.log('[getNetworkConfig] Body:', JSON.stringify(res.body, null, 2).slice(0, 2000));
  return res.body;
}

// ── Step 4: Try autoSuggest (learn the specialty code for Cardiologist) ───
async function autoSuggest(jwt, query) {
  console.log('\n[MultiPlan] Calling /autoSuggest...');
  // Try both GET and POST
  const payloads = [
    { method: 'GET',  url: `${MULTIPLAN_BASE}/autoSuggest?query=${encodeURIComponent(query)}&type=specialty` },
    { method: 'POST', url: `${MULTIPLAN_BASE}/autoSuggest`, body: { query, type: 'specialty' } },
    { method: 'POST', url: `${MULTIPLAN_BASE}/autoSuggest`, body: { searchText: query } },
  ];
  for (const p of payloads) {
    const res = await fetchJSON(p.url, {
      method: p.method,
      headers: {
        'ocp-apim-subscription-key': SUBSCRIPTION,
        ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
        'referer': 'https://providersearch.multiplan.com/',
      },
      ...(p.body ? { body: p.body } : {}),
    });
    console.log(`[autoSuggest] ${p.method} status:`, res.status, '| body:', res.raw.slice(0, 400));
    if (res.status === 200 && res.body) return res.body;
  }
  return null;
}

// ── Step 5: Try searchProviders with guessed body shapes ─────────────────
async function searchProviders(jwt, specialty, zip) {
  console.log('\n[MultiPlan] Calling /searchProviders...');

  // Try several likely body shapes
  const attempts = [
    {
      label: 'shape A (networkCode)',
      body: {
        networkCode: 'PHCS',
        searchType: 'specialty',
        specialty: specialty,
        zip: zip,
        radius: 25,
        pageNumber: 1,
        pageSize: 25,
      }
    },
    {
      label: 'shape B (providerType)',
      body: {
        networkCode: 'PHCS',
        providerName: '',
        specialtyCode: specialty,
        postalCode: zip,
        radiusMiles: 25,
        pageNumber: 1,
        pageSize: 25,
      }
    },
    {
      label: 'shape C (searchCriteria wrapper)',
      body: {
        searchCriteria: {
          networkCode: 'PHCS',
          specialty: specialty,
          location: { zip, radius: 25 },
        },
        paging: { page: 1, size: 25 },
      }
    },
    {
      label: 'shape D (minimal)',
      body: {
        zip: zip,
        specialty: specialty,
        network: 'PHCS',
      }
    },
  ];

  for (const attempt of attempts) {
    console.log(`\n  Trying ${attempt.label}...`);
    const res = await fetchJSON(`${MULTIPLAN_BASE}/searchProviders`, {
      method: 'POST',
      headers: {
        'ocp-apim-subscription-key': SUBSCRIPTION,
        ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
        'referer': 'https://providersearch.multiplan.com/',
        'origin': 'https://providersearch.multiplan.com',
      },
      body: attempt.body,
    });
    console.log(`  Status: ${res.status}`);
    console.log(`  Response: ${res.raw.slice(0, 600)}`);
    if (res.status === 200 && res.body) {
      console.log('\n✅ SUCCESS with', attempt.label);
      return res.body;
    }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Get reCAPTCHA token
    const recaptchaToken = await getRecaptchaToken();

    // Get JWT
    const jwt = await getJWT(recaptchaToken);
    console.log('\nJWT:', jwt ? '✅ ' + jwt.slice(0, 60) + '...' : '❌ null');

    // Even without JWT, try the other endpoints
    const config = await getNetworkConfig(jwt);
    const suggest = await autoSuggest(jwt, SPECIALTY);
    const results = await searchProviders(jwt, SPECIALTY, ZIP);

    if (results) {
      console.log('\n=== SEARCH RESULTS ===');
      console.log(JSON.stringify(results, null, 2).slice(0, 3000));
    } else {
      console.log('\n❌ Could not get search results.');
      if (!jwt) {
        console.log('\nNext step: sign up at https://2captcha.com and set CAPTCHA_KEY env var:');
        console.log('  export CAPTCHA_KEY=your_api_key_here');
        console.log('  node debug-phcs4.js');
        console.log('\nCost: ~$3 per 1000 searches (~$0.003 each)');
      }
    }

  } catch (e) {
    console.error('Error:', e.message);
  }
})();
