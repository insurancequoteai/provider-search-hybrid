// debug-aetna-api.js
// Try calling Aetna's provider search API directly from Node.js (no browser).
// CORS only blocks browsers — Node.js can call this freely if it doesn't need auth.

const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.aetna.com',
        'Referer': 'https://www.aetna.com/dsepublic/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  const ts = Date.now();

  // Test 1: specialty search (no providerID)
  const params1 = new URLSearchParams({
    searchText: 'Family Medicine',
    productIdentifier: '~MPPO',
    listFieldSelections: `acceptedVersion_jgegs,tmstmp${ts}tmstmp,affiliations,VisitType_NoPreference,groupSearch`,
    isGuidedSearch: 'true',
    state: 'TX',
    distance: '25',
    latitude: '29.873022',
    longitude: '-95.565545',
    postalCode: '77041',
    firstRecordOnPage: '1',
    lastRecordOnPage: '10',
    pipeName: 'Open Choice PPO',
    responseLanguagePreference: 'en',
    siteId: 'dse',
  });

  const url1 = `https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch?${params1}`;
  console.log('Calling:', url1.substring(0, 120) + '...');

  try {
    const res1 = await get(url1);
    console.log('Status:', res1.status);
    console.log('Content-Type:', res1.headers['content-type']);
    try {
      const parsed = JSON.parse(res1.body);
      console.log('Top-level keys:', Object.keys(parsed));
      const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]) && parsed[k].length > 0);
      if (arrKey) {
        console.log(`\n✅ ${parsed[arrKey].length} results under "${arrKey}"`);
        console.log('First result keys:', Object.keys(parsed[arrKey][0]));
        console.log('\nFirst result:\n', JSON.stringify(parsed[arrKey][0], null, 2).substring(0, 3000));
      } else {
        console.log('Full response:', JSON.stringify(parsed, null, 2).substring(0, 3000));
      }
    } catch {
      console.log('Raw response (first 2000):', res1.body.substring(0, 2000));
    }
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 2: name search
  console.log('\n\n=== TEST 2: name search "John Smith" ===');
  const params2 = new URLSearchParams({
    searchText: 'John Smith',
    productIdentifier: '~MPPO',
    listFieldSelections: `acceptedVersion_jgegs,tmstmp${ts + 1}tmstmp,affiliations,VisitType_NoPreference,groupSearch`,
    isGuidedSearch: 'false',
    state: 'TX',
    distance: '25',
    latitude: '29.873022',
    longitude: '-95.565545',
    postalCode: '77041',
    firstRecordOnPage: '1',
    lastRecordOnPage: '10',
    pipeName: 'Open Choice PPO',
    responseLanguagePreference: 'en',
    siteId: 'dse',
  });

  try {
    const res2 = await get(`https://api01.aetna.com/healthcore/prod/v3/publicdse_providersearch?${params2}`);
    console.log('Status:', res2.status);
    try {
      const parsed = JSON.parse(res2.body);
      const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]) && parsed[k].length > 0);
      if (arrKey) {
        console.log(`✅ ${parsed[arrKey].length} results under "${arrKey}"`);
        console.log('First result keys:', Object.keys(parsed[arrKey][0]));
        console.log('\nFirst result:\n', JSON.stringify(parsed[arrKey][0], null, 2).substring(0, 2000));
      } else {
        console.log(JSON.stringify(parsed, null, 2).substring(0, 2000));
      }
    } catch {
      console.log('Raw:', res2.body.substring(0, 1000));
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
})();
