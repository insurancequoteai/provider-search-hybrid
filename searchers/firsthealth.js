/**
 * FirstHealth Network Searcher
 * 3-step flow: network select → provider type → search form → scrape results
 */

const { chromium } = require('playwright');

async function jsfill(page, selector, value) {
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
}

module.exports = async function firsthealthSearch({ zip, name, specialty, npi } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    // ── STEP 1: Network selection ──────────────────────────────────────────
    await page.goto(
      'https://providerlocator.firsthealth.com/LocateProvider/LocateProviderSearch/',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name="RadioButtonSelected"]'));
      const fh = radios.find(r => {
        const label = document.querySelector(`label[for="${r.id}"]`);
        return label && label.textContent.includes('First Health') && !label.textContent.includes('Choice');
      }) || radios[0];
      if (fh) fh.click();
      const btn = document.querySelector('#btnSubmit');
      if (btn) btn.click();
    });

    await page.waitForURL('**/ProviderTypeSelection/**', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // ── STEP 2: Provider type = Physician ─────────────────────────────────
    const physicianLabel = page.locator('div#Physician label.btn').first();
    if (await physicianLabel.count() > 0) {
      await physicianLabel.click();
    } else {
      // Fallback: click any label containing "Physician"
      await page.locator('label:has-text("Physician")').first().click().catch(() => {});
    }
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const cb = document.querySelector('#AcceptingNewPatients');
      if (cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(300);

    await page.locator('#btnSubmit').click();
    await page.waitForURL('**/SearchIndex/**', { timeout: 15000 });
    await page.waitForTimeout(1500);

    // ── STEP 3: Fill search form ───────────────────────────────────────────

    // Provider name
    if (name && name.trim()) {
      let nameQuery = name.trim();
      if (!nameQuery.includes(',')) {
        const parts = nameQuery.split(/\s+/);
        if (parts.length >= 2) {
          nameQuery = parts[parts.length - 1] + ', ' + parts.slice(0, -1).join(' ');
        }
      }
      await jsfill(page, '#txtProviderName', nameQuery);
    }

    // NPI
    if (npi && npi.trim()) {
      await jsfill(page, '#txtProviderNPI', npi.trim());
    }

    // Specialty — try dropdown first, then text input
    if (specialty && specialty.trim()) {
      const spec = specialty.trim();

      // Try selecting from a <select> dropdown
      const selectEl = page.locator('select#selectedSpeciality, select[name*="pecial" i]').first();
      if (await selectEl.count() > 0) {
        // Find best matching option
        const matched = await selectEl.evaluate((el, kw) => {
          const opts = Array.from(el.options);
          const exact = opts.find(o => o.text.toLowerCase() === kw.toLowerCase());
          const partial = opts.find(o => o.text.toLowerCase().includes(kw.toLowerCase()));
          const opt = exact || partial;
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return opt.text; }
          return null;
        }, spec);
        console.log(`[FH] Specialty matched: ${matched}`);
      } else {
        // Fall back to text fill
        await jsfill(page, '#selectedSpeciality', spec);
      }
      await page.waitForTimeout(500);
    }

    // ZIP code
    if (zip && zip.trim()) {
      await page.click('#txtboxZipCode', { clickCount: 3 }).catch(() => {});
      await jsfill(page, '#txtboxZipCode', zip.trim());
      await page.dispatchEvent('#txtboxZipCode', 'change').catch(() => {});
      await page.dispatchEvent('#txtboxZipCode', 'blur').catch(() => {});
      await page.waitForTimeout(1000);
    }

    // ── Click Search ───────────────────────────────────────────────────────
    const searchBtn = page.locator('#SearchNow').first();
    if (await searchBtn.count() > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        searchBtn.click(),
      ]);
    } else {
      // Fallback: JS click
      await page.evaluate(() => {
        const btn = document.querySelector('#SearchNow') ||
          Array.from(document.querySelectorAll('button,input[type="submit"]'))
            .find(b => /search/i.test(b.textContent || b.value));
        if (btn) btn.click();
      });
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // ── STEP 4: Scrape results ─────────────────────────────────────────────
    const pageText = await page.evaluate(() => document.body.innerText);
    if (/no (providers?|results?) found|0 results|no match/i.test(pageText)) {
      return [];
    }

    await page.waitForSelector('h3.resultProviderHeader, div.panel.panelBodyStyle', { timeout: 15000 }).catch(() => {});

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

        let phone = '', distance = '', specialty = '';
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
          network: 'First Health PPO',
          name: providerName,
          specialty,
          address: addressLines.join(', '),
          phone,
          distance,
          primaryCare,
          acceptingNewPatients: true,
          npi: '',
        };
      }).filter(Boolean);
    });

    return providers;

  } finally {
    await browser.close();
  }
};
