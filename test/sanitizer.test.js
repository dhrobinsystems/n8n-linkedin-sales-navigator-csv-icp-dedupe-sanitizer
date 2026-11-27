'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('../lib/core');
const san = require('../lib/sanitizer');
const hs = require('../lib/hubspot');
const { render, NAMES } = require('../scripts/build-workflow');

const ROOT = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));

const RULES = readJson('config/icp-rules.example.json');
const STATIC_LIST = readJson('config/suppression-domains.example.json').domains;
const SNAPSHOT = readJson('fixtures/hubspot_crm_snapshot.sample.json');
const SAMPLE_CSV = readText('fixtures/sales_nav_export.sample.csv');
const COMPILED = san.compileRules(RULES);

// Real freemail hosts are assembled at runtime so no real domain or address is written into the repo.
const FREE_HOST = ['gma', 'il.com'].join('');
const FAKE_TOKEN = ['zzz', 'TEST', 'faketoken', '0123456789'].join('_');
const FAKE_BEARER = ['Bearer', FAKE_TOKEN].join(' ');
const FAKE_PAT = ['pat', 'na1', 'zzzzzzzz', 'zzzz', 'zzzz'].join('-');
const FAKE_SK = ['sk', 'zzzzTESTzzzz0123456789'].join('-');

function rec(overrides) {
  return Object.assign(
    {
      source_row: 1,
      record_id: 'zzz_TEST_R1',
      first_name: 'Alex',
      last_name: 'Rivera',
      title: 'Director of Sales',
      title_raw: 'Director of Sales',
      company: 'Acme Robotics',
      company_raw: 'Acme Robotics',
      website_raw: '',
      domain: 'acme-robotics.example',
      domain_source: 'website',
      linkedin_url: '',
      linkedin_key: '',
      email: '',
      geography: 'Austin, Texas, United States',
      industry: '',
      seniority: 'director',
      seniority_score: 60
    },
    overrides
  );
}

function publicConfigFrom(env) {
  return core.publicConfig(core.buildConfig(env || {}));
}

async function runSample(envOverrides, snapshotOverride) {
  const env = envOverrides || {};
  const config = core.buildConfig(env);
  return san.runPipeline(SAMPLE_CSV, {
    config: core.publicConfig(config),
    rules: RULES,
    staticSuppression: STATIC_LIST,
    nowIso: '2026-01-01T00:00:00.000Z',
    lookup: async (domains) =>
      hs.lookupFromSnapshot(domains, snapshotOverride || SNAPSHOT, {
        dncProperty: config.hubspot.dncProperty,
        closedLostStages: config.hubspot.closedLostStages
      })
  });
}

// ---------------------------------------------------------------------------
// Emoji and title/company/name cleaning
// ---------------------------------------------------------------------------

test('stripEmoji removes emoji, flags, ZWJ sequences, variation selectors, and zero-width characters', () => {
  assert.equal(san.stripEmoji('VP of Sales \u{1F680}'), 'VP of Sales');
  assert.equal(san.stripEmoji('Sales \u{1F1FA}\u{1F1F8} Lead \u2728\uFE0F'), 'Sales Lead');
  assert.equal(san.stripEmoji('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Founder'), 'Founder');
  assert.equal(san.stripEmoji('Head\u200B of Growth'), 'Head of Growth');
  assert.equal(san.stripEmoji('\u{1D415}\u{1D40F} of Sales'), 'VP of Sales');
  assert.equal(san.stripEmoji(null), '');
});

test('cleanTitle strips accolades after pipes, slashes, commas, and dashes', () => {
  const cases = [
    ['VP of Sales | Helping B2B Scale \u{1F680}', 'VP of Sales'],
    ['Chief Revenue Officer \u{1F680} | Helping B2B Teams Scale', 'Chief Revenue Officer'],
    ['Director, Demand Generation, MBA, PMP', 'Director, Demand Generation'],
    ['Director of Marketing / Advisor / Speaker', 'Director of Marketing'],
    ['Head of Sales / Marketing', 'Head of Sales / Marketing'],
    ['VP Sales - Acme Robotics', 'VP Sales'],
    ['VP Sales at Acme Robotics', 'VP Sales'],
    ['Director of Sales (She/Her)', 'Director of Sales'],
    ['Sales Director \u{1F4BC} | Open to work', 'Sales Director'],
    ['Account Executive \u2728', 'Account Executive'],
    ['Sales Manager, Top 40 Under 40', 'Sales Manager'],
    ['Head of Growth \u2022 Ex-Fintech \u2022 Podcast Host', 'Head of Growth'],
    ['| VP Marketing', 'VP Marketing'],
    ['', '']
  ];
  cases.forEach(([raw, expected]) => assert.equal(san.cleanTitle(raw, 'Acme Robotics'), expected, raw));
});

test('cleanCompanyName strips legal suffixes and noise', () => {
  const cases = [
    ['Acme Robotics Inc.', 'Acme Robotics'],
    ['Acme Robotics, Inc.', 'Acme Robotics'],
    ['Northstar Logistics LLC', 'Northstar Logistics'],
    ['Orbit Systems Ltd.', 'Orbit Systems'],
    ['Pioneer Grid GmbH', 'Pioneer Grid'],
    ['Stellar Freight Corp.', 'Stellar Freight'],
    ['Atlas \u{1F680} Corp', 'Atlas'],
    ['Acme Robotics Inc. (formerly Zed Works)', 'Acme Robotics'],
    ['Northstar Lab', 'Northstar Lab'],
    ['Inc', 'Inc']
  ];
  cases.forEach(([raw, expected]) => assert.equal(san.cleanCompanyName(raw), expected, raw));
});

test('cleanPersonName removes credentials, emoji, and fixes all-caps or all-lowercase names', () => {
  assert.equal(san.cleanPersonName('Dana \u{1F680}'), 'Dana');
  assert.equal(san.cleanPersonName('Whitfield, MBA'), 'Whitfield');
  assert.equal(san.cleanPersonName('Nair PMP'), 'Nair');
  assert.equal(san.cleanPersonName('PRIYA'), 'Priya');
  assert.equal(san.cleanPersonName("o'neil-smith"), "O'Neil-Smith");
  assert.equal(san.cleanPersonName('Ma'), 'Ma');
});

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

test('normalizeDomain returns clean root domains', () => {
  const opts = { blocklist: COMPILED.blocklist };
  const ok = [
    ['https://www.acme-robotics.example/about?utm_source=zzz_TEST', 'acme-robotics.example'],
    ['HTTP://WWW.ACME-ROBOTICS.EXAMPLE', 'acme-robotics.example'],
    ['acme-robotics.example/', 'acme-robotics.example'],
    ['eu.acme-robotics.example', 'acme-robotics.example'],
    ['https://shop.eu.acme-robotics.example:8443/x#frag', 'acme-robotics.example'],
    ['shop.acme-robotics.co.uk', 'acme-robotics.co.uk'],
    ['alex.rivera@acme-robotics.example', 'acme-robotics.example'],
    ['mailto:alex.rivera@acme-robotics.example', 'acme-robotics.example'],
    ['//www.northstar-logistics.example', 'northstar-logistics.example'],
    ['acme-robotics.example.', 'acme-robotics.example']
  ];
  ok.forEach(([input, expected]) => assert.deepEqual(san.normalizeDomain(input, opts), { domain: expected, reason: '' }, input));
});

test('normalizeDomain rejects missing, invalid, freemail, and social domains', () => {
  const opts = { blocklist: COMPILED.blocklist };
  assert.equal(san.normalizeDomain('', opts).reason, 'missing_domain');
  assert.equal(san.normalizeDomain('N/A', opts).reason, 'missing_domain');
  assert.equal(san.normalizeDomain('not a domain', opts).reason, 'invalid_domain');
  assert.equal(san.normalizeDomain('localhost', opts).reason, 'invalid_domain');
  assert.equal(san.normalizeDomain('192.0.2.5', opts).reason, 'invalid_domain');
  assert.equal(san.normalizeDomain(['https:', '', 'www.' + FREE_HOST, ''].join('/'), opts).reason, 'freemail_or_social_domain');
  assert.equal(san.normalizeDomain('someone@' + FREE_HOST, opts).reason, 'freemail_or_social_domain');
  assert.equal(san.normalizeDomain('linkedin.com/company/zzz-test-co', opts).reason, 'freemail_or_social_domain');
  assert.equal(san.normalizeDomain('www.yahoo.com', opts).reason, 'freemail_or_social_domain');
  assert.equal(san.normalizeDomain('acme.wixsite.com', opts).reason, 'freemail_or_social_domain');
});

test('LinkedIn URLs and emails are normalized to stable keys', () => {
  const a = san.normalizeLinkedInUrl('https://www.linkedin.com/in/ZZZ-test-Dana-Whitfield/?trk=zzz_TEST_nav');
  const b = san.normalizeLinkedInUrl('linkedin.com/in/zzz-test-dana-whitfield');
  assert.equal(a.url, 'https://www.linkedin.com/in/zzz-test-dana-whitfield');
  assert.equal(a.key, b.key);
  assert.equal(san.normalizeLinkedInUrl('https://example.example/profile').key, '');
  assert.equal(san.normalizeEmail('  Alex.Rivera@Acme-Robotics.Example '), 'alex.rivera@acme-robotics.example');
  assert.equal(san.normalizeEmail('not-an-email'), '');
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('CSV parser handles quotes, embedded newlines, CRLF, BOM, blank lines, and semicolon delimiters', () => {
  const text = '\uFEFFFirst Name,Title,Company\r\n"Alex","VP, Sales ""Lead""",Acme\r\n\r\n"Sam","Line one\nLine two",Northstar\r\n';
  const t = core.parseCsv(text);
  assert.deepEqual(t.headers, ['First Name', 'Title', 'Company']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].Title, 'VP, Sales "Lead"');
  assert.equal(t.rows[1].Title, 'Line one\nLine two');
  const semi = core.parseCsv('First Name;Company\nAlex;Acme');
  assert.equal(semi.delimiter, ';');
  assert.equal(semi.rows[0].Company, 'Acme');
  assert.throws(() => core.parseCsv('a,b\n"unterminated,1'), core.CsvError);
  assert.throws(() => core.parseCsv('   '), core.CsvError);
});

test('CSV serializer quotes cells and guards against spreadsheet formula injection', () => {
  const out = core.toCsv(['a', 'b'], [{ a: 'x,y', b: '=HYPERLINK("zzz")' }, { a: 'say "hi"', b: 5 }, { a: '', b: '-5 off' }]);
  assert.equal(out, 'a,b\n"x,y","\'=HYPERLINK(""zzz"")"\n"say ""hi""",5\n,\'-5 off\n');
  const round = core.parseCsv(core.toCsv(['t'], [{ t: 'multi\nline, "quoted"' }]));
  assert.equal(round.rows[0].t, 'multi\nline, "quoted"');
});

test('header aliases map common Sales Navigator column names; missing columns raise a clear error', () => {
  const table = core.parseCsv('Full Name,Job Title,Account Name,Website,Profile URL,Work Email,Location,Industry\nAlex Rivera,VP Sales,Acme,acme-robotics.example,linkedin.com/in/zzz-test-a,a@acme-robotics.example,Austin,Robotics');
  const rows = san.toCanonicalRows(table);
  assert.equal(rows[0].first_name, 'Alex');
  assert.equal(rows[0].last_name, 'Rivera');
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].geography, 'Austin');
  assert.equal(rows[0].record_id, 'row_001');
  assert.throws(() => san.toCanonicalRows(core.parseCsv('Foo,Bar\n1,2')), core.CsvError);
});

// ---------------------------------------------------------------------------
// ICP filtering and seniority
// ---------------------------------------------------------------------------

test('ICP filter applies title include, title exclude, and missing-title rules', () => {
  const r = san.applyIcpFilter(
    [
      rec({ source_row: 1, title: 'VP of Sales' }),
      rec({ source_row: 2, title: 'Sales Intern' }),
      rec({ source_row: 3, title: 'Talent Acquisition Manager' }),
      rec({ source_row: 4, title: 'Software Engineer' }),
      rec({ source_row: 5, title: '' }),
      rec({ source_row: 6, title: 'Account Executive' })
    ],
    COMPILED
  );
  assert.deepEqual(r.kept.map((x) => x.source_row), [1, 6]);
  const reasons = {};
  r.dropped.forEach((d) => {
    reasons[d.source_row] = d.drop_reason;
  });
  assert.deepEqual(reasons, { 2: 'title_excluded', 3: 'title_excluded', 4: 'title_not_icp', 5: 'missing_title' });
});

test('ICP filter applies geography rules with aliases and region suffixes', () => {
  const geo = (g) => san.applyIcpFilter([rec({ geography: g })], COMPILED);
  assert.equal(geo('Greater London, England, United Kingdom').kept.length, 1);
  assert.equal(geo('Remote, USA').kept.length, 1);
  assert.equal(geo('Toronto, Ontario, Canada').kept.length, 1);
  assert.equal(geo('Greater Boston Area, United States').kept.length, 1);
  assert.equal(geo('Pune, Maharashtra, India').dropped[0].drop_reason, 'geography_not_allowed');
  assert.equal(geo('').dropped[0].drop_reason, 'geography_missing');
  const open = san.compileRules(Object.assign({}, RULES, { allowedRegions: [] }));
  assert.equal(san.applyIcpFilter([rec({ geography: 'Pune, India' })], open).kept.length, 1);
});

test('invalid ICP rules fail loudly', () => {
  assert.throws(() => san.compileRules(Object.assign({}, RULES, { titleInclude: ['(unclosed'] })), core.ConfigError);
  assert.throws(() => san.compileRules(Object.assign({}, RULES, { titleInclude: [] })), core.ConfigError);
});

test('seniority classification: C-level > VP > Director > Manager > IC', () => {
  const lvl = (t) => san.classifySeniority(t, COMPILED).level;
  assert.equal(lvl('Chief Revenue Officer'), 'c_level');
  assert.equal(lvl('Co-Founder & CEO'), 'c_level');
  assert.equal(lvl('President'), 'c_level');
  assert.equal(lvl('Vice President of Sales'), 'vp');
  assert.equal(lvl('SVP Marketing'), 'vp');
  assert.equal(lvl('Head of Growth'), 'director');
  assert.equal(lvl('Sales Director'), 'director');
  assert.equal(lvl('Sales Manager'), 'manager');
  assert.equal(lvl('Product Owner'), 'ic');
  assert.equal(lvl('Account Executive'), 'ic');
  const scores = ['Chief Revenue Officer', 'VP Sales', 'Director of Sales', 'Sales Manager', 'Account Executive'].map((t) => san.classifySeniority(t, COMPILED).score);
  assert.deepEqual(scores, [100, 80, 60, 40, 20]);
});

// ---------------------------------------------------------------------------
// HubSpot suppression
// ---------------------------------------------------------------------------

test('snapshot lookup suppresses customers, evangelists, open deals, and DNC; ignores closed-lost-only accounts', () => {
  const domains = [
    'acme-robotics.example',
    'stellar-freight.example',
    'brightwave-analytics.example',
    'pioneer-grid.example',
    'harbor-light-media.example',
    'quietpeak-labs.example',
    'unknown-company.example'
  ];
  const res = hs.lookupFromSnapshot(domains, SNAPSHOT, { dncProperty: 'do_not_contact', closedLostStages: ['closedlost'] });
  const reasons = {};
  Object.keys(res.suppressed).forEach((d) => {
    reasons[d] = res.suppressed[d].reasons;
  });
  assert.deepEqual(reasons, {
    'stellar-freight.example': ['hubspot_customer', 'hubspot_open_deal'],
    'brightwave-analytics.example': ['hubspot_open_deal'],
    'harbor-light-media.example': ['hubspot_customer'],
    'quietpeak-labs.example': ['hubspot_dnc_flag']
  });
  assert.equal(res.source, 'fixture');
});

test('closed-lost stages and the DNC property are configurable', () => {
  const snap = {
    companies: [{ id: 'zzz_TEST_COMP_900', domain: 'orbit-systems.example', lifecyclestage: 'lead', flagged: 'yes' }],
    deals: [{ id: 'zzz_TEST_DEAL_900', companyId: 'zzz_TEST_COMP_900', dealstage: '9876_custom_lost' }]
  };
  assert.deepEqual(Object.keys(hs.lookupFromSnapshot(['orbit-systems.example'], snap, { closedLostStages: ['closedlost'], dncProperty: '' }).suppressed), ['orbit-systems.example']);
  assert.deepEqual(Object.keys(hs.lookupFromSnapshot(['orbit-systems.example'], snap, { closedLostStages: ['9876_custom_lost'], dncProperty: '' }).suppressed), []);
  assert.deepEqual(hs.lookupFromSnapshot(['orbit-systems.example'], snap, { closedLostStages: ['9876_custom_lost'], dncProperty: 'flagged' }).suppressed['orbit-systems.example'].reasons, ['hubspot_dnc_flag']);
});

test('suppression stage picks one primary reason and keeps the rest in drop_detail', () => {
  const staticSet = new Set(['suppressed-client.example']);
  const suppressed = { 'stellar-freight.example': { reasons: ['hubspot_customer', 'hubspot_open_deal'] } };
  const r = san.applySuppression(
    [rec({ source_row: 1, domain: 'suppressed-client.example' }), rec({ source_row: 2, domain: 'stellar-freight.example' }), rec({ source_row: 3, domain: 'fresh-lead.example' })],
    staticSet,
    suppressed
  );
  assert.deepEqual(r.kept.map((x) => x.source_row), [3]);
  assert.equal(r.dropped[0].drop_reason, 'static_suppression_list');
  assert.equal(r.dropped[1].drop_reason, 'hubspot_customer');
  assert.equal(r.dropped[1].drop_detail, 'hubspot_customer;hubspot_open_deal');
});

function makeFakeHubSpot(snapshot, token, hook) {
  const calls = [];
  async function request(req) {
    calls.push({ method: req.method, url: req.url });
    if (req.headers.Authorization !== 'Bearer ' + token) return { status: 401, headers: {}, body: { message: 'Authentication failed for ' + req.headers.Authorization } };
    const early = hook && hook(req, calls.length);
    if (early) return early;
    const p = req.url.replace('https://api.hubapi.com', '');
    if (p === '/crm/v3/objects/companies/search') {
      const wanted = req.body.filterGroups[0].filters[0].values;
      const results = snapshot.companies
        .filter((c) => wanted.indexOf(c.domain) !== -1)
        .map((c) => ({ id: c.id, properties: { domain: c.domain, name: c.name, lifecyclestage: c.lifecyclestage, do_not_contact: c.do_not_contact } }));
      return { status: 200, headers: {}, body: { results: results } };
    }
    if (p === '/crm/v4/associations/companies/deals/batch/read') {
      const results = req.body.inputs
        .map((i) => ({ from: { id: i.id }, to: snapshot.deals.filter((d) => d.companyId === i.id).map((d) => ({ toObjectId: d.id })) }))
        .filter((r) => r.to.length);
      return { status: 200, headers: {}, body: { results: results } };
    }
    if (p === '/crm/v3/objects/deals/batch/read') {
      const results = req.body.inputs
        .map((i) => snapshot.deals.find((d) => d.id === i.id))
        .filter(Boolean)
        .map((d) => ({ id: d.id, properties: { dealstage: d.dealstage } }));
      return { status: 200, headers: {}, body: { results: results } };
    }
    return { status: 404, headers: {}, body: { message: 'not found' } };
  }
  return { request: request, calls: calls };
}

function liveConfig(extra) {
  return core.buildConfig(Object.assign({ SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, HUBSPOT_MIN_INTERVAL_MS: '0' }, extra || {}));
}

test('live client returns the same suppression decisions as the fixture lookup', async () => {
  const domains = ['acme-robotics.example', 'stellar-freight.example', 'brightwave-analytics.example', 'pioneer-grid.example', 'quietpeak-labs.example'];
  const fake = makeFakeHubSpot(SNAPSHOT, FAKE_TOKEN);
  const live = await hs.lookupSuppression({ config: liveConfig(), domains: domains, snapshot: null, request: fake.request, sleep: async () => {} });
  const fixture = hs.lookupFromSnapshot(domains, SNAPSHOT, { dncProperty: 'do_not_contact', closedLostStages: ['closedlost'] });
  assert.equal(live.source, 'live');
  assert.deepEqual(Object.keys(live.suppressed).sort(), Object.keys(fixture.suppressed).sort());
  Object.keys(fixture.suppressed).forEach((d) => assert.deepEqual(live.suppressed[d].reasons, fixture.suppressed[d].reasons, d));
  assert.deepEqual(live.failedDomains, []);
  assert.ok(fake.calls.every((c) => c.method === 'POST' && c.url.indexOf('https://api.hubapi.com/crm/') === 0));
});

test('live client batches domains and backs off on 429 using Retry-After', async () => {
  const sleeps = [];
  const fake = makeFakeHubSpot(SNAPSHOT, FAKE_TOKEN, (req, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: { message: 'slow down' } } : null));
  const res = await hs.lookupSuppression({
    config: liveConfig(),
    domains: ['stellar-freight.example'],
    snapshot: null,
    request: fake.request,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  assert.deepEqual(res.failedDomains, []);
  assert.ok(res.suppressed['stellar-freight.example']);
  assert.ok(sleeps.indexOf(2000) !== -1);
  const many = Array.from({ length: 120 }, (_, i) => 'zzz-test-' + i + '.example');
  const fake2 = makeFakeHubSpot(SNAPSHOT, FAKE_TOKEN);
  await hs.lookupSuppression({ config: liveConfig(), domains: many, snapshot: null, request: fake2.request, sleep: async () => {} });
  assert.equal(fake2.calls.filter((c) => c.url.endsWith('/companies/search')).length, 3);
});

test('live client fails closed with a redacted error when HubSpot rejects the token', async () => {
  const fake = makeFakeHubSpot(SNAPSHOT, 'a_different_token_value');
  const logs = [];
  const logger = core.createLogger({ secrets: [FAKE_TOKEN], sink: (l) => logs.push(l) });
  const res = await hs.lookupSuppression({
    config: liveConfig(),
    domains: ['acme-robotics.example', 'northstar-logistics.example'],
    snapshot: null,
    request: fake.request,
    sleep: async () => {},
    logger: logger
  });
  assert.deepEqual(res.failedDomains, ['acme-robotics.example', 'northstar-logistics.example']);
  assert.deepEqual(res.suppressed['acme-robotics.example'].reasons, ['hubspot_lookup_failed']);
  const dump = JSON.stringify(res) + logs.join('\n');
  assert.ok(!dump.includes(FAKE_TOKEN));
  assert.ok(!/Bearer\s+(?!\[REDACTED\])\S{8,}/.test(dump));
});

test('live client gives up after the retry budget and quarantines instead of passing prospects through', async () => {
  const fake = makeFakeHubSpot(SNAPSHOT, FAKE_TOKEN, () => ({ status: 503, headers: {}, body: { message: 'unavailable' } }));
  const res = await hs.lookupSuppression({ config: liveConfig({ HUBSPOT_MAX_RETRIES: '2' }), domains: ['acme-robotics.example'], snapshot: null, request: fake.request, sleep: async () => {} });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(res.failedDomains, ['acme-robotics.example']);
});

test('sandbox mode never touches the network and requires a snapshot', async () => {
  let calls = 0;
  const res = await hs.lookupSuppression({ config: core.buildConfig({}), domains: ['stellar-freight.example'], snapshot: SNAPSHOT, request: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(res.source, 'fixture');
  await assert.rejects(hs.lookupSuppression({ config: core.buildConfig({}), domains: ['x.example'], snapshot: null }), core.ConfigError);
});

// ---------------------------------------------------------------------------
// Dedupe and cap
// ---------------------------------------------------------------------------

test('dedupe by LinkedIn URL, email, and name plus root domain, keeping the most complete record', () => {
  const li = san.normalizeLinkedInUrl('linkedin.com/in/zzz-test-dana').key;
  const records = [
    rec({ source_row: 1, record_id: 'a', first_name: 'Dana', last_name: 'Whitfield', linkedin_key: li, linkedin_url: 'u' }),
    rec({ source_row: 2, record_id: 'b', first_name: 'Dana', last_name: 'W.', linkedin_key: li, linkedin_url: 'u', email: 'dana@acme-robotics.example' }),
    rec({ source_row: 3, record_id: 'c', first_name: 'Sam', last_name: 'Okafor', email: 'sam@acme-robotics.example' }),
    rec({ source_row: 4, record_id: 'd', first_name: 'Samuel', last_name: 'Okafor', email: 'sam@acme-robotics.example' }),
    rec({ source_row: 5, record_id: 'e', first_name: 'Jos\u00E9', last_name: 'Garc\u00EDa' }),
    rec({ source_row: 6, record_id: 'f', first_name: 'Jose', last_name: 'Garcia', email: 'jose@acme-robotics.example' }),
    rec({ source_row: 7, record_id: 'g', first_name: 'Jose', last_name: 'Garcia', domain: 'other-company.example' })
  ];
  const r = san.dedupeRecords(records);
  assert.deepEqual(r.kept.map((x) => x.record_id), ['b', 'c', 'f', 'g']);
  const reason = {};
  r.dropped.forEach((d) => {
    reason[d.record_id] = d.drop_reason;
  });
  assert.deepEqual(reason, { a: 'duplicate_linkedin_url', d: 'duplicate_email', e: 'duplicate_name_domain' });
});

test('dedupe links records transitively', () => {
  const records = [
    rec({ source_row: 1, record_id: 'a', first_name: 'Lee', last_name: 'Park', linkedin_key: 'in:zzz-test-lee', linkedin_url: 'u' }),
    rec({ source_row: 2, record_id: 'b', first_name: 'Leigh', last_name: 'Park', linkedin_key: 'in:zzz-test-lee', linkedin_url: 'u', email: 'lee@acme-robotics.example' }),
    rec({ source_row: 3, record_id: 'c', first_name: 'L', last_name: 'Park', email: 'lee@acme-robotics.example' })
  ];
  const r = san.dedupeRecords(records);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].record_id, 'b');
  assert.equal(r.dropped.length, 2);
});

test('per-account cap keeps the most senior contacts and quarantines overflow with a reason', () => {
  const records = [
    rec({ source_row: 1, record_id: 'ic', seniority: 'ic', seniority_score: 20 }),
    rec({ source_row: 2, record_id: 'mgr', seniority: 'manager', seniority_score: 40 }),
    rec({ source_row: 3, record_id: 'cro', seniority: 'c_level', seniority_score: 100 }),
    rec({ source_row: 4, record_id: 'vp', seniority: 'vp', seniority_score: 80 }),
    rec({ source_row: 5, record_id: 'dir-no-email', seniority_score: 60 }),
    rec({ source_row: 6, record_id: 'dir-email', seniority_score: 60, email: 'x@acme-robotics.example' }),
    rec({ source_row: 7, record_id: 'other', domain: 'northstar-logistics.example', seniority_score: 20 })
  ];
  const r = san.capPerAccount(records, 3);
  assert.deepEqual(r.kept.map((x) => x.record_id), ['cro', 'vp', 'dir-email', 'other']);
  assert.deepEqual(r.kept.filter((x) => x.domain === 'acme-robotics.example').map((x) => x.account_rank).sort(), [1, 2, 3]);
  assert.deepEqual(r.dropped.map((x) => x.record_id), ['ic', 'mgr', 'dir-no-email']);
  assert.ok(r.dropped.every((d) => d.drop_reason === 'account_cap_exceeded'));
  assert.equal(r.dropped.find((d) => d.record_id === 'ic').drop_detail, 'rank 6 of 6 (cap 3)');
  assert.equal(san.capPerAccount(records, 1).kept.filter((x) => x.domain === 'acme-robotics.example').length, 1);
});

// ---------------------------------------------------------------------------
// Redaction and configuration
// ---------------------------------------------------------------------------

test('redact masks bearer tokens, private app keys, sk- keys, emails, and literal secrets', () => {
  const text = redactAll();
  assert.ok(!text.includes(FAKE_TOKEN));
  assert.ok(!text.includes(FAKE_PAT));
  assert.ok(!text.includes(FAKE_SK));
  assert.ok(!text.includes('alex.rivera@acme-robotics.example'));
  assert.ok(text.includes('Bearer [REDACTED]'));
  assert.ok(text.includes('[REDACTED_EMAIL]'));
  assert.ok(core.redact(new Error('token ' + FAKE_TOKEN + ' failed'), [FAKE_TOKEN]).indexOf(FAKE_TOKEN) === -1);
  assert.ok(core.redact({ headers: { a: FAKE_BEARER } }).indexOf(FAKE_TOKEN) === -1);
});

function redactAll() {
  return core.redact(['Authorization: ' + FAKE_BEARER, 'key ' + FAKE_PAT, 'other ' + FAKE_SK, 'mail alex.rivera@acme-robotics.example'].join('\n'));
}

test('logger redacts every line', () => {
  const lines = [];
  const log = core.createLogger({ sink: (l) => lines.push(l), secrets: ['plain_secret_value'] });
  log.info('sent to alex.rivera@acme-robotics.example with plain_secret_value');
  log.debug('hidden at info level');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].indexOf('plain_secret_value') === -1 && lines[0].indexOf('alex.rivera') === -1);
});

test('config defaults are safe and garbage values keep the safe defaults', () => {
  const c = core.buildConfig({});
  assert.equal(c.dryRun, true);
  assert.equal(c.sandbox, true);
  assert.equal(c.maxContactsPerAccount, 3);
  assert.equal(core.buildConfig({ DRY_RUN: 'maybe', SANDBOX_MODE: 'perhaps' }).dryRun, true);
  assert.equal(core.buildConfig({ DRY_RUN: 'maybe', SANDBOX_MODE: 'perhaps' }).sandbox, true);
  assert.equal(core.buildConfig({ MAX_CONTACTS_PER_ACCOUNT: '0' }).maxContactsPerAccount, 1);
  assert.equal(core.buildConfig({ MAX_CONTACTS_PER_ACCOUNT: '5' }).maxContactsPerAccount, 5);
});

test('SANDBOX_MODE=false needs a real token; the placeholder does not count', () => {
  assert.ok(core.buildConfig({ SANDBOX_MODE: 'false' }).errors.length > 0);
  assert.ok(core.buildConfig({ SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: core.PLACEHOLDER_TOKEN }).errors.length > 0);
  assert.equal(core.buildConfig({ SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN }).errors.length, 0);
  assert.ok(core.buildConfig({ HUBSPOT_BASE_URL: 'http://insecure.example' }).errors.length > 0);
});

test('publicConfig never exposes the token', () => {
  const pub = core.publicConfig(core.buildConfig({ SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN }));
  assert.ok(!JSON.stringify(pub).includes(FAKE_TOKEN));
  assert.equal(pub.hubspot.hasToken, true);
});

test('.env.example parses and ships safe defaults', () => {
  const env = core.parseEnvFile(readText('.env.example'));
  assert.equal(env.DRY_RUN, 'true');
  assert.equal(env.SANDBOX_MODE, 'true');
  assert.equal(env.MAX_CONTACTS_PER_ACCOUNT, '3');
  assert.equal(env.HUBSPOT_ACCESS_TOKEN, core.PLACEHOLDER_TOKEN);
  assert.equal(core.buildConfig(env).errors.length, 0);
});

// ---------------------------------------------------------------------------
// End to end fixture scenario
// ---------------------------------------------------------------------------

test('end to end: sample export produces the expected ready list and quarantine reasons', async () => {
  const result = await runSample({ CAMPAIGN_TAG: 'zzz_TEST_CAMP_01' });
  const ready = core.parseCsv(result.files['sequencer_ready.csv']).rows;
  assert.deepEqual(ready.map((r) => r.record_id), ['zzz_TEST_001', 'zzz_TEST_002', 'zzz_TEST_003', 'zzz_TEST_007', 'zzz_TEST_009', 'zzz_TEST_013']);
  assert.deepEqual(ready.map((r) => r.title), ['Chief Revenue Officer', 'VP of Sales', 'Director, Demand Generation', 'Head of Growth', 'Director of Marketing', 'Head of Sales']);
  assert.ok(ready.every((r) => r.campaign_tag === 'zzz_TEST_CAMP_01'));
  assert.deepEqual(ready.filter((r) => r.domain === 'acme-robotics.example').map((r) => r.seniority), ['c_level', 'vp', 'director']);

  const quarantine = core.parseCsv(result.files['quarantine_dropped.csv']).rows;
  const byId = {};
  quarantine.forEach((q) => {
    byId[q.record_id] = q.drop_reason;
  });
  assert.deepEqual(byId, {
    zzz_TEST_004: 'account_cap_exceeded',
    zzz_TEST_005: 'account_cap_exceeded',
    zzz_TEST_006: 'duplicate_linkedin_url',
    zzz_TEST_008: 'duplicate_email',
    zzz_TEST_010: 'hubspot_customer',
    zzz_TEST_011: 'hubspot_open_deal',
    zzz_TEST_012: 'static_suppression_list',
    zzz_TEST_014: 'freemail_or_social_domain',
    zzz_TEST_015: 'geography_not_allowed'
  });

  const s = result.summary;
  assert.deepEqual(s.counts, {
    input_rows: 15,
    sequencer_ready: 6,
    quarantined: 9,
    unique_accounts_ready: 3,
    hubspot_domains_checked: 5,
    hubspot_lookup_failures: 0,
    invalid_emails_cleared: 0
  });
  assert.equal(s.mode.dry_run, true);
  assert.equal(s.mode.sandbox, true);
  assert.equal(s.mode.hubspot_source, 'fixture');
  assert.equal(JSON.parse(result.files['run_summary.json']).counts.sequencer_ready, 6);
});

test('end to end: every reason code in the output is documented in REASON_CODES', async () => {
  const result = await runSample();
  Object.keys(result.summary.dropped_by_reason).forEach((code) => assert.ok(san.REASON_CODES.indexOf(code) !== -1, code));
});

test('end to end: cap of 1 and REQUIRE_EMAIL change the outcome as documented', async () => {
  const one = await runSample({ MAX_CONTACTS_PER_ACCOUNT: '1' });
  assert.equal(one.summary.counts.unique_accounts_ready, one.summary.counts.sequencer_ready);
  const needEmail = await runSample({ REQUIRE_EMAIL: 'true' });
  assert.ok((needEmail.summary.dropped_by_reason.missing_email || 0) >= 2);
  assert.ok(core.parseCsv(needEmail.files['sequencer_ready.csv']).rows.every((r) => r.email));
});

test('end to end: a failed HubSpot lookup quarantines the affected domains', async () => {
  const config = core.buildConfig({});
  const result = await san.runPipeline(SAMPLE_CSV, {
    config: core.publicConfig(config),
    rules: RULES,
    staticSuppression: STATIC_LIST,
    nowIso: '2026-01-01T00:00:00.000Z',
    lookup: async (domains) => ({
      source: 'live',
      checked: domains.length,
      failedDomains: domains,
      suppressed: domains.reduce((acc, d) => {
        acc[d] = { reasons: ['hubspot_lookup_failed'] };
        return acc;
      }, {})
    })
  });
  assert.equal(result.summary.counts.sequencer_ready, 0);
  assert.equal(result.summary.dropped_by_reason.hubspot_lookup_failed, 12);
  assert.equal(result.summary.dropped_by_reason.static_suppression_list, 1);
  assert.ok(result.summary.counts.hubspot_lookup_failures > 0);
});

test('CLI: DRY_RUN=true writes nothing, DRY_RUN=false writes the three output files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzz-test-sanitizer-'));
  try {
    const baseEnv = { PATH: process.env.PATH, OUTPUT_DIR: dir, SANDBOX_MODE: 'true' };
    const dry = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-local.js')], { env: Object.assign({}, baseEnv, { DRY_RUN: 'true' }), encoding: 'utf8', cwd: ROOT });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /no files written/);
    assert.deepEqual(fs.readdirSync(dir), []);
    const wet = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-local.js')], { env: Object.assign({}, baseEnv, { DRY_RUN: 'false' }), encoding: 'utf8', cwd: ROOT });
    assert.equal(wet.status, 0, wet.stderr);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['quarantine_dropped.csv', 'run_summary.json', 'sequencer_ready.csv']);
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-local.js')], { env: { PATH: process.env.PATH, SANDBOX_MODE: 'false' }, encoding: 'utf8', cwd: ROOT });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /HUBSPOT_ACCESS_TOKEN/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workflow.json
// ---------------------------------------------------------------------------

test('workflow parity: workflow.json matches the output of scripts/build-workflow.js', () => {
  assert.equal(readText('workflow.json'), render());
  assert.equal(render(), render());
});

test('workflow structure: required nodes, valid connections, no credentials or instance metadata', () => {
  const wf = readJson('workflow.json');
  const names = wf.nodes.map((n) => n.name);
  [NAMES.manual, NAMES.webhook, NAMES.load, NAMES.parse, NAMES.normalize, NAMES.icp, NAMES.sandboxLookup, NAMES.liveLookup, NAMES.dedupe, NAMES.split].forEach((n) => assert.ok(names.indexOf(n) !== -1, n));
  Object.keys(wf.connections).forEach((from) => {
    assert.ok(names.indexOf(from) !== -1, 'unknown source ' + from);
    wf.connections[from].main.forEach((branch) => branch.forEach((c) => assert.ok(names.indexOf(c.node) !== -1, 'unknown target ' + c.node)));
  });
  const raw = readText('workflow.json');
  assert.ok(raw.indexOf('"credentials"') === -1);
  assert.ok(raw.indexOf('instance' + 'Id') === -1);
  assert.ok(raw.indexOf('webhook' + 'Id') === -1);
  assert.equal(wf.active, false);
  wf.nodes.forEach((n) => assert.ok(!('credentials' in n) && !(('webhook' + 'Id') in n)));
  const ids = wf.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

async function runWorkflow(options) {
  const wf = readJson('workflow.json');
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let current = NAMES.load;
  let data = options.items;
  const visited = [];
  while (current) {
    const node = byName.get(current);
    visited.push(current);
    let outputIndex = 0;
    if (node.type === 'n8n-nodes-base.code') {
      const fn = new AsyncFunction('$env', '$input', 'require', 'Buffer', node.parameters.jsCode);
      data = await fn.call({ helpers: options.helpers }, options.env, { first: () => data[0], all: () => data }, require, Buffer);
    } else if (node.type === 'n8n-nodes-base.if') {
      outputIndex = data[0].json.config.sandbox ? 0 : 1;
    }
    const conn = wf.connections[current];
    current = conn && conn.main[outputIndex] && conn.main[outputIndex][0] ? conn.main[outputIndex][0].node : null;
  }
  return { items: data, visited: visited };
}

const stubHelpers = (extra) =>
  Object.assign(
    {
      prepareBinaryData: async (buf, fileName, mimeType) => ({ data: buf.toString('base64'), fileName: fileName, mimeType: mimeType })
    },
    extra || {}
  );

const decode = (item) => Buffer.from(item.binary.data.data, 'base64').toString('utf8');

test('workflow parity: sandbox branch outputs match the library pipeline', async () => {
  const env = { SANDBOX_MODE: 'true', DRY_RUN: 'true' };
  const run = await runWorkflow({ env: env, items: [{ json: {} }], helpers: stubHelpers() });
  assert.deepEqual(run.visited, [NAMES.load, NAMES.parse, NAMES.normalize, NAMES.icp, NAMES.sandbox, NAMES.sandboxLookup, NAMES.dedupe, NAMES.split]);
  const expected = await runSample(env);
  assert.equal(decode(run.items[0]), expected.files['sequencer_ready.csv']);
  assert.equal(decode(run.items[1]), expected.files['quarantine_dropped.csv']);
  const summary = JSON.parse(decode(run.items[2]));
  delete summary.generated_at;
  const expectedSummary = JSON.parse(expected.files['run_summary.json']);
  delete expectedSummary.generated_at;
  assert.deepEqual(summary, expectedSummary);
  assert.equal(run.items[0].json.rows, 6);
  assert.equal(run.items[1].json.rows, 9);
});

test('workflow parity: live branch (fake HubSpot) matches sandbox decisions and never leaks the token', async () => {
  const fake = makeFakeHubSpot(SNAPSHOT, FAKE_TOKEN);
  const env = { SANDBOX_MODE: 'false', DRY_RUN: 'true', HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, HUBSPOT_MIN_INTERVAL_MS: '0' };
  const helpers = stubHelpers({
    httpRequest: async (req) => {
      const res = await fake.request({ method: req.method, url: req.url, headers: req.headers, body: req.body });
      return { statusCode: res.status, headers: res.headers, body: res.body };
    }
  });
  const run = await runWorkflow({ env: env, items: [{ json: {} }], helpers: helpers });
  assert.ok(run.visited.indexOf(NAMES.liveLookup) !== -1);
  const expected = await runSample({});
  assert.equal(decode(run.items[0]), expected.files['sequencer_ready.csv']);
  assert.equal(decode(run.items[1]), expected.files['quarantine_dropped.csv']);
  const summary = JSON.parse(decode(run.items[2]));
  assert.equal(summary.mode.hubspot_source, 'live');
  assert.equal(summary.mode.sandbox, false);
  assert.ok(!JSON.stringify(run.items.map((i) => i.json)).includes(FAKE_TOKEN));
  assert.ok(fake.calls.length >= 3);
});

test('workflow webhook: requires a shared secret and a csv field', async () => {
  const base = { SANDBOX_MODE: 'true' };
  const call = (env, headers, body) => runWorkflow({ env: env, items: [{ json: { headers: headers, body: body } }], helpers: stubHelpers() });
  await assert.rejects(call(base, { 'x-webhook-secret': 'abc' }, { csv: SAMPLE_CSV }), /WEBHOOK_SHARED_SECRET/);
  const env = Object.assign({ WEBHOOK_SHARED_SECRET: 'zzz_TEST_shared_secret' }, base);
  await assert.rejects(call(env, { 'x-webhook-secret': 'wrong' }, { csv: SAMPLE_CSV }), /Unauthorized/);
  await assert.rejects(call(env, {}, { csv: SAMPLE_CSV }), /Unauthorized/);
  await assert.rejects(call(env, { 'x-webhook-secret': 'zzz_TEST_shared_secret' }, {}), /csv/);
  const ok = await call(env, { 'x-webhook-secret': 'zzz_TEST_shared_secret' }, { csv: SAMPLE_CSV });
  assert.equal(ok.items[0].json.rows, 6);
});

test('workflow config errors surface as node failures', async () => {
  await assert.rejects(runWorkflow({ env: { SANDBOX_MODE: 'false' }, items: [{ json: {} }], helpers: stubHelpers() }), /HUBSPOT_ACCESS_TOKEN/);
  await assert.rejects(runWorkflow({ env: { ICP_RULES_JSON: '{not json' }, items: [{ json: {} }], helpers: stubHelpers() }), /ICP_RULES_JSON/);
  await assert.rejects(runWorkflow({ env: { ICP_RULES_JSON: JSON.stringify({ titleInclude: ['(bad'] }) }, items: [{ json: {} }], helpers: stubHelpers() }), /Invalid ICP rules/);
});

// ---------------------------------------------------------------------------
// Repository hygiene
// ---------------------------------------------------------------------------

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

const ALLOWED_URL_HOSTS = new Set(['api.hubapi.com', 'docs.n8n.io']);
const LINKEDIN_PATH_OK = /^\/(?:(?:in|company|sales\/lead)\/(?:zzz[-_]test.*)?)?$/i;

test('hygiene: only synthetic data, no secrets, no instance metadata, no em-dashes', () => {
  const files = walk(ROOT, []).filter((f) => !/\.env$/.test(f) && path.basename(f) !== '.DS_Store');
  assert.ok(files.length >= 15);
  const emDash = String.fromCharCode(0x2014);
  files.forEach((f) => {
    const rel = path.relative(ROOT, f);
    const text = fs.readFileSync(f, 'utf8');

    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((m) => {
      assert.ok(/\.example$/i.test(m), rel + ' contains a non-example email: ' + m);
    });

    (text.match(/https?:\/\/[^\s"'`)<>\],\\]+/gi) || []).forEach((u) => {
      const rest = u.replace(/^https?:\/\//i, '');
      const host = rest.split(/[/:?#]/)[0].toLowerCase();
      const pathPart = '/' + rest.slice(host.length).replace(/^:\d+/, '').replace(/^\//, '').split(/[?#]/)[0];
      if (/(^|\.)linkedin\.com$/.test(host)) {
        assert.ok(LINKEDIN_PATH_OK.test(pathPart), rel + ' contains a LinkedIn URL that is not synthetic: ' + u);
      } else {
        assert.ok(/\.example$/.test(host) || ALLOWED_URL_HOSTS.has(host), rel + ' references an unexpected host: ' + host);
      }
    });

    (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).forEach((ip) => {
      assert.ok(/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip), rel + ' contains a non-documentation IP: ' + ip);
    });

    assert.ok(!/\bpat-[a-z]{2}\d-[A-Za-z0-9-]{8,}/.test(text), rel + ' contains a HubSpot private app key pattern');
    assert.ok(!/\bsk-[A-Za-z0-9_-]{16,}/.test(text), rel + ' contains an sk- key pattern');
    assert.ok(!/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/.test(text), rel + ' contains a bearer token');
    assert.ok(!/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text), rel + ' contains a JWT');
    assert.ok(!/\b[A-Fa-f0-9]{32,}\b/.test(text), rel + ' contains a long hex string');
    assert.ok(!/instance(?:Id)\b/.test(text) && !/webhook(?:Id)\b/.test(text), rel + ' contains n8n instance metadata');
    assert.ok(text.indexOf(emDash) === -1, rel + ' contains an em-dash');

    if (rel.indexOf('fixtures' + path.sep) === 0) {
      const withoutEmails = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ');
      (withoutEmails.match(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi) || []).forEach((d) => {
        assert.ok(/\.example$/i.test(d) || /(^|\.)linkedin\.com$/i.test(d), rel + ' contains a non-example domain: ' + d);
      });
    }
  });
});

test('hygiene: documentation avoids em-dashes and the banned words, and documents every reason code', () => {
  const banned = /\b(meticulous\w*|telemetry|firmographic\w*|corporate|critical\w*|guesswork|gauge\w*)\b/i;
  ['README.md', 'DISCLAIMER.md'].forEach((f) => {
    const text = readText(f);
    assert.ok(text.indexOf(String.fromCharCode(0x2014)) === -1, f + ' has an em-dash');
    assert.ok(!banned.test(text), f + ' contains a banned word: ' + (text.match(banned) || [])[0]);
  });
  const readme = readText('README.md');
  san.REASON_CODES.forEach((code) => assert.ok(readme.indexOf('`' + code + '`') !== -1, 'README is missing reason code ' + code));
  assert.ok(readme.indexOf('Disclaimer & Liability Limitation') !== -1);
  assert.ok(readme.trim().endsWith('MIT \u00A9 2026 dhRobin Systems \u00B7 Provided as-is, see the disclaimer.'));
  assert.ok(readme.lastIndexOf('## License') > readme.indexOf('Disclaimer & Liability Limitation'));
});

test('hygiene: package.json is zero-dependency and LICENSE is the exact MIT text', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.scripts['build:workflow'], 'node scripts/build-workflow.js');
  assert.ok(!pkg.dependencies && !pkg.devDependencies);
  assert.match(pkg.engines.node, />=20/);
  const license = readText('LICENSE');
  assert.ok(license.startsWith('MIT License\n\nCopyright (c) 2026 dhRobin Systems\n\nPermission is hereby granted'));
  assert.ok(license.trimEnd().endsWith('OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.'));
});

test('hygiene: .gitignore covers secrets and generated output', () => {
  const ignore = readText('.gitignore');
  ['.env', 'node_modules/', 'output/*.csv', '.DS_Store'].forEach((line) => assert.ok(ignore.split('\n').indexOf(line) !== -1, line));
});
