/**
 * FirstHealth Network Searcher
 * 3-step flow: network select → provider type → search form → scrape results
 */

const https    = require('https');
const { chromium } = require('playwright');

// Geocode ZIP → state abbreviation (needed for #SearchState Required field)
function zipToState(zip) {
  return new Promise((resolve) => {
    https.get(`https://api.zippopotam.us/us/${zip}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const place = JSON.parse(data).places?.[0];
          resolve(place ? place['state abbreviation'] : null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function jsfill(page, selector, value) {
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
}

// Poll for URL fragment instead of waitForURL (more reliable on cloud)
async function waitForUrlContains(page, fragment, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.url().includes(fragment)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

module.exports = async function firsthealthSearch({ zip, name, specialty, npi } = {}) {
  // Resolve state from ZIP (needed for the Required #SearchState dropdown)
  const stateCode = zip ? await zipToState(zip.trim()) : null;
  console.log(`[FH] ZIP ${zip} → state: ${stateCode}`);
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
    await page.waitForTimeout(2000);

    // Select First Health radio and click submit — all via evaluate to bypass visibility checks
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      page.evaluate(() => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"][name="RadioButtonSelected"]'));
        const fh = radios.find(r => {
          const label = document.querySelector(`label[for="${r.id}"]`);
          return label && label.textContent.includes('First Health') && !label.textContent.includes('Choice');
        }) || radios[0];
        if (fh) fh.click();
        const btn = document.querySelector('#btnSubmit') ||
          Array.from(document.querySelectorAll('button, input[type="submit"]'))
            .find(b => /submit|search|next|continue/i.test(b.value || b.textContent));
        if (btn) btn.click();
      }),
    ]);

    const onTypeSelection = await waitForUrlContains(page, 'ProviderTypeSelection', 15000);
    if (!onTypeSelection) {
      console.log('[FH] Step 1 navigation may have stalled, current URL:', page.url());
    }
    await page.waitForTimeout(1500);

    // ── STEP 2: Provider type = Physician ─────────────────────────────────
    await page.evaluate(() => {
      // Click the Physician radio button (works with both styled and plain radio inputs)
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const physician = radios.find(r => {
        const label = document.querySelector(`label[for="${r.id}"]`);
        return label && /physician/i.test(label.textContent);
      }) || radios.find(r => /physician/i.test(r.value || ''));
      if (physician) {
        physician.checked = true;
        physician.click();
        physician.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Check "Accepting new patients" if present
      const cb = document.querySelector('#AcceptingNewPatients, input[id*="ccepting"], input[name*="ccepting"]');
      if (cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(600);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      page.evaluate(() => {
        const btn = document.querySelector('#btnSubmit') ||
          Array.from(document.querySelectorAll('button, input[type="submit"]'))
            .find(b => /submit|search|next|continue/i.test(b.value || b.textContent));
        if (btn) btn.click();
      }),
    ]);

    await waitForUrlContains(page, 'SearchIndex', 15000);
    await page.waitForTimeout(2000);

    // ── STEP 3: Fill search form ───────────────────────────────────────────
    // IMPORTANT: ZIP must be entered FIRST — the #specialities dropdown is
    // empty on page load and is AJAX-populated only after ZIP is entered.

    // 3a. Set state dropdown first (#SearchState is marked Required)
    if (stateCode) {
      await page.evaluate((sc) => {
        const sel = document.querySelector('#SearchState');
        if (!sel) return;
        // Find option matching state abbreviation (value or text)
        const opt = Array.from(sel.options).find(o =>
          o.value.toUpperCase() === sc.toUpperCase() ||
          o.text.trim().toUpperCase() === sc.toUpperCase()
        );
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, stateCode);
      await page.waitForTimeout(800);
      console.log(`[FH] State set to ${stateCode}`);
    }

    // 3b. Enter ZIP via JS (bypasses visibility) — single clean entry
    if (zip && zip.trim()) {
      await page.evaluate((z) => {
        const el = document.querySelector('#txtboxZipCode');
        if (!el) return;
        el.value = z;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
      }, zip.trim());
      await page.waitForTimeout(400);

      // Also slow-type to trigger any keydown/keyup handlers
      await page.evaluate(() => {
        const el = document.querySelector('#txtboxZipCode');
        if (el) el.select?.();
      });
      await page.keyboard.type(zip.trim(), { delay: 60 }).catch(() => {});
      await page.dispatchEvent('#txtboxZipCode', 'change').catch(() => {});
      await page.dispatchEvent('#txtboxZipCode', 'blur').catch(() => {});

      // Poll for #specialities to populate (AJAX triggered by ZIP + state)
      const specialtiesLoaded = await page.evaluate(() => {
        return new Promise(resolve => {
          let tries = 0;
          const poll = setInterval(() => {
            const sel = document.querySelector('#specialities');
            if ((sel && sel.options.length > 1) || tries++ > 40) {
              clearInterval(poll);
              resolve(sel ? sel.options.length : 0);
            }
          }, 300);
        });
      });
      console.log(`[FH] #specialities options after ZIP+state: ${specialtiesLoaded}`);
      await page.waitForTimeout(500);
    }

    // 3b. Specialty — select from #specialities (correct ID, AJAX-populated)
    if (specialty && specialty.trim()) {
      const spec = specialty.trim();
      const matched = await page.evaluate((kw) => {
        const sel = document.querySelector('#specialities');
        if (!sel || sel.options.length <= 1) return null;
        const opts = Array.from(sel.options);
        const kl = kw.toLowerCase();
        const exact   = opts.find(o => o.text.trim().toLowerCase() === kl);
        const partial = opts.find(o => o.text.trim().toLowerCase().includes(kl));
        const reverse = opts.find(o => o.text.trim().length > 3 && kl.includes(o.text.trim().toLowerCase()));
        const opt = exact || partial || reverse;
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return opt.text.trim();
        }
        return null;
      }, spec);
      console.log(`[FH] Specialty matched: ${matched}`);
      await page.waitForTimeout(400);
    }

    // 3c. Provider name (optional)
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

    // 3d. NPI (optional)
    if (npi && npi.trim()) {
      await jsfill(page, '#txtProviderNPI', npi.trim());
    }

    // ── Click Search ───────────────────────────────────────────────────────
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.locator('#SearchNow').first().click().catch(async () => {
        // Fallback if #SearchNow not visible
        await page.evaluate(() => {
          const btn = document.querySelector('#SearchNow') ||
            Array.from(document.querySelectorAll('button,input[type="submit"]'))
              .find(b => /search/i.test(b.textContent || b.value));
          if (btn) btn.click();
        });
      }),
    ]);

    await page.waitForTimeout(2000);

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

        // Parse addressLines into object { street, city, state, zip }
        // Typical FH format: ["123 Main St", "Tampa, FL 33701"]
        let street = '', city = '', state = '', zip = '';
        if (addressLines.length > 0) {
          street = addressLines[0] || '';
          const last = addressLines[addressLines.length - 1] || '';
          const m = last.match(/^(.*?),\s*([A-Z]{2})\s*(\d{5})?/);
          if (m) { city = m[1].trim(); state = m[2]; zip = m[3] || ''; }
          else if (addressLines.length === 1) {
            // Single line — try to split on last comma
            const parts = last.split(',');
            street = parts[0]?.trim() || last;
            city   = parts[1]?.trim() || '';
          }
        }
        return {
          network: 'First Health PPO',
          name: providerName,
          specialty,
          address: { street, city, state, zip },
          phone,
          distance: parseFloat(distance) || null,
          primaryCare,
          acceptingNewPatients: true,
          inNetwork: true,
          npi: '',
          providerType: '',
        };
      }).filter(Boolean);
    });

    return providers;

  } finally {
    await browser.close();
  }
};
