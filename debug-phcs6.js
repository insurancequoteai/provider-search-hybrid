/**
 * debug-phcs6.js
 * Smarter bundle search — target config URL names and broader patterns
 * since "searchProviders" string is minified away.
 * Run: node debug-phcs6.js
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
        'Accept': '*/*',
        'Referer': 'https://providersearch.multiplan.com/',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function extractWindow(text, keyword, before = 300, after = 1500) {
  const idx = text.indexOf(keyword);
  if (idx === -1) return null;
  return text.slice(Math.max(0, idx - before), idx + after);
}

function extractAll(text, keyword, before = 200, after = 800, max = 5) {
  const results = [];
  let start = 0;
  while (results.length < max) {
    const idx = text.indexOf(keyword, start);
    if (idx === -1) break;
    results.push(text.slice(Math.max(0, idx - before), idx + after));
    start = idx + keyword.length;
  }
  return results;
}

(async () => {
  console.log('Fetching main page...');
  const html = await fetchText('https://providersearch.multiplan.com/');

  const scriptMatches = [...html.matchAll(/src="([^"]*\.js[^"]*)"/g)];
  const scripts = scriptMatches.map(m => {
    const src = m[1];
    return src.startsWith('http') ? src : `https://providersearch.multiplan.com${src}`;
  });

  console.log('Fetching main bundle...');
  const src = await fetchText(scripts[0]);
  console.log(`Bundle size: ${(src.length / 1024).toFixed(0)} KB\n`);

  // ── Search for config URL variable names (we know these from config.json) ──
  const urlVarNames = [
    'NETWORK_SEARCH_URL',
    'PROVIDER_SEARCH_DOWNLOAD_URL',
    'AUTOSUGGEST_URL',
    'NETWORK_CONFIG_URL',
    'NETWORK_DETAIL_URL',
    'provider-ps-search',
    'provider-services',
    'searchProviders',
    'autoSuggest',
    'getNetworkConfig',
    'providerDetails',
  ];

  console.log('=== CONFIG / URL VARIABLE HITS ===\n');
  for (const kw of urlVarNames) {
    const hits = extractAll(src, kw, 300, 1000, 3);
    if (hits.length > 0) {
      console.log(`\n--- "${kw}" (${hits.length} hits) ---`);
      hits.forEach((h, i) => console.log(`[hit ${i+1}]\n${h}\n`));
    }
  }

  // ── Search for field names likely in the request body ──
  const bodyFields = [
    'specialty',
    'Specialty',
    'taxonomyCode',
    'taxonomyId',
    'providerName',
    'radiusMiles',
    'radius',
    'distance',
    'pageSize',
    'recordsPerPage',
    'latitude',
    'longitude',
    'networkIds',
    'networkId',
    'PHCS',
    'Authorization',
    'Bearer',
    'jwttoken',
    'jwtToken',
  ];

  console.log('\n\n=== BODY FIELD HITS ===\n');
  for (const kw of bodyFields) {
    const snippet = extractWindow(src, kw, 200, 600);
    if (snippet) {
      console.log(`\n--- "${kw}" ---`);
      console.log(snippet);
    }
  }

  // ── Find the rp() / fetch call function and all its calls ──
  // We know from debug-phcs5 it's called as: rp(q.PROVIDER_SEARCH_DOWNLOAD_URL, t, h)
  // Search for this pattern to find similar calls to NETWORK_SEARCH_URL
  console.log('\n\n=== FUNCTION CALL PATTERNS (rp / fetch wrappers) ===\n');
  const fnPatterns = [
    /rp\([^)]{0,200}\)/g,
    /await [a-zA-Z]{1,4}\(q\.[A-Z_]{5,}/g,
    /\.post\([^)]{0,300}\)/g,
    /\.get\([^)]{0,300}\)/g,
    /fetch\([^)]{0,300}\)/g,
    /axios\.[a-z]+\([^)]{0,300}\)/g,
  ];

  for (const pat of fnPatterns) {
    const matches = [...src.matchAll(pat)];
    if (matches.length > 0) {
      console.log(`\nPattern: ${pat} (${matches.length} hits)`);
      matches.slice(0, 6).forEach(m => console.log(' ', m[0].slice(0, 300)));
    }
  }

  // ── Extract all usages of the config object q ──
  // Pattern: q.SOMETHING_URL
  console.log('\n\n=== ALL q.XXX_URL REFERENCES ===\n');
  const qUrlRefs = [...src.matchAll(/q\.[A-Z_]{4,}(?:URL|ENDPOINT|PATH)/g)];
  const unique = [...new Set(qUrlRefs.map(m => m[0]))];
  console.log(unique);

  // ── Try to find the actual body object near NETWORK_SEARCH_URL ──
  // Look for 100-char windows around any mention of the URL config keys
  console.log('\n\n=== CONTEXT AROUND NETWORK_SEARCH_URL ===\n');
  const nsHits = extractAll(src, 'NETWORK_SEARCH_URL', 500, 2000, 5);
  if (nsHits.length > 0) {
    nsHits.forEach((h, i) => { console.log(`[hit ${i+1}]`); console.log(h); console.log('---'); });
  } else {
    console.log('Not found — checking for the actual URL string...');
    // Try the actual URL path
    const pathHits = extractAll(src, '/searchProviders', 400, 1000, 5);
    pathHits.forEach((h, i) => { console.log(`[/searchProviders hit ${i+1}]`); console.log(h); console.log('---'); });
  }

})().catch(console.error);
