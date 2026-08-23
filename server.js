/**
 * Provider Network Search — Hybrid Backend
 *
 * UHC   → searchers/uhc.js        (UHC Choice Plus, GraphQL)
 * Aetna → searchers/aetna.js      (Aetna Open Choice PPO, Playwright + stealth)
 * PHCS  → searchers/phcs.js
 * FH    → searchers/firsthealth.js
 *
 * Setup:
 *   npm install
 *   npx playwright install chromium
 *   node server.js
 */

const express     = require('express');
const cors        = require('cors');
const uhc         = require('./searchers/uhc');
const aetna       = require('./searchers/aetna');
const phcs        = require('./searchers/phcs');
const firsthealth = require('./searchers/firsthealth');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Each network key maps to its scraper function
const SEARCHERS = { uhc, aetna, phcs, fh: firsthealth };

// POST /api/search
// Body: { zip, specialty, name, networks: ['uhc','aetna','phcs','fh'] }
app.post('/api/search', async (req, res) => {
  const {
    zip       = '',
    name      = '',
    specialty = '',
    networks  = ['uhc', 'aetna', 'phcs', 'fh'],
  } = req.body;

  if (!zip && !name && !specialty) {
    return res.status(400).json({ error: 'Provide at least one search parameter.' });
  }

  const params = { zip, name, specialty };
  const start  = Date.now();

  // Run all requested networks in parallel
  const tasks = networks.map(net => {
    const fn = SEARCHERS[net];
    if (!fn) return Promise.resolve({ source: net, providers: [], error: 'Unknown network' });

    return fn(params)
      .then(providers => ({ source: net, providers, error: null }))
      .catch(e         => ({ source: net, providers: [], error: e.message }));
  });

  const settled = await Promise.all(tasks);

  const results = {};
  const errors  = {};

  settled.forEach(({ source, providers, error }) => {
    results[source] = providers;
    if (error) errors[source] = error;
  });

  res.json({ results, errors, durationMs: Date.now() - start });
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
