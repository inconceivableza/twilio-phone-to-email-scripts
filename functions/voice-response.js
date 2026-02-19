function resolveAssetUrl(context, url) {
  if (!url) return null;
  if (url.startsWith('/')) return `https://${context.DOMAIN_NAME}${url}`;
  return url;
}

function getNumberConfig(toNumber) {
  try {
    const asset = Runtime.getAssets()['/phone-config.json'];
    if (asset) {
      return JSON.parse(asset.open())[toNumber] || {};
    }
  } catch (e) { /* config missing or invalid */ }
  return {};
}

exports.handler = function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const numberConfig = getNumberConfig(event.To);

  const sipEnabled = context.SIP_DOMAIN && context.SIP_INBOUND !== 'false';
  const emailConfigured = context.MAILJET_API_KEY && context.MAILJET_API_SECRET
    && context.FROM_EMAIL && (numberConfig.forwardingEmail || context.FORWARDING_EMAIL);

  if (sipEnabled) {
    // Ring the SIP client first; if unanswered, fall back to voicemail
    const timeout = parseInt(context.SIP_DIAL_TIMEOUT, 10) || 20;
    const sipUri = `sip:${event.To}@${context.SIP_DOMAIN}`;
    console.log(`Dialing SIP: ${sipUri} (timeout ${timeout}s)`);

    const dial = twiml.dial({
      timeout: timeout,
      action: '/sip-voicemail-fallback',
      callerId: event.From
    });
    dial.sip(sipUri);
  } else if (emailConfigured) {
    // Voicemail path — only if email is configured to deliver the message
    const answerUrl = resolveAssetUrl(context, numberConfig.answerMessageUrl || context.ANSWER_MESSAGE_URL);
    if (answerUrl) {
      console.log("Playing audio answer message");
      twiml.play(answerUrl);
    } else {
      console.log("Generating audio answer speech");
      const name = numberConfig.answerMessageName || context.ANSWER_MESSAGE_NAME || 'us';
      twiml.say('Thank you for calling ' + name + '. Please leave a message after the tone. Press star when finished.');
    }

    twiml.record({
      action: '/recording-handler',
      transcribeCallback: '/transcription-handler',
      maxLength: 300,
      playBeep: true,
      transcribe: true,
      finishOnKey: '*'
    });
  } else {
    // No SIP and no email configured — cannot take a message
    console.log("No email configured; not taking a message");
    twiml.say('Sorry, we are unable to take your call right now. Please try again later.');
    twiml.hangup();
  }

  callback(null, twiml);
};