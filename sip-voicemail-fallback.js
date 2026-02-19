exports.handler = function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const status = event.DialCallStatus;
  console.log(`SIP dial result: ${status}`);

  const emailConfigured = context.MAILJET_API_KEY && context.MAILJET_API_SECRET
    && context.FROM_EMAIL && context.FORWARDING_EMAIL;

  if (status === 'completed') {
    // Call was answered and has ended; nothing more to do
    twiml.hangup();
  } else if (emailConfigured) {
    // SIP unavailable — fall back to voicemail (only if email is configured)
    if (context.ANSWER_MESSAGE_URL) {
      console.log("Playing audio answer message");
      twiml.play(context.ANSWER_MESSAGE_URL);
    } else {
      console.log("Generating audio answer speech");
      const name = context.ANSWER_MESSAGE_NAME || 'us';
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
