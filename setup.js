#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { spawnSync } = require('child_process');

const {
  HELP_TEXT, REGIONS, VALID_REGIONS,
  ENV_PATH, SECRETS_PATH, PHONE_CONFIG_PATH,
  getEdgeForRegion, regionSupportsFeature, recommendRegion,
  loadEnvFile, loadSecretsFile, loadAllConfig, loadPhoneConfig,
  isSecretKey, writeEnvFile, writeSecretsFile, writePhoneConfig,
  generatePassword, parseArgs,
} = require('./lib/config');

const {
  getTwilioClient, getClientForRegion, getAnyClient,
  validateCredentials, listPhoneNumbers, listServerlessServices,
  listSipDomains, resolveRegionalCredentials, checkTwilioCli,
  getDeployedUrl,
} = require('./lib/twilio-api');

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

function askSecret(question, defaultVal) {
  const suffix = defaultVal ? ' [****]' : '';
  return new Promise(resolve => {
    // Close readline entirely so its stdin listeners can't echo input
    if (rl) { rl.close(); rl = null; }

    process.stdout.write(`${question}${suffix}: `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (data) => {
      // Iterate over each character — paste delivers multiple at once
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          initReadline();
          resolve(input.trim() || defaultVal || '');
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch === '\u0003') {
          process.exit(1);
        } else {
          input += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
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

function formatCredentialError(res) {
  let msg = res.error || 'Unknown error';
  if (res.code) msg += ` (code ${res.code})`;
  if (res.status) msg += ` [HTTP ${res.status}]`;
  if (res.domain) msg += `\n    Request to: ${res.domain}`;
  if (res.accountSid) msg += `\n    Account SID: ${res.accountSid}`;
  if (res.authMethod) msg += `\n    Auth: ${res.authMethod}`;
  return msg;
}

function printBanner(title) {
  print(`\n${'='.repeat(60)}`);
  print(`  ${title}`);
  print(`${'='.repeat(60)}\n`);
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
    secrets: loadSecretsFile(),
    allConfig: loadAllConfig(),
    phoneConfig: loadPhoneConfig(),
    accountSid: '',
    regionalCredentials: {},  // { us1: { apiKeySid, apiKeySecret } | { authToken }, ... }
    initialRegion: null,      // region of first valid credentials
    voiceRegion: 'us1',
    smsRegion: 'us1',
    regionsNeeded: new Set(),
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
    existingServices: {},  // { region: [services] }
    existingSipDomains: [],
    saveSecrets: false,    // whether user wants .secrets file
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
    await step7_writeConfig(state, nonInteractive);
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
// Step 1: Credentials — API keys recommended
// ---------------------------------------------------------------------------

async function step1_credentials(state, cliArgs, nonInteractive) {
  printBanner('Step 1: Twilio Account Credentials');

  print('Twilio requires per-region credentials. API keys are recommended');
  print('(standard keys, not restricted).\n');
  print('Create API keys at the Twilio Console:');
  print('  US1: https://console.twilio.com/ → Account → API keys & tokens');
  print('  IE1: https://console.ie1.twilio.com/ → Account → API keys & tokens');
  print('  AU1: https://console.au1.twilio.com/ → Account → API keys & tokens\n');
  print('You can also use an Auth Token per region (AUTH_TOKEN_US1, AUTH_TOKEN_IE1, etc.).\n');

  // Resolve Account SID
  let sid = cliArgs.accountSid || state.allConfig.ACCOUNT_SID || '';

  if (!nonInteractive) {
    if (sid) {
      print(`Found Account SID: ${sid}`);
      const keep = await ask('Keep this Account SID? (y/n)', 'y');
      if (keep.toLowerCase() !== 'y') sid = '';
    }
    if (!sid) {
      sid = await ask('Account SID');
    }
  }

  if (!sid) {
    print('Error: Account SID is required.');
    process.exit(1);
  }

  state.accountSid = sid;

  // Resolve regional credentials from CLI args / config files / env vars
  const preResolved = resolveRegionalCredentials(state.allConfig, cliArgs);
  state.regionalCredentials = preResolved;

  // If we already have credentials for at least one region, try to validate
  const existingRegions = Object.keys(preResolved);

  if (existingRegions.length > 0 && !nonInteractive) {
    print(`\nFound credentials for region(s): ${existingRegions.join(', ')}`);
    const keep = await ask('Keep existing credentials? (y/n)', 'y');
    if (keep.toLowerCase() !== 'y') {
      state.regionalCredentials = {};
    }
  }

  // Prompt for missing secrets and validate each region's credentials
  if (!nonInteractive) {
    for (const region of Object.keys(state.regionalCredentials)) {
      const creds = state.regionalCredentials[region];
      if (creds.apiKeySid && !creds.apiKeySecret && !creds.authToken) {
        // Have an API key SID but no secret — confirm SID and ask for secret
        let valid = false;
        while (!valid) {
          print(`\nAPI Key SID found for ${region}: ${creds.apiKeySid}`);
          const confirmedSid = await ask(`  Confirm API Key SID for ${region}`, creds.apiKeySid);
          creds.apiKeySid = confirmedSid;
          creds.apiKeySecret = await askSecret(`  API Key Secret for ${region}`);
          if (!creds.apiKeySecret) {
            print(`  No secret provided — removing ${region} credentials.`);
            delete state.regionalCredentials[region];
            break;
          }
          print(`  Validating credentials for ${region}...`);
          const res = await validateCredentials({
            accountSid: sid, apiKeySid: creds.apiKeySid,
            apiKeySecret: creds.apiKeySecret, region,
          });
          if (res.valid) {
            print(`  ${region}: valid (${res.friendlyName})`);
            creds._validated = true;
            valid = true;
          } else {
            print(`  ${region}: ${formatCredentialError(res)}`);
            const retry = await ask('  Try again? (y/n)', 'y');
            if (retry.toLowerCase() !== 'y') {
              print(`  Removing ${region} credentials.`);
              delete state.regionalCredentials[region];
              break;
            }
          }
        }
      }
    }
  }

  // If no credentials yet, prompt for initial credentials
  if (Object.keys(state.regionalCredentials).length === 0) {
    if (nonInteractive) {
      print('Error: No credentials found. Provide API key or auth token via CLI flags, env vars, or .secrets file.');
      process.exit(1);
    }

    let valid = false;
    while (!valid) {
      print('\nProvide credentials for your first region.\n');
      const authType = await ask('Use API key (k) or Auth Token (t)?', 'k');

      let region;
      if (authType.toLowerCase() === 't') {
        const token = await askSecret('Auth Token');
        region = await ask('Region for this token', 'us1');
        if (!VALID_REGIONS.includes(region)) {
          print(`Warning: "${region}" is not recognized, using us1.`);
          region = 'us1';
        }
        state.regionalCredentials[region] = { authToken: token };
      } else {
        const keySid = await ask('API Key SID');
        const keySecret = await askSecret('API Key Secret');
        region = await ask('Region for this key', 'us1');
        if (!VALID_REGIONS.includes(region)) {
          print(`Warning: "${region}" is not recognized, using us1.`);
          region = 'us1';
        }
        state.regionalCredentials[region] = { apiKeySid: keySid, apiKeySecret: keySecret };
      }

      print(`\nValidating credentials for ${region}...`);
      const res = await validateCredentials({
        accountSid: sid,
        apiKeySid: (state.regionalCredentials[region] || {}).apiKeySid,
        apiKeySecret: (state.regionalCredentials[region] || {}).apiKeySecret,
        authToken: (state.regionalCredentials[region] || {}).authToken,
        region,
      });

      if (res.valid) {
        print(`Authenticated as: ${res.friendlyName}`);
        state.regionalCredentials[region]._validated = true;
        state.initialRegion = region;
        valid = true;
      } else {
        print(`Invalid credentials for ${region}: ${formatCredentialError(res)}`);
        delete state.regionalCredentials[region];
      }
    }
  } else {
    state.initialRegion = existingRegions[0];
  }

  // Validate pre-resolved credentials that haven't been validated yet
  // (ones that had both SID+secret from config, or auth tokens)
  for (const region of Object.keys(state.regionalCredentials)) {
    const creds = state.regionalCredentials[region];
    if (creds._validated) continue;
    print(`Validating credentials for ${region}...`);
    const res = await validateCredentials({
      accountSid: sid,
      apiKeySid: creds.apiKeySid,
      apiKeySecret: creds.apiKeySecret,
      authToken: creds.authToken,
      region,
    });
    if (res.valid) {
      print(`  ${region}: valid (${res.friendlyName})`);
    } else {
      print(`  ${region}: ${formatCredentialError(res)}`);
      if (!nonInteractive) {
        const retry = await ask(`  Re-enter credentials for ${region}? (y/n)`, 'y');
        if (retry.toLowerCase() === 'y') {
          let retryValid = false;
          while (!retryValid) {
            const authType = await ask(`  Use API key (k) or Auth Token (t) for ${region}?`, 'k');
            if (authType.toLowerCase() === 't') {
              const token = await askSecret(`  Auth Token for ${region}`);
              state.regionalCredentials[region] = { authToken: token };
            } else {
              const keySid = await ask(`  API Key SID for ${region}`, creds.apiKeySid || '');
              const keySecret = await askSecret(`  API Key Secret for ${region}`);
              state.regionalCredentials[region] = { apiKeySid: keySid, apiKeySecret: keySecret };
            }
            print(`  Validating credentials for ${region}...`);
            const res2 = await validateCredentials({
              accountSid: sid,
              apiKeySid: (state.regionalCredentials[region]).apiKeySid,
              apiKeySecret: (state.regionalCredentials[region]).apiKeySecret,
              authToken: (state.regionalCredentials[region]).authToken,
              region,
            });
            if (res2.valid) {
              print(`  ${region}: valid (${res2.friendlyName})`);
              retryValid = true;
            } else {
              print(`  ${region}: ${formatCredentialError(res2)}`);
              const again = await ask('  Try again? (y/n)', 'y');
              if (again.toLowerCase() !== 'y') {
                delete state.regionalCredentials[region];
                break;
              }
            }
          }
        } else {
          delete state.regionalCredentials[region];
        }
      } else {
        delete state.regionalCredentials[region];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Detect existing setup
// ---------------------------------------------------------------------------

async function step2_detectExisting(state) {
  printBanner('Step 2: Checking Existing Configuration');

  const client = getAnyClient(state);
  if (!client) {
    print('No valid client available. Skipping detection.\n');
    return;
  }

  print('Querying Twilio API...\n');

  // Account-level queries (work from any region)
  const [sipDomains, numbers] = await Promise.all([
    listSipDomains(client),
    listPhoneNumbers(client),
  ]);

  state.existingSipDomains = sipDomains;
  state.numbers = numbers;

  // Serverless services are region-specific — query the initial region
  const initServices = await listServerlessServices(client);
  state.existingServices[state.initialRegion] = initServices;

  // Services
  if (initServices.length > 0) {
    print(`Serverless services (${state.initialRegion}):`);
    for (const s of initServices) {
      print(`  - ${s.friendlyName} (${s.sid})`);
    }
  } else {
    print(`No serverless services found in ${state.initialRegion}.`);
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

  const envKeys = Object.keys(state.env).filter(k => !isSecretKey(k));
  if (envKeys.length > 0) {
    print('\nExisting .env values detected — will pre-fill prompts.');
  }

  print('');
}

// ---------------------------------------------------------------------------
// Step 3: Consolidated region selection
// ---------------------------------------------------------------------------

async function step3_regions(state, cliArgs, nonInteractive) {
  printBanner('Step 3: Regions');

  // a) Display available regions
  print('Available regions:\n');
  for (const [id, info] of Object.entries(REGIONS)) {
    const features = Object.entries(info.features)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');
    print(`  ${id} — ${info.location} (${info.status})`);
    print(`         Features: ${features}`);
  }
  print('');

  // b) Auto-recommend per number
  const numberRegions = {};  // { number: { voice: region, sms: region } }

  if (state.numbers.length > 0) {
    print('Region recommendations per phone number:\n');
    for (const n of state.numbers) {
      const existing = state.phoneConfig[n.number] || {};
      const recVoice = recommendRegion(n.number, 'voice');
      const recSms = recommendRegion(n.number, 'sms');
      const label = n.friendlyName !== n.number ? ` (${n.friendlyName})` : '';
      print(`  ${n.number}${label}:`);
      print(`    Voice: ${recVoice} (recommended)  SMS: ${recSms} (recommended)`);

      numberRegions[n.number] = {
        voice: existing.voiceRegion || recVoice,
        sms: existing.smsRegion || recSms,
      };
    }
    print('');
  }

  // c) Ask user to confirm/adjust regions per number
  let defaultVoice = cliArgs.voiceRegion || state.env.VOICE_REGION || 'us1';
  let defaultSms = cliArgs.smsRegion || state.env.SMS_REGION || 'us1';

  if (!nonInteractive) {
    defaultVoice = await ask('Default voice region', defaultVoice);
    defaultSms = await ask('Default SMS region', defaultSms);

    if (!VALID_REGIONS.includes(defaultVoice)) {
      print(`Warning: "${defaultVoice}" is not recognized, using us1.`);
      defaultVoice = 'us1';
    }
    if (!VALID_REGIONS.includes(defaultSms)) {
      print(`Warning: "${defaultSms}" is not recognized, using us1.`);
      defaultSms = 'us1';
    }

    // Per-number region confirmation
    if (state.numbers.length > 0) {
      print('\nConfirm/adjust regions per phone number:');
      for (const n of state.numbers) {
        const rec = numberRegions[n.number] || { voice: defaultVoice, sms: defaultSms };
        const label = n.friendlyName !== n.number ? ` (${n.friendlyName})` : '';
        print(`\n  ${n.number}${label}:`);
        const vr = await ask('    Voice region', rec.voice);
        const sr = await ask('    SMS region', rec.sms);
        numberRegions[n.number] = {
          voice: VALID_REGIONS.includes(vr) ? vr : defaultVoice,
          sms: VALID_REGIONS.includes(sr) ? sr : defaultSms,
        };
      }
    }

    // SIP region
    if (!cliArgs.skipSip) {
      const existingDomain = state.env.SIP_DOMAIN || '';
      let sipRegionDefault = 'us1';
      if (existingDomain) {
        const match = existingDomain.match(/\.sip\.(\w+)\.twilio\.com$/);
        if (match) sipRegionDefault = match[1];
      }
      if (cliArgs.sipRegion) sipRegionDefault = cliArgs.sipRegion;
      const sr = await ask('SIP region (if using SIP)', sipRegionDefault);
      state.sipRegion = VALID_REGIONS.includes(sr) ? sr : 'us1';
    }
  } else {
    if (!VALID_REGIONS.includes(defaultVoice)) defaultVoice = 'us1';
    if (!VALID_REGIONS.includes(defaultSms)) defaultSms = 'us1';

    // Auto-assign regions for non-interactive
    for (const n of state.numbers) {
      const existing = state.phoneConfig[n.number] || {};
      numberRegions[n.number] = {
        voice: existing.voiceRegion || defaultVoice,
        sms: existing.smsRegion || defaultSms,
      };
    }

    if (cliArgs.sipRegion && VALID_REGIONS.includes(cliArgs.sipRegion)) {
      state.sipRegion = cliArgs.sipRegion;
    }
  }

  state.voiceRegion = defaultVoice;
  state.smsRegion = defaultSms;
  state.env.VOICE_REGION = defaultVoice;
  state.env.SMS_REGION = defaultSms;

  // Store per-number regions in numberConfigs for later steps
  for (const n of state.numbers) {
    if (!state.numberConfigs[n.number]) state.numberConfigs[n.number] = {};
    const nr = numberRegions[n.number];
    if (nr) {
      if (nr.voice !== defaultVoice) state.numberConfigs[n.number].voiceRegion = nr.voice;
      if (nr.sms !== defaultSms) state.numberConfigs[n.number].smsRegion = nr.sms;
    }
  }

  // d) Validate feature support
  for (const n of state.numbers) {
    const nr = numberRegions[n.number] || { voice: defaultVoice, sms: defaultSms };
    if (!regionSupportsFeature(nr.voice, 'voice')) {
      print(`Warning: ${nr.voice} does not support voice. ${n.number} falling back to us1.`);
      nr.voice = 'us1';
      state.numberConfigs[n.number].voiceRegion = 'us1';
    }
    if (!regionSupportsFeature(nr.sms, 'sms')) {
      // SMS may work through functions in that region even if not officially supported
      // Just warn, don't force fallback
      print(`Note: ${nr.sms} has limited SMS support for ${n.number}. SMS may use the functions deployment URL.`);
    }
  }

  // e) Collect regionsNeeded
  state.regionsNeeded.add(defaultVoice);
  state.regionsNeeded.add(defaultSms);
  for (const n of state.numbers) {
    const nr = numberRegions[n.number] || {};
    if (nr.voice) state.regionsNeeded.add(nr.voice);
    if (nr.sms) state.regionsNeeded.add(nr.sms);
  }
  if (state.sipRegion) state.regionsNeeded.add(state.sipRegion);

  print(`\nDefault voice region: ${defaultVoice}`);
  print(`Default SMS region:   ${defaultSms}`);
  print(`Regions needed: ${[...state.regionsNeeded].join(', ')}`);

  // f) Collect credentials for each needed region without credentials
  for (const region of state.regionsNeeded) {
    if (state.regionalCredentials[region]) continue;

    if (nonInteractive) {
      print(`Warning: No credentials for ${region}. Numbers using this region may not work.`);
      continue;
    }

    print(`\nCredentials needed for ${region}.`);
    print(`Create an API key at the Twilio Console for ${region}.`);

    let regionValid = false;
    while (!regionValid) {
      const authType = await ask(`  Use API key (k) or Auth Token (t) for ${region}?`, 'k');
      if (authType.toLowerCase() === 't') {
        const token = await askSecret(`  Auth Token for ${region}`);
        if (!token) {
          print(`  Skipping ${region} — numbers in this region will fall back.`);
          break;
        }
        state.regionalCredentials[region] = { authToken: token };
      } else {
        const keySid = await ask(`  API Key SID for ${region}`);
        const keySecret = await askSecret(`  API Key Secret for ${region}`);
        if (!keySid || !keySecret) {
          print(`  Skipping ${region} — numbers in this region will fall back.`);
          break;
        }
        state.regionalCredentials[region] = { apiKeySid: keySid, apiKeySecret: keySecret };
      }

      // Validate
      const creds = state.regionalCredentials[region];
      print(`  Validating credentials for ${region}...`);
      const res = await validateCredentials({
        accountSid: state.accountSid,
        apiKeySid: creds.apiKeySid,
        apiKeySecret: creds.apiKeySecret,
        authToken: creds.authToken,
        region,
      });
      if (res.valid) {
        print(`  ${region}: valid (${res.friendlyName})`);
        regionValid = true;
      } else {
        print(`  ${region}: ${formatCredentialError(res)}`);
        delete state.regionalCredentials[region];
        const retry = await ask('  Try again? (y/n)', 'y');
        if (retry.toLowerCase() !== 'y') {
          print(`  Numbers using ${region} will need to fall back to another region.`);
          break;
        }
      }
    }
  }

  // g) Check existing services across all credentialed regions
  for (const region of Object.keys(state.regionalCredentials)) {
    if (state.existingServices[region]) continue; // already checked
    const client = getClientForRegion(state, region);
    if (!client) continue;
    try {
      const services = await listServerlessServices(client);
      state.existingServices[region] = services;
      if (services.length > 0) {
        print(`\nServerless services in ${region}:`);
        for (const s of services) {
          print(`  - ${s.friendlyName} (${s.sid})`);
        }
      }
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Step 4: Phone number configuration (no region prompts)
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
  const globalAnswerUrl = state.env.ANSWER_MESSAGE_URL || '';
  const globalThankYouUrl = state.env.THANK_YOU_MESSAGE_URL || '';

  if (!nonInteractive) {
    print('For each number, configure per-number settings.');
    print('Leave blank to use the global default.\n');

    for (const n of state.numbers) {
      const existing = state.phoneConfig[n.number] || {};
      const current = state.numberConfigs[n.number] || {};
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
      const answerUrl = await ask(
        '  Answer message audio URL or asset path (e.g. /greeting.mp3)',
        existing.answerMessageUrl || ''
      );
      const thankYouUrl = await ask(
        '  Thank-you message audio URL or asset path (e.g. /thankyou.mp3)',
        existing.thankYouMessageUrl || ''
      );

      // Merge with region settings already in numberConfigs from Step 3
      const cfg = { ...current };
      if (email && email !== '(global)' && email !== globalEmail) cfg.forwardingEmail = email;
      if (smsForward && smsForward !== globalSmsForward) cfg.smsForwardNumber = smsForward;
      if (answerName && answerName !== globalAnswerName) cfg.answerMessageName = answerName;
      if (answerUrl && answerUrl !== globalAnswerUrl) cfg.answerMessageUrl = answerUrl;
      if (thankYouUrl && thankYouUrl !== globalThankYouUrl) cfg.thankYouMessageUrl = thankYouUrl;

      state.numberConfigs[n.number] = cfg;
      print('');
    }
  } else {
    // Non-interactive: preserve existing config, merge with region configs from Step 3
    for (const n of state.numbers) {
      const existing = state.phoneConfig[n.number] || {};
      const current = state.numberConfigs[n.number] || {};
      state.numberConfigs[n.number] = { ...existing, ...current };
    }
  }

  print('Per-number configuration:');
  for (const n of state.numbers) {
    const cfg = state.numberConfigs[n.number];
    if (cfg && Object.keys(cfg).length > 0) {
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

  let mailjetKey = cliArgs.mailjetKey || state.allConfig.MAILJET_API_KEY || '';
  let mailjetSecret = cliArgs.mailjetSecret || state.allConfig.MAILJET_API_SECRET || '';
  let forwardingEmail = cliArgs.forwardingEmail || state.env.FORWARDING_EMAIL || '';
  let fromEmail = cliArgs.fromEmail || state.env.FROM_EMAIL || '';

  if (!nonInteractive) {
    mailjetKey = await askSecret('Mailjet API key (blank to skip email)', mailjetKey);

    if (mailjetKey) {
      mailjetSecret = await askSecret('Mailjet API secret', mailjetSecret);
      fromEmail = await ask('Sender email address (FROM_EMAIL)', fromEmail);
      forwardingEmail = await ask('Default forwarding email (FORWARDING_EMAIL)', forwardingEmail);
    }
  }

  state.emailEnabled = !!(mailjetKey && mailjetSecret);
  state.mailjetKey = mailjetKey;
  state.mailjetSecret = mailjetSecret;
  state.env.FORWARDING_EMAIL = forwardingEmail;
  state.env.FROM_EMAIL = fromEmail;

  if (state.emailEnabled) {
    print(`\nEmail forwarding: enabled (${fromEmail} → ${forwardingEmail})`);
  } else {
    print('\nEmail forwarding: disabled');
    print('Note: voicemail recordings will not be delivered without email configured.');
  }

  // Also prompt for answer message / thank you message URLs — but skip any
  // parameter that every phone number already has configured per-number,
  // since the global value would never be used at runtime.
  if (!nonInteractive) {
    const allNumbersHave = (field) =>
      state.numbers.length > 0 &&
      state.numbers.every(n => {
        const cfg = state.numberConfigs[n.number];
        return cfg && cfg[field];
      });

    const needAnswerUrl = !allNumbersHave('answerMessageUrl');
    const needAnswerName = !allNumbersHave('answerMessageName');
    const needThankYouUrl = !allNumbersHave('thankYouMessageUrl');

    if (needAnswerUrl || needAnswerName || needThankYouUrl) {
      print('');
      if (needAnswerUrl) {
        const answerUrl = await ask('Answer message audio URL (optional)', state.env.ANSWER_MESSAGE_URL || '');
        state.env.ANSWER_MESSAGE_URL = answerUrl;
      }
      if (needAnswerName) {
        const answerName = await ask('Answer message name (default greeting name)', state.env.ANSWER_MESSAGE_NAME || '');
        state.env.ANSWER_MESSAGE_NAME = answerName;
      }
      if (needThankYouUrl) {
        const thankYouUrl = await ask('Thank-you message audio URL (optional)', state.env.THANK_YOU_MESSAGE_URL || '');
        state.env.THANK_YOU_MESSAGE_URL = thankYouUrl;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: SIP setup (region already chosen in Step 3)
// ---------------------------------------------------------------------------

async function step6_sip(state, cliArgs, nonInteractive) {
  printBanner('Step 6: SIP Softphone Setup (Optional)');

  print('SIP lets you answer calls on a softphone (e.g. Zoiper) and make');
  print('outbound calls through your Twilio numbers.\n');

  if (cliArgs.skipSip) {
    print('(Skipped via --skip-sip flag)\n');
    state.sipEnabled = false;
    return;
  }

  let sipDomainName = cliArgs.sipDomainName || '';
  let sipRegion = state.sipRegion;

  // Try to detect existing SIP domain from env or API
  const existingDomain = state.env.SIP_DOMAIN || '';
  if (existingDomain) {
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
    print(`SIP region: ${sipRegion} (configured in Step 3)`);
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

  // Use the regional client for SIP operations
  let client = getClientForRegion(state, sipRegion);
  if (!client) {
    // Fall back to any available client (SIP domains are account-level)
    client = getAnyClient(state);
  }
  if (!client) {
    print('Error: No valid client available for SIP setup.');
    state.sipEnabled = false;
    return;
  }

  // Create or find existing SIP domain — re-fetch with the regional client
  // since the list from Step 2 may have been fetched with a different client.
  print('Checking for existing SIP domain...');
  let domain = state.existingSipDomains.find(d => d.domainName === fullDomain);
  if (!domain) {
    try {
      const domains = await client.sip.domains.list();
      domain = domains.find(d => d.domainName === fullDomain);
    } catch { /* ignore — will attempt to create below */ }
  }

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
      if (/already exists/i.test(e.message)) {
        // Domain exists but wasn't found via the list API (can happen with
        // API-key credentials).  On a re-run the credential mappings and
        // webhooks from the previous run are still in place, so it's safe
        // to continue without the SID.
        print(`SIP domain ${fullDomain} already exists.`);
      } else {
        print(`Error creating SIP domain: ${e.message}`);
        print('You may need to create it manually in the Twilio console.');
        state.sipEnabled = false;
        return;
      }
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
  if (state.sipDomainSid) {
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
  }

  // Create credentials for each phone number
  print('\nCreating SIP credentials for phone numbers...');
  const existingCreds = await client.sip
    .credentialLists(credList.sid)
    .credentials.list();

  state.sipCredentials = [];

  for (const n of state.numbers) {
    const username = n.number;
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
// Step 7: Write config files — secrets separated
// ---------------------------------------------------------------------------

async function step7_writeConfig(state, nonInteractive) {
  printBanner('Step 7: Writing Configuration');

  // Merge number configs
  const phoneConfig = { ...state.phoneConfig };
  for (const [num, cfg] of Object.entries(state.numberConfigs)) {
    if (Object.keys(cfg).length > 0) {
      phoneConfig[num] = { ...phoneConfig[num], ...cfg };
    }
  }

  // Build secrets object
  const secrets = {};
  secrets.ACCOUNT_SID = state.accountSid;
  for (const [region, creds] of Object.entries(state.regionalCredentials)) {
    const upper = region.toUpperCase();
    if (creds.apiKeySid) secrets[`API_KEY_SID_${upper}`] = creds.apiKeySid;
    if (creds.apiKeySecret) secrets[`API_KEY_SECRET_${upper}`] = creds.apiKeySecret;
    if (creds.authToken) secrets[`AUTH_TOKEN_${upper}`] = creds.authToken;
  }
  if (state.mailjetKey) secrets.MAILJET_API_KEY = state.mailjetKey;
  if (state.mailjetSecret) secrets.MAILJET_API_SECRET = state.mailjetSecret;

  // Ask about .secrets file
  let saveSecrets = false;
  if (!nonInteractive) {
    const answer = await ask('Save credentials to .secrets file? (y/n)', 'y');
    saveSecrets = answer.toLowerCase() === 'y';
  } else {
    // In non-interactive mode, save .secrets if we have credentials
    saveSecrets = Object.keys(secrets).length > 0;
  }
  state.saveSecrets = saveSecrets;

  // Check if existing .env has secrets that need migrating
  const existingEnv = loadEnvFile();
  const envSecrets = {};
  for (const [k, v] of Object.entries(existingEnv)) {
    if (isSecretKey(k) && v) {
      envSecrets[k] = v;
    }
  }

  // Write .env (non-secret config only)
  writeEnvFile(state.env);
  print(`Wrote ${ENV_PATH} (non-secret config)`);

  if (saveSecrets) {
    // Merge any existing .env secrets into .secrets if migrating
    const allSecrets = { ...envSecrets, ...secrets };
    writeSecretsFile(allSecrets);
    print(`Wrote ${SECRETS_PATH} (credentials)`);

    if (Object.keys(envSecrets).length > 0) {
      print('  Migrated secrets from .env to .secrets.');
    }
  } else {
    if (Object.keys(secrets).length > 0) {
      print('\nCredentials NOT saved to file. Set these environment variables:');
      for (const [k, v] of Object.entries(secrets)) {
        const display = k.includes('SECRET') || k.includes('TOKEN')
          ? `${v.slice(0, 4)}${'*'.repeat(Math.max(0, v.length - 4))}`
          : v;
        print(`  export ${k}=${display}`);
      }
    }
  }

  writePhoneConfig(phoneConfig);
  print(`Wrote ${PHONE_CONFIG_PATH}`);

  // Show .env summary
  print('\n.env contents:');
  const envContents = loadEnvFile();
  for (const [k, v] of Object.entries(envContents)) {
    print(`  ${k}=${v}`);
  }

  if (Object.keys(phoneConfig).length > 0) {
    print('\nphone-config.private.json:');
    for (const [num, cfg] of Object.entries(phoneConfig)) {
      print(`  ${num}: ${JSON.stringify(cfg)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 8: Deploy — regional auth via env vars
// ---------------------------------------------------------------------------

async function step8_deploy(state, nonInteractive) {
  printBanner('Step 8: Deploy to Twilio');

  // Filter to regions that support functions
  const deployRegions = [...state.regionsNeeded].filter(r => {
    if (!regionSupportsFeature(r, 'functions')) {
      print(`Skipping ${r} — does not support serverless functions.`);
      print(`  Numbers using ${r} should point webhooks at a different region's deployment.\n`);
      return false;
    }
    return true;
  });

  if (deployRegions.length === 0) {
    print('No regions to deploy to.\n');
    return;
  }

  print(`Regions to deploy: ${deployRegions.join(', ')}\n`);

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

  for (const region of deployRegions) {
    print(`\nDeploying to ${region}...`);

    const creds = state.regionalCredentials[region];
    if (!creds) {
      print(`  No credentials for ${region}, skipping deployment.`);
      continue;
    }

    const envVars = { ...process.env };

    // Set authentication env vars for the twilio CLI subprocess
    envVars.TWILIO_ACCOUNT_SID = state.accountSid;
    if (creds.apiKeySid && creds.apiKeySecret) {
      envVars.TWILIO_API_KEY = creds.apiKeySid;
      envVars.TWILIO_API_SECRET = creds.apiKeySecret;
    } else if (creds.authToken) {
      envVars.TWILIO_AUTH_TOKEN = creds.authToken;
      // Clear API key vars in case they're set in the environment
      delete envVars.TWILIO_API_KEY;
      delete envVars.TWILIO_API_SECRET;
    }

    // Set region/edge
    const edge = getEdgeForRegion(region);
    if (region !== 'us1') {
      envVars.TWILIO_REGION = region;
      if (edge) envVars.TWILIO_EDGE = edge;
    } else {
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
      const urlMatch = output.match(/https:\/\/[\w-]+\.twil\.io/);
      if (urlMatch) {
        state.deployUrls[region] = urlMatch[0];
        print(`Deployment URL for ${region}: ${state.deployUrls[region]}`);
      } else {
        print(`Warning: Could not extract deployment URL for ${region} from output.`);
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

// ---------------------------------------------------------------------------
// Step 9: Configure webhooks — use regional client per phone number
// ---------------------------------------------------------------------------

async function step9_configureWebhooks(state, nonInteractive) {
  printBanner('Step 9: Configure Phone Numbers & SIP Domain');

  // Default URL is the us1 deployment (or the only one we have)
  const defaultUrl = state.deployUrls.us1 || state.deployUrls.ie1 || Object.values(state.deployUrls)[0];

  for (const n of state.numbers) {
    const cfg = state.numberConfigs[n.number] || {};
    const vr = cfg.voiceRegion || state.voiceRegion;
    const sr = cfg.smsRegion || state.smsRegion;

    // For webhook URLs, use the deployment in the number's voice/SMS region.
    // If that region doesn't have a deployment (e.g. no functions support),
    // fall back to the nearest region that does.
    const voiceDeployRegion = state.deployUrls[vr] ? vr : Object.keys(state.deployUrls)[0];
    const smsDeployRegion = state.deployUrls[sr] ? sr : Object.keys(state.deployUrls)[0];

    const voiceUrl = (state.deployUrls[voiceDeployRegion] || defaultUrl) + '/voice-response';
    const smsUrl = (state.deployUrls[smsDeployRegion] || defaultUrl) + '/sms-handler';

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

    // Use the regional client for this number's voice region to update webhooks.
    // Phone number webhook configuration is region-specific for routing.
    let client = getClientForRegion(state, vr);
    if (!client) {
      // Fall back to any available client
      client = getAnyClient(state);
    }
    if (!client) {
      print(`  Warning: No client available for ${vr}, skipping webhook update.`);
      continue;
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
  }

  // Update SIP domain webhook if SIP is enabled
  if (state.sipEnabled && state.sipDomainSid) {
    const sipDeployRegion = state.deployUrls[state.sipRegion]
      ? state.sipRegion
      : Object.keys(state.deployUrls)[0];
    const sipUrl = (state.deployUrls[sipDeployRegion] || defaultUrl) + '/sip-outbound';
    print(`\nSIP domain (${state.sipDomain}):`);
    print(`  Voice URL: ${sipUrl}`);

    let client = getClientForRegion(state, state.sipRegion);
    if (!client) client = getAnyClient(state);
    if (!client) {
      print('  Warning: No client available for SIP domain update.');
    } else {
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
}

// ---------------------------------------------------------------------------
// Step 10: Summary
// ---------------------------------------------------------------------------

function step10_summary(state) {
  printBanner('Step 10: Setup Complete');

  print(`Account: ${state.accountSid}`);
  print(`Default voice region: ${state.voiceRegion}`);
  print(`Default SMS region:   ${state.smsRegion}`);

  // Regional credential status
  print('\nCredentials:');
  for (const region of VALID_REGIONS) {
    const creds = state.regionalCredentials[region];
    if (creds) {
      const type = creds.apiKeySid ? 'API key' : 'Auth Token';
      print(`  ${region}: ${type}`);
    } else if (state.regionsNeeded.has(region)) {
      print(`  ${region}: MISSING (needed)`);
    }
  }

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

  if (state.saveSecrets) {
    print(`\nCredentials saved to: ${SECRETS_PATH}`);
  } else {
    print('\nCredentials: set via environment variables (not saved to file)');
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
