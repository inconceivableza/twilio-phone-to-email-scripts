'use strict';

/**
 * Shared email helper — loaded by functions via:
 *   require(Runtime.getAssets()['/email-helper.js'].path)
 *
 * Supports Mailjet, SendGrid, Gmail SMTP, and custom SMTP.
 * Provider selected by context.EMAIL_PROVIDER (default: 'mailjet').
 */

// --- Provider: Mailjet ---

function sendViaMailjet(context, options) {
  const mailjet = require('node-mailjet');
  const client = mailjet.apiConnect(
    context.MAILJET_API_KEY,
    context.MAILJET_API_SECRET
  );

  const message = {
    From: { Email: context.FROM_EMAIL, Name: options.fromName || 'Twilio' },
    To: [{ Email: options.to, Name: 'Recipient' }],
    Subject: options.subject,
    TextPart: options.textBody,
  };
  if (options.htmlBody) message.HTMLPart = options.htmlBody;

  if (options.attachments && options.attachments.length > 0) {
    message.Attachments = options.attachments.map(a => ({
      ContentType: a.contentType,
      Filename: a.filename,
      Base64Content: a.base64Content,
    }));
  }

  return client.post('send', { version: 'v3.1' }).request({ Messages: [message] });
}

// --- Provider: SendGrid ---

function sendViaSendGrid(context, options) {
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(context.SENDGRID_API_KEY);

  const msg = {
    to: options.to,
    from: { email: context.FROM_EMAIL, name: options.fromName || 'Twilio' },
    subject: options.subject,
    text: options.textBody,
  };
  if (options.htmlBody) msg.html = options.htmlBody;

  if (options.attachments && options.attachments.length > 0) {
    msg.attachments = options.attachments.map(a => ({
      content: a.base64Content,
      filename: a.filename,
      type: a.contentType,
      disposition: 'attachment',
    }));
  }

  return sgMail.send(msg);
}

// --- Provider: SMTP (also used for Gmail) ---

function sendViaSmtp(context, options, smtpConfig) {
  const nodemailer = require('nodemailer');

  const transport = nodemailer.createTransport({
    host: smtpConfig.host,
    port: parseInt(smtpConfig.port, 10) || 587,
    secure: smtpConfig.secure === 'true' || smtpConfig.secure === true,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    connectionTimeout: 5000,
    greetingTimeout: 3000,
    socketTimeout: 8000,
  });

  const mail = {
    from: `"${options.fromName || 'Twilio'}" <${context.FROM_EMAIL}>`,
    to: options.to,
    subject: options.subject,
    text: options.textBody,
  };
  if (options.htmlBody) mail.html = options.htmlBody;

  if (options.attachments && options.attachments.length > 0) {
    mail.attachments = options.attachments.map(a => ({
      filename: a.filename,
      content: a.base64Content,
      encoding: 'base64',
      contentType: a.contentType,
    }));
  }

  return transport.sendMail(mail);
}

// --- Public API ---

function isEmailConfigured(context, forwardingEmail) {
  const provider = (context.EMAIL_PROVIDER || 'mailjet').toLowerCase();
  if (!context.FROM_EMAIL || !forwardingEmail) return false;

  switch (provider) {
    case 'mailjet':
      return !!(context.MAILJET_API_KEY && context.MAILJET_API_SECRET);
    case 'sendgrid':
      return !!context.SENDGRID_API_KEY;
    case 'gmail':
      return !!(context.SMTP_USER && context.SMTP_PASS);
    case 'smtp':
      return !!(context.SMTP_HOST && context.SMTP_USER && context.SMTP_PASS);
    default:
      return false;
  }
}

function sendEmail(context, options) {
  const provider = (context.EMAIL_PROVIDER || 'mailjet').toLowerCase();

  switch (provider) {
    case 'mailjet':
      return sendViaMailjet(context, options);
    case 'sendgrid':
      return sendViaSendGrid(context, options);
    case 'gmail':
      return sendViaSmtp(context, options, {
        host: 'smtp.gmail.com',
        port: '465',
        secure: 'true',
        user: context.SMTP_USER,
        pass: context.SMTP_PASS,
      });
    case 'smtp':
      return sendViaSmtp(context, options, {
        host: context.SMTP_HOST,
        port: context.SMTP_PORT || '587',
        secure: context.SMTP_SECURE || 'false',
        user: context.SMTP_USER,
        pass: context.SMTP_PASS,
      });
    default:
      return Promise.reject(new Error(`Unknown email provider: ${provider}`));
  }
}

module.exports = { isEmailConfigured, sendEmail };
