Twilio Phone to Email Scripts
=======

This is a set of [Twilio](https://twilio.com/) Functions that will capture voicemails, download recordings, and send them as email attachments along with transcriptions, and forward SMS messages, using the [Mailjet](https://www.mailjet.com/) email service. All code is in JavaScript, ready for Twilio's [serverless Functions environment](https://www.twilio.com/docs/serverless/functions-assets/functions).

Optionally, incoming calls can ring a SIP client (e.g. Zoiper) first, falling back to voicemail+email if unanswered. The SIP client can also make outbound PSTN calls through the Twilio number. Multiple phone numbers on the same account are supported — each number gets its own SIP credential and rings independently.

This code can be used to cost-effectively service one or more unattended phone numbers, or as a lightweight softphone setup with voicemail.

Step 1: Create a Twilio Account and Purchase a Number
-------

- Sign up at twilio.com
- Buy one or more phone numbers with voice and SMS capabilities
- All numbers on the same account share the same Functions service and SIP domain

Step 2: Add Voice Recordings (Optional)
-------

If you would like personalized greetings, record a message asking the caller to leave a message, and/or one thanking them for their message:
- Use your own software to record the messages and save them as MP3 files
- In your Twilio dashboard, navigate to "Functions and Assets" > "Assets"
- Upload the mp3 files as public assets.
- You can copy the URLs from here to fill in environment variables that will use these files later.

Step 3: Create a Twilio Functions Service
-------

- Navigate to "Functions and Assets" > "Services" in your Twilio dashboard
- Click "Create Service" and give it a name (e.g., "phone-handling")

Step 4: Add the Functions to Your Service
-------

- Create the functions in your Twilio Functions service by clicking the "+" button and adding each file with its corresponding code:
   - `voice-response` — answers incoming calls (SIP dial or voicemail)
   - `recording-handler` — handles completed recordings
   - `transcription-handler` — emails voicemail transcriptions with recording attached
   - `sms-handler` — forwards SMS to email (and optionally to another phone number)
   - `sip-voicemail-fallback` — voicemail fallback when SIP client doesn't answer (only needed with SIP)
   - `sip-outbound` — bridges outbound calls from SIP client to PSTN (only needed with SIP)

Step 5: Set Up Environment Variables
-------

In your Twilio Functions service, go to "Settings" > "Environment Variables" and add these variables:

**Required:**
   - `MAILJET_API_KEY`: Your Mailjet API key
   - `MAILJET_API_SECRET`: Your Mailjet API secret
   - `FORWARDING_EMAIL`: The email where you want to receive voicemails and SMS
   - `FROM_EMAIL`: The verified email that will appear as the sender

**Optional (voicemail greeting):**
   - `ANSWER_MESSAGE_URL`: A public URL containing a message to play on your answer phone (can be set to point to a Twilio Asset you have uploaded)
   - `ANSWER_MESSAGE_NAME`: The name to include in your answering machine message (defaults to "us")
   - `THANK_YOU_MESSAGE_URL`: A public URL containing a message to play to thank the caller for their message (can be set to point to a Twilio Asset you have uploaded)

**Optional (SIP):**
   - `SIP_DOMAIN`: Full SIP domain hostname (e.g. `yourname.sip.ie1.twilio.com`). Setting this enables SIP support.
   - `SIP_INBOUND`: Set to `false` to skip SIP for incoming calls (outbound-only mode). Default: `true` when `SIP_DOMAIN` is set.
   - `SIP_DIAL_TIMEOUT`: Seconds to ring SIP client before falling back to voicemail (default: `20`)

**Optional (SMS forwarding):**
   - `SMS_FORWARD_NUMBER`: Phone number in E.164 format (e.g. `+353861234567`) to forward incoming SMS to, in addition to email

Step 6: Configure Dependencies
-------

- Go to "Settings" > "Dependencies" in your Twilio Functions service
- Add these dependencies:

   - `node-mailjet`: version `^6.0.2`
   - `axios`: version `^1.3.6`

Step 7: Deploy Your Functions
-------

- Click "Deploy All" to deploy your functions

Step 8: Configure Your Twilio Phone Number
-------

- Navigate to "Phone Numbers" > "Manage" > "Active Numbers"
- For **each** phone number, click on it and configure:
   - For "Voice & Fax" configuration:
      - Set "A Call Comes In" to "Function"
      - Select your service and the `voice-response` function
   - For "Messaging" configuration:
      - Set "A Message Comes In" to "Function"
      - Select your service and the `sms-handler` function
   - Save your changes
- Repeat for every phone number on the account — they all point to the same functions

Step 9: Set Up SIP Domain (Optional)
-------

If you want to use a SIP client (e.g. Zoiper) to make and receive calls:

1. **Create SIP Domain**: In your Twilio dashboard, go to "Voice" > "SIP Domains" > "Create SIP Domain"
   - Choose a name (e.g. `yourname`) — your full domain will be `yourname.sip.twilio.com`
   - Under "A Call Comes In", set it to "Function", select your service and the `sip-outbound` function, using **HTTP POST**
   - Under "SIP Registration", enable it and add a credential list

2. **Create Credential List**: Go to "SIP Domains" > "Credential Lists"
   - Create a credential list with one entry **per phone number**
   - The **username must be the phone number in E.164 format** (e.g. `+15551234567`)
   - Choose any password for each entry
   - This is what allows multiple numbers to work: when a call comes in to a number, the system dials `sip:{that number}@{SIP_DOMAIN}`, which rings only the SIP client registered with that number as its username

3. **Configure your SIP client** (e.g. Zoiper):
   - Create one SIP account per phone number
   - Server/Domain: your SIP domain (e.g. `yourname.sip.twilio.com`)
   - Username: the phone number in E.164 format (e.g. `+15551234567`)
   - Password: the password you set for that credential
   - To dial out: enter the destination number in E.164 format (e.g. `+353861234567`) — the caller ID will automatically be the Twilio number used as the SIP username

4. **Add environment variables**: Set `SIP_DOMAIN` in your Functions environment variables to match your SIP domain hostname

**Multiple numbers:** All phone numbers share a single SIP domain and Functions service. Each number is distinguished by its SIP credential username. A SIP client registered as `+15551234567` will only ring for calls to that number. You can register multiple numbers in the same SIP client (e.g. Zoiper supports multiple SIP accounts) or use different clients for different numbers.

**SIP mode combinations:**
- `SIP_DOMAIN` not set: no SIP at all, original email-only voicemail behavior
- `SIP_DOMAIN` set (default): incoming calls ring the SIP client registered for that number, fall back to voicemail+email if unanswered; outbound calls from SIP client work
- `SIP_DOMAIN` set + `SIP_INBOUND=false`: outbound SIP calls only; incoming calls go straight to voicemail+email

Key Features of This Setup
=======

- **Voicemail Capture**: Takes voicemail messages with a customizable greeting
- **Transcription**: Automatically transcribes voicemail content for easy reading
- **Email Forwarding**: Sends both voicemails and SMS to your email
- **Recording Attachment**: Downloads the audio file and attaches it to the email
- **Online Link**: Also includes a link to the online recording
- **SIP Support**: Optionally ring a SIP client before voicemail, and make outbound calls
- **SMS Forwarding**: Optionally forward SMS to another phone number in addition to email

How It Works
=======

Voice Calls (Voicemail Only)
-------

When someone calls your Twilio number and SIP is not configured:

- They hear a greeting and can leave a message
- Twilio transcribes the message and sends it to the transcription handler
- The transcription handler downloads the recording, attaches it to an email, and sends it via Mailjet

Voice Calls (With SIP)
-------

When someone calls your Twilio number and SIP is configured:

- The call rings the SIP client registered for that specific number (using the called number as the SIP username)
- If answered: two-way audio conversation proceeds normally
- If unanswered (busy, no answer, offline): the caller hears a greeting and can leave a voicemail, which is emailed as above

Outbound Calls (SIP)
-------

When you dial from your SIP client:

- The SIP domain webhook routes the call to `sip-outbound`
- The destination number is extracted from the SIP `To` URI
- The caller ID is extracted from the SIP `From` URI (your Twilio number, which is the SIP username)
- The call is bridged to the PSTN number with that Twilio number as caller ID

SMS Messages
-------

When someone texts your Twilio number:

- The SMS handler forwards the message to your email via Mailjet
- If `SMS_FORWARD_NUMBER` is set, the SMS is also forwarded to that phone number (prefixed with the original sender's number)

**Note:** Twilio SIP does not support the SIP MESSAGE protocol, so SMS messages cannot be delivered directly to a SIP client. Use email forwarding and/or SMS forwarding to another phone number instead.

Cost and Usage
=======

These are at the time of writing; please consult [Twilio's pricing page](https://www.twilio.com/en-us/voice/pricing/us) for more information.

- Twilio number: $1/month
- Voice calls: $0.0085/minute (or part thereof)
- Recording: $0.0025/minute (or part thereof)
- Transcription: $0.05/minute (or part thereof)
- SMS messages: $0.0075 per message
- Twilio Functions: Free up to 10,000 invocations/month
- Text to Speech: $0.0008 per hundred characters (see [pricing](https://www.twilio.com/docs/voice/twiml/say/text-speech#pricing))
- Mailjet: Free tier includes 200 emails/day (see [pricing](https://www.mailjet.com/pricing/))
- SIP registration: no additional cost (included with Twilio)

For typical personal use, this entire setup should cost around $1-3 per month.

Notes and Customizations
=======

- Make sure your Mailjet account has a verified sender email address for the `FROM_EMAIL` variable.
- If needed, you can upload your own voicemail greeting, or change the text in the `voice-response.js` function.
- You can adjust the maximum voicemail length by changing the maxLength parameter in the record function.
- For testing, use the "Function Testing" feature in the Twilio console before connecting to your phone number.
- If you experience any issues with the attachment size, Mailjet has a 15MB limit per email. Most voicemails should be well under this limit.
