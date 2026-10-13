// Emails an invoice PDF to a customer, from your business, via Resend.
// Deploy as an Edge Function named exactly `send-invoice` with "Verify JWT" ON (only signed-in users can call it).
// Secrets needed (Edge Functions > Secrets):
//   RESEND_API_KEY  – your Resend API key (sending access)
//   FROM_EMAIL      – a sender address on a domain you have verified in Resend, e.g. invoices@yourdomain.co.uk
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const okEmail = (s: unknown) => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/.test(String(s ?? '').trim());
const safeName = (s: unknown) => String(s ?? '').replace(/["<>\r\n\\]/g, '').trim().slice(0, 60);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const key = Deno.env.get('RESEND_API_KEY'), from = Deno.env.get('FROM_EMAIL');
  if (!key || !from) return json({ error: 'Email is not set up yet (RESEND_API_KEY / FROM_EMAIL missing)' }, 500);
  let b: any; try { b = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const to = String(b.to ?? '').trim();
  if (!okEmail(to)) return json({ error: 'That email address does not look right' }, 400);
  const pdf = String(b.pdf ?? ''); if (!pdf || pdf.length > 7_000_000) return json({ error: 'Invoice PDF missing or too large' }, 400);
  const name = safeName(b.fromName) || 'Your window cleaner';
  const text = String(b.text ?? '').slice(0, 5000), subject = String(b.subject ?? 'Your invoice').replace(/[\r\n]/g, ' ').slice(0, 200);
  const filename = String(b.filename ?? 'invoice.pdf').replace(/[^\w .-]/g, '').slice(0, 80) || 'invoice.pdf';
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0B2A3C">${esc(text).replace(/\n/g, '<br>')}</div>`;
  const payload: Record<string, unknown> = { from: `${name} <${from}>`, to: [to], subject, text, html, attachments: [{ filename, content: pdf }] };
  if (okEmail(b.replyTo)) payload.reply_to = String(b.replyTo).trim();
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) { const t = await r.text(); console.error('Resend error', r.status, t); return json({ error: 'The email service refused it (' + r.status + ')' }, 502); }
  return json({ ok: true });
});
