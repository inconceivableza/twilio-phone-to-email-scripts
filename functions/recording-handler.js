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
  // Log recording information
  console.log(`Recording received from ${event.From} to ${event.To}, CallSid: ${event.CallSid}, Duration: ${event.RecordingDuration}s`);
  // console.log("Recording event information follows:");
  // JSON.stringify(event, null, 4).split('\n').forEach(line => console.log(line));

  const numberConfig = getNumberConfig(event.To);

  // Return TwiML response with a thank you message
  const twiml = new Twilio.twiml.VoiceResponse();
  const thankYouUrl = resolveAssetUrl(context, numberConfig.thankYouMessageUrl || context.THANK_YOU_MESSAGE_URL);
  if (thankYouUrl) {
    console.log("Playing audio thank you message");
    twiml.play(thankYouUrl);
  } else {
    console.log("Generating audio thank you speech");
    twiml.say('Thank you for your message. Goodbye.');
  }
  callback(null, twiml);
};