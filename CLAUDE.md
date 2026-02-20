# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Twilio Serverless Functions that forward voicemails (with transcription and recording attachment) and SMS to email via Mailjet. Optionally supports SIP softphone (e.g. Zoiper) for answering/making calls. Supports multiple phone numbers per account with per-number configuration.

## Instructions for Claude

Never read the contents of any file matching *.private.json

## Commands

- `npm run setup` — Interactive setup wizard (credentials, email, SIP, deploy, webhooks)
- `npm run deploy` — Deploy functions to Twilio (`twilio serverless:deploy`)
- `TWILIO_REGION=ie1 TWILIO_EDGE=dublin npm run deploy` — Deploy to Dublin region
- `node setup.js --help` — Show CLI flags for non-interactive/automated setup

No test suite or linter is configured.

## Architecture

### Runtime Environment

Functions run in Twilio's serverless environment, not Node.js directly. The runtime provides:
- Global `Twilio` object (for `Twilio.twiml.VoiceResponse()`, `Twilio.twiml.MessagingResponse()`)
- Global `Runtime` object (for `Runtime.getAssets()`)
- `context` parameter contains all `.env` variables plus `DOMAIN_NAME` and `getTwilioClient()`
- `event` parameter contains webhook POST parameters from Twilio

All functions use the signature: `exports.handler = function(context, event, callback)`

### Call Flow

```
Incoming call → voice-response.js
  ├─ SIP enabled? → Dial SIP client → answered? → done
  │                                  → not answered? → sip-voicemail-fallback.js → voicemail
  ├─ Email configured? → voicemail greeting → record
  └─ Neither? → "unable to take your call" → hangup

Recording complete → recording-handler.js (plays thank-you message)
Transcription complete → transcription-handler.js (downloads .mp3, emails via Mailjet)

Incoming SMS → sms-handler.js (emails via Mailjet + optionally forwards to another number)

Outbound SIP call → sip-outbound.js (extracts E.164 from SIP URI, bridges to PSTN)
```

### Per-Number Configuration

`assets/phone-config.private.json` maps E.164 numbers to per-number overrides. On disk it's `phone-config.private.json` but in the Twilio runtime it's accessed as `/phone-config.json` via `Runtime.getAssets()`. Missing fields fall back to global `.env` values.

### Shared Patterns

`getNumberConfig(toNumber)` and `resolveAssetUrl(context, url)` are duplicated in `voice-response.js`, `recording-handler.js`, `sip-voicemail-fallback.js`, and `sms-handler.js`. Changes to these helpers must be applied to each file.

### Setup Wizard

`setup.js` is a 10-step interactive wizard that handles the full provisioning lifecycle: credential validation, Twilio API discovery, region selection, per-number config, Mailjet setup, SIP domain/credential creation, config file generation, deployment, and webhook configuration. It supports `--non-interactive` mode with CLI flags.

## Key Dependencies

- `node-mailjet` — Email sending (Mailjet API v3.1)
- `axios` — Downloads voicemail recordings as MP3 for email attachment
- `twilio` (devDependency) — Used only by `setup.js` for API calls; the runtime provides its own Twilio client
