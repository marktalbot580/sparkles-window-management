# Window Round Pro – going live

The app already works with no setup: open `index.html` from any web server and everything is kept on that phone.
To get logins, sync between devices and automatic invoice emails, do these in order. None of it touches the OMB Gas app – this uses its own Supabase project.

## 1. Put the app on the web (GitHub Pages, free)
1. On github.com create a **new repository** (for example `windowroundpro`), public.
2. Upload every file in this folder to it (keep the `fonts`, `lib` and `backend` folders).
3. Repository **Settings → Pages → Build from branch → main / root**. After a minute the app is live at `https://windowroundpro.com`.
4. On the phone: open that address, then **Share → Add to Home Screen**.

## 2. Supabase (logins + cloud storage) – new project
1. supabase.com → **New project**, name it `windowroundpro`, London region, set a database password and keep it safe.
2. **SQL Editor → New query** → paste all of `backend/schema.sql` → Run.
3. **Project Settings → API**: copy the **Project URL** and the **publishable (anon) key** into `config.js` (`url` and `key`), then upload `config.js` to GitHub again. Never use the `secret` / `service_role` key anywhere in the app.
4. **Authentication → URL Configuration**: set **Site URL** to the GitHub Pages address from step 1.
5. Open the app and tap **First time? Create your account**, confirm the email, log in.

## 3. Automatic invoice emails (Resend)
1. resend.com: add and verify a sending domain (or use your business domain), then create an **API key** (sending access).
2. Supabase → **Edge Functions → Deploy a new function** named exactly `send-invoice`, paste in `backend/functions/send-invoice/index.ts`. Leave **Verify JWT** switched on.
3. Supabase → **Edge Functions → Secrets**: add `RESEND_API_KEY` (the key from step 1) and `FROM_EMAIL` (for example `invoices@yourdomain.co.uk`).
4. In the app: Settings → "Email invoices automatically" → Yes. Tap Complete on a house that has an email address; the invoice goes out ten seconds later (that is your time to tap Undo).

## Still to come
- Text reminders sent automatically to a whole round (needs an SMS service such as Twilio).
- Public quote link where customers send their details and a photo of the house.
- The £15/month subscription layer (14-day trial, Stripe checkout and customer portal).

## Before you sell it (UK)
Register with the ICO (data protection fee), add a privacy policy and terms, and make sure each customer's data stays private to their own login (the schema does this with row level security).

## Tests
```
python3 -m http.server 8765 &
pip install playwright && playwright install chromium
python3 tests/run.py
```
