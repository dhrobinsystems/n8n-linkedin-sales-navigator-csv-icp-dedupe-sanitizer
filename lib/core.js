'use strict';

/*
 * Config loading, redaction logging, and CSV parsing/serialization.
 *
 * No third-party dependencies. Node built-ins are required lazily, only inside the
 * helpers that touch the file system, so this module also runs inside an n8n Code node.
 */

const PLACEHOLDER_TOKEN = 'replace_with_your_hubspot_private_app_token';
const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

function parseList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  return String(value).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

// Unset or unparseable values fall back to the supplied default. Callers pass the SAFE default.
function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function toInt(value, fallback, min, max) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Constant-time string comparison for shared secrets.
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Redaction and logging
// ---------------------------------------------------------------------------

const REDACTIONS = [
  [/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]'],
  [/\bpat-[A-Za-z0-9]{2,6}-[A-Za-z0-9-]{8,}/g, '[REDACTED_PAT]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[REDACTED_EMAIL]']
];

/*
 * Masks bearer tokens, HubSpot private app keys, generic sk- keys, and email addresses.
 * Pass literal secrets (for example the configured token) in `secrets` to mask them as well.
 */
function redact(value, secrets) {
  let text;
  if (value instanceof Error) text = value.name + ': ' + value.message;
  else if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch (e) {
      text = String(value);
    }
  }
  if (typeof text !== 'string') text = '';
  (secrets || []).forEach((s) => {
    if (typeof s === 'string' && s.length >= 6) text = text.split(s).join('[REDACTED]');
  });
  REDACTIONS.forEach((pair) => {
    text = text.replace(pair[0], pair[1]);
  });
  return text;
}

function createLogger(options) {
  const opts = options || {};
  const secrets = opts.secrets || [];
  const sink = opts.sink || ((line) => process.stderr.write(line + '\n'));
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const threshold = order[opts.level || 'info'] || 20;
  function make(level) {
    return function () {
      if (order[level] < threshold) return;
      const text = Array.prototype.slice.call(arguments).map((a) => redact(a, secrets)).join(' ');
      sink('[' + level + '] ' + text);
    };
  }
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseEnvFile(text) {
  const out = {};
  String(text).split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;
    const eq = trimmed.indexOf('=');
    if (eq < 1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value.charAt(0);
      if ((q === '"' || q === "'") && value.charAt(value.length - 1) === q) value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

// Reads .env (if present) without overriding variables that are already set.
function loadEnv(options) {
  const opts = options || {};
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.resolve(opts.cwd || process.cwd(), opts.file || '.env');
  const merged = Object.assign({}, opts.env || process.env);
  if (fs.existsSync(file)) {
    const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
    Object.keys(parsed).forEach((k) => {
      if (merged[k] === undefined) merged[k] = parsed[k];
    });
  }
  return merged;
}

/*
 * Builds the run configuration from an environment object.
 * Safe defaults: DRY_RUN=true and SANDBOX_MODE=true. Any unset or unparseable value keeps them on.
 * The result holds the HubSpot token, so use publicConfig() before putting it in logs or n8n items.
 */
function buildConfig(env) {
  const e = env || {};
  const errors = [];
  const warnings = [];

  const sandbox = parseBool(e.SANDBOX_MODE, true);
  const dryRun = parseBool(e.DRY_RUN, true);

  let token = String(e.HUBSPOT_ACCESS_TOKEN || '').trim();
  if (token === PLACEHOLDER_TOKEN) token = '';
  if (!sandbox && !token) errors.push('SANDBOX_MODE=false needs HUBSPOT_ACCESS_TOKEN');

  let baseUrl = DEFAULT_HUBSPOT_BASE_URL;
  if (e.HUBSPOT_BASE_URL && String(e.HUBSPOT_BASE_URL).trim()) {
    const v = String(e.HUBSPOT_BASE_URL).trim().replace(/\/+$/, '');
    if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v)) baseUrl = v;
    else errors.push('HUBSPOT_BASE_URL must be an https origin');
  }

  const campaignTag = String(e.CAMPAIGN_TAG || '').trim();
  if (campaignTag && !/^[A-Za-z0-9_.-]{1,64}$/.test(campaignTag)) {
    errors.push('CAMPAIGN_TAG may only contain letters, digits, dot, dash, underscore (max 64)');
  }

  const stages = parseList(e.HUBSPOT_CLOSED_LOST_STAGES);
  const dncProperty = e.HUBSPOT_DNC_PROPERTY === undefined ? 'do_not_contact' : String(e.HUBSPOT_DNC_PROPERTY).trim();
  if (dncProperty && !/^[a-z][a-z0-9_]{0,99}$/.test(dncProperty)) {
    errors.push('HUBSPOT_DNC_PROPERTY must be a HubSpot internal property name');
  }

  return {
    dryRun: dryRun,
    sandbox: sandbox,
    maxContactsPerAccount: toInt(e.MAX_CONTACTS_PER_ACCOUNT, 3, 1, 100),
    requireEmail: parseBool(e.REQUIRE_EMAIL, false),
    campaignTag: campaignTag,
    hubspot: {
      token: token,
      baseUrl: baseUrl,
      dncProperty: dncProperty,
      closedLostStages: (stages.length ? stages : ['closedlost']).map((s) => s.toLowerCase()),
      maxRetries: toInt(e.HUBSPOT_MAX_RETRIES, 4, 0, 8),
      minIntervalMs: toInt(e.HUBSPOT_MIN_INTERVAL_MS, 220, 0, 5000)
    },
    paths: {
      icpRules: String(e.ICP_RULES_PATH || 'config/icp-rules.example.json'),
      suppression: String(e.SUPPRESSION_DOMAINS_PATH || 'config/suppression-domains.example.json'),
      snapshot: String(e.HUBSPOT_SNAPSHOT_PATH || 'fixtures/hubspot_crm_snapshot.sample.json'),
      input: String(e.INPUT_CSV_PATH || 'fixtures/sales_nav_export.sample.csv'),
      outputDir: String(e.OUTPUT_DIR || 'output')
    },
    errors: errors,
    warnings: warnings
  };
}

// Config that is safe to log or pass between n8n nodes: the token is removed.
function publicConfig(config) {
  const hubspot = Object.assign({}, config.hubspot);
  const hasToken = Boolean(hubspot.token);
  delete hubspot.token;
  hubspot.hasToken = hasToken;
  return Object.assign({}, config, { hubspot: hubspot });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) break;
    else if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, c)) counts[c] += 1;
  }
  let best = ',';
  Object.keys(counts).forEach((d) => {
    if (counts[d] > counts[best]) best = d;
  });
  return best;
}

function parseCsvRecords(s, delimiter) {
  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      out.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) throw new CsvError('CSV has an unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

// Returns { headers, rows, delimiter }. Rows are objects keyed by header; blank lines are skipped.
function parseCsv(text) {
  let s = text === undefined || text === null ? '' : String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s.trim()) throw new CsvError('CSV input is empty');
  const delimiter = detectDelimiter(s);
  const records = parseCsvRecords(s, delimiter);
  const headers = records[0].map((h) => h.trim());
  const rows = records
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        if (h && !Object.prototype.hasOwnProperty.call(obj, h)) obj[h] = (r[idx] === undefined ? '' : r[idx]).trim();
      });
      return obj;
    });
  return { headers: headers, rows: rows, delimiter: delimiter };
}

/*
 * Serializes rows to CSV. String cells that start with = + - @ tab or CR get a leading
 * apostrophe so spreadsheet tools do not run them as formulas (CSV injection guard).
 */
function csvCell(value, formulaGuard) {
  if (value === undefined || value === null) return '';
  let v = typeof value === 'string' ? value : String(value);
  if (formulaGuard !== false && typeof value === 'string' && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\r\n]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function toCsv(columns, rows, options) {
  const guard = !options || options.formulaGuard !== false;
  const lines = [columns.map((c) => csvCell(c, false)).join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((c) => csvCell(row[c], guard)).join(','));
  });
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// File helpers (CLI only)
// ---------------------------------------------------------------------------

function resolveFromRoot(p, root) {
  const path = require('node:path');
  return path.isAbsolute(p) ? p : path.resolve(root || process.cwd(), p);
}

function readJsonFile(p, root) {
  const fs = require('node:fs');
  const full = resolveFromRoot(p, root);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    throw new ConfigError('Could not read JSON file ' + p + ': ' + e.message);
  }
}

function writeOutputs(files, dir, root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const full = resolveFromRoot(dir, root);
  fs.mkdirSync(full, { recursive: true });
  const written = [];
  Object.keys(files).forEach((name) => {
    const target = path.join(full, name);
    fs.writeFileSync(target, files[name]);
    written.push(target);
  });
  return written;
}

module.exports = {
  PLACEHOLDER_TOKEN,
  DEFAULT_HUBSPOT_BASE_URL,
  ConfigError,
  CsvError,
  parseList,
  parseBool,
  toInt,
  safeEqual,
  redact,
  createLogger,
  parseEnvFile,
  loadEnv,
  buildConfig,
  publicConfig,
  parseCsv,
  toCsv,
  csvCell,
  resolveFromRoot,
  readJsonFile,
  writeOutputs
};
