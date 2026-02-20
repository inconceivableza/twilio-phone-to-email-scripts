const axios = require('axios');

/**
 * Generates a formatted date-time string for filenames from current date
 * @returns {string} Formatted date-time string (YYYY-MM-DD_HH-MM-SS)
 */
function getFormattedDateTime() {
  const date = new Date();

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

function getNumberConfig(toNumber) {
  try {
    const asset = Runtime.getAssets()['/phone-config.json'];
    if (asset) {
      return JSON.parse(asset.open())[toNumber] || {};
    }
  } catch (e) { /* config missing or invalid */ }
  return {};
}

exports.handler = function(context, event, callback) {
  // Only proceed if transcription is complete
  if (event.TranscriptionStatus === 'completed') {
    const { sendEmail } = require(Runtime.getAssets()['/email-helper.js'].path);
    const toNumber = event.To || 'Unknown';
    const numberConfig = getNumberConfig(toNumber);
    const forwardingEmail = numberConfig.forwardingEmail || context.FORWARDING_EMAIL;

    const transcriptionText = event.TranscriptionText || 'No transcription available';
    const recordingUrl = event.RecordingUrl || '';
    const fromNumber = event.From || 'Unknown';
    // console.log("Transcription event information follows:");
    // JSON.stringify(event, null, 4).split('\n').forEach(line => console.log(line));
    const dateTimeStr = getFormattedDateTime();

    // Download the recording
    const attachmentFilename = `voicemail_${fromNumber.replace('+', '')}_${dateTimeStr}.mp3`;
    getAttachmentData(recordingUrl, context.ACCOUNT_SID, context.AUTH_TOKEN)
      .then(attachmentData => {
        const attachments = attachmentData ? [{
          filename: attachmentFilename,
          contentType: 'audio/mpeg',
          base64Content: attachmentData,
        }] : [];

        const htmlBody = `
                <h2>New Voicemail Received</h2>
                <p><strong>From:</strong> ${fromNumber}<br/>
                <strong>To:</strong> ${toNumber}<br/>
                <p><strong>Transcription:</strong> ${event.TranscriptionText}</p>
                <p><strong>Recording:</strong> <a href="${event.RecordingUrl}.mp3">Listen to recording</a></p>
              ` + (attachmentData ? `
                <p>The recording is also attached to this email.</p>
              ` : ``);

        return sendEmail(context, {
          to: forwardingEmail,
          fromName: 'Voicemail Service',
          subject: `New Voicemail from ${fromNumber}`,
          textBody: `You received a new voicemail from ${fromNumber} to your number ${toNumber}.\n\nTranscription: ${transcriptionText}\n\nRecording: ${event.RecordingUrl}.mp3`,
          htmlBody,
          attachments,
        });
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
