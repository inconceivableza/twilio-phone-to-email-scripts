exports.handler = function(context, event, callback) {
  // Create a TwiML response
  const twiml = new Twilio.twiml.VoiceResponse();
  
  if (context.ANSWER_MESSAGE_URL) {
    console.log("Playing audio answer message");
    twiml.play(context.ANSWER_MESSAGE_URL);
  } else {
    console.log("Generating audio answer speech");
    const name = context.ANSWER_MESSAGE_NAME || 'us';
    twiml.say('Thank you for calling ' + name +  '. Please leave a message after the tone. Press star when finished.');
  }
  
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