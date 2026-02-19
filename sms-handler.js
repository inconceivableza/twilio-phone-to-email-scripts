const mailjet = require('node-mailjet');

exports.handler = function(context, event, callback) {
  const emailConfigured = context.MAILJET_API_KEY && context.MAILJET_API_SECRET
    && context.FROM_EMAIL && context.FORWARDING_EMAIL;

  const promises = [];

  // Send email if configured
  if (emailConfigured) {
    const mailjetClient = mailjet.apiConnect(
      context.MAILJET_API_KEY,
      context.MAILJET_API_SECRET
    );

    const emailData = {
      Messages: [
        {
          From: {
            Email: context.FROM_EMAIL,
            Name: "SMS Forwarding Service"
          },
          To: [
            {
              Email: context.FORWARDING_EMAIL,
              Name: "Recipient"
            }
          ],
          Subject: `New SMS from ${event.From}`,
          TextPart: `You received a new SMS from ${event.From} to your number ${event.To}.\n\nMessage: ${event.Body}`
        }
      ]
    };

    promises.push(
      mailjetClient
        .post('send', { version: 'v3.1' })
        .request(emailData)
        .then(() => {
          console.log('SMS email sent successfully');
        })
    );
  } else {
    console.log('Email not configured; skipping SMS-to-email forwarding');
  }

  // Optionally forward the SMS to another phone number
  if (context.SMS_FORWARD_NUMBER) {
    promises.push(
      context.getTwilioClient().messages.create({
        to: context.SMS_FORWARD_NUMBER,
        from: event.To,
        body: `SMS from ${event.From}:\n${event.Body}`
      }).then(() => {
        console.log(`SMS forwarded to ${context.SMS_FORWARD_NUMBER}`);
      })
    );
  }

  Promise.all(promises)
    .then(() => {
      const twiml = new Twilio.twiml.MessagingResponse();
      callback(null, twiml);
    })
    .catch(error => {
      console.error('Error in SMS handler:', error);
      callback(error);
    });
};