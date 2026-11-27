'use strict';

/*
 * HubSpot suppression lookups. Read-only: this module only calls search and batch-read endpoints.
 *
 * Required private app scopes: crm.objects.companies.read, crm.objects.deals.read
 *
 * - SANDBOX_MODE=true  : lookups are answered from a fixture snapshot, no network access.
 * - SANDBOX_MODE=false : lookups call the HubSpot API with rate-limit backoff.
 *
 * Fail closed: if a live lookup fails after retries, every domain in that batch is reported as
 * `hubspot_lookup_failed` so those prospects are quarantined instead of slipping through unchecked.
 *
 * The network is injected as `request({ method, url, headers, body }) -> { status, headers, body }`.
 */

const core = require('./core');
const sanitizer = require('./sanitizer');

const CUSTOMER_STAGES = new Set(['customer', 'evangelist']);
const TRUTHY = new Set(['true', 'yes', '1', 'y']);
const DOMAIN_CHUNK = 50;
const READ_CHUNK = 100;

class HubSpotError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubSpotError';
    this.status = status;
  }
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Decides whether a domain is suppressed.
 *   entries: [{ company: {lifecyclestage, <dnc property>}, deals: [{dealstage}] }]
 * Rules: lifecycle stage customer or evangelist; any deal whose stage is not a closed-lost stage
 * (so open and closed-won deals both suppress); DNC property set to a truthy value.
 */
function evaluateDomain(entries, options) {
  const closedLost = new Set((options.closedLostStages || ['closedlost']).map((s) => String(s).toLowerCase()));
  const dnc = options.dncProperty;
  const reasons = new Set();
  let openDeals = 0;
  const stages = [];
  entries.forEach((entry) => {
    const stage = String(entry.company.lifecyclestage || '').toLowerCase();
    if (stage) stages.push(stage);
    if (CUSTOMER_STAGES.has(stage)) reasons.add('hubspot_customer');
    entry.deals.forEach((deal) => {
      if (!closedLost.has(String(deal.dealstage || '').toLowerCase())) openDeals += 1;
    });
    if (dnc && TRUTHY.has(String(entry.company[dnc] === undefined || entry.company[dnc] === null ? '' : entry.company[dnc]).toLowerCase())) {
      reasons.add('hubspot_dnc_flag');
    }
  });
  if (openDeals > 0) reasons.add('hubspot_open_deal');
  return { reasons: Array.from(reasons).sort(), detail: { lifecyclestages: stages.sort(), non_closed_lost_deals: openDeals } };
}

// ---------------------------------------------------------------------------
// Sandbox: fixture snapshot
// ---------------------------------------------------------------------------

/*
 * snapshot: { companies: [{ id, domain, lifecyclestage, <dnc property> }], deals: [{ id, companyId, dealstage }] }
 */
function lookupFromSnapshot(domains, snapshot, options) {
  const opts = options || {};
  const companies = (snapshot && snapshot.companies) || [];
  const deals = (snapshot && snapshot.deals) || [];
  const dealsByCompany = {};
  deals.forEach((d) => {
    const key = String(d.companyId);
    (dealsByCompany[key] = dealsByCompany[key] || []).push(d);
  });
  const byDomain = {};
  companies.forEach((c) => {
    const d = sanitizer.normalizeDomain(c.domain).domain;
    if (!d) return;
    (byDomain[d] = byDomain[d] || []).push({ company: c, deals: dealsByCompany[String(c.id)] || [] });
  });
  const suppressed = {};
  domains.forEach((domain) => {
    if (!byDomain[domain]) return;
    const res = evaluateDomain(byDomain[domain], opts);
    if (res.reasons.length) suppressed[domain] = res;
  });
  return { suppressed: suppressed, source: 'fixture', failedDomains: [], checked: domains.length };
}

// ---------------------------------------------------------------------------
// Live API
// ---------------------------------------------------------------------------

function statusHint(status) {
  if (status === 401) return ' (check HUBSPOT_ACCESS_TOKEN)';
  if (status === 403) return ' (token is missing crm.objects.companies.read or crm.objects.deals.read)';
  if (status === 429) return ' (rate limited)';
  return '';
}

function createHubSpotClient(options) {
  const opts = options || {};
  const token = opts.token;
  if (!token) throw new core.ConfigError('HUBSPOT_ACCESS_TOKEN is required when SANDBOX_MODE=false');
  if (typeof opts.request !== 'function') throw new TypeError('createHubSpotClient needs a request function');
  const baseUrl = opts.baseUrl || core.DEFAULT_HUBSPOT_BASE_URL;
  const request = opts.request;
  const sleep = opts.sleep || defaultSleep;
  const maxRetries = opts.maxRetries === undefined ? 4 : opts.maxRetries;
  const minIntervalMs = opts.minIntervalMs === undefined ? 220 : opts.minIntervalMs;
  const logger = opts.logger;
  const evalOptions = { dncProperty: opts.dncProperty, closedLostStages: opts.closedLostStages };
  let lastCall = 0;

  const backoff = (attempt) => Math.min(8000, 500 * Math.pow(2, attempt));
  const retryDelay = (res, attempt) => {
    const header = res.headers && res.headers['retry-after'];
    const seconds = header === undefined ? NaN : Number(header);
    return Number.isFinite(seconds) ? Math.min(30000, Math.max(0, seconds * 1000)) : backoff(attempt);
  };

  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      let res;
      try {
        res = await request({
          method: method,
          url: baseUrl + path,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body
        });
      } catch (e) {
        if (attempt >= maxRetries) throw new HubSpotError(core.redact('Network error: ' + (e && e.message), [token]));
        await sleep(backoff(attempt));
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res.body || {};
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        if (logger) logger.warn('HubSpot returned ' + res.status + ', retrying (attempt ' + (attempt + 1) + ')');
        await sleep(retryDelay(res, attempt));
        continue;
      }
      const msg = res.body && typeof res.body.message === 'string' ? ': ' + res.body.message.slice(0, 200) : '';
      throw new HubSpotError(
        core.redact('HubSpot API ' + method + ' ' + path + ' failed with status ' + res.status + statusHint(res.status) + msg, [token]),
        res.status
      );
    }
  }

  async function findCompanies(domains) {
    const props = ['domain', 'name', 'lifecyclestage'];
    if (opts.dncProperty) props.push(opts.dncProperty);
    const found = [];
    let after;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'IN', values: domains }] }],
        properties: props,
        limit: 100
      };
      if (after) body.after = after;
      const res = await call('POST', '/crm/v3/objects/companies/search', body);
      (res.results || []).forEach((r) => found.push(r));
      after = res.paging && res.paging.next ? res.paging.next.after : undefined;
    } while (after);
    return found;
  }

  // Returns { "<companyId>": [{ dealstage }] }. Unknown deals count as not closed-lost (fail closed).
  async function fetchDeals(companyIds) {
    const dealIdsByCompany = {};
    for (const ids of chunks(companyIds, READ_CHUNK)) {
      const res = await call('POST', '/crm/v4/associations/companies/deals/batch/read', { inputs: ids.map((id) => ({ id: id })) });
      (res.results || []).forEach((r) => {
        if (r.paging && r.paging.next) throw new HubSpotError('Company has more associated deals than one page; refusing to guess');
        dealIdsByCompany[String(r.from.id)] = (r.to || []).map((t) => String(t.toObjectId));
      });
    }
    const allDealIds = Array.from(new Set([].concat(...Object.keys(dealIdsByCompany).map((k) => dealIdsByCompany[k]))));
    const stageById = {};
    for (const ids of chunks(allDealIds, READ_CHUNK)) {
      const res = await call('POST', '/crm/v3/objects/deals/batch/read', {
        properties: ['dealstage'],
        inputs: ids.map((id) => ({ id: id }))
      });
      (res.results || []).forEach((d) => {
        stageById[String(d.id)] = (d.properties && d.properties.dealstage) || '';
      });
    }
    const out = {};
    Object.keys(dealIdsByCompany).forEach((cid) => {
      out[cid] = dealIdsByCompany[cid].map((did) => ({ dealstage: stageById[did] === undefined ? '' : stageById[did] }));
    });
    return out;
  }

  async function lookupDomains(domains) {
    const suppressed = {};
    const failed = [];
    for (const chunk of chunks(domains, DOMAIN_CHUNK)) {
      try {
        const companies = await findCompanies(chunk);
        const dealsByCompany = companies.length ? await fetchDeals(companies.map((c) => String(c.id))) : {};
        const byDomain = {};
        companies.forEach((c) => {
          const props = c.properties || {};
          const d = sanitizer.normalizeDomain(props.domain).domain;
          if (!d || chunk.indexOf(d) === -1) return;
          (byDomain[d] = byDomain[d] || []).push({ company: props, deals: dealsByCompany[String(c.id)] || [] });
        });
        Object.keys(byDomain).forEach((d) => {
          const res = evaluateDomain(byDomain[d], evalOptions);
          if (res.reasons.length) suppressed[d] = res;
        });
      } catch (e) {
        if (logger) logger.error('HubSpot lookup failed for a batch of ' + chunk.length + ' domains:', core.redact(e, [token]));
        chunk.forEach((d) => {
          failed.push(d);
          suppressed[d] = { reasons: ['hubspot_lookup_failed'], detail: { error: core.redact(e, [token]).slice(0, 200) } };
        });
      }
    }
    return { suppressed: suppressed, source: 'live', failedDomains: failed.sort(), checked: domains.length };
  }

  return { lookupDomains: lookupDomains };
}

/*
 * Entry point used by the CLI and the workflow.
 *   opts: { config, domains, snapshot, request, sleep, logger }
 * `config` is the full config (with token) for live lookups, or any config with sandbox=true.
 */
async function lookupSuppression(opts) {
  const config = opts.config;
  const hs = config.hubspot || {};
  const domains = opts.domains || [];
  const evalOptions = { dncProperty: hs.dncProperty, closedLostStages: hs.closedLostStages };
  if (config.sandbox) {
    if (!opts.snapshot) throw new core.ConfigError('SANDBOX_MODE=true needs a HubSpot snapshot fixture');
    return lookupFromSnapshot(domains, opts.snapshot, evalOptions);
  }
  if (!domains.length) return { suppressed: {}, source: 'live', failedDomains: [], checked: 0 };
  const client = createHubSpotClient({
    token: hs.token,
    baseUrl: hs.baseUrl,
    request: opts.request,
    sleep: opts.sleep,
    maxRetries: hs.maxRetries,
    minIntervalMs: hs.minIntervalMs,
    dncProperty: hs.dncProperty,
    closedLostStages: hs.closedLostStages,
    logger: opts.logger
  });
  return client.lookupDomains(domains);
}

// Adapts the global fetch (Node 20+) to the injected request contract. CLI use only.
function createFetchRequest(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 30000;
  return async function request(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (e) {
        body = null;
      }
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: res.status, headers: headers, body: body };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  HubSpotError,
  evaluateDomain,
  lookupFromSnapshot,
  createHubSpotClient,
  lookupSuppression,
  createFetchRequest
};
