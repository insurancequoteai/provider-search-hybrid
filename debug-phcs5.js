/**
 * debug-phcs5.js
 * Fetch the React app JS bundles and extract the searchProviders
 * request body format from the source code. No browser, no captcha.
 *
 * Run: node debug-phcs5.js
 */

const https = require('https');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/javascript,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://providersearch.multiplan.com/',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function extractSnippet(text, keyword, windowSize = 800) {
  const idx = text.indexOf(keyword);
  if (idx === -1) return null;
  return text.slice(Math.max(0, idx - 200), idx + windowSize);
}

(async () => {
  // ── Step 1: Fetch the main HTML page ──────────────────────────────────────
  console.log('Fetching main page...');
  const html = await fetchText('https://providersearch.multiplan.com/');

  // Find all script bundle URLs
  const scriptMatches = [...html.matchAll(/src="([^"]*\.js[^"]*)"/g)];
  const scripts = scriptMatches.map(m => {
    const src = m[1];
    return src.startsWith('http') ? src : `https://providersearch.multiplan.com${src}`;
  });
  console.log(`Found ${scripts.length} script bundles:`);
  scripts.forEach(s => console.log(' ', s));

  // ── Step 2: Fetch each bundle and search for API call patterns ───────────
  const keywords = [
    'searchProviders',
    'autoSuggest',
    'getNetworkConfig',
    'postalCode',
    'zipCode',
    'specialtyCode',
    'specialtyId',
    'networkCode',
    'networkId',
    'providerType',
    'searchType',
    'pageNumber',
    'pageSize',
    'radiusMiles',
  ];

  const findings = {};

  for (const scriptUrl of scripts) {
    console.log(`\nFetching: ${scriptUrl.split('/').pop()}`);
    let src;
    try {
      src = await fetchText(scriptUrl);
    } catch (e) {
      console.log('  Error:', e.message);
      continue;
    }

    console.log(`  Size: ${(src.length / 1024).toFixed(0)} KB`);

    for (const kw of keywords) {
      if (src.includes(kw)) {
        if (!findings[kw]) findings[kw] = [];
        const snippet = extractSnippet(src, kw, 600);
        findings[kw].push({ url: scriptUrl.split('/').pop(), snippet });
      }
    }
  }

  // ── Step 3: Print findings ─────────────────────────────────────────────────
  console.log('\n\n=== KEY FINDINGS ===\n');

  // Most important: searchProviders request body
  if (findings['searchProviders']) {
    console.log('=== searchProviders ===');
    findings['searchProviders'].forEach(f => {
      console.log(`\n[${f.url}]`);
      console.log(f.snippet);
      console.log('---');
    });
  }

  // autoSuggest
  if (findings['autoSuggest']) {
    console.log('\n=== autoSuggest ===');
    findings['autoSuggest'].slice(0, 2).forEach(f => {
      console.log(`\n[${f.url}]`);
      console.log(f.snippet);
      console.log('---');
    });
  }

  // Field names that hint at body structure
  const bodyHints = ['postalCode','zipCode','specialtyCode','networkCode','pageNumber'];
  for (const hint of bodyHints) {
    if (findings[hint]) {
      console.log(`\n=== ${hint} ===`);
      findings[hint].slice(0, 1).forEach(f => {
        console.log(`[${f.url}]`);
        console.log(f.snippet);
      });
    }
  }

  // ── Step 4: Try to extract the actual fetch/axios call for searchProviders ──
  console.log('\n\n=== SEARCHING FOR FETCH CALL PATTERNS ===');
  for (const scriptUrl of scripts) {
    let src;
    try { src = await fetchText(scriptUrl); } catch { continue; }

    // Look for patterns like: axios.post(URL, {body}) or fetch(URL, {body})
    const patterns = [
      /searchProviders[^;]{0,500}/g,
      /postalCode[^;]{0,300}/g,
    ];
    for (const pat of patterns) {
      const matches = [...src.matchAll(pat)];
      if (matches.length > 0) {
        console.log(`\n[${scriptUrl.split('/').pop()}] - ${pat}:`);
        matches.slice(0, 3).forEach(m => console.log(m[0].slice(0, 400)));
      }
    }
  }

})().catch(console.error);
