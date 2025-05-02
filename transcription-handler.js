const mailjet = require('node-mailjet');

exports.handler = function(context, event, callback) {
  // Only proceed if transcription is complete
  if (event.TranscriptionStatus === 'completed') {
    // Initialize Mailjet
    const mailjetClient = mailjet.apiConnect(
      context.MAILJET_API_KEY,
      context.MAILJET_API_SECRET
    );
    
    // Prepare the email content
    const emailData = {
      Messages: [
        {
          From: {
            Email: context.FROM_EMAIL,
            Name: "Voicemail Service"
          },
          To: [
            {
              Email: context.FORWARDING_EMAIL,
              Name: "Recipient"
            }
          ],
          Subject: `New Voicemail from ${event.From}`,
          TextPart: `You received a new voicemail from ${event.From} to your number ${event.To}.\n\nTranscription: ${event.TranscriptionText}\n\nRecording: ${event.RecordingUrl}.mp3`,
          HTMLPart: `
            <h2>New Voicemail Received</h2>
            <p><strong>From:</strong> ${event.From}</p>
            <p><strong>To:</strong> ${event.To}</p>
            <p><strong>Transcription:</strong> ${event.TranscriptionText}</p>
            <p><strong>Recording:</strong> <a href="${event.RecordingUrl}.mp3">Listen to recording</a></p>
          `
        }
      ]
    };
    
    // Send the email
    mailjetClient
      .post('send', { version: 'v3.1' })
      .request(emailData)
      .then(() => {
        console.log('Voicemail email sent successfully');
        callback(null, 'Email sent');
      })
      .catch(error => {
        console.error('Error sending email:', error);
        callback(error);
      });
  } else {
    // If transcription is not complete, just return
    callback(null, 'Transcription not complete');
  }
};