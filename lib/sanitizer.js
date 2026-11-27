'use strict';

/*
 * Sales Navigator CSV sanitizer engine.
 *
 * Pure functions only. HubSpot lookups are injected by the caller (see lib/hubspot.js),
 * so the same stage functions run in the CLI, in the tests, and inside the n8n Code nodes.
 *
 * Pipeline: parse -> normalize -> ICP filter -> suppression -> dedupe -> per-account cap -> outputs
 */

const core = require('./core');

const MAX_FIELD_LENGTH = 300;
const LEVELS = ['c_level', 'vp', 'director', 'manager'];
const DEFAULT_WEIGHTS = { c_level: 100, vp: 80, director: 60, manager: 40, ic: 20 };
const DEFAULT_SENIORITY_PATTERNS = {
  c_level: '\\b(chief|ceo|cfo|coo|cto|cmo|cro|cio|cpo|cso|founder|co-?founder|managing director|managing partner)\\b|(?<!product[ -])\\bowner\\b|(?<!vice[ -])\\bpresident\\b',
  vp: '\\b(vice[ -]president|vp|svp|evp|avp)\\b',
  director: '\\b(director|head)\\b',
  manager: '\\b(manager|lead|supervisor)\\b'
};

const REASON_CODES = [
  'missing_name',
  'missing_domain',
  'invalid_domain',
  'freemail_or_social_domain',
  'missing_email',
  'missing_title',
  'title_excluded',
  'title_not_icp',
  'geography_missing',
  'geography_not_allowed',
  'static_suppression_list',
  'hubspot_dnc_flag',
  'hubspot_customer',
  'hubspot_open_deal',
  'hubspot_lookup_failed',
  'duplicate_linkedin_url',
  'duplicate_email',
  'duplicate_name_domain',
  'account_cap_exceeded'
];

// Highest priority first. Used to pick the single drop_reason when several suppression reasons apply.
const SUPPRESSION_PRIORITY = [
  'static_suppression_list',
  'hubspot_dnc_flag',
  'hubspot_customer',
  'hubspot_open_deal',
  'hubspot_lookup_failed'
];

const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'org.nz',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'co.in', 'net.in', 'org.in',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.sg', 'com.my',
  'com.hk', 'com.tw', 'com.cn', 'com.ph', 'com.sa', 'com.eg', 'co.za',
  'co.il', 'co.id', 'co.th', 'com.ua', 'com.vn', 'com.pk', 'com.ng', 'co.ke'
]);

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

function collapse(s) {
  return String(s).normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
}

function limit(s) {
  return String(s).slice(0, MAX_FIELD_LENGTH);
}

// Removes Unicode emoji, flags, keycaps, variation selectors, and zero-width characters.
function stripEmoji(input) {
  const s = input === undefined || input === null ? '' : String(input);
  return collapse(s.replace(EMOJI_RE, ' '));
}

const CREDENTIAL_TOKENS = new Set([
  'mba', 'pmp', 'cpa', 'cfa', 'phd', 'ph.d', 'msc', 'ms', 'bsc', 'bs', 'ma', 'ba', 'jd', 'md',
  'csm', 'cspo', 'sphr', 'cissp', 'cism', 'peng', 'p.eng', 'itil', 'frm', 'cma', 'cia', 'lssbb',
  'lssgb', 'esq', 'pmi-acp', 'cmp', 'cscp'
]);
const SAFE_NAME_CREDENTIALS = new Set(['mba', 'pmp', 'cpa', 'cfa', 'phd', 'esq', 'cissp', 'csm']);

const NOISE_START_RE = /^(?:helping|helps|help|i help|i'm|i am|we help|driving|building|scaling|passionate|empowering|transforming|enabling|ex[- ]|former(?:ly)?\b|previously|speaker|keynote|author|podcast|host\b|advisor|adviser|investor|mentor|coach|open to|hiring|we're hiring|top \d+|#\d+|forbes|inc\.? 5000|award|winner|best-?selling|thought leader|linkedin top voice|top voice|ted\b)/i;
const NOISE_ANY_RE = /\bhelping\b|\bhelps\b|\bi help\b/i;

function isNoiseSegment(segment) {
  const seg = String(segment).trim();
  if (!seg) return true;
  const tokens = seg.split(/[\s/&+]+/).filter(Boolean);
  if (tokens.length && tokens.every((t) => CREDENTIAL_TOKENS.has(t.replace(/[.,]/g, '').toLowerCase()))) return true;
  if (NOISE_START_RE.test(seg) || NOISE_ANY_RE.test(seg)) return true;
  return seg.split(/\s+/).length >= 6;
}

const PRONOUN_RE = /\(\s*(?:he|she|they|him|her|them|xe|ze)\s*\/\s*[a-z]+(?:\s*\/\s*[a-z]+)?\s*\)/gi;

/*
 * Cleans a LinkedIn headline into a job title.
 *   "VP of Sales | Helping B2B Scale 🚀"        -> "VP of Sales"
 *   "Director, Demand Generation, MBA, PMP"      -> "Director, Demand Generation"
 *   "Director of Marketing / Advisor / Speaker"  -> "Director of Marketing"
 * Commas and slashes are only cut when what follows is a credential or accolade, so
 * titles such as "Director, Demand Generation" or "Sales / Marketing Lead" survive.
 */
function cleanTitle(raw, company) {
  let t = limit(stripEmoji(raw));
  if (!t) return '';
  t = t.replace(PRONOUN_RE, ' ');
  const hard = t.split(/\s*(?:[|\u2022\u00B7\u25CF\u25AA~]+)\s*/).map((s) => s.trim()).filter(Boolean);
  t = hard.length ? hard[0] : '';
  t = t.replace(/\(([^)]*)\)/g, (m, inner) => (isNoiseSegment(inner) ? ' ' : m));
  t = collapse(t);

  const parts = t.split(/(\s+[-\u2013\u2014]\s+|\s*\/\s*|\s*,\s*)/);
  let result = parts[0];
  const companyLower = String(company || '').toLowerCase();
  for (let i = 1; i < parts.length; i += 2) {
    const delim = parts[i];
    const seg = parts[i + 1] === undefined ? '' : parts[i + 1];
    const isDash = /[-\u2013\u2014]/.test(delim) && !/[,/]/.test(delim);
    const matchesCompany = isDash && companyLower && seg.toLowerCase().indexOf(companyLower) !== -1;
    if (isNoiseSegment(seg) || matchesCompany) break;
    result += delim + seg;
  }
  t = result.replace(/\s+(?:at|@)\s+\S.*$/i, '');
  t = t.replace(/^[\s\-\u2013\u2014,;:|/&]+|[\s\-\u2013\u2014,;:|/&]+$/g, '');
  return collapse(t);
}

const LEGAL_SUFFIX_RE = /[\s,]+(?:inc\.?|incorporated|llc|l\.l\.c\.?|ltd\.?|limited|gmbh|corp\.?|corporation|co\.|plc|llp|lp|ag|sa|s\.a\.|b\.v\.|bv|pty|pvt|sas|oy|ab|s\.r\.l\.|srl)\.?\s*$/i;

// Strips emoji, parentheticals, and legal entity suffixes (Inc., LLC, Ltd., GmbH, Corp., ...).
function cleanCompanyName(raw) {
  let c = limit(stripEmoji(raw));
  c = collapse(c.replace(/\([^)]*\)/g, ' '));
  let prev;
  do {
    prev = c;
    c = c.replace(LEGAL_SUFFIX_RE, '').trim();
  } while (c !== prev);
  return c.replace(/^[\s,.\-|]+|[\s,.\-|]+$/g, '');
}

function titleCaseName(n) {
  return n
    .split(' ')
    .map((word) => word.replace(/[^\-'\u2019]+/g, (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join(' ');
}

function cleanPersonName(raw) {
  let n = limit(stripEmoji(raw));
  n = n.replace(/\([^)]*\)/g, ' ');
  n = n.split(',')[0];
  n = n.replace(/[^\p{L}\p{M}\s'\u2019.\-]/gu, ' ');
  n = collapse(n);
  const tokens = n.split(' ');
  while (tokens.length > 1 && SAFE_NAME_CREDENTIALS.has(tokens[tokens.length - 1].replace(/\./g, '').toLowerCase())) tokens.pop();
  n = tokens.join(' ').replace(/^[\s.\-']+|[\s\-']+$/g, '');
  if (n && (n === n.toUpperCase() || n === n.toLowerCase())) n = titleCaseName(n);
  return n;
}

function normalizeEmail(raw) {
  let e = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  e = e.replace(/^mailto:/, '').replace(/[<>]/g, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '';
  const domain = e.slice(e.lastIndexOf('@') + 1);
  return /^[a-z0-9.-]+$/.test(domain) ? e : '';
}

function normalizeLinkedInUrl(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return { url: '', key: '' };
  const profile = /linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i.exec(s);
  if (profile) {
    let slug = profile[1];
    try {
      slug = decodeURIComponent(slug);
    } catch (e) {
      // keep the raw slug
    }
    slug = slug.toLowerCase();
    return { url: 'https://www.linkedin.com/in/' + slug, key: 'in:' + slug };
  }
  const sales = /linkedin\.com\/sales\/(?:lead|people)\/([^/?#\s,]+)/i.exec(s);
  if (sales) {
    return { url: 'https://www.linkedin.com/sales/lead/' + sales[1], key: 'sales:' + sales[1].toLowerCase() };
  }
  return { url: '', key: '' };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function rootDomain(host) {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/*
 * Normalizes a website or email address to a clean root domain.
 * Returns { domain, reason }. `reason` is '' on success, otherwise one of
 * missing_domain, invalid_domain, freemail_or_social_domain.
 */
function normalizeDomain(input, options) {
  const blocklist = options && options.blocklist;
  let s = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
  if (!s || /^(?:n\/a|na|none|null|unknown|-+|\.)$/.test(s)) return { domain: '', reason: 'missing_domain' };
  s = s.replace(/^mailto:/, '');
  let host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  host = host.split(/[/?#]/)[0];
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  host = host.replace(/:\d+$/, '').replace(/\.+$/, '').replace(/^(?:www\d?\.)+/, '');
  if (!HOSTNAME_RE.test(host)) return { domain: '', reason: 'invalid_domain' };
  const root = rootDomain(host);
  if (blocklist && (blocklist.has(root) || blocklist.has(host))) return { domain: root, reason: 'freemail_or_social_domain' };
  return { domain: root, reason: '' };
}

// ---------------------------------------------------------------------------
// ICP rules
// ---------------------------------------------------------------------------

const GEO_ALIASES = {
  'usa': 'united states', 'us': 'united states', 'u.s.': 'united states', 'u.s.a.': 'united states',
  'united states of america': 'united states', 'uk': 'united kingdom', 'u.k.': 'united kingdom',
  'great britain': 'united kingdom', 'gb': 'united kingdom', 'england': 'united kingdom',
  'scotland': 'united kingdom', 'wales': 'united kingdom', 'northern ireland': 'united kingdom',
  'deutschland': 'germany', 'uae': 'united arab emirates', 'holland': 'netherlands'
};

function geoTerms(geo) {
  const terms = new Set();
  String(geo).toLowerCase().split(/[,;|/]/).forEach((p) => {
    let part = p.trim().replace(/\s+(?:metropolitan\s+)?area$/, '').replace(/^greater\s+/, '').trim();
    if (!part) return;
    terms.add(part);
    if (GEO_ALIASES[part]) terms.add(GEO_ALIASES[part]);
  });
  return terms;
}

function compileRules(raw) {
  const rules = raw || {};
  const errors = [];
  function compileList(list, name) {
    return (Array.isArray(list) ? list : [])
      .map((p, i) => {
        try {
          return new RegExp(String(p), 'i');
        } catch (e) {
          errors.push(name + '[' + i + '] is not a valid regular expression');
          return null;
        }
      })
      .filter(Boolean);
  }
  const titleInclude = compileList(rules.titleInclude, 'titleInclude');
  const titleExclude = compileList(rules.titleExclude, 'titleExclude');
  const weights = Object.assign({}, DEFAULT_WEIGHTS, rules.seniorityWeights || {});
  const patterns = Object.assign({}, DEFAULT_SENIORITY_PATTERNS, rules.seniorityPatterns || {});
  const seniority = LEVELS.map((level) => {
    try {
      return { level: level, score: Number(weights[level]), re: new RegExp(patterns[level], 'i') };
    } catch (e) {
      errors.push('seniorityPatterns.' + level + ' is not a valid regular expression');
      return null;
    }
  }).filter(Boolean);
  if (errors.length) throw new core.ConfigError('Invalid ICP rules: ' + errors.join('; '));
  if (!titleInclude.length) throw new core.ConfigError('Invalid ICP rules: titleInclude needs at least one pattern');
  const blocklist = new Set();
  []
    .concat(rules.freemailBlocklist || [], rules.socialBlocklist || [])
    .forEach((d) => blocklist.add(String(d).trim().toLowerCase()));
  const allowedRegions = [];
  (rules.allowedRegions || []).forEach((r) => {
    const v = String(r).trim().toLowerCase();
    if (v) allowedRegions.push(GEO_ALIASES[v] || v);
  });
  return {
    titleInclude: titleInclude,
    titleExclude: titleExclude,
    seniority: seniority,
    icScore: Number(weights.ic),
    allowedRegions: allowedRegions,
    blocklist: blocklist
  };
}

function classifySeniority(title, compiled) {
  for (const entry of compiled.seniority) {
    if (entry.re.test(title)) return { level: entry.level, score: entry.score };
  }
  return { level: 'ic', score: compiled.icScore };
}

function geographyAllowed(geo, allowedRegions) {
  const terms = geoTerms(geo);
  return allowedRegions.some((a) => terms.has(a));
}

// ---------------------------------------------------------------------------
// CSV schema mapping
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  first_name: ['firstname', 'first', 'givenname'],
  last_name: ['lastname', 'last', 'surname', 'familyname'],
  full_name: ['name', 'fullname', 'contactname'],
  title: ['title', 'jobtitle', 'position', 'currentjobtitle'],
  company: ['company', 'companyname', 'account', 'accountname', 'organization', 'currentcompany'],
  website: ['companywebsite', 'website', 'companyurl', 'companydomain', 'domain', 'websiteurl'],
  linkedin_url: ['linkedinurl', 'linkedinprofileurl', 'profileurl', 'personlinkedinurl', 'salesnavigatorurl', 'linkedin', 'linkedinprofile'],
  email: ['email', 'emailaddress', 'workemail', 'businessemail'],
  geography: ['geography', 'location', 'region', 'country', 'geo'],
  industry: ['industry', 'companyindustry'],
  record_id: ['recordid', 'id', 'leadid']
};

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h) => {
    const norm = String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    Object.keys(HEADER_ALIASES).forEach((canon) => {
      if (map[canon] === undefined && HEADER_ALIASES[canon].indexOf(norm) !== -1) map[canon] = h;
    });
  });
  return map;
}

function pad(n) {
  return String(n).padStart(3, '0');
}

// Maps raw CSV rows (objects keyed by header) into the canonical input schema.
function toCanonicalRows(table) {
  const map = mapHeaders(table.headers);
  const hasName = map.first_name !== undefined || map.full_name !== undefined;
  const hasAccount = map.company !== undefined || map.website !== undefined || map.email !== undefined;
  if (!hasName || !hasAccount) {
    throw new core.CsvError(
      'CSV is missing required columns. Need a name column (First Name / Last Name) and at least one of ' +
        'Company, Company Website, or Email. Found headers: ' + table.headers.join(', ')
    );
  }
  const val = (row, key) => (map[key] === undefined ? '' : String(row[map[key]] === undefined ? '' : row[map[key]]));
  return table.rows.map((row, i) => {
    let first = val(row, 'first_name');
    let last = val(row, 'last_name');
    if (!first && !last && map.full_name !== undefined) {
      const full = val(row, 'full_name').trim();
      const space = full.indexOf(' ');
      first = space === -1 ? full : full.slice(0, space);
      last = space === -1 ? '' : full.slice(space + 1);
    }
    return {
      source_row: i + 1,
      record_id: val(row, 'record_id').trim() || 'row_' + pad(i + 1),
      first_name: first,
      last_name: last,
      title: val(row, 'title'),
      company: val(row, 'company'),
      website: val(row, 'website'),
      linkedin_url: val(row, 'linkedin_url'),
      email: val(row, 'email'),
      geography: val(row, 'geography'),
      industry: val(row, 'industry')
    };
  });
}

// ---------------------------------------------------------------------------
// Record-level stages
// ---------------------------------------------------------------------------

function drop(record, stage, reason, detail) {
  return Object.assign({}, record, { drop_stage: stage, drop_reason: reason, drop_detail: detail || '' });
}

function normalizeRecord(row, compiled, options) {
  const first = cleanPersonName(row.first_name);
  const last = cleanPersonName(row.last_name);
  const company = cleanCompanyName(row.company);
  const title = cleanTitle(row.title, company);
  const email = normalizeEmail(row.email);
  const emailCleared = Boolean(String(row.email || '').trim()) && !email;
  const li = normalizeLinkedInUrl(row.linkedin_url);

  const web = normalizeDomain(row.website, { blocklist: compiled.blocklist });
  const mail = email ? normalizeDomain(email, { blocklist: compiled.blocklist }) : { domain: '', reason: 'missing_domain' };
  let chosen;
  let source = '';
  if (!web.reason) {
    chosen = web;
    source = 'website';
  } else if (!mail.reason) {
    chosen = mail;
    source = 'email';
  } else {
    chosen = web.reason !== 'missing_domain' ? web : mail;
  }

  const seniority = classifySeniority(title, compiled);
  const record = {
    source_row: row.source_row,
    record_id: row.record_id,
    first_name: first,
    last_name: last,
    title: title,
    title_raw: limit(String(row.title || '')),
    company: company,
    company_raw: limit(String(row.company || '')),
    website_raw: limit(String(row.website || '')),
    domain: chosen.domain,
    domain_source: source,
    linkedin_url: li.url,
    linkedin_key: li.key,
    email: email,
    geography: collapse(stripEmoji(row.geography)),
    industry: collapse(stripEmoji(row.industry)),
    seniority: seniority.level,
    seniority_score: seniority.score
  };

  let dropInfo = null;
  if (!first || !last) dropInfo = ['missing_name', ''];
  else if (chosen.reason) dropInfo = [chosen.reason, chosen.domain ? 'domain=' + chosen.domain : ''];
  else if (options && options.requireEmail && !email) dropInfo = ['missing_email', ''];
  return { record: record, dropInfo: dropInfo, emailCleared: emailCleared };
}

function normalizeRecords(rows, compiled, options) {
  const records = [];
  const dropped = [];
  let invalidEmails = 0;
  rows.forEach((row) => {
    const res = normalizeRecord(row, compiled, options);
    if (res.emailCleared) invalidEmails += 1;
    if (res.dropInfo) dropped.push(drop(res.record, 'normalize', res.dropInfo[0], res.dropInfo[1]));
    else records.push(res.record);
  });
  return { records: records, dropped: dropped, stats: { invalid_emails_cleared: invalidEmails } };
}

function applyIcpFilter(records, compiled) {
  const kept = [];
  const dropped = [];
  records.forEach((r) => {
    if (!r.title) {
      dropped.push(drop(r, 'icp', 'missing_title'));
      return;
    }
    const excludeIdx = compiled.titleExclude.findIndex((re) => re.test(r.title));
    if (excludeIdx !== -1) {
      dropped.push(drop(r, 'icp', 'title_excluded', 'exclude rule #' + (excludeIdx + 1)));
      return;
    }
    if (!compiled.titleInclude.some((re) => re.test(r.title))) {
      dropped.push(drop(r, 'icp', 'title_not_icp'));
      return;
    }
    if (compiled.allowedRegions.length) {
      if (!r.geography) {
        dropped.push(drop(r, 'icp', 'geography_missing'));
        return;
      }
      if (!geographyAllowed(r.geography, compiled.allowedRegions)) {
        dropped.push(drop(r, 'icp', 'geography_not_allowed', 'geography=' + r.geography));
        return;
      }
    }
    kept.push(r);
  });
  return { kept: kept, dropped: dropped };
}

// suppressed: { "<domain>": { reasons: [...] } }. staticSet: Set of root domains.
function applySuppression(records, staticSet, suppressed) {
  const kept = [];
  const dropped = [];
  records.forEach((r) => {
    const reasons = [];
    if (staticSet.has(r.domain)) reasons.push('static_suppression_list');
    const hit = suppressed && suppressed[r.domain];
    if (hit && !staticSet.has(r.domain)) hit.reasons.forEach((x) => reasons.push(x));
    if (!reasons.length) {
      kept.push(r);
      return;
    }
    const primary = SUPPRESSION_PRIORITY.find((p) => reasons.indexOf(p) !== -1) || reasons[0];
    dropped.push(drop(r, 'suppression', primary, reasons.join(';')));
  });
  return { kept: kept, dropped: dropped };
}

function nameKey(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}]/gu, '');
}

function dedupeKeys(r) {
  const keys = [];
  if (r.linkedin_key) keys.push({ type: 'li', key: r.linkedin_key });
  if (r.email) keys.push({ type: 'em', key: r.email });
  const f = nameKey(r.first_name);
  const l = nameKey(r.last_name);
  if (f && l && r.domain) keys.push({ type: 'nm', key: f + '|' + l + '|' + r.domain });
  return keys;
}

const DUPE_REASON = { li: 'duplicate_linkedin_url', em: 'duplicate_email', nm: 'duplicate_name_domain' };

function completeness(r) {
  return (r.email ? 4 : 0) + (r.linkedin_url ? 2 : 0) + (r.title ? 1 : 0);
}

/*
 * Deduplicates by LinkedIn URL, email, and (first + last + root domain).
 * Records that share any key are grouped (transitively). The most complete record survives
 * (email, then LinkedIn URL, then title), ties go to the earliest row.
 */
function dedupeRecords(records) {
  const parent = records.map((_, i) => i);
  const find = (x) => {
    let n = x;
    while (parent[n] !== n) {
      parent[n] = parent[parent[n]];
      n = parent[n];
    }
    return n;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const keysOf = records.map(dedupeKeys);
  const owner = new Map();
  keysOf.forEach((keys, i) => {
    keys.forEach((k) => {
      const id = k.type + ':' + k.key;
      if (owner.has(id)) union(i, owner.get(id));
      else owner.set(id, i);
    });
  });
  const groups = new Map();
  records.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  const droppedAt = new Map();
  groups.forEach((members) => {
    if (members.length < 2) return;
    let survivor = members[0];
    members.forEach((i) => {
      if (completeness(records[i]) > completeness(records[survivor])) survivor = i;
    });
    const survivorKeys = new Set(keysOf[survivor].map((k) => k.type + ':' + k.key));
    members.forEach((i) => {
      if (i === survivor) return;
      let reason = null;
      for (const k of keysOf[i]) {
        if (survivorKeys.has(k.type + ':' + k.key)) {
          reason = DUPE_REASON[k.type];
          break;
        }
      }
      if (!reason) {
        const others = new Set();
        members.forEach((j) => {
          if (j !== i) keysOf[j].forEach((k) => others.add(k.type + ':' + k.key));
        });
        const shared = keysOf[i].find((k) => others.has(k.type + ':' + k.key));
        reason = shared ? DUPE_REASON[shared.type] : 'duplicate_name_domain';
      }
      droppedAt.set(i, drop(records[i], 'dedupe', reason, 'duplicate_of=' + records[survivor].record_id));
    });
  });
  const kept = [];
  const dropped = [];
  records.forEach((r, i) => {
    if (droppedAt.has(i)) dropped.push(droppedAt.get(i));
    else kept.push(r);
  });
  return { kept: kept, dropped: dropped };
}

function compareRank(a, b) {
  return (
    b.seniority_score - a.seniority_score ||
    (b.email ? 1 : 0) - (a.email ? 1 : 0) ||
    a.source_row - b.source_row
  );
}

// Keeps the top `max` contacts per root domain by seniority score. Overflow goes to quarantine.
function capPerAccount(records, max) {
  const byDomain = new Map();
  records.forEach((r) => {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain).push(r);
  });
  const kept = [];
  const dropped = [];
  byDomain.forEach((list) => {
    list
      .slice()
      .sort(compareRank)
      .forEach((r, idx) => {
        if (idx < max) kept.push(Object.assign({}, r, { account_rank: idx + 1 }));
        else dropped.push(drop(r, 'cap', 'account_cap_exceeded', 'rank ' + (idx + 1) + ' of ' + list.length + ' (cap ' + max + ')'));
      });
  });
  kept.sort((a, b) => a.source_row - b.source_row);
  dropped.sort((a, b) => a.source_row - b.source_row);
  return { kept: kept, dropped: dropped };
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const SEQUENCER_COLUMNS = [
  'record_id', 'first_name', 'last_name', 'email', 'title', 'company', 'domain',
  'linkedin_url', 'geography', 'industry', 'seniority', 'account_rank'
];
const QUARANTINE_COLUMNS = [
  'source_row', 'record_id', 'drop_stage', 'drop_reason', 'drop_detail', 'first_name', 'last_name',
  'email', 'title_raw', 'title', 'company_raw', 'company', 'website_raw', 'domain', 'linkedin_url',
  'geography', 'industry', 'seniority'
];

function countBy(items, field) {
  const out = {};
  items.forEach((i) => {
    out[i[field]] = (out[i[field]] || 0) + 1;
  });
  const sorted = {};
  Object.keys(out).sort().forEach((k) => {
    sorted[k] = out[k];
  });
  return sorted;
}

// ---------------------------------------------------------------------------
// Stages (state in, state out; the state is plain JSON so it can travel between n8n nodes)
// ---------------------------------------------------------------------------

function omit(obj, keys) {
  const out = Object.assign({}, obj);
  keys.forEach((k) => {
    delete out[k];
  });
  return out;
}

function stageParse(state) {
  const rows = toCanonicalRows(core.parseCsv(state.csvText));
  return Object.assign(omit(state, ['csvText']), {
    rows: rows,
    dropped: [],
    counts: { input_rows: rows.length },
    stats: {},
    meta: {}
  });
}

function stageNormalize(state) {
  const compiled = compileRules(state.rules);
  const res = normalizeRecords(state.rows, compiled, { requireEmail: state.config.requireEmail });
  return Object.assign(omit(state, ['rows']), {
    records: res.records,
    dropped: state.dropped.concat(res.dropped),
    stats: Object.assign({}, state.stats, res.stats)
  });
}

function stageIcp(state) {
  const res = applyIcpFilter(state.records, compileRules(state.rules));
  return Object.assign({}, state, { records: res.kept, dropped: state.dropped.concat(res.dropped) });
}

function normalizedStaticSet(list) {
  const set = new Set();
  (list || []).forEach((d) => {
    const n = normalizeDomain(d);
    if (!n.reason) set.add(n.domain);
  });
  return set;
}

// Domains to send to HubSpot: unique, sorted, and not already on the static suppression list.
function suppressionDomains(state) {
  const staticSet = normalizedStaticSet(state.staticSuppression);
  const seen = new Set();
  state.records.forEach((r) => {
    if (r.domain && !staticSet.has(r.domain)) seen.add(r.domain);
  });
  return Array.from(seen).sort();
}

// lookup: { suppressed, source, failedDomains, checked } from lib/hubspot.js
function stageSuppress(state, lookup) {
  const res = applySuppression(state.records, normalizedStaticSet(state.staticSuppression), lookup.suppressed);
  return Object.assign({}, state, {
    records: res.kept,
    dropped: state.dropped.concat(res.dropped),
    meta: {
      hubspot_source: lookup.source,
      hubspot_domains_checked: lookup.checked,
      hubspot_lookup_failures: lookup.failedDomains.length
    }
  });
}

function stageDedupeCap(state) {
  const d = dedupeRecords(state.records);
  const c = capPerAccount(d.kept, state.config.maxContactsPerAccount);
  return Object.assign({}, state, { records: c.kept, dropped: state.dropped.concat(d.dropped, c.dropped) });
}

function stageOutputs(state, nowIso) {
  const config = state.config;
  const sequencerColumns = SEQUENCER_COLUMNS.slice();
  const ready = state.records.map((r) => {
    const row = Object.assign({}, r);
    if (config.campaignTag) row.campaign_tag = config.campaignTag;
    return row;
  });
  if (config.campaignTag) sequencerColumns.push('campaign_tag');
  const quarantined = state.dropped.slice().sort((a, b) => a.source_row - b.source_row);
  const summary = {
    generated_at: nowIso,
    mode: {
      dry_run: config.dryRun,
      sandbox: config.sandbox,
      hubspot_source: (state.meta && state.meta.hubspot_source) || 'none'
    },
    settings: {
      max_contacts_per_account: config.maxContactsPerAccount,
      require_email: config.requireEmail
    },
    counts: {
      input_rows: state.counts.input_rows,
      sequencer_ready: ready.length,
      quarantined: quarantined.length,
      unique_accounts_ready: new Set(ready.map((r) => r.domain)).size,
      hubspot_domains_checked: (state.meta && state.meta.hubspot_domains_checked) || 0,
      hubspot_lookup_failures: (state.meta && state.meta.hubspot_lookup_failures) || 0,
      invalid_emails_cleared: (state.stats && state.stats.invalid_emails_cleared) || 0
    },
    dropped_by_reason: countBy(quarantined, 'drop_reason'),
    dropped_by_stage: countBy(quarantined, 'drop_stage')
  };
  return {
    summary: summary,
    files: {
      'sequencer_ready.csv': core.toCsv(sequencerColumns, ready),
      'quarantine_dropped.csv': core.toCsv(QUARANTINE_COLUMNS, quarantined),
      'run_summary.json': JSON.stringify(summary, null, 2) + '\n'
    },
    counts: { ready: ready.length, quarantined: quarantined.length }
  };
}

/*
 * Runs every stage in order. ctx: { config (public), rules, staticSuppression, lookup, nowIso }
 * `lookup(domains)` must resolve to { suppressed, source, failedDomains, checked }.
 */
async function runPipeline(csvText, ctx) {
  let state = {
    config: ctx.config,
    rules: ctx.rules,
    staticSuppression: ctx.staticSuppression || [],
    csvText: csvText
  };
  state = stageParse(state);
  state = stageNormalize(state);
  state = stageIcp(state);
  const lookup = await ctx.lookup(suppressionDomains(state));
  state = stageSuppress(state, lookup);
  state = stageDedupeCap(state);
  return Object.assign({ state: state }, stageOutputs(state, ctx.nowIso || new Date().toISOString()));
}

module.exports = {
  REASON_CODES,
  SUPPRESSION_PRIORITY,
  SEQUENCER_COLUMNS,
  QUARANTINE_COLUMNS,
  stripEmoji,
  cleanTitle,
  cleanCompanyName,
  cleanPersonName,
  normalizeEmail,
  normalizeLinkedInUrl,
  rootDomain,
  normalizeDomain,
  compileRules,
  classifySeniority,
  geographyAllowed,
  toCanonicalRows,
  normalizeRecord,
  normalizeRecords,
  applyIcpFilter,
  applySuppression,
  dedupeRecords,
  capPerAccount,
  stageParse,
  stageNormalize,
  stageIcp,
  suppressionDomains,
  stageSuppress,
  stageDedupeCap,
  stageOutputs,
  runPipeline
};
