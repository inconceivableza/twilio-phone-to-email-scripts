const mailjet = require('node-mailjet');

exports.handler = function(context, event, callback) {
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
  
  // Send the email
  mailjetClient
    .post('send', { version: 'v3.1' })
    .request(emailData)
    .then(() => {
      console.log('SMS email sent successfully');
      
      // Return empty TwiML response (no SMS auto-reply)
      const twiml = new Twilio.twiml.MessagingResponse();
      callback(null, twiml);
    })
    .catch(error => {
      console.error('Error sending email:', error);
      callback(error);
    });
};