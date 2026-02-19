/**
 * Extracts an E.164 phone number from a SIP URI.
 * e.g. "sip:+15551234567@domain.com" → "+15551234567"
 */
function extractE164(sipUri) {
  const match = sipUri && sipUri.match(/sip:(\+?\d+)@/);
  return match ? match[1] : null;
}

exports.handler = function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  const toNumber = extractE164(event.To);
  const callerId = extractE164(event.From);

  if (!toNumber) {
    console.error(`Could not extract destination number from: ${event.To}`);
    twiml.say('Sorry, the number you dialed could not be understood.');
    callback(null, twiml);
    return;
  }

  console.log(`SIP outbound: ${callerId || 'unknown'} → ${toNumber}`);

  const dialAttrs = { answerOnBridge: true };
  if (callerId) {
    dialAttrs.callerId = callerId;
  }

  const dial = twiml.dial(dialAttrs);
  dial.number(toNumber);

  callback(null, twiml);
};
