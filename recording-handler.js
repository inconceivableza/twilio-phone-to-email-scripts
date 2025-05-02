exports.handler = function(context, event, callback) {
  // Log recording information
  console.log(`Recording received from ${event.From} to ${event.To}, CallSid: ${event.CallSid}, Duration: ${event.RecordingDuration}s`);
  console.log("Recording event information follows:");
  JSON.stringify(event, null, 4).split('\n').forEach(line => console.log(line));

  
  // Return TwiML response with a thank you message
  const twiml = new Twilio.twiml.VoiceResponse();
  if (context.THANK_YOU_MESSAGE_URL) {
    console.log("Playing audio thank you message");
    twiml.play(context.THANK_YOU_MESSAGE_URL);
  } else {
    console.log("Generating audio thank you speech");
    twiml.say('Thank you for your message. Goodbye.');
  }
  callback(null, twiml);
};