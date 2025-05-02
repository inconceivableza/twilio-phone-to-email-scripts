const mailjet = require('node-mailjet');
const axios = require('axios');

/**
 * Generates a formatted date-time string for filenames from RFC 2822 date string
 * @param {string} rfc2822DateString - Date string in RFC 2822 format
 * @returns {string} Formatted date-time string (YYYY-MM-DD_HH-MM-SS)
 */
function getFormattedDateTime(rfc2822DateString) {
  // Parse the RFC 2822 date string
  let date = rfc2822DateString? new Date(rfc2822DateString) : null;

  // Handle invalid date
  if (date === null || isNaN(date.getTime())) {
    console.warn(`Invalid date string: ${rfc2822DateString}, using current time instead`);
    date = new Date();
  }

  return date.getFullYear() + '-' +
         String(date.getMonth() + 1).padStart(2, '0') + '-' +
         String(date.getDate()).padStart(2, '0') + '_' +
         String(date.getHours()).padStart(2, '0') + '-' +
         String(date.getMinutes()).padStart(2, '0') + '-' +
         String(date.getSeconds()).padStart(2, '0');
}

/**
 * Downloads and prepares recording attachment data
 * @param {string} recordingUrl - The URL of the recording to download
 * @param {string} accountSid - Twilio Account SID for authentication
 * @param {string} authToken - Twilio Auth Token for authentication
 * @returns {Promise<string|null>} Base64-encoded attachment data or null if download fails
 */
function getAttachmentData(recordingUrl, accountSid, authToken) {
  return new Promise((resolve, reject) => {
    // Add .mp3 extension to the recording URL to get the audio file
    const mp3Url = `${recordingUrl}.mp3`;
    const axiosConfig = {
      responseType: 'arraybuffer',
      auth: {
        username: accountSid,
        password: authToken
      }
    };
    axios.get(mp3Url, axiosConfig)
      .then(response => {
        if (response.status === 200) {
          // Convert the audio data to base64 for the email attachment
          const audioData = response.data;
          const attachmentData = Buffer.from(audioData).toString('base64');
          console.log(`Successfully downloaded recording, size: ${audioData.length} bytes`);
          resolve(attachmentData);
        } else {
          console.error(`Failed to download recording: HTTP status ${response.status}`);
          resolve(null);
        }
      })
      .catch(error => {
        console.error(`Error downloading recording: ${error.message}`);
        resolve(null);
      });
  });
}

exports.handler = function(context, event, callback) {
  // Only proceed if transcription is complete
  if (event.TranscriptionStatus === 'completed') {
    // Initialize Mailjet
    const mailjetClient = mailjet.apiConnect(
      context.MAILJET_API_KEY,
      context.MAILJET_API_SECRET
    );

    const transcriptionText = event.TranscriptionText || 'No transcription available';
    const recordingUrl = event.RecordingUrl || '';
    const fromNumber = event.From || 'Unknown';
    const toNumber = event.To || 'Unknown';
    // console.log("Transcription event information follows:");
    // JSON.stringify(event, null, 4).split('\n').forEach(line => console.log(line));
    const dateTimeStr = getFormattedDateTime(event.RecordingStartTime);

    // Download the recording
    const attachmentFilename = `voicemail_${fromNumber.replace('+', '')}_${dateTimeStr}.mp3`;
    getAttachmentData(recordingUrl, context.ACCOUNT_SID, context.AUTH_TOKEN)
      .then(attachmentData => {

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
              Subject: `New Voicemail from ${fromNumber}`,
              TextPart: `You received a new voicemail from ${fromNumber} to your number ${toNumber}.\n\nTranscription: ${transcriptionText}\n\nRecording: ${event.RecordingUrl}.mp3`,
              HTMLPart: `
                <h2>New Voicemail Received</h2>
                <p><strong>From:</strong> ${fromNumber}<br/>
                <strong>To:</strong> ${toNumber}<br/>
                <p><strong>Transcription:</strong> ${event.TranscriptionText}</p>
                <p><strong>Recording:</strong> <a href="${event.RecordingUrl}.mp3">Listen to recording</a></p>
              ` + (attachmentData ? `
                <p>The recording is also attached to this email.</p>
              ` : ``)
            }
          ]
        };

        // Add attachment if download was successful
        if (attachmentData) {
          emailData.Messages[0].Attachments = [
            {
              ContentType: 'audio/mpeg',
              Filename: attachmentFilename,
              Base64Content: attachmentData
            }
          ];
        }

        // Send the email
        return mailjetClient
          .post('send', { version: 'v3.1' })
          .request(emailData)
      })
      .then(result => {
        console.log('Voicemail email sent successfully');
        callback(null);
      })
      .catch(error => {
        console.error('Error sending email:', error);
        callback(error);
      });
  } else {
    // If transcription is not complete, just return
    callback('Transcription not complete');
  }
};