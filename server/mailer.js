// SMTP delivery seam. nodemailer is imported lazily so the default
// `local` delivery mode keeps running with no transport loaded at all.
let transportPromise = null;

export const SMTP_URL = () => process.env.DOCHUB_SMTP_URL || null;
export const MAIL_FROM = () => process.env.DOCHUB_MAIL_FROM || 'DocHub <no-reply@dochub.local>';

async function transport() {
  if (!transportPromise) {
    transportPromise = (async () => {
      const url = SMTP_URL();
      if (!url) throw new Error('DOCHUB_SMTP_URL is not set');
      let nodemailer;
      try { nodemailer = (await import('nodemailer')).default; }
      catch { throw new Error('nodemailer is not installed: run `npm install nodemailer`'); }
      return nodemailer.createTransport(url);
    })().catch((err) => { transportPromise = null; throw err; });
  }
  return transportPromise;
}

/** Resolves to { messageId } on a real accepted handoff, throws otherwise.
 *  Never swallows an error: the caller records the failure verbatim. */
export async function smtpSend({ to, subject, body }) {
  const t = await transport();
  const info = await t.sendMail({ from: MAIL_FROM(), to, subject, text: body });
  if (info.rejected?.length) throw new Error(`Recipient rejected: ${info.rejected.join(', ')}`);
  return { messageId: info.messageId || null, response: info.response || null };
}

/** Used by the e2e script and the settings view to describe the seam. */
export function smtpStatus() {
  const url = SMTP_URL();
  if (!url) return { configured: false, host: null };
  try { const u = new URL(url); return { configured: true, host: `${u.hostname}:${u.port || '(default)'}` }; }
  catch { return { configured: false, host: null, error: 'DOCHUB_SMTP_URL is not a valid URL' }; }
}
