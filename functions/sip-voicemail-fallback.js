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
  const { isEmailConfigured } = require(Runtime.getAssets()['/email-helper.js'].path);
  const twiml = new Twilio.twiml.VoiceResponse();
  const numberConfig = getNumberConfig(event.To);
  const status = event.DialCallStatus;
  console.log(`SIP dial result: ${status}`);

  const emailConfigured = isEmailConfigured(context, numberConfig.forwardingEmail || context.FORWARDING_EMAIL);

  if (status === 'completed') {
    // Call was answered and has ended; nothing more to do
    twiml.hangup();
  } else if (emailConfigured) {
    // SIP unavailable — fall back to voicemail (only if email is configured)
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
    // No email configured — cannot take a message
    console.log("No email configured; not taking a message");
    twiml.say('Sorry, we are unable to take your call right now. Please try again later.');
    twiml.hangup();
  }

  callback(null, twiml);
};
