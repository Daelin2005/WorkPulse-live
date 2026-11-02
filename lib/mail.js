// Outgoing email. In development the message is printed to the console so you can click the link.
// TODO: replace with nodemailer (or your provider's SDK) and read SMTP settings from .env.
async function send(to, subject, text) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Production email delivery is not configured. Configure a mail provider before sending account emails.');
  }
  console.log(`\n[mail] to: ${to}\n[mail] ${subject}\n[mail] ${text}\n`);
}
module.exports = { send };
