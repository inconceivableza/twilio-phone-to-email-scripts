'use strict';

const { spawnSync } = require('child_process');
const { getEdgeForRegion, VALID_REGIONS } = require('./config');

// ---------------------------------------------------------------------------
// Twilio API helpers — per-region client registry
// ---------------------------------------------------------------------------

const twilioClients = {};

function getTwilioClient({ accountSid, apiKeySid, apiKeySecret, authToken, region }) {
  const cacheKey = region || 'default';
  if (twilioClients[cacheKey]) return twilioClients[cacheKey];

  const twilio = require('twilio');
  const edge = getEdgeForRegion(region);
  const opts = {};
  // Always set region + edge so the SDK targets the correct regional API
  // endpoint (e.g. api.dublin.ie1.twilio.com, api.ashburn.us1.twilio.com).
  if (region) opts.region = region;
  if (edge) opts.edge = edge;

  let client;
  if (apiKeySid && apiKeySecret) {
    opts.accountSid = accountSid;
    client = twilio(apiKeySid, apiKeySecret, opts);
  } else if (authToken) {
    client = twilio(accountSid, authToken, opts);
  } else {
    throw new Error(`No credentials available for region ${region || 'default'}`);
  }

  twilioClients[cacheKey] = client;
  return client;
}

function getClientForRegion(state, region) {
  const creds = state.regionalCredentials[region];
  if (!creds) return null;
  return getTwilioClient({
    accountSid: state.accountSid,
    apiKeySid: creds.apiKeySid,
    apiKeySecret: creds.apiKeySecret,
    authToken: creds.authToken,
    region,
  });
}

function getAnyClient(state) {
  // Return a client from the initial region, or any region with credentials
  if (state.initialRegion) {
    return getClientForRegion(state, state.initialRegion);
  }
  for (const region of Object.keys(state.regionalCredentials)) {
    const client = getClientForRegion(state, region);
    if (client) return client;
  }
  return null;
}

async function validateCredentials({ accountSid, apiKeySid, apiKeySecret, authToken, region }) {
  // Build diagnostic info for error reporting
  const edge = getEdgeForRegion(region);
  const domain = edge && region
    ? `api.${edge}.${region}.twilio.com`
    : 'api.twilio.com';
  let authMethod;
  if (apiKeySid && apiKeySecret) {
    authMethod = `API Key SID (${apiKeySid}) + API Key Secret`;
  } else if (authToken) {
    authMethod = 'Account SID + Auth Token';
  } else {
    authMethod = '(none)';
  }

  try {
    const client = getTwilioClient({ accountSid, apiKeySid, apiKeySecret, authToken, region });

    // Try fetching the account for the friendly name. Standard API keys
    // cannot access /Accounts, so fall back to listing phone numbers
    // which any key type can do.
    let friendlyName;
    try {
      const account = await client.api.v2010.accounts(accountSid).fetch();
      friendlyName = account.friendlyName;
    } catch (accountErr) {
      if (accountErr.status === 401 || accountErr.code === 20003) {
        // Standard key — verify credentials via a permitted endpoint
        await client.incomingPhoneNumbers.list({ limit: 1 });
        friendlyName = accountSid;
      } else {
        throw accountErr;
      }
    }

    return { valid: true, friendlyName };
  } catch (e) {
    // Remove cached client on failure
    delete twilioClients[region || 'default'];
    const result = { valid: false, error: e.message, domain, authMethod, accountSid };
    if (e.code) result.code = e.code;
    if (e.status) result.status = e.status;
    return result;
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
// Credential resolution helpers
// ---------------------------------------------------------------------------

function resolveRegionalCredentials(allConfig, cliArgs) {
  // Build per-region credentials from CLI args, .secrets, .env, and process.env
  const creds = {};

  for (const region of VALID_REGIONS) {
    const upper = region.toUpperCase();
    const entry = {};

    // API Key SID for this region (CLI wins over config)
    const cliKeySid = cliArgs[`apiKeySid${region.charAt(0).toUpperCase()}${region.slice(1)}`];
    const cliKeySecret = cliArgs[`apiKeySecret${region.charAt(0).toUpperCase()}${region.slice(1)}`];

    entry.apiKeySid = cliKeySid || allConfig[`API_KEY_SID_${upper}`] || '';
    entry.apiKeySecret = cliKeySecret || allConfig[`API_KEY_SECRET_${upper}`] || '';
    entry.authToken = cliArgs[`authToken${region.charAt(0).toUpperCase()}${region.slice(1)}`]
      || allConfig[`AUTH_TOKEN_${upper}`] || '';

    // Include entries with a lone API key SID (no secret) so the
    // interactive wizard can use the SID as a default and prompt for
    // the missing secret.
    if (entry.apiKeySid || entry.authToken) {
      creds[region] = entry;
    }
  }

  // Handle generic --api-key-sid / --api-key-secret / --api-key-region
  if (cliArgs.apiKeySid) {
    const region = cliArgs.apiKeyRegion || 'us1';
    if (!creds[region]) creds[region] = {};
    creds[region].apiKeySid = cliArgs.apiKeySid;
    if (cliArgs.apiKeySecret) {
      creds[region].apiKeySecret = cliArgs.apiKeySecret;
    }
  }

  return creds;
}

// ---------------------------------------------------------------------------
// CLI & deployment helpers
// ---------------------------------------------------------------------------

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
    const client = getClientForRegion(state, region);
    if (!client) return null;
    const services = await client.serverless.v1.services.list();
    for (const svc of services) {
      const environments = await client.serverless.v1
        .services(svc.sid)
        .environments.list();
      for (const env of environments) {
        if (env.domainName) {
          return `https://${env.domainName}`;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getTwilioClient,
  getClientForRegion,
  getAnyClient,
  validateCredentials,
  listPhoneNumbers,
  listServerlessServices,
  listSipDomains,
  resolveRegionalCredentials,
  checkTwilioCli,
  getDeployedUrl,
};
