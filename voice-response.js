exports.handler = function(context, event, callback) {
  // Create a TwiML response
  const twiml = new Twilio.twiml.VoiceResponse();
  
  // Add a greeting
  twiml.say('Thank you for calling ' + context.ANSWER_MESSAGE_NAME +  '. Please leave a message after the tone. Press star when finished.');
  
  // Configure recording with transcription
  twiml.record({
    action: `/recording-handler`,
    transcribeCallback: `/transcription-handler`,
    maxLength: 300,
    playBeep: true,
    transcribe: true,
    finishOnKey: '*'
  });
  
  twiml.say('Thank you for your message. Goodbye.');
  
  // Return the TwiML response
  callback(null, twiml);
};