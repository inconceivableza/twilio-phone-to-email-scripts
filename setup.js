#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = `
Usage: node setup.js [options]

Interactive setup wizard for Twilio Phone-to-Email Functions.

Options:
  --account-sid <sid>         Twilio Account SID
  --auth-token <token>        Twilio Auth Token
  --voice-region <r>          Default voice region: us1 or ie1
  --sms-region <r>            Default SMS region: us1 or ie1
  --mailjet-key <key>         Mailjet API key (omit to skip email)
  --mailjet-secret <secret>   Mailjet API secret
  --forwarding-email <email>  Default forwarding email
  --from-email <email>        Sender email address
  --sip-domain-name <name>    SIP domain prefix (omit to skip SIP)
  --sip-region <r>            SIP domain region: us1 or ie1
  --skip-sip                  Skip SIP setup
  --skip-deploy               Skip deployment step
  --non-interactive           No prompts; all values from flags/env/.env
  --help                      Show this help message
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
      '--auth-token': 'authToken',
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
// Utility helpers
// ---------------------------------------------------------------------------

const ENV_PATH = path.join(__dirname, '.env');
const PHONE_CONFIG_PATH = path.join(__dirname, 'assets', 'phone-config.private.json');
const VALID_REGIONS = ['us1', 'ie1'];

function loadEnvFile() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
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

function loadPhoneConfig() {
  if (!fs.existsSync(PHONE_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(PHONE_CONFIG_PATH, 'utf8'));
  } catch { return {}; }
}

function writeEnvFile(vars) {
  const lines = [
    '# Twilio credentials (needed for setup script; auto-provided in Functions runtime)',
    `ACCOUNT_SID=${vars.ACCOUNT_SID || ''}`,
    `AUTH_TOKEN=${vars.AUTH_TOKEN || ''}`,
    '',
    '# Default regions for phone numbers (us1 or ie1)',
    `VOICE_REGION=${vars.VOICE_REGION || 'us1'}`,
    `SMS_REGION=${vars.SMS_REGION || 'us1'}`,
    '',
    '# Email configuration (optional — leave blank to skip email forwarding)',
    `MAILJET_API_KEY=${vars.MAILJET_API_KEY || ''}`,
    `MAILJET_API_SECRET=${vars.MAILJET_API_SECRET || ''}`,
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
// Interactive I/O
// ---------------------------------------------------------------------------

let rl;

function initReadline() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(question, defaultVal) {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function pressEnter() {
  return new Promise(resolve => {
    rl.question('\nPress Enter to continue...', () => resolve());
  });
}

function print(text) {
  console.log(text);
}

function printBanner(title) {
  print(`\n${'='.repeat(60)}`);
  print(`  ${title}`);
  print(`${'='.repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// Twilio API helpers (uses the twilio npm package)
// ---------------------------------------------------------------------------

let twilioClient;

function getTwilioClient(accountSid, authToken) {
  if (!twilioClient) {
    const twilio = require('twilio');
    twilioClient = twilio(accountSid, authToken);
  }
  return twilioClient;
}

async function validateCredentials(accountSid, authToken) {
  try {
    const client = getTwilioClient(accountSid, authToken);
    const account = await client.api.v2010.accounts(accountSid).fetch();
    return { valid: true, friendlyName: account.friendlyName };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

async function listPhoneNumbers(client) {
  const numbers = await client.incomingPhoneNumbers.list();
  return numbers.map(n => ({
    sid: n.sid,
    number: n.phoneNumber,
    friendlyName: n.friendlyName,
    voiceUrl: n.voiceUrl,
    smsUrl: n.smsUrl,
  }));
}

async function listServerlessServices(client) {
  try {
    const services = await client.serverless.v1.services.list();
    return services;
  } catch { return []; }
}

async function listSipDomains(client) {
  try {
    const domains = await client.sip.domains.list();
    return domains;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

async function main() {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.help) {
    print(HELP_TEXT);
    process.exit(0);
  }

  const nonInteractive = !!cliArgs.nonInteractive;
  if (!nonInteractive) {
    initReadline();
  }

  // State that accumulates through the steps
  const state = {
    env: loadEnvFile(),
    phoneConfig: loadPhoneConfig(),
    accountSid: '',
    authToken: '',
    voiceRegion: 'us1',
    smsRegion: 'us1',
    numbers: [],        // from Twilio API
    numberConfigs: {},   // per-number settings we're building
    emailEnabled: false,
    sipEnabled: false,
    sipDomainName: '',
    sipRegion: 'us1',
    sipDomainSid: '',
    sipDomain: '',
    sipCredentials: [],  // { number, username, password }
    deployUrls: {},      // { us1: 'https://...', ie1: 'https://...' }
    existingServices: [],
    existingSipDomains: [],
  };

  try {
    print('\nTwilio Phone-to-Email Setup Wizard');
    print('==================================\n');
    print('This wizard will walk you through configuring your Twilio');
    print('phone numbers for voicemail, SMS forwarding, and SIP.\n');

    await step1_credentials(state, cliArgs, nonInteractive);
    await step2_detectExisting(state);
    if (!nonInteractive) await pressEnter();

    await step3_regions(state, cliArgs, nonInteractive);
    await step4_phoneNumbers(state, cliArgs, nonInteractive);
    await step5_email(state, cliArgs, nonInteractive);
    await step6_sip(state, cliArgs, nonInteractive);
    await step7_writeConfig(state);
    if (!nonInteractive) await pressEnter();

    if (!cliArgs.skipDeploy) {
      await step8_deploy(state, nonInteractive);
    } else {
      print('\n(Skipping deployment — use "npm run deploy" later.)\n');
    }

    if (Object.keys(state.deployUrls).length > 0) {
      await step9_configureWebhooks(state, nonInteractive);
    } else {
      print('\nSkipping webhook configuration (no deployment URLs available).');
      print('Run "npm run setup" again after deploying to configure webhooks.\n');
    }

    step10_summary(state);
  } finally {
    if (rl) rl.close();
  }
}

// ---------------------------------------------------------------------------
// Step 1: Credentials
// ---------------------------------------------------------------------------

async function step1_credentials(state, cliArgs, nonInteractive) {
  printBanner('Step 1: Twilio Account Credentials');

  print('Your Account SID and Auth Token are at https://console.twilio.com/');
  print('These are needed to deploy functions and configure phone numbers.\n');

  let sid = cliArgs.accountSid || state.env.ACCOUNT_SID || process.env.ACCOUNT_SID || '';
  let token = cliArgs.authToken || state.env.AUTH_TOKEN || process.env.AUTH_TOKEN || '';

  if (!nonInteractive) {
    if (sid) {
      print(`Found Account SID: ${sid}`);
      const keep = await ask('Keep this Account SID? (y/n)', 'y');
      if (keep.toLowerCase() !== 'y') sid = '';
    }
    if (!sid) {
      sid = await ask('Account SID');
    }

    if (token) {
      print(`Found Auth Token: ${token.slice(0, 4)}${'*'.repeat(token.length - 4)}`);
      const keep = await ask('Keep this Auth Token? (y/n)', 'y');
      if (keep.toLowerCase() !== 'y') token = '';
    }
    if (!token) {
      token = await ask('Auth Token');
    }
  }

  if (!sid || !token) {
    print('Error: Account SID and Auth Token are required.');
    process.exit(1);
  }

  print('\nValidating credentials...');
  const result = await validateCredentials(sid, token);
  if (!result.valid) {
    print(`Error: Invalid credentials — ${result.error}`);
    process.exit(1);
  }
  print(`Authenticated as: ${result.friendlyName}\n`);

  state.accountSid = sid;
  state.authToken = token;
  state.env.ACCOUNT_SID = sid;
  state.env.AUTH_TOKEN = token;
}

// ---------------------------------------------------------------------------
// Step 2: Detect existing setup
// ---------------------------------------------------------------------------

async function step2_detectExisting(state) {
  printBanner('Step 2: Checking Existing Configuration');

  const client = getTwilioClient(state.accountSid, state.authToken);

  print('Querying Twilio API...\n');

  const [services, sipDomains, numbers] = await Promise.all([
    listServerlessServices(client),
    listSipDomains(client),
    listPhoneNumbers(client),
  ]);

  state.existingServices = services;
  state.existingSipDomains = sipDomains;
  state.numbers = numbers;

  // Services
  if (services.length > 0) {
    print('Serverless services:');
    for (const s of services) {
      print(`  - ${s.friendlyName} (${s.sid})`);
    }
  } else {
    print('No serverless services found.');
  }

  // SIP domains
  if (sipDomains.length > 0) {
    print('\nSIP domains:');
    for (const d of sipDomains) {
      print(`  - ${d.domainName} (${d.sid})`);
    }
  } else {
    print('\nNo SIP domains found.');
  }

  // Phone numbers
  if (numbers.length > 0) {
    print(`\nPhone numbers (${numbers.length}):`);
    for (const n of numbers) {
      const label = n.friendlyName !== n.number ? `  (${n.friendlyName})` : '';
      print(`  - ${n.number}${label}`);
      if (n.voiceUrl) print(`    Voice URL: ${n.voiceUrl}`);
      if (n.smsUrl) print(`    SMS URL:   ${n.smsUrl}`);
    }
  } else {
    print('\nNo phone numbers found. Purchase one at https://console.twilio.com/');
  }

  // Disk config
  if (Object.keys(state.phoneConfig).length > 0) {
    print('\nExisting phone-config.private.json:');
    for (const [num, cfg] of Object.entries(state.phoneConfig)) {
      print(`  ${num}: ${JSON.stringify(cfg)}`);
    }
  }

  if (Object.keys(state.env).length > 2) { // more than just SID+token
    print('\nExisting .env values detected — will pre-fill prompts.');
  }

  print('');
}

// ---------------------------------------------------------------------------
// Step 3: Region selection
// ---------------------------------------------------------------------------

async function step3_regions(state, cliArgs, nonInteractive) {
  printBanner('Step 3: Default Regions');

  print('Twilio can process voice calls and SMS in different regions.');
  print('Choose the regions closest to your callers for lowest latency.\n');
  print('Available regions:');
  print('  us1 — Virginia, USA (generally available)');
  print('  ie1 — Dublin, Ireland (beta)\n');
  print('You can override the region per phone number in the next step.\n');

  let voiceRegion = cliArgs.voiceRegion || state.env.VOICE_REGION || 'us1';
  let smsRegion = cliArgs.smsRegion || state.env.SMS_REGION || 'us1';

  if (!nonInteractive) {
    voiceRegion = await ask('Default voice region (us1 or ie1)', voiceRegion);
    smsRegion = await ask('Default SMS region (us1 or ie1)', smsRegion);
  }

  if (!VALID_REGIONS.includes(voiceRegion)) {
    print(`Warning: "${voiceRegion}" is not a recognized region, using us1.`);
    voiceRegion = 'us1';
  }
  if (!VALID_REGIONS.includes(smsRegion)) {
    print(`Warning: "${smsRegion}" is not a recognized region, using us1.`);
    smsRegion = 'us1';
  }

  state.voiceRegion = voiceRegion;
  state.smsRegion = smsRegion;
  state.env.VOICE_REGION = voiceRegion;
  state.env.SMS_REGION = smsRegion;

  print(`\nDefault voice region: ${voiceRegion}`);
  print(`Default SMS region:   ${smsRegion}`);
}

// ---------------------------------------------------------------------------
// Step 4: Phone number configuration
// ---------------------------------------------------------------------------

async function step4_phoneNumbers(state, cliArgs, nonInteractive) {
  printBanner('Step 4: Phone Numbers');

  if (state.numbers.length === 0) {
    print('No phone numbers on your account. Skipping per-number configuration.\n');
    return;
  }

  print(`Found ${state.numbers.length} phone number(s) on your account:\n`);
  state.numbers.forEach((n, i) => {
    const label = n.friendlyName !== n.number ? `  (${n.friendlyName})` : '';
    print(`  ${i + 1}. ${n.number}${label}`);
  });
  print('');

  const globalEmail = cliArgs.forwardingEmail || state.env.FORWARDING_EMAIL || '';
  const globalSmsForward = state.env.SMS_FORWARD_NUMBER || '';
  const globalAnswerName = state.env.ANSWER_MESSAGE_NAME || '';

  if (!nonInteractive) {
    print('For each number, configure per-number settings.');
    print('Leave blank to use the global default.\n');

    for (const n of state.numbers) {
      const existing = state.phoneConfig[n.number] || {};
      const label = n.friendlyName !== n.number ? ` (${n.friendlyName})` : '';

      print(`--- ${n.number}${label} ---`);

      const email = await ask(
        '  Forwarding email',
        existing.forwardingEmail || globalEmail || '(global)'
      );
      const smsForward = await ask(
        '  SMS forward number (E.164)',
        existing.smsForwardNumber || globalSmsForward || ''
      );
      const answerName = await ask(
        '  Answer message name',
        existing.answerMessageName || globalAnswerName || ''
      );
      const vr = await ask(
        '  Voice region (us1 or ie1)',
        existing.voiceRegion || state.voiceRegion
      );
      const sr = await ask(
        '  SMS region (us1 or ie1)',
        existing.smsRegion || state.smsRegion
      );

      const cfg = {};
      if (email && email !== '(global)' && email !== globalEmail) cfg.forwardingEmail = email;
      if (smsForward && smsForward !== globalSmsForward) cfg.smsForwardNumber = smsForward;
      if (answerName && answerName !== globalAnswerName) cfg.answerMessageName = answerName;
      if (vr && vr !== state.voiceRegion) cfg.voiceRegion = vr;
      if (sr && sr !== state.smsRegion) cfg.smsRegion = sr;

      state.numberConfigs[n.number] = cfg;
      print('');
    }
  } else {
    // Non-interactive: preserve existing config
    for (const n of state.numbers) {
      state.numberConfigs[n.number] = state.phoneConfig[n.number] || {};
    }
  }

  print('Per-number configuration:');
  for (const n of state.numbers) {
    const cfg = state.numberConfigs[n.number];
    if (Object.keys(cfg).length > 0) {
      print(`  ${n.number}: ${JSON.stringify(cfg)}`);
    } else {
      print(`  ${n.number}: (using global defaults)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 5: Email configuration
// ---------------------------------------------------------------------------

async function step5_email(state, cliArgs, nonInteractive) {
  printBanner('Step 5: Email Configuration (Optional)');

  print('Voicemails and SMS can be forwarded to email using Mailjet.');
  print('Sign up at https://www.mailjet.com/ for a free account (200 emails/day).');
  print('Leave blank to skip email forwarding entirely.\n');

  let mailjetKey = cliArgs.mailjetKey || state.env.MAILJET_API_KEY || '';
  let mailjetSecret = cliArgs.mailjetSecret || state.env.MAILJET_API_SECRET || '';
  let forwardingEmail = cliArgs.forwardingEmail || state.env.FORWARDING_EMAIL || '';
  let fromEmail = cliArgs.fromEmail || state.env.FROM_EMAIL || '';

  if (!nonInteractive) {
    mailjetKey = await ask('Mailjet API key (blank to skip email)', mailjetKey);

    if (mailjetKey) {
      mailjetSecret = await ask('Mailjet API secret', mailjetSecret);
      fromEmail = await ask('Sender email address (FROM_EMAIL)', fromEmail);
      forwardingEmail = await ask('Default forwarding email (FORWARDING_EMAIL)', forwardingEmail);
    }
  }

  state.emailEnabled = !!(mailjetKey && mailjetSecret);
  state.env.MAILJET_API_KEY = mailjetKey;
  state.env.MAILJET_API_SECRET = mailjetSecret;
  state.env.FORWARDING_EMAIL = forwardingEmail;
  state.env.FROM_EMAIL = fromEmail;

  if (state.emailEnabled) {
    print(`\nEmail forwarding: enabled (${fromEmail} → ${forwardingEmail})`);
  } else {
    print('\nEmail forwarding: disabled');
    print('Note: voicemail recordings will not be delivered without email configured.');
  }

  // Also prompt for answer message / thank you message URLs
  if (!nonInteractive) {
    print('');
    const answerUrl = await ask('Answer message audio URL (optional)', state.env.ANSWER_MESSAGE_URL || '');
    const answerName = await ask('Answer message name (default greeting name)', state.env.ANSWER_MESSAGE_NAME || '');
    const thankYouUrl = await ask('Thank-you message audio URL (optional)', state.env.THANK_YOU_MESSAGE_URL || '');
    state.env.ANSWER_MESSAGE_URL = answerUrl;
    state.env.ANSWER_MESSAGE_NAME = answerName;
    state.env.THANK_YOU_MESSAGE_URL = thankYouUrl;
  }
}

// ---------------------------------------------------------------------------
// Step 6: SIP setup
// ---------------------------------------------------------------------------

async function step6_sip(state, cliArgs, nonInteractive) {
  printBanner('Step 6: SIP Softphone Setup (Optional)');

  print('SIP lets you answer calls on a softphone (e.g. Zoiper) and make');
  print('outbound calls through your Twilio numbers.\n');
  print('SIP domains are available in us1 or ie1.');
  print('Format: yourname.sip.us1.twilio.com or yourname.sip.ie1.twilio.com\n');

  if (cliArgs.skipSip) {
    print('(Skipped via --skip-sip flag)\n');
    state.sipEnabled = false;
    return;
  }

  let sipDomainName = cliArgs.sipDomainName || '';
  let sipRegion = cliArgs.sipRegion || 'us1';

  // Try to detect existing SIP domain from env or API
  const existingDomain = state.env.SIP_DOMAIN || '';
  if (existingDomain) {
    // Parse existing domain: name.sip.region.twilio.com
    const match = existingDomain.match(/^(.+)\.sip\.(\w+)\.twilio\.com$/);
    if (match) {
      sipDomainName = sipDomainName || match[1];
      sipRegion = match[2] || sipRegion;
    }
  }

  if (!nonInteractive) {
    const enableSip = await ask('Enable SIP? (y/n)', sipDomainName ? 'y' : 'n');
    if (enableSip.toLowerCase() !== 'y') {
      print('\nSIP: disabled\n');
      state.sipEnabled = false;
      state.env.SIP_DOMAIN = '';
      return;
    }

    sipDomainName = await ask('SIP domain prefix (e.g. "yourname")', sipDomainName);
    sipRegion = await ask('SIP region (us1 or ie1)', sipRegion);
  } else if (!sipDomainName) {
    state.sipEnabled = false;
    return;
  }

  if (!VALID_REGIONS.includes(sipRegion)) {
    print(`Warning: "${sipRegion}" is not valid, using us1.`);
    sipRegion = 'us1';
  }

  state.sipEnabled = true;
  state.sipDomainName = sipDomainName;
  state.sipRegion = sipRegion;

  const fullDomain = `${sipDomainName}.sip.${sipRegion}.twilio.com`;
  state.sipDomain = fullDomain;
  state.env.SIP_DOMAIN = fullDomain;

  print(`\nSIP domain: ${fullDomain}`);

  const client = getTwilioClient(state.accountSid, state.authToken);

  // Create or find existing SIP domain
  print('Checking for existing SIP domain...');
  let domain = state.existingSipDomains.find(d => d.domainName === fullDomain);

  if (domain) {
    print(`Found existing SIP domain: ${domain.domainName} (${domain.sid})`);
    state.sipDomainSid = domain.sid;
  } else {
    print('Creating SIP domain...');
    try {
      domain = await client.sip.domains.create({
        domainName: fullDomain,
        friendlyName: sipDomainName,
        sipRegistration: true,
      });
      print(`Created SIP domain: ${domain.domainName} (${domain.sid})`);
      state.sipDomainSid = domain.sid;
    } catch (e) {
      print(`Error creating SIP domain: ${e.message}`);
      print('You may need to create it manually in the Twilio console.');
      state.sipEnabled = false;
      return;
    }
  }

  // Create or find credential list
  print('Setting up credential list...');
  let credLists;
  try {
    credLists = await client.sip.credentialLists.list();
  } catch { credLists = []; }

  let credList = credLists.find(cl => cl.friendlyName === 'phone-to-email-sip');
  if (!credList) {
    credList = await client.sip.credentialLists.create({
      friendlyName: 'phone-to-email-sip',
    });
    print(`Created credential list: ${credList.sid}`);
  } else {
    print(`Found existing credential list: ${credList.sid}`);
  }

  // Map credential list to domain (if not already)
  try {
    const mappings = await client.sip
      .domains(state.sipDomainSid)
      .auth.registrations.credentialListMappings.list();
    const alreadyMapped = mappings.some(m => m.sid === credList.sid || m.credentialListSid === credList.sid);
    if (!alreadyMapped) {
      await client.sip
        .domains(state.sipDomainSid)
        .auth.registrations.credentialListMappings.create({
          credentialListSid: credList.sid,
        });
      print('Mapped credential list to SIP domain (registration).');
    }
  } catch (e) {
    print(`Note: Could not map credential list for registration: ${e.message}`);
  }

  // Also map for calls (IP Access Control is separate from registration)
  // Registration mapping handles SIP REGISTER; we also want to allow calls
  // Some setups need the credential list mapped under calls as well
  // This is optional and depends on the domain config

  // Create credentials for each phone number
  print('\nCreating SIP credentials for phone numbers...');
  const existingCreds = await client.sip
    .credentialLists(credList.sid)
    .credentials.list();

  state.sipCredentials = [];

  for (const n of state.numbers) {
    const username = n.number; // E.164 format
    const existing = existingCreds.find(c => c.username === username);

    if (existing) {
      print(`  ${username}: credential exists (password unchanged)`);
      state.sipCredentials.push({
        number: n.number,
        username,
        password: '(existing — not displayed)',
        existing: true,
      });
    } else {
      const password = generatePassword();
      try {
        await client.sip
          .credentialLists(credList.sid)
          .credentials.create({ username, password });
        print(`  ${username}: credential created`);
        state.sipCredentials.push({
          number: n.number,
          username,
          password,
          existing: false,
        });
      } catch (e) {
        print(`  ${username}: error creating credential — ${e.message}`);
      }
    }
  }

  // SIP inbound mode
  if (!nonInteractive) {
    print('\nSIP inbound mode:');
    print('  y — Incoming calls ring SIP client first, then fall back to voicemail');
    print('  n — Incoming calls go straight to voicemail (outbound SIP only)\n');
    const inbound = await ask('Enable SIP for incoming calls?', state.env.SIP_INBOUND || 'true');
    state.env.SIP_INBOUND = (inbound.toLowerCase() === 'y' || inbound === 'true') ? 'true' : 'false';

    const timeout = await ask('SIP dial timeout (seconds)', state.env.SIP_DIAL_TIMEOUT || '20');
    state.env.SIP_DIAL_TIMEOUT = timeout;
  } else {
    state.env.SIP_INBOUND = state.env.SIP_INBOUND || 'true';
    state.env.SIP_DIAL_TIMEOUT = state.env.SIP_DIAL_TIMEOUT || '20';
  }

  // Print SIP credentials summary
  const newCreds = state.sipCredentials.filter(c => !c.existing);
  if (newCreds.length > 0) {
    print('\n*** Save these SIP credentials — passwords cannot be retrieved later ***\n');
    print('  Server/Domain: ' + fullDomain);
    for (const c of newCreds) {
      print(`  Username: ${c.username}`);
      print(`  Password: ${c.password}`);
      print('');
    }
  }
}

// ---------------------------------------------------------------------------
// Step 7: Write config files
// ---------------------------------------------------------------------------

async function step7_writeConfig(state) {
  printBanner('Step 7: Writing Configuration');

  // Merge number configs
  const phoneConfig = { ...state.phoneConfig };
  for (const [num, cfg] of Object.entries(state.numberConfigs)) {
    if (Object.keys(cfg).length > 0) {
      phoneConfig[num] = { ...phoneConfig[num], ...cfg };
    } else if (!phoneConfig[num]) {
      // Number exists but has no overrides; don't add an empty entry
    }
  }

  writeEnvFile(state.env);
  print(`Wrote ${ENV_PATH}`);

  writePhoneConfig(phoneConfig);
  print(`Wrote ${PHONE_CONFIG_PATH}`);

  // Show summary
  print('\n.env contents:');
  for (const [k, v] of Object.entries(state.env)) {
    if (k === 'AUTH_TOKEN' && v) {
      print(`  ${k}=${v.slice(0, 4)}${'*'.repeat(Math.max(0, v.length - 4))}`);
    } else {
      print(`  ${k}=${v}`);
    }
  }

  if (Object.keys(phoneConfig).length > 0) {
    print('\nphone-config.private.json:');
    for (const [num, cfg] of Object.entries(phoneConfig)) {
      print(`  ${num}: ${JSON.stringify(cfg)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 8: Deploy
// ---------------------------------------------------------------------------

async function step8_deploy(state, nonInteractive) {
  printBanner('Step 8: Deploy to Twilio');

  // Determine regions needed
  const regionsNeeded = new Set();
  regionsNeeded.add(state.voiceRegion);
  regionsNeeded.add(state.smsRegion);

  for (const cfg of Object.values(state.numberConfigs)) {
    if (cfg.voiceRegion) regionsNeeded.add(cfg.voiceRegion);
    if (cfg.smsRegion) regionsNeeded.add(cfg.smsRegion);
  }
  if (state.sipEnabled && state.sipRegion) {
    regionsNeeded.add(state.sipRegion);
  }

  print(`Regions to deploy: ${[...regionsNeeded].join(', ')}\n`);

  // Check if twilio CLI is available
  const cliAvailable = checkTwilioCli();
  if (!cliAvailable) {
    print('The Twilio CLI is required for deployment but was not found.');
    print('Install it with: npm install -g twilio-cli');
    print('Then install the serverless plugin: twilio plugins:install @twilio-labs/plugin-serverless');
    print('\nAfter installing, run "npm run setup" again or deploy manually with "npm run deploy".\n');
    return;
  }

  if (!nonInteractive) {
    const proceed = await ask('Deploy now? (y/n)', 'y');
    if (proceed.toLowerCase() !== 'y') {
      print('\nSkipping deployment. Run "npm run deploy" later.\n');
      return;
    }
  }

  for (const region of regionsNeeded) {
    print(`\nDeploying to ${region}...`);

    const envVars = { ...process.env };
    if (region === 'ie1') {
      envVars.TWILIO_REGION = 'ie1';
      envVars.TWILIO_EDGE = 'dublin';
    } else {
      // us1 is default, no special env needed
      delete envVars.TWILIO_REGION;
      delete envVars.TWILIO_EDGE;
    }

    try {
      const result = spawnSync('twilio', ['serverless:deploy'], {
        cwd: __dirname,
        env: envVars,
        stdio: ['inherit', 'pipe', 'pipe'],
        encoding: 'utf8',
      });

      const output = (result.stdout || '') + (result.stderr || '');
      print(output);

      // Extract the deployment URL from output
      // Typical output includes: "https://phone-handling-1234.twil.io"
      const urlMatch = output.match(/https:\/\/[\w-]+\.twil\.io/);
      if (urlMatch) {
        state.deployUrls[region] = urlMatch[0];
        print(`Deployment URL for ${region}: ${state.deployUrls[region]}`);
      } else {
        print(`Warning: Could not extract deployment URL for ${region} from output.`);
        // Try to get it from the API
        const url = await getDeployedUrl(state, region);
        if (url) {
          state.deployUrls[region] = url;
          print(`Found deployment URL for ${region}: ${url}`);
        }
      }

      if (result.status !== 0) {
        print(`Warning: deployment to ${region} exited with code ${result.status}`);
      }
    } catch (e) {
      print(`Error deploying to ${region}: ${e.message}`);
    }
  }

  if (Object.keys(state.deployUrls).length > 0) {
    print('\nDeployment URLs:');
    for (const [region, url] of Object.entries(state.deployUrls)) {
      print(`  ${region}: ${url}`);
    }
  }
}

function checkTwilioCli() {
  try {
    const result = spawnSync('twilio', ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function getDeployedUrl(state, region) {
  try {
    const client = getTwilioClient(state.accountSid, state.authToken);
    const services = await client.serverless.v1.services.list();
    // Find the most recently deployed service
    for (const svc of services) {
      const environments = await client.serverless.v1
        .services(svc.sid)
        .environments.list();
      for (const env of environments) {
        if (env.domainName) {
          // Check if this matches the region
          if (region === 'ie1' && env.domainName.includes('ie1')) {
            return `https://${env.domainName}`;
          } else if (region === 'us1' && !env.domainName.includes('ie1')) {
            return `https://${env.domainName}`;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Step 9: Configure webhooks
// ---------------------------------------------------------------------------

async function step9_configureWebhooks(state, nonInteractive) {
  printBanner('Step 9: Configure Phone Numbers & SIP Domain');

  const client = getTwilioClient(state.accountSid, state.authToken);

  // Default URL is the us1 deployment (or the only one we have)
  const defaultUrl = state.deployUrls.us1 || state.deployUrls.ie1 || Object.values(state.deployUrls)[0];

  for (const n of state.numbers) {
    const cfg = state.numberConfigs[n.number] || {};
    const vr = cfg.voiceRegion || state.voiceRegion;
    const sr = cfg.smsRegion || state.smsRegion;

    const voiceUrl = (state.deployUrls[vr] || defaultUrl) + '/voice-response';
    const smsUrl = (state.deployUrls[sr] || defaultUrl) + '/sms-handler';

    const label = n.friendlyName !== n.number ? ` (${n.friendlyName})` : '';

    // Check if already correct
    if (n.voiceUrl === voiceUrl && n.smsUrl === smsUrl) {
      print(`${n.number}${label}: webhooks already configured correctly`);
      continue;
    }

    // Show what will change
    if (n.voiceUrl || n.smsUrl) {
      print(`${n.number}${label}:`);
      if (n.voiceUrl !== voiceUrl) {
        print(`  Voice: ${n.voiceUrl || '(none)'} → ${voiceUrl}`);
      }
      if (n.smsUrl !== smsUrl) {
        print(`  SMS:   ${n.smsUrl || '(none)'} → ${smsUrl}`);
      }
    } else {
      print(`${n.number}${label}: setting webhooks`);
      print(`  Voice: ${voiceUrl}`);
      print(`  SMS:   ${smsUrl}`);
    }

    if (!nonInteractive && (n.voiceUrl || n.smsUrl)) {
      const ok = await ask('  Update webhooks? (y/n)', 'y');
      if (ok.toLowerCase() !== 'y') {
        print('  Skipped.');
        continue;
      }
    }

    try {
      await client.incomingPhoneNumbers(n.sid).update({
        voiceUrl,
        voiceMethod: 'POST',
        smsUrl,
        smsMethod: 'POST',
      });
      print(`  Updated.`);
    } catch (e) {
      print(`  Error updating webhooks: ${e.message}`);
    }

    // Set voice inbound processing region
    if (VALID_REGIONS.includes(vr)) {
      try {
        await client.incomingPhoneNumbers(n.sid).update({
          voiceReceiveMode: 'voice',
        });
        // Note: Twilio's Inbound Processing Region is set at the account level
        // or via the number's voice region, which is handled by the webhook URL
        // pointing to the correct regional deployment
      } catch { /* region setting is best-effort */ }
    }
  }

  // Update SIP domain webhook if SIP is enabled
  if (state.sipEnabled && state.sipDomainSid) {
    const sipUrl = (state.deployUrls[state.sipRegion] || defaultUrl) + '/sip-outbound';
    print(`\nSIP domain (${state.sipDomain}):`);
    print(`  Voice URL: ${sipUrl}`);

    try {
      await client.sip.domains(state.sipDomainSid).update({
        voiceUrl: sipUrl,
        voiceMethod: 'POST',
      });
      print('  Updated.');
    } catch (e) {
      print(`  Error updating SIP domain: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 10: Summary
// ---------------------------------------------------------------------------

function step10_summary(state) {
  printBanner('Step 10: Setup Complete');

  print(`Account: ${state.accountSid}`);
  print(`Default voice region: ${state.voiceRegion}`);
  print(`Default SMS region:   ${state.smsRegion}`);

  if (Object.keys(state.deployUrls).length > 0) {
    print('\nDeployment URLs:');
    for (const [region, url] of Object.entries(state.deployUrls)) {
      print(`  ${region}: ${url}`);
    }
  }

  print('\nPhone numbers:');
  for (const n of state.numbers) {
    const cfg = state.numberConfigs[n.number] || {};
    const label = n.friendlyName !== n.number ? ` (${n.friendlyName})` : '';
    print(`  ${n.number}${label}`);
    if (cfg.forwardingEmail) print(`    Email: ${cfg.forwardingEmail}`);
    if (cfg.smsForwardNumber) print(`    SMS forward: ${cfg.smsForwardNumber}`);
    if (cfg.voiceRegion) print(`    Voice region: ${cfg.voiceRegion}`);
    if (cfg.smsRegion) print(`    SMS region: ${cfg.smsRegion}`);
  }

  if (state.emailEnabled) {
    print(`\nEmail: ${state.env.FROM_EMAIL} → ${state.env.FORWARDING_EMAIL}`);
  } else {
    print('\nEmail: disabled');
  }

  if (state.sipEnabled) {
    print(`\nSIP domain: ${state.sipDomain}`);
    print(`SIP inbound: ${state.env.SIP_INBOUND}`);
    print(`SIP dial timeout: ${state.env.SIP_DIAL_TIMEOUT}s`);

    const newCreds = state.sipCredentials.filter(c => !c.existing);
    if (newCreds.length > 0) {
      print('\nNew SIP credentials (save these!):');
      for (const c of newCreds) {
        print(`  ${c.username} / ${c.password}`);
      }
    }
  }

  print('\nUseful commands:');
  print('  npm run setup   — Run this wizard again');
  print('  npm run deploy  — Deploy functions to Twilio');
  print('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch(err => {
  console.error('Setup failed:', err);
  if (rl) rl.close();
  process.exit(1);
});
