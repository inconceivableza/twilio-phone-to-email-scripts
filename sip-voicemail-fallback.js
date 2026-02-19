exports.handler = function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const status = event.DialCallStatus;
  console.log(`SIP dial result: ${status}`);

  if (status === 'completed') {
    // Call was answered and has ended; nothing more to do
    twiml.hangup();
  } else {
    // SIP unavailable (busy, no-answer, failed, canceled) — fall back to voicemail
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
  }

  callback(null, twiml);
};
