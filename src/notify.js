import nodemailer from 'nodemailer';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function createNotifier(config, log = console) {
  let timer = null;

  // Tell the website to drop its cached pages. Debounced so a burst of edits sends one request.
  function revalidate() {
    if (!config.revalidateUrl) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const res = await fetch(config.revalidateUrl, {
          method: 'POST',
          headers: { 'x-revalidate-secret': config.revalidateSecret },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) log.warn(`Website refresh failed: HTTP ${res.status}`);
      } catch (err) {
        log.warn(`Website refresh failed: ${err.message}`);
      }
    }, 1000);
    timer.unref();
  }

  const transport = config.smtpUrl && config.notifyEmail ? nodemailer.createTransport(config.smtpUrl) : null;

  async function enquiry(e) {
    if (!transport) return;
    const lines = [
      e.property_title ? `Property: ${e.property_title}` : 'General enquiry',
      `Name: ${e.name}`,
      `Contact: ${e.contact}`,
      '',
      e.message || '(no message)',
      '',
      e.page_url ? `Sent from: ${e.page_url}` : '',
    ];
    try {
      await transport.sendMail({
        from: config.mailFrom || config.notifyEmail,
        to: config.notifyEmail,
        replyTo: EMAIL.test(e.contact) ? e.contact : undefined,
        subject: `New enquiry${e.property_title ? `: ${e.property_title}` : ''}`,
        text: lines.join('\n'),
      });
    } catch (err) {
      log.warn(`Enquiry email failed: ${err.message}`);
    }
  }

  return { revalidate, enquiry };
}
