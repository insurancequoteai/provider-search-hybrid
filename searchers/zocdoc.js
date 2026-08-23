/**
 * ZocDoc Searcher — covers UHC Choice Plus AND Aetna Open Choice
 *
 * Runs one browser session and searches ZocDoc with each insurance filter
 * in parallel (two pages, same browser). Then merges the results — if the
 * same doctor appears in both, they get both network tags on one card.
 *
 * HOW TO SPEED THIS UP LATER (optional):
 *   Open ZocDoc in Chrome DevTools → Network → Fetch/XHR → run a search.
 *   Find the API call (look for /api/search or similar), copy the URL +
 *   headers, and replace the Playwright logic below with a direct fetch().
 *   That brings search time from ~10s down to under 1s.
 */

const { chromium } = require('playwright');

// Maps our network keys to what ZocDoc calls them in its insurance dropdown
const INSURANCE = {
  uhc:   { carrier: 'UnitedHealthcare', plan: 'Choice Plus' },
  aetna: { carrier: 'Aetna',           plan: 'Open Choice' },
};

// Search ZocDoc for one specific insurance filter
async function searchWithInsurance(page, { zip, name, specialty }, netKey) {
  const ins = INSURANCE[netKey];

  await page.goto('https://www.zocdoc.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });

  // ── Location ──────────────────────────────────────────────────────
  // ZocDoc's homepage has a location field. Selector verified against live site
  // structure as of 2024 — update if ZocDoc redesigns.
  const locInput = 'input[placeholder*="city"], input[placeholder*="location"], input[placeholder*="zip"], [data-testid="location-input"]';
  await page.waitForSelector(locInput, { timeout: 8000 });
  await page.fill(locInput, zip || '');

  // ── What are you looking for (specialty / name) ───────────────────
  const searchInput = 'input[placeholder*="doctor"], input[placeholder*="condition"], input[placeholder*="specialty"], [data-testid="search-input"]';
  if (await page.isVisible(searchInput) && (name || specialty)) {
    await page.fill(searchInput, name || specialty);
  }

  // ── Insurance selector ────────────────────────────────────────────
  // ZocDoc has an insurance dropdown — click it, type carrier name, pick plan
  const insBtn = '[data-testid="insurance-selector"], button:has-text("Insurance"), input[placeholder*="insurance"]';
  if (await page.isVisible(insBtn)) {
    await page.click(insBtn);
    await page.waitForTimeout(400);

    // Type carrier name to filter the list
    const carrierInput = 'input[placeholder*="carrier"], input[placeholder*="insurance"], [data-testid="carrier-input"]';
    if (await page.isVisible(carrierInput)) {
      await page.fill(carrierInput, ins.carrier);
      await page.waitForTimeout(600);

      // Pick first matching option
      const opt = `[role="option"]:has-text("${ins.carrier}"), li:has-text("${ins.carrier}")`;
      if (await page.isVisible(opt)) await page.click(opt);

      // Now pick the plan
      await page.waitForTimeout(400);
      const planOpt = `[role="option"]:has-text("${ins.plan}"), li:has-text("${ins.plan}")`;
      if (await page.isVisible(planOpt)) await page.click(planOpt);
    }
  }

  // ── Submit ────────────────────────────────────────────────────────
  await page.click('button[type="submit"], button:has-text("Search"), [data-testid="search-submit"]');
  await page.waitForLoadState('networkidle', { timeout: 18000 });
  await page.waitForTimeout(1000); // let React finish rendering

  // ── Scrape results ────────────────────────────────────────────────
  // ZocDoc provider cards — update selectors from DevTools if these drift
  const providers = await page.$$eval(
    '[data-testid="provider-card"], .provider-card, [class*="ProviderCard"], article[class*="provider"]',
    (cards, netKey) => cards.slice(0, 25).map(card => ({
      name:      card.querySelector('[data-testid="provider-name"], h3, [class*="ProviderName"]')?.textContent?.trim() || '',
      specialty: card.querySelector('[data-testid="specialty"], [class*="Specialty"], [class*="specialty"]')?.textContent?.trim() || '',
      address:   card.querySelector('[data-testid="address"], [class*="Address"], [class*="address"]')?.textContent?.trim() || '',
      phone:     card.querySelector('[href^="tel:"], [class*="Phone"]')?.textContent?.trim() || '',
      distance:  card.querySelector('[class*="Distance"], [class*="distance"], [class*="miles"]')?.textContent?.trim() || '',
      accepting: !card.querySelector('[class*="not-accepting"], [class*="NotAccepting"]'),
      npi:       '',
      zocdocUrl: card.querySelector('a[href*="/doctor/"]')?.href || '',
      network:   netKey,
    })).filter(p => p.name),
    netKey
  );

  return providers;
}

// Merge UHC + Aetna results — same doctor (matched by name) gets both tags
function mergeResults(uhcList, aetnaList) {
  const merged = {};

  const add = (provider) => {
    const key = provider.name.toLowerCase().replace(/\W/g, '');
    if (merged[key]) {
      // Doctor already in map — just add this network tag
      if (!merged[key].networks.includes(provider.network)) {
        merged[key].networks.push(provider.network);
      }
    } else {
      merged[key] = { ...provider, networks: [provider.network] };
    }
  };

  uhcList.forEach(add);
  aetnaList.forEach(add);

  return Object.values(merged);
}

// Exported function — called by server.js
// requestedNets tells us which of ['uhc','aetna'] the user actually wants
module.exports = async function zocdocSearch(params, requestedNets = ['uhc', 'aetna']) {
  const browser = await chromium.launch({ headless: true });

  try {
    const searches = requestedNets.map(async (netKey) => {
      const page = await browser.newPage();
      try {
        return await searchWithInsurance(page, params, netKey);
      } finally {
        await page.close();
      }
    });

    const results = await Promise.all(searches);

    // Build per-network result object + merged combined view
    const output = {};
    requestedNets.forEach((key, i) => { output[key] = results[i]; });

    // Also store merged so the frontend can show "accepts both"
    if (requestedNets.length > 1) {
      const merged = mergeResults(results[0] || [], results[1] || []);
      // Flatten back into per-network arrays for the server's output format,
      // but tag providers that appear in multiple networks
      requestedNets.forEach((key, i) => {
        output[key] = results[i].map(p => ({
          ...p,
          alsoInNetwork: merged.find(m =>
            m.name.toLowerCase() === p.name.toLowerCase() && m.networks.length > 1
          )?.networks.filter(n => n !== key) || [],
        }));
      });
    }

    return output;
  } finally {
    await browser.close();
  }
};
