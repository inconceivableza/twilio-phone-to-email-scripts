= Complete Twilio Functions Setup with Recording Attachment

Here's the complete setup for Twilio Functions that will capture voicemails, download recordings, send them as email attachments along with transcriptions, and forward SMS messages. All code is in JavaScript, ready for Twilio's serverless Functions environment.

== Step 1: Create a Twilio Account and Purchase a Number

- Sign up at twilio.com
- Buy a phone number with voice and SMS capabilities

== Step 2: Create a Twilio Functions Service

- Navigate to "Functions and Assets" > "Services" in your Twilio dashboard
- Click "Create Service" and give it a name (e.g., "Voicemail Forwarding")

== Step 3: Add the Functions to Your Service

- Create each of the four functions in your Twilio Functions service by clicking the "+" button and adding each file with its corresponding code. All functions use JavaScript designed specifically for Twilio's environment.

== Step 4: Set Up Environment Variables

- In your Twilio Functions service, go to "Settings" > "Environment Variables"
- Add these variables:
   - `MAILJET_API_KEY`: Your Mailjet API key
   - `MAILJET_API_SECRET`: Your Mailjet API secret
   - `FORWARDING_EMAIL`: The email where you want to receive voicemails and SMS
   - `FROM_EMAIL`: The verified email that will appear as the sender
   - `ANSWER_MESSAGE_URL`: A public URL containing a message to play on your answer phone (optional, can be set to point to a Twilio Asset you have uploaded).
   - `ANSWER_MESSAGE_NAME`: The name to include in your answering machine message (optional, defaults to "us").

== Step 5: Configure Dependencies

- Go to "Settings" > "Dependencies" in your Twilio Functions service
- Add these dependencies:

   - `node-mailjet`: version `^6.0.2`
   - `axios`: version `^1.3.6`

== Step 6: Deploy Your Functions

- Click "Deploy All" to deploy your functions

== Step 7: Configure Your Twilio Phone Number

- Navigate to "Phone Numbers" > "Manage" > "Active Numbers"
- Click on your phone number
- For "Voice & Fax" configuration:
   - Set "A Call Comes In" to "Function"
   - Select your service and the `voice-response` function
- For "Messaging" configuration:
   - Set "A Message Comes In" to "Function"
   - Select your service and the `sms-handler` function
- Save your changes

== Key Features of This Setup

- **Voicemail Capture**: Takes voicemail messages with a customizable greeting
- **Transcription**: Automatically transcribes voicemail content for easy reading
- **Email Forwarding**: Sends both voicemails and SMS to your email
- **Recording Attachment**: Downloads the audio file and attaches it to the email
- **Online Link**: Also includes a link to the online recording

== How It Works

=== Voice Calls

When someone calls your Twilio number:

- They hear a greeting and can leave a message
- Twilio transcribes the message and sends it to the transcription handler
- The transcription handler downloads the recording, attaches it to an email, and sends it via Mailjet

=== SMS Messages

When someone texts your Twilio number:

- The SMS handler forwards the message to your email via Mailjet

== Cost and Usage

- Twilio number: $1/month
-Voice calls: $0.0085/minute
-Transcription: $0.05/minute
-SMS messages: $0.0075 per message
-Twilio Functions: Free up to 10,000 invocations/month
-Mailjet: Free tier includes 200 emails/day

For typical personal use, this entire setup should cost around $1-3 per month.

== Notes and Customizations

- Make sure your Mailjet account has a verified sender email address for the `FROM_EMAIL` variable.
- If needed, you can modify the voicemail greeting by changing the text in the `voice-response.js` function.
- You can adjust the maximum voicemail length by changing the maxLength parameter in the record function.
- For testing, use the "Function Testing" feature in the Twilio console before connecting to your phone number.
- If you experience any issues with the attachment size, Mailjet has a 15MB limit per email. Most voicemails should be well under this limit.