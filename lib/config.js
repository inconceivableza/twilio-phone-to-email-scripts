'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = `
Usage: node setup.js [options]

Interactive setup wizard for Twilio Phone-to-Email Functions.

Options:
  --account-sid <sid>            Twilio Account SID
  --api-key-sid <sid>            API Key SID (for initial region)
  --api-key-secret <secret>      API Key Secret (for initial region)
  --api-key-region <r>           Region for the API key (default: us1)
  --auth-token-us1 <token>       Auth Token for US1 region
  --auth-token-ie1 <token>       Auth Token for IE1 region
  --api-key-sid-us1 <sid>        API Key SID for US1
  --api-key-secret-us1 <secret>  API Key Secret for US1
  --api-key-sid-ie1 <sid>        API Key SID for IE1
  --api-key-secret-ie1 <secret>  API Key Secret for IE1
  --api-key-sid-au1 <sid>        API Key SID for AU1
  --api-key-secret-au1 <secret>  API Key Secret for AU1
  --voice-region <r>             Default voice region (us1, ie1, au1)
  --sms-region <r>               Default SMS region (us1, ie1, au1)
  --mailjet-key <key>            Mailjet API key (omit to skip email)
  --mailjet-secret <secret>      Mailjet API secret
  --forwarding-email <email>     Default forwarding email
  --from-email <email>           Sender email address
  --sip-domain-name <name>       SIP domain prefix (omit to skip SIP)
  --sip-region <r>               SIP domain region
  --skip-sip                     Skip SIP setup
  --skip-deploy                  Skip deployment step
  --non-interactive              No prompts; all values from flags/env/.env
  --help                         Show this help message
`.trim();

function parseArgs(argv) {
  const args = {};
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--help') { args.help = true; continue; }
    if (a === '--skip-sip') { args.skipSip = true; continue; }
    if (a === '--skip-deploy') { args.skipDeploy = true; continue; }
    if (a === '--non-interactive') { args.nonInteractive = true; continue; }
    // key-value flags
    const map = {
      '--account-sid': 'accountSid',
      '--api-key-sid': 'apiKeySid',
      '--api-key-secret': 'apiKeySecret',
      '--api-key-region': 'apiKeyRegion',
      '--auth-token-us1': 'authTokenUs1',
      '--auth-token-ie1': 'authTokenIe1',
      '--api-key-sid-us1': 'apiKeySidUs1',
      '--api-key-secret-us1': 'apiKeySecretUs1',
      '--api-key-sid-ie1': 'apiKeySidIe1',
      '--api-key-secret-ie1': 'apiKeySecretIe1',
      '--api-key-sid-au1': 'apiKeySidAu1',
      '--api-key-secret-au1': 'apiKeySecretAu1',
      '--voice-region': 'voiceRegion',
      '--sms-region': 'smsRegion',
      '--mailjet-key': 'mailjetKey',
      '--mailjet-secret': 'mailjetSecret',
      '--forwarding-email': 'forwardingEmail',
      '--from-email': 'fromEmail',
      '--sip-domain-name': 'sipDomainName',
      '--sip-region': 'sipRegion',
    };
    if (map[a] && i + 1 < raw.length) {
      args[map[a]] = raw[++i];
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Static data & constants
// ---------------------------------------------------------------------------

const REGIONS = require('../data/regions.json');
const COUNTRY_REGIONS = require('../data/country-regions.json');
const VALID_REGIONS = Object.keys(REGIONS);

const PROJECT_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const SECRETS_PATH = path.join(PROJECT_ROOT, '.secrets');
const PHONE_CONFIG_PATH = path.join(PROJECT_ROOT, 'assets', 'phone-config.private.json');

// ---------------------------------------------------------------------------
// Region helpers
// ---------------------------------------------------------------------------

function getEdgeForRegion(regionId) {
  const r = REGIONS[regionId];
  return r ? r.edge : null;
}

function regionSupportsFeature(regionId, feature) {
  const r = REGIONS[regionId];
  return r && r.features && r.features[feature] === true;
}

function recommendRegion(phoneNumber, feature) {
  // Extract country code digits from E.164 number (after the +)
  const digits = phoneNumber.replace(/^\+/, '');

  // Longest-prefix match
  let bestMatch = null;
  let bestLen = 0;
  for (const prefix of Object.keys(COUNTRY_REGIONS)) {
    if (prefix.startsWith('_')) continue;
    if (digits.startsWith(prefix) && prefix.length > bestLen) {
      bestMatch = prefix;
      bestLen = prefix.length;
    }
  }

  const candidates = bestMatch
    ? COUNTRY_REGIONS[bestMatch]
    : COUNTRY_REGIONS._default;

  // Return first region that supports the needed feature
  for (const region of candidates) {
    if (regionSupportsFeature(region, feature)) {
      return region;
    }
  }
  // Fallback to us1
  return 'us1';
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function parseKeyValueFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    env[key] = val;
  }
  return env;
}

function loadEnvFile() {
  return parseKeyValueFile(ENV_PATH);
}

function loadSecretsFile() {
  return parseKeyValueFile(SECRETS_PATH);
}

function loadAllConfig() {
  // Priority: process.env > .secrets > .env
  const envFile = loadEnvFile();
  const secretsFile = loadSecretsFile();
  return { ...envFile, ...secretsFile, ...process.env };
}

function loadPhoneConfig() {
  if (!fs.existsSync(PHONE_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(PHONE_CONFIG_PATH, 'utf8'));
  } catch { return {}; }
}

const SECRET_KEYS = [
  'ACCOUNT_SID', 'AUTH_TOKEN',
  'MAILJET_API_KEY', 'MAILJET_API_SECRET',
];
const SECRET_PREFIXES = [
  'API_KEY_SID_', 'API_KEY_SECRET_', 'AUTH_TOKEN_',
];

function isSecretKey(key) {
  if (SECRET_KEYS.includes(key)) return true;
  for (const prefix of SECRET_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function writeEnvFile(vars) {
  const lines = [
    '# Non-secret configuration (credentials belong in .secrets or env vars)',
    '# See README for API key creation instructions',
    '',
    '# Default regions for phone numbers',
    `VOICE_REGION=${vars.VOICE_REGION || 'us1'}`,
    `SMS_REGION=${vars.SMS_REGION || 'us1'}`,
    '',
    '# Email configuration (optional — leave blank to skip email forwarding)',
    `FORWARDING_EMAIL=${vars.FORWARDING_EMAIL || ''}`,
    `FROM_EMAIL=${vars.FROM_EMAIL || ''}`,
    '',
    '# Voicemail greeting (optional)',
    `ANSWER_MESSAGE_URL=${vars.ANSWER_MESSAGE_URL || ''}`,
    `ANSWER_MESSAGE_NAME=${vars.ANSWER_MESSAGE_NAME || ''}`,
    `THANK_YOU_MESSAGE_URL=${vars.THANK_YOU_MESSAGE_URL || ''}`,
    '',
    '# SIP configuration (optional — leave blank to skip SIP)',
    `SIP_DOMAIN=${vars.SIP_DOMAIN || ''}`,
    `SIP_INBOUND=${vars.SIP_INBOUND || 'true'}`,
    `SIP_DIAL_TIMEOUT=${vars.SIP_DIAL_TIMEOUT || '20'}`,
    '',
    '# SMS forwarding (optional — leave blank to skip)',
    `SMS_FORWARD_NUMBER=${vars.SMS_FORWARD_NUMBER || ''}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

function writeSecretsFile(secrets) {
  const lines = [
    '# Credentials — DO NOT commit this file (it is in .gitignore)',
    '',
  ];
  for (const [key, val] of Object.entries(secrets)) {
    if (val) lines.push(`${key}=${val}`);
  }
  fs.writeFileSync(SECRETS_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

function writePhoneConfig(config) {
  fs.mkdirSync(path.dirname(PHONE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(PHONE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function generatePassword(length = 16) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let pw = '';
  for (let i = 0; i < length; i++) {
    pw += chars[bytes[i] % chars.length];
  }
  return pw;
}

function isValidE164(num) {
  return /^\+\d{7,15}$/.test(num);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  HELP_TEXT,
  REGIONS,
  VALID_REGIONS,
  ENV_PATH,
  SECRETS_PATH,
  PHONE_CONFIG_PATH,
  SECRET_KEYS,
  SECRET_PREFIXES,
  getEdgeForRegion,
  regionSupportsFeature,
  recommendRegion,
  parseKeyValueFile,
  loadEnvFile,
  loadSecretsFile,
  loadAllConfig,
  loadPhoneConfig,
  isSecretKey,
  writeEnvFile,
  writeSecretsFile,
  writePhoneConfig,
  generatePassword,
  isValidE164,
  parseArgs,
};
