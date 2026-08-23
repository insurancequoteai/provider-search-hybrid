/**
 * FirstHealth Network Searcher
 *
 * Confirmed 3-step flow (Aug 2026):
 *   Step 1 → /LocateProvider/LocateProviderSearch/  — select First Health radio → #btnSubmit
 *   Step 2 → /ProviderTypeSelection/                — click Physician label → #AcceptingNewPatients → #btnSubmit
 *   Step 3 → /SearchIndex/                          — fill fields (via JS, some are in hidden accordions) → #SearchNow
 *   Results → /ProviderSearchResult/                — scrape .panel.panelBodyStyle cards
 *
 * Params:
 *   zip       {string}  Required. 5-digit ZIP code.
 *   name      {string}  Optional. "Last, First" or "First Last" — used for in-network name lookup.
 *   specialty {string}  Optional. Specialty keyword e.g. "Family Medicine".
 *   npi       {string}  Optional. 10-digit NPI for exact provider lookup.
 */

const { chromium } = require('playwright');

// Fill a hidden field via JS (bypasses Playwright's visibility requirement)
async function jsfill(page, selector, value) {
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
}

module.exports = async function firsthealthSearch({ zip, name, specialty, npi }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    // ── STEP 1: Network selection ─────────────────────────────────────
    await page.goto(
      'https://providerlocator.firsthealth.com/LocateProvider/LocateProviderSearch/',
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    );

    await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name="RadioButtonSelected"]'));
      const fh = radios.find(r => {
        const label = document.querySelector(`label[for="${r.id}"]`);
        return label && label.textContent.includes('First Health') && !label.textContent.includes('Choice');
      }) || radios[0];
      if (fh) fh.click();
      document.querySelector('#btnSubmit').click();
    });

    await page.waitForURL('**/ProviderTypeSelection/**', { timeout: 15000 });

    // ── STEP 2: Provider type = Physician ─────────────────────────────
    await page.locator('div#Physician label.btn').click();
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const cb = document.querySelector('#AcceptingNewPatients');
      if (cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(300);

    const sessionPromise = page.waitForResponse(
      res => res.url().includes('SaveSearchRequestToSession'),
      { timeout: 10000 }
    );
    await page.locator('#btnSubmit').click();
    await sessionPromise;
    await page.waitForURL('**/SearchIndex/**', { timeout: 10000 });

    // ── STEP 3: Fill search form via JS (fields may be in hidden accordions) ──

    // Provider name — "Last, First" format for in-network lookup
    if (name && name.trim()) {
      let nameQuery = name.trim();
      if (!nameQuery.includes(',')) {
        const parts = nameQuery.split(/\s+/);
        if (parts.length >= 2) {
          nameQuery = parts[parts.length - 1] + ', ' + parts.slice(0, -1).join(' ');
        }
      }
      await jsfall(page, '#txtProviderName', nameQuery);
    }

    // NPI (exact lookup)
    if (npi && npi.trim()) {
      await jsfall(page, '#txtProviderNPI', npi.trim());
    }

    // Specialty
    if (specialty && specialty.trim()) {
      await jsfall(page, '#selectedSpeciality', specialty.trim());
      await page.waitForTimeout(500);
    }

    // ZIP (slow-type + events so AJAX validation passes)
    if (zip && zip.trim()) {
      await page.click('#txtboxZipCode', { clickCount: 3 });
      await page.type('#txtboxZipCode', zip.trim(), { delay: 80 });
      await page.dispatchEvent('#txtboxZipCode', 'change');
      await page.dispatchEvent('#txtboxZipCode', 'blur');
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // ── Click Search Now ──────────────────────────────────────────────
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }),
      page.evaluate(() => document.querySelector('#SearchNow').click()),
    ]);

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // ── STEP 4: Scrape results ────────────────────────────────────────
    const pageText = await page.evaluate(() => document.body.innerText);
    if (/no (providers?|results?) found|0 results/i.test(pageText)) {
      return [];
    }

    await page.waitForSelector('h3.resultProviderHeader', { timeout: 15000 }).catch(() => {});

    const providers = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('div.panel.panelBodyStyle'));
      return cards.slice(0, 25).map(card => {
        const nameEl = card.querySelector('h3.resultProviderHeader');
        const providerName = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : '';
        if (!providerName) return null;

        const bodyEl = card.querySelector('div.resultProviderBody');
        const lines = bodyEl
          ? bodyEl.innerText.split('\n').map(l => l.trim()).filter(Boolean)
          : [];

        let phone = '';
        let distance = '';
        let specialty = '';
        let primaryCare = false;
        const addressLines = [];

        for (const line of lines) {
          if (/^\d+(\.\d+)?\s*miles?$/i.test(line)) {
            distance = line;
          } else if (/^\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4}$/.test(line)) {
            phone = line;
          } else if (/Specialty Type\s*:/i.test(line)) {
            specialty = line.replace(/Specialty Type\s*:\s*/i, '').trim();
          } else if (/Primary Care Provider\s*:/i.test(line)) {
            primaryCare = /yes/i.test(line);
          } else if (
            !/Report Incorrect/i.test(line) &&
            !/Focus Type/i.test(line) &&
            !/Virtual Care/i.test(line) &&
            !/Accepting New/i.test(line)
          ) {
            addressLines.push(line);
          }
        }

        return {
          name: providerName,
          specialty,
          address: addressLines.join(', '),
          phone,
          distance,
          primaryCare,
          accepting: true,
          npi: '',
          network: 'firsthealth',
          alsoInNetwork: [],
        };
      }).filter(Boolean);
    });

    return providers;

  } finally {
    await browser.close();
  }
};

// Alias typo fix
async function jsfall(page, selector, value) {
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
}
