#!/usr/bin/env node
'use strict';

/*
 * Generates workflow.json deterministically from lib/*.js and the example config and fixtures.
 * The output has no timestamps, no random IDs, no credential blocks, and no instance metadata.
 *
 *   node scripts/build-workflow.js           write workflow.json
 *   node scripts/build-workflow.js --check   exit 1 if workflow.json is out of date
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'workflow.json');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function nodeId(name) {
  const h = crypto.createHash('sha1').update('sn-csv-sanitizer:' + name).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

// Wraps lib modules so Code nodes can use them without any file system access.
function bundle(modules) {
  const lines = [
    '// ---- bundled library (generated from lib/*.js by scripts/build-workflow.js) ----',
    'const __lib = {};',
    "const __req = (n) => (n === './core' ? __lib.core : n === './sanitizer' ? __lib.sanitizer : n === './hubspot' ? __lib.hubspot : require(n));"
  ];
  modules.forEach((name) => {
    lines.push(
      '__lib.' + name + ' = (function () {',
      '  const module = { exports: {} };',
      '  (function (module, exports, require) {',
      read('lib/' + name + '.js').trim(),
      '  })(module, module.exports, __req);',
      '  return module.exports;',
      '})();'
    );
  });
  lines.push(
    'const core = __lib.core;',
    'const san = __lib.sanitizer;',
    'const hs = __lib.hubspot;',
    '// ---- end bundled library ----'
  );
  return lines.join('\n');
}

function loadConfigGlue(defaults) {
  return [
    '// ---- node: Load Config & Defaults ----',
    '// Settings come from environment variables only. The HubSpot token is never copied into the data flow.',
    'const DEFAULTS = ' + JSON.stringify(defaults, null, 2) + ';',
    '',
    'const input = $input.first().json || {};',
    'const isWebhook = input.headers !== undefined && input.body !== undefined;',
    'const full = core.buildConfig($env);',
    "if (full.errors.length) throw new Error('Configuration error: ' + full.errors.join('; '));",
    '',
    'let csvText;',
    'if (isWebhook) {',
    "  const secret = String($env.WEBHOOK_SHARED_SECRET || '');",
    "  if (!secret) throw new Error('Webhook input is disabled: set WEBHOOK_SHARED_SECRET on the n8n host');",
    "  const supplied = String((input.headers || {})['x-webhook-secret'] || '');",
    "  if (!core.safeEqual(secret, supplied)) throw new Error('Unauthorized webhook call');",
    '  const body = input.body || {};',
    "  csvText = typeof body.csv === 'string' ? body.csv : '';",
    "  if (!csvText) throw new Error('Webhook body must be JSON with a \"csv\" string field');",
    '} else {',
    '  // Manual runs use the bundled synthetic sample.',
    '  csvText = DEFAULTS.sampleCsv;',
    '}',
    '',
    'function envJson(name, fallback) {',
    '  const raw = $env[name];',
    "  if (!raw || !String(raw).trim()) return fallback;",
    '  try {',
    '    return JSON.parse(raw);',
    '  } catch (e) {',
    "    throw new Error(name + ' is not valid JSON');",
    '  }',
    '}',
    "const rules = envJson('ICP_RULES_JSON', DEFAULTS.rules);",
    'san.compileRules(rules); // fail fast on a bad regex',
    "const listEnv = core.parseList($env.SUPPRESSION_DOMAINS);",
    'const staticSuppression = listEnv.length ? listEnv : DEFAULTS.suppression;',
    "const snapshot = full.sandbox ? envJson('HUBSPOT_SNAPSHOT_JSON', DEFAULTS.snapshot) : null;",
    '',
    'return [{ json: { config: core.publicConfig(full), rules, staticSuppression, snapshot, csvText } }];'
  ].join('\n');
}

const GLUE = {
  parse: [
    '// ---- node: Parse CSV ----',
    'return [{ json: san.stageParse($input.first().json) }];'
  ].join('\n'),

  normalize: [
    '// ---- node: Normalize & Strip Noise ----',
    'return [{ json: san.stageNormalize($input.first().json) }];'
  ].join('\n'),

  icp: [
    '// ---- node: ICP Filter ----',
    'return [{ json: san.stageIcp($input.first().json) }];'
  ].join('\n'),

  sandboxLookup: [
    '// ---- node: HubSpot Suppression Check (Sandbox Fixture) ----',
    '// No network access. Answers come from the snapshot fixture.',
    'const state = $input.first().json;',
    'const lookup = hs.lookupFromSnapshot(san.suppressionDomains(state), state.snapshot, state.config.hubspot);',
    'return [{ json: san.stageSuppress(state, lookup) }];'
  ].join('\n'),

  liveLookup: [
    '// ---- node: HubSpot Suppression Check (Live API) ----',
    '// Read-only: HubSpot search and batch-read endpoints. The token is read from $env here only.',
    'const state = $input.first().json;',
    'const full = core.buildConfig($env);',
    "if (full.errors.length) throw new Error('Configuration error: ' + full.errors.join('; '));",
    'const self = this;',
    'const request = async (req) => {',
    '  const res = await self.helpers.httpRequest({',
    '    method: req.method,',
    '    url: req.url,',
    '    headers: req.headers,',
    '    body: req.body,',
    '    json: true,',
    '    returnFullResponse: true,',
    '    ignoreHttpStatusCodes: true,',
    '    timeout: 30000',
    '  });',
    '  return { status: res.statusCode, headers: res.headers || {}, body: res.body };',
    '};',
    'const lookup = await hs.lookupSuppression({',
    '  config: full,',
    '  domains: san.suppressionDomains(state),',
    '  snapshot: null,',
    '  request,',
    '  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
    '});',
    'return [{ json: san.stageSuppress(state, lookup) }];'
  ].join('\n'),

  dedupeCap: [
    '// ---- node: Dedupe & Per-Account Cap ----',
    'return [{ json: san.stageDedupeCap($input.first().json) }];'
  ].join('\n'),

  split: [
    '// ---- node: Split Outputs ----',
    '// Emits three items with binary files. Attach Write Binary File, Google Drive, or S3 nodes after this.',
    '// DRY_RUN is recorded in run_summary.json. This workflow itself writes nothing to disk.',
    'const state = $input.first().json;',
    'const out = san.stageOutputs(state, new Date().toISOString());',
    'const make = (name, text, mime) => this.helpers.prepareBinaryData(Buffer.from(text, \'utf8\'), name, mime);',
    "const readyFile = await make('sequencer_ready.csv', out.files['sequencer_ready.csv'], 'text/csv');",
    "const quarantineFile = await make('quarantine_dropped.csv', out.files['quarantine_dropped.csv'], 'text/csv');",
    "const summaryFile = await make('run_summary.json', out.files['run_summary.json'], 'application/json');",
    'return [',
    "  { json: { file: 'sequencer_ready.csv', rows: out.counts.ready }, binary: { data: readyFile } },",
    "  { json: { file: 'quarantine_dropped.csv', rows: out.counts.quarantined }, binary: { data: quarantineFile } },",
    "  { json: Object.assign({ file: 'run_summary.json' }, out.summary), binary: { data: summaryFile } }",
    '];'
  ].join('\n')
};

function codeNode(name, modules, glue, position) {
  return {
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: bundle(modules) + '\n\n' + glue
    },
    id: nodeId(name),
    name: name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: position
  };
}

const NAMES = {
  manual: 'Manual Trigger',
  webhook: 'Webhook Trigger (POST CSV)',
  load: 'Load Config & Defaults',
  parse: 'Parse CSV',
  normalize: 'Normalize & Strip Noise',
  icp: 'ICP Filter',
  sandbox: 'Sandbox Mode?',
  sandboxLookup: 'HubSpot Suppression Check (Sandbox Fixture)',
  liveLookup: 'HubSpot Suppression Check (Live API)',
  dedupe: 'Dedupe & Per-Account Cap',
  split: 'Split Outputs',
  note: 'Setup Notes'
};

function buildWorkflow() {
  const defaults = {
    sampleCsv: read('fixtures/sales_nav_export.sample.csv'),
    rules: JSON.parse(read('config/icp-rules.example.json')),
    suppression: JSON.parse(read('config/suppression-domains.example.json')).domains,
    snapshot: JSON.parse(read('fixtures/hubspot_crm_snapshot.sample.json'))
  };
  const N = NAMES;

  const nodes = [
    {
      parameters: {
        content: [
          '## LinkedIn Sales Navigator CSV Sanitizer',
          'Cleans a Sales Navigator export before sequencer upload: strips emoji and title noise, normalizes domains, applies ICP rules, checks HubSpot, dedupes, and caps contacts per account.',
          '',
          '**Safe by default:** SANDBOX_MODE=true reads HubSpot data from a bundled synthetic fixture. DRY_RUN=true is recorded in the run summary. This workflow only reads from HubSpot and never writes to it.',
          '',
          '**Inputs**',
          '- Manual Trigger runs the bundled synthetic sample.',
          '- Webhook Trigger takes JSON {"csv": "..."} and needs WEBHOOK_SHARED_SECRET plus an x-webhook-secret header.',
          '',
          '**Host settings:** N8N_BLOCK_ENV_ACCESS_IN_NODE=false. For live lookups set SANDBOX_MODE=false and HUBSPOT_ACCESS_TOKEN.',
          '',
          'Outputs: sequencer_ready.csv, quarantine_dropped.csv, run_summary.json (as binary items).'
        ].join('\n'),
        height: 400,
        width: 480
      },
      id: nodeId(N.note),
      name: N.note,
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-60, -460]
    },
    {
      parameters: {},
      id: nodeId(N.manual),
      name: N.manual,
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0]
    },
    {
      parameters: {
        httpMethod: 'POST',
        path: 'linkedin-sales-nav-csv-sanitizer',
        responseMode: 'lastNode',
        options: { responseData: 'allEntries' }
      },
      id: nodeId(N.webhook),
      name: N.webhook,
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 200]
    },
    codeNode(N.load, ['core', 'sanitizer'], loadConfigGlue(defaults), [260, 100]),
    codeNode(N.parse, ['core', 'sanitizer'], GLUE.parse, [520, 100]),
    codeNode(N.normalize, ['core', 'sanitizer'], GLUE.normalize, [780, 100]),
    codeNode(N.icp, ['core', 'sanitizer'], GLUE.icp, [1040, 100]),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: nodeId('sandbox-condition'),
              leftValue: '={{ $json.config.sandbox }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true }
            }
          ],
          combinator: 'and'
        },
        options: {}
      },
      id: nodeId(N.sandbox),
      name: N.sandbox,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1300, 100]
    },
    codeNode(N.sandboxLookup, ['core', 'sanitizer', 'hubspot'], GLUE.sandboxLookup, [1560, 0]),
    codeNode(N.liveLookup, ['core', 'sanitizer', 'hubspot'], GLUE.liveLookup, [1560, 220]),
    codeNode(N.dedupe, ['core', 'sanitizer'], GLUE.dedupeCap, [1820, 100]),
    codeNode(N.split, ['core', 'sanitizer'], GLUE.split, [2080, 100])
  ];

  const link = (to) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  const connections = {};
  connections[N.manual] = link(N.load);
  connections[N.webhook] = link(N.load);
  connections[N.load] = link(N.parse);
  connections[N.parse] = link(N.normalize);
  connections[N.normalize] = link(N.icp);
  connections[N.icp] = link(N.sandbox);
  connections[N.sandbox] = {
    main: [
      [{ node: N.sandboxLookup, type: 'main', index: 0 }],
      [{ node: N.liveLookup, type: 'main', index: 0 }]
    ]
  };
  connections[N.sandboxLookup] = link(N.dedupe);
  connections[N.liveLookup] = link(N.dedupe);
  connections[N.dedupe] = link(N.split);

  return {
    name: 'LinkedIn Sales Navigator CSV ICP Dedupe Sanitizer',
    nodes: nodes,
    pinData: {},
    connections: connections,
    active: false,
    settings: { executionOrder: 'v1' },
    tags: [],
    meta: {}
  };
}

function render() {
  return JSON.stringify(buildWorkflow(), null, 2) + '\n';
}

if (require.main === module) {
  const rendered = render();
  if (process.argv.indexOf('--check') !== -1) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== rendered) {
      console.error('workflow.json is out of date. Run: npm run build:workflow');
      process.exit(1);
    }
    console.log('workflow.json is up to date.');
  } else {
    fs.writeFileSync(OUTPUT, rendered);
    console.log('Wrote workflow.json (' + rendered.length + ' bytes)');
  }
}

module.exports = { buildWorkflow, render, NAMES };
