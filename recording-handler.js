exports.handler = function(context, event, callback) {
  // Log recording information
  console.log(`Recording received from ${event.From} to ${event.To}, CallSid: ${event.CallSid}, Duration: ${event.RecordingDuration}s`);
  
  // Return empty TwiML response
  const twiml = new Twilio.twiml.VoiceResponse();
  callback(null, twiml);
};