/* Sparkles Window Management – a phone-first app for a window cleaning round.
   Plain JavaScript, no build step. Data is kept on the phone and synced to Supabase when signed in. */
'use strict';
const APP_VERSION = 'v1';

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d, 12); };
const todayISO = () => iso(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const ukDate = s => (s ? String(s).split('-').reverse().join('/') : '');
const dayLabel = s => parse(s).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setP = (o, p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('Storage full – export a backup in Settings'); return false; } }
};
function toast(msg, undoId) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undoId ? `<button data-act="undoJob" data-id="${esc(undoId)}">Undo</button>` : ''}`;
  t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), undoId ? 9000 : 2800);
}
const PAY = ['Cash', 'Bank transfer', 'Card'];
const addrFirst = a => String(a || '').split(/\r?\n/)[0].trim();

/* ---------- saved data ---------- */
const DEFAULTS = {
  businessName: '', phone: '', email: '', address: '', homePostcode: '',
  invPrefix: 'INV-', invNext: '1', invDigits: '3', payDays: '7', vatReg: 'No', vatRate: '20', vatNumber: '',
  bankName: '', accName: '', sortCode: '', accNo: '', invFooter: 'Thank you for your business.',
  autoEmail: 'on', defaultFreq: '4', defaultPrice: '',
  omwText: "Hi {name}, it's {business}. I'm on my way to clean your windows today.",
  payText: "Hi {name}, just a quick message to let you know your windows have been cleaned. The cost is {amount}.\n\nYou can pay by bank transfer to {bank} (reference {ref}), or I can collect cash.\n\nPlease reply 1 if you're paying by bank transfer, or 2 if you'd like me to collect cash. Thank you! {business}",
  remText: "Hi {name}, it's {business}. Just a reminder that your windows are due to be cleaned {when}. Thank you!",
  orders: {}, updated: 0
};
let settings = Object.assign({}, DEFAULTS, LS.get('swm_settings', {}));
let customers = LS.get('swm_customers', []);
let jobs = LS.get('swm_jobs', []);
let invoices = LS.get('swm_invoices', []);
const saveS = () => { settings.updated = Date.now(); LS.set('swm_settings', settings); CLOUD.changed(); };
const saveC = () => { LS.set('swm_customers', customers); CLOUD.changed(); };
const saveJ = () => { LS.set('swm_jobs', jobs); CLOUD.changed(); };
const saveI = () => { LS.set('swm_invoices', invoices); CLOUD.changed(); };
const touch = o => { o.updated = Date.now(); return o; };
/* forget saved round orders for days long gone */
(() => { const cut = addDays(todayISO(), -14); let ch = false; Object.keys(settings.orders || {}).forEach(d => { if (d < cut) { delete settings.orders[d]; ch = true; } }); if (ch) LS.set('swm_settings', settings); })();

CLOUD.bind({
  local() {
    const out = [];
    customers.forEach(c => out.push({ kind: 'customer', id: c.id, data: c, updated: c.updated || 0 }));
    jobs.forEach(j => out.push({ kind: 'job', id: j.id, data: j, updated: j.updated || 0 }));
    invoices.forEach(i => out.push({ kind: 'invoice', id: i.id, data: i, updated: i.updated || 0 }));
    if (settings.updated) out.push({ kind: 'settings', id: 'main', data: settings, updated: settings.updated });
    return out;
  },
  apply(d, syncedUpd) {
    if (d.kind === 'settings') { if ((d.updated || 0) > (settings.updated || 0)) { Object.assign(settings, d.data); LS.set('swm_settings', settings); } return; }
    const name = d.kind === 'customer' ? 'customers' : d.kind === 'job' ? 'jobs' : d.kind === 'invoice' ? 'invoices' : null; if (!name) return;
    let arr = name === 'customers' ? customers : name === 'jobs' ? jobs : invoices;
    const i = arr.findIndex(x => x.id === d.id);
    if (d.deleted) { if (i >= 0) arr.splice(i, 1); }
    else if (i < 0) arr.push(d.data);
    else if (!(syncedUpd !== (arr[i].updated || 0) && (arr[i].updated || 0) > (d.updated || 0))) arr[i] = d.data;   // this phone has a newer unsynced edit: it wins
    LS.set('swm_' + name, arr);
  },
  done() { applyBrand(); render(); },
  toast
});

/* ---------- customers and rounds ---------- */
const isActive = c => c.active !== false;
const fullAddr = c => [String(c.address || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).join(', '), c.postcode].filter(Boolean).join(', ');
const freqText = c => (c.freq > 0 ? 'Every ' + c.freq + ' weeks' : 'One-off');
const custName = id => (customers.find(c => c.id === id) || {}).name || 'Customer';
function occursOn(c, date) {
  if (!isActive(c) || !c.next) return false;
  if (c.freq > 0) { const d = diffDays(c.next, date); return d >= 0 && d % (7 * c.freq) === 0; }
  return c.next === date;
}
/* the houses for one day: due ones (plus anything overdue when looking at today), and the ones already done */
function stopsFor(date) {
  const today = todayISO(), out = [];
  const done = jobs.filter(j => j.date === date);
  const doneIds = new Set(done.map(j => j.customerId));
  customers.forEach(c => {
    if (doneIds.has(c.id)) return;
    if (occursOn(c, date)) out.push({ c, overdue: false });
    else if (date === today && isActive(c) && c.next && c.next < today) out.push({ c, overdue: true });
  });
  const ord = (settings.orders || {})[date] || [];
  const rank = s => { const k = ord.indexOf(s.c.id); return k < 0 ? 1e6 : k; };
  out.sort((a, b) => rank(a) - rank(b) || (a.c.postcode || '').localeCompare(b.c.postcode || '') || a.c.name.localeCompare(b.c.name));
  const doneStops = done.map(j => ({ c: customers.find(c => c.id === j.customerId) || { id: j.customerId, name: 'Deleted customer', address: '' }, job: j, inv: invoices.find(i => i.id === j.invoiceId) }));
  return { todo: out, done: doneStops };
}

/* ---------- invoices ---------- */
const invNumberFor = n => (settings.invPrefix || '') + String(Math.max(1, parseInt(n, 10) || 1)).padStart(Math.min(8, Math.max(1, parseInt(settings.invDigits, 10) || 3)), '0');
function nextInvNumber() { const n = Math.max(1, parseInt(settings.invNext, 10) || 1), num = invNumberFor(n); settings.invNext = String(n + 1); saveS(); return num; }
const invStatus = i => (i.paid ? 'paid' : i.due && i.due < todayISO() ? 'overdue' : 'unpaid');
function makeInvoice(c, date, price) {
  const d = date || todayISO();
  return touch({
    id: uid(), number: nextInvNumber(), date: d, due: addDays(d, parseInt(settings.payDays, 10) || 0), workDate: d,
    customerId: c ? c.id : '', customer: { name: c ? c.name : '', phone: c ? c.phone || '' : '', email: c ? c.email || '' : '', billing: c ? fullAddr(c) : '' },
    jobAddress: c ? fullAddr(c) : '',
    lines: [{ d: c ? 'Window cleaning – ' + (addrFirst(c.address) || c.name) : '', q: '1', p: price ? numOf(price).toFixed(2) : '' }],
    vatRate: settings.vatReg === 'Yes' ? String(numOf(settings.vatRate)) : '0', vatNumber: settings.vatReg === 'Yes' ? settings.vatNumber : '',
    paid: false, paidDate: '', payMethod: '', notes: '', created: Date.now()
  });
}
const pending = {};   // invoice id -> timer of the automatic email (the undo window)
function queueEmail(inv) {
  if (settings.autoEmail !== 'on' || !inv.customer.email || !CLOUD.on) return;
  clearTimeout(pending[inv.id]);
  pending[inv.id] = setTimeout(() => { delete pending[inv.id]; sendInvoiceEmail(inv); }, 10000);
}
const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';
const bizName = () => settings.businessName || 'Sparkles Window Management';
function emailText(inv) {
  const T = invTotals(inv);
  const bank = [settings.accName && 'Account name: ' + settings.accName, settings.sortCode && 'Sort code: ' + fmtSort(settings.sortCode), settings.accNo && 'Account number: ' + settings.accNo].filter(Boolean).join('\n');
  return `Hi ${firstName(inv.customer.name)},\n\nThank you – your windows at ${addrFirst(inv.jobAddress) || 'your property'} were cleaned on ${ukDate(inv.workDate || inv.date)}. Your invoice ${inv.number} for ${money(T.total)} is attached${inv.paid ? ' (paid – thank you).' : '.'}` +
    (inv.paid ? '' : `\n\nPlease pay by ${ukDate(inv.due)} using reference ${inv.number}.${bank ? '\n\n' + bank : ''}`) + `\n\nKind regards,\n${bizName()}${settings.phone ? '\n' + settings.phone : ''}`;
}
const invFileName = i => `Invoice ${i.number} - ${(i.customer.name || 'Customer').replace(/[^\w ]+/g, '')}.pdf`;
async function sendInvoiceEmail(inv, manual) {
  if (!inv.customer.email) { if (manual) toast('This invoice has no email address'); return false; }
  if (!CLOUD.on || !CLOUD.signedIn()) { if (manual) return shareInvoice(inv); return false; }
  try {
    const blob = await buildInvPdf(inv, settings), b64 = await blobToB64(blob);
    await CLOUD.call('send-invoice', { to: inv.customer.email, subject: `Invoice ${inv.number} from ${bizName()}`, text: emailText(inv), filename: invFileName(inv), pdf: b64, replyTo: settings.email || '', fromName: bizName() });
    inv.sent = Date.now(); inv.sentTo = inv.customer.email; delete inv.sendError; touch(inv); saveI(); render();
    if (manual) toast('Invoice emailed to ' + inv.customer.email);
    return true;
  } catch (e) {
    console.warn(e); inv.sendError = e.message; saveI(); render();
    toast('Could not email ' + inv.number + ': ' + e.message); return false;
  }
}
/* no server set up yet (or no signal): hand the invoice to the phone's share sheet / mail app */
async function shareInvoice(inv) {
  try {
    const blob = await buildInvPdf(inv, settings), file = new File([blob], invFileName(inv), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Invoice ' + inv.number, text: emailText(inv) }); inv.sent = Date.now(); touch(inv); saveI(); render(); return true; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = invFileName(inv); document.body.appendChild(a); a.click(); a.remove();
    location.href = `mailto:${encodeURIComponent(inv.customer.email || '')}?subject=${encodeURIComponent('Invoice ' + inv.number + ' from ' + bizName())}&body=${encodeURIComponent(emailText(inv) + '\n\n(Attach the downloaded PDF)')}`;
    inv.sent = Date.now(); touch(inv); saveI(); render(); return true;
  } catch (e) { if (e.name !== 'AbortError') toast('Could not share: ' + e.message); return false; }
}
async function openInvPdf(inv) {
  const w = window.open('', '_blank');
  try { const blob = await buildInvPdf(inv, settings); if (w) w.location.href = URL.createObjectURL(blob); else toast('Allow pop-ups to view the PDF'); }
  catch (e) { if (w) w.close(); toast('Could not create the PDF: ' + e.message); }
}
function setPaid(inv, method) {
  if (inv.paid && inv.payMethod === method) { inv.paid = false; inv.paidDate = ''; inv.payMethod = ''; }
  else { inv.paid = true; inv.paidDate = inv.paidDate || todayISO(); inv.payMethod = method; }
  touch(inv); saveI(); render();
}

/* ---------- completing, undoing ---------- */
function completeStop(cid, date) {
  const c = customers.find(x => x.id === cid); if (!c) return;
  if (jobs.some(j => j.customerId === cid && j.date === date)) return;
  const inv = makeInvoice(c, date, c.price);
  const job = touch({ id: uid(), customerId: cid, date, price: numOf(c.price), invoiceId: inv.id, prevNext: c.next || '', prevLast: c.last || '', created: Date.now() });
  jobs.push(job); invoices.unshift(inv);
  c.last = date; c.next = c.freq > 0 ? addDays(date, c.freq * 7) : ''; touch(c);
  const ord = (settings.orders || {})[date]; if (ord) settings.orders[date] = ord.filter(id => id !== cid);
  saveJ(); saveI(); saveC(); saveS();
  queueEmail(inv);
  toast(inv.customer.email && settings.autoEmail === 'on' && CLOUD.on ? `Done – emailing ${inv.number} in 10 seconds` : `Done – ${inv.number} created`, job.id);
  render();
}
function undoJob(jobId) {
  const k = jobs.findIndex(j => j.id === jobId); if (k < 0) return;
  const job = jobs[k], inv = invoices.find(i => i.id === job.invoiceId), c = customers.find(x => x.id === job.customerId);
  if (inv && (inv.sent || inv.paid)) { toast('That invoice has already been sent or paid'); return; }
  if (inv) {
    clearTimeout(pending[inv.id]); delete pending[inv.id];
    const n = parseInt((String(inv.number).match(/(\d+)$/) || [])[1], 10);
    if (n && n === (parseInt(settings.invNext, 10) || 1) - 1) { settings.invNext = String(n); saveS(); }   // give the number back so there is no gap
    invoices = invoices.filter(i => i.id !== inv.id); saveI(); CLOUD.del('invoice', inv.id);
  }
  if (c) { c.next = job.prevNext; c.last = job.prevLast; touch(c); saveC(); }
  jobs.splice(k, 1); saveJ(); CLOUD.del('job', jobId);
  toast('Undone'); render();
}

/* ---------- route planning (postcodes.io for locations, nearest-neighbour + 2-opt for the order) ---------- */
const normPC = p => String(p || '').toUpperCase().replace(/\s+/g, '').replace(/^(.+)(\d[A-Z]{2})$/, '$1 $2');
async function geocode(pcs) {
  const out = {}, list = [...new Set(pcs.map(normPC).filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const r = await fetch('https://api.postcodes.io/postcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postcodes: chunk }) });
    if (!r.ok) throw new Error('Postcode lookup failed (' + r.status + ')');
    const j = await r.json();
    (j.result || []).forEach(x => { if (x.result) out[normPC(x.query)] = { lat: x.result.latitude, lng: x.result.longitude }; });
  }
  return out;
}
function hav(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180, dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/* start = {lat,lng} or null; pts = [{id,lat,lng}]; returns { ids, km } */
function planOrder(start, pts) {
  if (!pts.length) return { ids: [], km: 0 };
  const left = pts.slice(), path = [];
  let cur = start || left.shift(); if (!start) path.push(cur);
  while (left.length) { let bi = 0, bd = Infinity; left.forEach((p, i) => { const d = hav(cur, p); if (d < bd) { bd = d; bi = i; } }); cur = left.splice(bi, 1)[0]; path.push(cur); }
  const P = start ? [start, ...path] : path.slice();
  const n = P.length, d = (i, j) => hav(P[i], P[j]);
  for (let pass = 0, imp = true; imp && pass < 50; pass++) {
    imp = false;
    for (let i = 1; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const before = d(i - 1, i) + (j + 1 < n ? d(j, j + 1) : 0), after = d(i - 1, j) + (j + 1 < n ? d(i, j + 1) : 0);
      if (after + 1e-9 < before) { P.splice(i, j - i + 1, ...P.slice(i, j + 1).reverse()); imp = true; }
    }
  }
  let km = 0; for (let i = 1; i < n; i++) km += d(i - 1, i);
  return { ids: (start ? P.slice(1) : P).map(p => p.id), km };
}
async function planRoute() {
  const date = ui.roundDate, S = stopsFor(date).todo;
  if (S.length < 2) { toast('Add at least two houses to plan a route'); return; }
  ui.planning = true; render();
  try {
    const need = S.map(s => s.c).filter(c => c.postcode && (!c.lat || c.geoPc !== normPC(c.postcode)));
    const geo = await geocode(need.map(c => c.postcode).concat(settings.homePostcode ? [settings.homePostcode] : []));
    let changed = false;
    need.forEach(c => { const g = geo[normPC(c.postcode)]; if (g) { c.lat = g.lat; c.lng = g.lng; c.geoPc = normPC(c.postcode); changed = true; } });
    if (changed) saveC();
    const placed = S.map(s => s.c).filter(c => c.lat && c.geoPc === normPC(c.postcode)), missing = S.length - placed.length;
    const hg = settings.homePostcode ? geo[normPC(settings.homePostcode)] : null;
    const r = planOrder(hg || null, placed.map(c => ({ id: c.id, lat: c.lat, lng: c.lng })));
    (settings.orders = settings.orders || {})[date] = r.ids; saveS();
    ui.route = { date, miles: Math.round(r.km * 1.3 * 0.621 * 10) / 10, missing, home: !!hg };
    toast('Route planned' + (missing ? ` – ${missing} without a valid postcode are at the end` : ''));
  } catch (e) { console.warn(e); toast(navigator.onLine === false ? 'You need a signal to plan the route' : 'Could not plan the route: ' + e.message); }
  ui.planning = false; render();
}
const mapQ = c => encodeURIComponent(fullAddr(c));
const navUrl = c => 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + mapQ(c);
function routeLinks(stops) {
  const out = []; let prev = settings.homePostcode ? encodeURIComponent(settings.homePostcode) : '';
  for (let i = 0; i < stops.length; i += 9) {
    const part = stops.slice(i, i + 9), dest = mapQ(part[part.length - 1].c), wp = part.slice(0, -1).map(s => mapQ(s.c)).join('%7C');
    out.push({ from: i + 1, to: i + part.length, url: 'https://www.google.com/maps/dir/?api=1&travelmode=driving' + (prev ? '&origin=' + prev : '') + '&destination=' + dest + (wp ? '&waypoints=' + wp : '') });
    prev = dest;
  }
  return out;
}
const telHref = p => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
const smsHref = (p, body) => 'sms:' + String(p || '').replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(body);
function payTextFor(inv) {
  const bank = [settings.sortCode && 'sort code ' + fmtSort(settings.sortCode), settings.accNo && 'account ' + settings.accNo, settings.accName && '(' + settings.accName + ')'].filter(Boolean).join(' ');
  return fillText(settings.payText, { name: inv.customer.name }).replace(/\{amount\}/g, money(invTotals(inv).total)).replace(/\{bank\}/g, bank || 'the account I will give you').replace(/\{ref\}/g, inv.number);
}
const fillText = (t, c, when) => String(t || '').replace(/\{name\}/g, firstName(c.name)).replace(/\{business\}/g, bizName()).replace(/\{when\}/g, when || 'soon');

/* ---------- screens ---------- */
const ui = { view: 'round', roundDate: todayISO(), salesTab: 'inv', invFilter: 'all', calY: new Date().getFullYear(), calM: new Date().getMonth(), search: '', cust: null, custNew: false, inv: null, statsYear: new Date().getFullYear(), planning: false, moveId: '', route: null, remSent: {} };
const ICON = {
  round: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  cust: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  sales: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'
};
const TABS = [['round', 'Round'], ['cal', 'Calendar'], ['cust', 'Customers'], ['sales', 'Sales']];
const PARENT = { remind: 'round', custEdit: 'cust', inv: 'sales', settings: '' };
function renderTabs() {
  const cur = PARENT[ui.view] !== undefined ? PARENT[ui.view] : ui.view;
  $('#nav').innerHTML = TABS.map(([k, l]) => `<button type="button" class="${cur === k ? 'on' : ''}" data-act="tab" data-v="${k}"><svg viewBox="0 0 24 24">${ICON[k]}</svg>${l}</button>`).join('');
}
const SUB = { round: 'Round', cal: 'Calendar', cust: 'Customers', sales: 'Sales', settings: 'Settings', custEdit: 'Customer', inv: 'Invoice', remind: 'Reminder texts' };
let _lastView = '';
function render() {
  const v = $('#view'), y = window.scrollY;
  (VIEWS[ui.view] || VIEWS.round)(v);
  renderTabs(); $('#barSub').textContent = SUB[ui.view] || ''; applyBrand(); CLOUD.paint();
  if (_lastView === ui.view) window.scrollTo(0, y); else window.scrollTo(0, 0);
  _lastView = ui.view;
}
function applyBrand() { const n = $('#barName'); if (n) n.textContent = settings.businessName || 'Sparkles Window Management'; document.title = settings.businessName || 'Sparkles Window Management'; }
const go = (view, o) => { Object.assign(ui, o || {}, { view }); render(); };
const fld = (b, path, label, o = {}) => {
  const obj = b === 'cust' ? ui.cust : b === 'inv' ? ui.inv : settings, v = getP(obj, path) ?? '';
  const el = o.area ? `<textarea data-b="${b}" data-n="${path}" rows="${o.rows || 3}" placeholder="${esc(o.ph || '')}">${esc(v)}</textarea>`
    : `<input data-b="${b}" data-n="${path}" type="${o.type || 'text'}" ${o.mode ? `inputmode="${o.mode}"` : ''} value="${esc(v)}" placeholder="${esc(o.ph || '')}" autocomplete="${o.ac || 'off'}" autocapitalize="${o.cap || 'sentences'}">`;
  return `<label class="f"><span>${label}</span>${el}${o.hint ? `<small>${o.hint}</small>` : ''}</label>`;
};

/* ----- round ----- */
function stopHtml(s, i) {
  const c = s.c, a = esc(addrFirst(c.address)) + (c.postcode ? ', ' + esc(c.postcode) : '');
  if (s.job) {
    const inv = s.inv, st = inv ? invStatus(inv) : '';
    const sent = !inv ? '' : inv.sent ? (inv.sentTo === 'SMS' ? 'texted ✓' : 'emailed ✓') : pending[inv.id] ? 'emailing in a moment…' : inv.sendError ? 'email failed – tap Invoice' : inv.customer.email ? 'not emailed yet' : 'no email – text instead';
    return `<div class="stop done"><div class="row top"><div class="num">✓</div><div class="grow"><div class="nm">${esc(c.name)}</div><div class="ad">${a}</div></div><div class="pr">${money(s.job.price)}</div></div>
      ${inv ? `<div class="row sp" style="margin-top:10px"><span class="small muted">${esc(inv.number)} · ${sent}</span><span class="badge ${st}">${st}</span></div>
      <div class="seg" style="margin-top:10px">${PAY.map(m => `<button type="button" class="pay ${inv.paid && inv.payMethod === m ? 'on' : ''}" data-act="pay" data-id="${inv.id}" data-m="${m}">${m}</button>`).join('')}</div>
      <div class="acts">${!inv.customer.email && c.phone && !inv.paid ? `<a class="btn blue sm" data-act="smsSent" data-id="${inv.id}" href="${esc(smsHref(c.phone, payTextFor(inv)))}">${inv.sent ? 'Text again' : 'Text payment request'}</a>` : ''}<button class="btn ghost sm" data-act="openInv" data-id="${inv.id}">Open invoice</button>${!inv.sent && !inv.paid ? `<button class="btn ghost sm" data-act="undoJob" data-id="${s.job.id}">Undo</button>` : ''}</div>` : ''}</div>`;
  }
  const moving = ui.moveId === c.id;
  return `<div class="stop"><div class="row top"><div class="num">${i + 1}</div><div class="grow"><div class="nm">${esc(c.name)} ${s.overdue ? '<span class="badge overdue">overdue</span>' : ''}</div><div class="ad">${a}</div></div><div class="pr">${c.price ? money(numOf(c.price)) : '–'}</div></div>
    ${c.notes ? `<div class="note">${esc(c.notes)}</div>` : ''}
    <div class="acts"><a class="btn sm" href="${navUrl(c)}" target="_blank" rel="noopener">Navigate</a>${c.phone ? `<a class="btn sm" href="${telHref(c.phone)}">Call</a><a class="btn sm" href="${esc(smsHref(c.phone, fillText(settings.omwText, c)))}">On my way</a>` : ''}</div>
    <div class="acts"><button class="btn teal block" data-act="complete" data-id="${c.id}">✓ Complete${c.email && settings.autoEmail === 'on' && CLOUD.on ? ' &amp; send invoice' : ' &amp; create invoice'}</button></div>
    ${moving ? `<div class="row" style="margin-top:10px"><input type="date" id="moveDate" value="${addDays(ui.roundDate, 1)}"><button class="btn sm" data-act="doMove" data-id="${c.id}">Move</button><button class="btn ghost sm" data-act="cancelMove">Cancel</button></div>`
      : `<div class="acts"><button class="btn ghost sm" data-act="moveStop" data-id="${c.id}">Move date</button><button class="btn ghost sm" data-act="skipStop" data-id="${c.id}">Skip this time</button></div>`}</div>`;
}
function renderRound(v) {
  const date = ui.roundDate, today = todayISO(), S = stopsFor(date);
  const total = S.todo.reduce((a, s) => a + numOf(s.c.price), 0) + S.done.reduce((a, s) => a + numOf(s.job.price), 0);
  const route = ui.route && ui.route.date === date ? ui.route : null;
  const links = S.todo.length > 1 ? routeLinks(S.todo) : [];
  const unsent = CLOUD.on && CLOUD.signedIn() ? invoices.filter(i => !i.sent && i.customer.email && !pending[i.id]).length : 0;
  v.innerHTML = `
    <div class="daynav"><button data-act="dayPrev" aria-label="Previous day">‹</button><div class="day">${date === today ? 'Today · ' : date === addDays(today, 1) ? 'Tomorrow · ' : ''}${dayLabel(date)}</div><button data-act="dayNext" aria-label="Next day">›</button></div>
    ${date !== today ? `<button class="btn ghost sm block" data-act="dayToday" style="margin-bottom:12px">Back to today</button>` : ''}
    <div class="card"><div class="row sp"><div><div class="small muted">${S.todo.length + S.done.length} houses · ${S.done.length} done</div><div class="big">${money(total)}</div></div>
      <div style="text-align:right"><div class="small muted">${S.todo.length} to go</div>${route ? `<div class="small" style="color:var(--blue2);font-weight:700">≈ ${route.miles} miles</div>` : ''}</div></div></div>
    ${!settings.homePostcode ? `<div class="notice">Add your home postcode in <a href="#" data-act="goSettings" style="color:inherit;font-weight:700">Settings</a> so the route starts from your door.</div>` : ''}
    ${S.todo.length > 1 ? `<button class="btn blue block" data-act="plan" ${ui.planning ? 'disabled' : ''}>${ui.planning ? 'Planning the best route…' : route ? '↻ Re-plan the route' : '🧭 Plan the best route'}</button><div class="gap"></div>` : ''}
    ${route && route.missing ? `<div class="notice warn">${route.missing} house${route.missing > 1 ? 's have' : ' has'} no valid postcode, so ${route.missing > 1 ? 'they are' : 'it is'} at the end. Add the postcode on the customer.</div>` : ''}
    ${links.length ? `<div class="chips">${links.map(l => `<a class="chip on" style="text-decoration:none" href="${l.url}" target="_blank" rel="noopener">Maps: stops ${l.from}–${l.to}</a>`).join('')}</div>` : ''}
    ${S.todo.length ? S.todo.map((s, i) => stopHtml(s, i)).join('') : `<div class="empty">${S.done.length ? 'All done for this day 🎉' : 'Nobody due on this day.<br>Add customers or pick another date in the Calendar.'}</div>`}
    ${S.done.length ? `<h2>Done (${S.done.length})</h2>${S.done.map(s => stopHtml(s, 0)).join('')}` : ''}
    <div class="gap"></div>
    <button class="btn block" data-act="addToRound">+ Add a customer to this day</button>
    ${S.todo.length && date > today ? `<div class="gap"></div><button class="btn block" data-act="remind">Send reminder texts for this day</button>` : ''}
    ${unsent ? `<div class="gap"></div><div class="notice warn">${unsent} invoice${unsent > 1 ? 's' : ''} not emailed yet. <a href="#" data-act="sendAll" style="color:inherit;font-weight:700">Send them now</a></div>` : ''}`;
}
function renderRemind(v) {
  const date = ui.roundDate, S = stopsFor(date).todo, when = date === addDays(todayISO(), 1) ? 'tomorrow' : 'on ' + dayLabel(date);
  v.innerHTML = `<h1>Reminder texts</h1><p class="muted">For ${dayLabel(date)}. Tap Text next to each customer – your messages app opens with the text ready, and you just press send. Edit the wording in Settings.</p>
    ${S.map(s => { const c = s.c, sent = ui.remSent[date + c.id];
      return `<div class="item"><div class="row sp"><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(addrFirst(c.address))}</div></div>${c.phone ? `<a class="btn sm ${sent ? 'ghost' : 'blue'}" data-act="remSent" data-k="${esc(date + c.id)}" href="${esc(smsHref(c.phone, fillText(settings.remText, c, when)))}">${sent ? 'Sent ✓' : 'Text'}</a>` : '<span class="small muted">no number</span>'}</div></div>`; }).join('') || '<div class="empty">Nobody due that day.</div>'}
    <button class="btn ghost block" data-act="tab" data-v="round">Back to the round</button>`;
}

/* ----- calendar ----- */
function renderCal(v) {
  const y = ui.calY, m = ui.calM, first = new Date(y, m, 1), startOff = (first.getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate(), today = todayISO();
  const cells = []; for (let i = 0; i < startOff; i++) cells.push(null); for (let d = 1; d <= days; d++) cells.push(iso(new Date(y, m, d, 12)));
  const count = d => { const done = jobs.filter(j => j.date === d).length; if (d < today) return done; return customers.filter(c => occursOn(c, d) || (d === today && isActive(c) && c.next && c.next < today)).length + done; };
  v.innerHTML = `<div class="daynav"><button data-act="calPrev">‹</button><div class="day">${first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div><button data-act="calNext">›</button></div>
    <div class="calg">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="hd">${d}</div>`).join('')}${cells.map(d => { if (!d) return '<div></div>'; const n = count(d); return `<button type="button" data-act="calDay" data-d="${d}" class="${d === today ? 'today' : ''} ${d === ui.roundDate ? 'sel' : ''}">${+d.slice(8)}${n ? `<b>${n}</b>` : ''}</button>`; }).join('')}</div>
    <p class="small muted" style="margin-top:12px">The number on a day is how many houses are due (or were cleaned). Tap a day to open its round.</p>`;
}

/* ----- customers ----- */
function custRow(c) {
  return `<button class="item" data-act="editCust" data-id="${c.id}"><div class="row sp"><span class="t">${esc(c.name)}</span><span class="t" style="color:var(--blue2)">${c.price ? money(numOf(c.price)) : ''}</span></div>
    <div class="s">${esc(addrFirst(c.address))}${c.postcode ? ', ' + esc(c.postcode) : ''}</div>
    <div class="row sp"><span class="s">${freqText(c)}${c.next ? ' · next ' + ukDate(c.next) : ''}</span>${isActive(c) ? '' : '<span class="badge">paused</span>'}</div></button>`;
}
function paintCustList() {
  const q = ui.search.trim().toLowerCase(), box = $('#custList'); if (!box) return;
  const list = customers.filter(c => !q || [c.name, c.address, c.postcode, c.phone].join(' ').toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  box.innerHTML = list.length ? list.map(custRow).join('') : `<div class="empty">${customers.length ? 'No match.' : 'No customers yet.<br>Add one, or import a list from a spreadsheet (CSV).'}</div>`;
}
function renderCust(v) {
  v.innerHTML = `<h1>Customers <span class="small muted">(${customers.length})</span></h1>
    ${ui.pickDay ? `<div class="notice">Tap a customer to put them on ${ukDate(ui.roundDate)}. <a href="#" data-act="tab" data-v="round" style="color:inherit;font-weight:700">Cancel</a></div>` : ''}
    <button class="btn blue block" data-act="newCust">+ Add customer</button><div class="gap"></div>
    <label class="btn block" style="cursor:pointer">Import customers from a CSV file<input type="file" id="csvFile" accept=".csv,text/csv" hidden></label><div class="gap"></div>
    <input class="search" id="custSearch" placeholder="Search name, street, postcode or phone" value="${esc(ui.search)}" autocomplete="off"><div id="custList"></div>`;
  paintCustList();
}
function renderCustEdit(v) {
  const c = ui.cust, hist = jobs.filter(j => j.customerId === c.id).sort((a, b) => b.date.localeCompare(a.date));
  v.innerHTML = `<h1>${ui.custNew ? 'New customer' : esc(c.name || 'Customer')}</h1>
    <div class="card">
      ${fld('cust', 'name', 'Name', { cap: 'words', ac: 'name' })}
      ${fld('cust', 'phone', 'Mobile', { type: 'tel', mode: 'tel', ac: 'tel' })}
      ${fld('cust', 'email', 'Email (invoices are sent here)', { type: 'email', mode: 'email', cap: 'none', ac: 'email' })}
      ${fld('cust', 'address', 'Address', { area: 1, rows: 3, cap: 'words', ph: 'House number and street\nTown' })}
      ${fld('cust', 'postcode', 'Postcode', { cap: 'characters', hint: 'Needed to plan the best route.' })}
    </div>
    <h2>Cleaning</h2>
    <div class="card">
      ${fld('cust', 'price', 'Price per clean (£)', { mode: 'decimal' })}
      <div class="f"><span>How often</span><div class="chips">${[4, 6, 8, 12, 0].map(n => `<button type="button" class="chip ${+c.freq === n ? 'on' : ''}" data-act="setFreq" data-n="${n}">${n ? n + ' weeks' : 'One-off'}</button>`).join('')}</div></div>
      ${fld('cust', 'next', 'Next clean due', { type: 'date' })}
      ${fld('cust', 'notes', 'Notes (gate code, dog, access…)', { area: 1, rows: 2 })}
      <label class="row" style="margin-bottom:6px"><input type="checkbox" data-b="cust" data-n="paused" ${c.active === false ? 'checked' : ''}><span>Paused – leave off the round for now</span></label>
    </div>
    <button class="btn blue block" data-act="saveCust">Save customer</button><div class="gap"></div>
    <button class="btn ghost block" data-act="tab" data-v="cust">Cancel</button>
    ${!ui.custNew ? `<h2>History (${hist.length})</h2>${hist.map(j => { const i = invoices.find(x => x.id === j.invoiceId); return `<div class="item"><div class="row sp"><span class="t">${ukDate(j.date)}</span><span class="t">${money(j.price)}</span></div>${i ? `<div class="s">${esc(i.number)} · ${invStatus(i)}</div>` : ''}</div>`; }).join('') || '<div class="empty">No cleans yet.</div>'}
    <div class="gap"></div><button class="btn danger block" data-act="delCust">Delete this customer</button>` : ''}`;
}
/* CSV: handles quoted fields, commas inside quotes and Excel's line endings */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const looseDate = s => { s = String(s || '').trim(); let m; if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`; if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`; return ''; };
function importCSV(text) {
  const rows = parseCSV(text); if (rows.length < 2) { toast('That file has no customers in it'); return; }
  const head = rows[0].map(h => h.trim().toLowerCase()), col = (...names) => head.findIndex(h => names.some(n => h === n || h.includes(n)));
  const ix = { name: col('name', 'customer'), address: col('address', 'street'), postcode: col('postcode', 'post code'), phone: col('phone', 'mobile', 'tel'), email: col('email'), price: col('price', 'charge', '£'), freq: col('freq', 'every', 'weeks'), next: col('next', 'due'), notes: col('note') };
  if (ix.name < 0) { toast('The first row must have a "name" column'); return; }
  let n = 0;
  rows.slice(1).forEach(r => {
    const g = k => (ix[k] >= 0 ? String(r[ix[k]] || '').trim() : ''); if (!g('name')) return;
    const fr = parseInt(g('freq'), 10);
    customers.push(touch({ id: uid(), name: g('name'), address: g('address'), postcode: g('postcode').toUpperCase(), phone: g('phone'), email: g('email'), price: g('price').replace(/[£\s]/g, ''), freq: isFinite(fr) ? fr : (parseInt(settings.defaultFreq, 10) || 4), next: looseDate(g('next')), notes: g('notes'), active: true, created: Date.now() })); n++;
  });
  saveC(); toast(n + ' customer' + (n === 1 ? '' : 's') + ' imported'); render();
}

/* ----- sales: invoices and statistics ----- */
const salesTabs = () => `<div class="seg" style="margin-bottom:12px"><button type="button" class="${ui.salesTab === 'inv' ? 'on' : ''}" data-act="salesTab" data-t="inv">Invoices</button><button type="button" class="${ui.salesTab === 'stats' ? 'on' : ''}" data-act="salesTab" data-t="stats">Statistics</button></div>`;
function renderSales(v) { return ui.salesTab === 'stats' ? renderStats(v) : renderInvoices(v); }
function renderInvoices(v) {
  const f = ui.invFilter, list = [...invoices].sort((a, b) => (b.date + b.number).localeCompare(a.date + a.number));
  const open = invoices.filter(i => !i.paid), late = open.filter(i => invStatus(i) === 'overdue'), owed = open.reduce((a, i) => a + invTotals(i).total, 0);
  const shown = list.filter(i => f === 'all' || (f === 'unpaid' && !i.paid) || (f === 'paid' && i.paid) || (f === 'overdue' && invStatus(i) === 'overdue'));
  const chip = (k, l) => `<button class="chip ${f === k ? 'on' : ''}" data-act="invFilter" data-f="${k}">${l}</button>`;
  v.innerHTML = `<h1>Sales</h1>${salesTabs()}
    <div class="card"><div class="row sp"><div><div class="small muted">Outstanding</div><div class="big">${money(owed)}</div></div><div style="text-align:right"><div class="small muted">${open.length} unpaid</div>${late.length ? `<div class="small" style="color:var(--bad);font-weight:700">${late.length} overdue</div>` : ''}</div></div></div>
    <button class="btn blue block" data-act="newInv">+ New invoice</button><div class="gap"></div>
    <button class="btn block" data-act="csvOut">Download for my accountant (CSV)</button><div class="gap"></div>
    <div class="chips">${chip('all', 'All')}${chip('unpaid', 'Unpaid')}${late.length ? chip('overdue', 'Overdue (' + late.length + ')') : ''}${chip('paid', 'Paid')}</div>
    ${shown.length ? shown.map(i => `<button class="item" data-act="openInv" data-id="${i.id}"><div class="row sp"><span class="t">${esc(i.customer.name || 'No customer')}</span><span class="badge ${invStatus(i)}">${invStatus(i)}</span></div>
      <div class="s">${esc(addrFirst(i.jobAddress) || 'No address')}</div><div class="row sp"><span class="s">${esc(i.number)} · ${ukDate(i.date)}${i.paid ? ' · ' + esc(i.payMethod || '') : ' · due ' + ukDate(i.due)}${i.sent ? (i.sentTo === 'SMS' ? ' · texted ✓' : ' · emailed ✓') : ''}</span><span class="t">${money(invTotals(i).total)}</span></div></button>`).join('') : `<div class="empty">${invoices.length ? 'Nothing in this view.' : 'No invoices yet.<br>They appear here when you tap Complete on the round.'}</div>`}`;
}
function renderInvEdit(v) {
  const i = ui.inv, T = invTotals(i);
  v.innerHTML = `<div class="row sp"><h1 style="margin-bottom:6px">${esc(i.number)}</h1><span class="badge ${invStatus(i)}">${invStatus(i)}</span></div>
    <div class="card"><div class="row sp"><span class="t">${i.paid ? 'Paid on ' + ukDate(i.paidDate) : 'Mark as paid'}</span></div>
      <div class="seg" style="margin-top:10px">${PAY.map(m => `<button type="button" class="pay ${i.paid && i.payMethod === m ? 'on' : ''}" data-act="payHere" data-m="${m}">${m}</button>`).join('')}</div>
      <p class="small muted" style="margin:8px 0 0">${i.paid ? 'Tap the highlighted button again to mark it unpaid.' : 'One tap marks it paid and records how.'}</p></div>
    <button class="btn blue block" data-act="emailInv">${i.sent ? 'Email it again' : 'Email invoice'}${i.customer.email ? ' to ' + esc(i.customer.email) : ''}</button>
    ${i.sendError ? `<p class="err">Last attempt failed: ${esc(i.sendError)}</p>` : ''}<div class="gap"></div>
    <button class="btn block" data-act="viewInv">View invoice (PDF)</button>
    <h2>Customer</h2><div class="card">
      ${fld('inv', 'customer.name', 'Name', { cap: 'words' })}${fld('inv', 'customer.email', 'Email', { type: 'email', mode: 'email', cap: 'none' })}
      ${fld('inv', 'customer.billing', 'Billing address', { area: 1, rows: 2 })}${fld('inv', 'jobAddress', 'Property cleaned', { area: 1, rows: 2 })}</div>
    <h2>Dates</h2><div class="card">${fld('inv', 'date', 'Invoice date', { type: 'date' })}${fld('inv', 'due', 'Payment due by', { type: 'date' })}${fld('inv', 'workDate', 'Date of work', { type: 'date' })}</div>
    <h2>Services</h2>${i.lines.map((l, k) => `<div class="card">${fld('inv', `lines.${k}.d`, 'Description')}<div class="row"><div class="grow">${fld('inv', `lines.${k}.q`, 'Qty', { mode: 'decimal' })}</div><div class="grow">${fld('inv', `lines.${k}.p`, 'Price each (£)', { mode: 'decimal' })}</div></div>${i.lines.length > 1 ? `<button class="btn danger block" data-act="rmLine" data-i="${k}">Remove this line</button>` : ''}</div>`).join('')}
    <button class="btn block" data-act="addLine">+ Add a line</button>
    <h2>VAT and notes</h2><div class="card">${fld('inv', 'vatRate', 'VAT rate (%)', { mode: 'decimal', hint: 'Prices are entered without VAT. Use 0 for no VAT.' })}${fld('inv', 'notes', 'Note on the invoice', { area: 1, rows: 2 })}</div>
    <div class="card" id="invTotals">${invTotalsHtml(i)}</div>
    <button class="btn ghost block" data-act="tab" data-v="sales">Back to invoices</button><div class="gap"></div>
    <button class="btn danger block" data-act="delInv">Delete this invoice</button>`;
}
const invTotalsHtml = i => { const T = invTotals(i); return `<dl class="kv"><dt>Subtotal</dt><dd>${money(T.sub)}</dd>${T.rate > 0 ? `<dt>VAT (${T.rate}%)</dt><dd>${money(T.vat)}</dd>` : ''}<dt><b>Total ${i.paid ? 'paid' : 'due'}</b></dt><dd style="font-size:18px">${money(T.total)}</dd></dl>`; };
function weekStart(d) { const x = parse(d), k = (x.getDay() + 6) % 7; return addDays(d, -k); }
function renderStats(v) {
  const yr = ui.statsYear, today = todayISO(), mon = today.slice(0, 7);
  const jy = jobs.filter(j => j.date.startsWith(yr + '-')), iy = invoices.filter(i => i.date.startsWith(yr + '-'));
  const sum = a => a.reduce((s, i) => s + invTotals(i).total, 0), net = a => a.reduce((s, i) => s + invTotals(i).net, 0), vat = a => a.reduce((s, i) => s + invTotals(i).vat, 0);
  const paidInv = iy.filter(i => i.paid), owed = iy.filter(i => !i.paid);
  const years = [...new Set([new Date().getFullYear(), ...jobs.map(j => +j.date.slice(0, 4)), ...invoices.map(i => +i.date.slice(0, 4))])].sort((a, b) => b - a);
  const months = Array.from({ length: 12 }, (_, m) => { const p = yr + '-' + pad(m + 1); return { m, houses: jy.filter(j => j.date.startsWith(p)).length, inc: sum(iy.filter(i => i.date.startsWith(p))) }; });
  const maxM = Math.max(1, ...months.map(m => m.houses)), ws = weekStart(today);
  const weeks = Array.from({ length: 8 }, (_, k) => { const s = addDays(ws, -7 * (7 - k)), e = addDays(s, 6); return { s, n: jobs.filter(j => j.date >= s && j.date <= e).length }; }), maxW = Math.max(1, ...weeks.map(w => w.n));
  const by = m => paidInv.filter(i => i.payMethod === m);
  v.innerHTML = `<h1>Sales</h1>${salesTabs()}
    <div class="chips">${years.map(y => `<button class="chip ${y === yr ? 'on' : ''}" data-act="statsYear" data-y="${y}">${y}</button>`).join('')}</div>
    <div class="card"><div class="small muted">Houses cleaned in ${yr}</div><div class="big">${jy.length}</div>
      <dl class="stat" style="margin-top:8px"><dt>This month</dt><dd>${jobs.filter(j => j.date.startsWith(mon)).length}</dd><dt>This week</dt><dd>${jobs.filter(j => j.date >= ws && j.date <= addDays(ws, 6)).length}</dd><dt>Average per house</dt><dd>${jy.length ? money(sum(iy) / jy.length) : '–'}</dd></dl></div>
    <h2>Money</h2><div class="card"><dl class="stat"><dt>Invoiced (before VAT)</dt><dd>${money(net(iy))}</dd><dt>VAT</dt><dd>${money(vat(iy))}</dd><dt>Total invoiced</dt><dd>${money(sum(iy))}</dd><dt>Paid</dt><dd>${money(sum(paidInv))}</dd><dt>Still owed</dt><dd style="color:${owed.length ? 'var(--bad)' : 'inherit'}">${money(sum(owed))}</dd></dl></div>
    <h2>How they paid</h2><div class="card"><dl class="stat">${PAY.map(m => `<dt>${m} (${by(m).length})</dt><dd>${money(sum(by(m)))}</dd>`).join('')}</dl></div>
    <h2>Last 8 weeks – houses per week</h2><div class="card bars">${weeks.map(w => `<div class="b"><span class="small muted">${ukDate(w.s).slice(0, 5)}</span><i style="width:${Math.max(2, Math.round(w.n / maxW * 100))}%"></i><b>${w.n}</b></div>`).join('')}</div>
    <h2>Month by month</h2><div class="card bars">${months.map(m => `<div class="b"><span class="small muted">${new Date(2000, m.m, 1).toLocaleDateString('en-GB', { month: 'short' })}</span><i style="width:${Math.max(m.houses ? 2 : 0, Math.round(m.houses / maxM * 100))}%"></i><b>${m.houses} · ${money(m.inc)}</b></div>`).join('')}</div>`;
}
function downloadFile(name, type, content) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
const csvCell = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
function exportCSV() {
  const rows = [['Invoice', 'Date', 'Customer', 'Property', 'Net', 'VAT', 'Total', 'Paid', 'Paid date', 'Paid by']];
  [...invoices].sort((a, b) => a.date.localeCompare(b.date)).forEach(i => { const T = invTotals(i); rows.push([i.number, ukDate(i.date), i.customer.name, addrLine(i.jobAddress), T.net.toFixed(2), T.vat.toFixed(2), T.total.toFixed(2), i.paid ? 'Yes' : 'No', ukDate(i.paidDate), i.payMethod || '']); });
  downloadFile('invoices.csv', 'text/csv', rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
}

/* ----- settings ----- */
function renderSettings(v) {
  v.innerHTML = `<h1>Settings</h1>
    <h2>Your business</h2><div class="card">${fld('set', 'businessName', 'Business name', { cap: 'words', ph: 'Sparkles Window Management' })}${fld('set', 'phone', 'Phone', { type: 'tel', mode: 'tel' })}${fld('set', 'email', 'Email (customers can reply to this)', { type: 'email', mode: 'email', cap: 'none' })}${fld('set', 'address', 'Business address', { area: 1, rows: 3 })}${fld('set', 'homePostcode', 'Home postcode (your round starts here)', { cap: 'characters' })}</div>
    <h2>Invoices</h2><div class="card">
      <div class="f"><span>Email invoices automatically when I tap Complete</span><div class="seg">${['on', 'off'].map(x => `<button type="button" class="${settings.autoEmail === x ? 'on' : ''}" data-act="setOpt" data-k="autoEmail" data-v="${x}">${x === 'on' ? 'Yes' : 'No'}</button>`).join('')}</div></div>
      ${fld('set', 'invPrefix', 'Invoice number prefix', { cap: 'characters' })}${fld('set', 'invNext', 'Next invoice number', { mode: 'numeric' })}${fld('set', 'payDays', 'Days to pay', { mode: 'numeric' })}
      <div class="f"><span>VAT registered?</span><div class="seg">${['No', 'Yes'].map(x => `<button type="button" class="${settings.vatReg === x ? 'on' : ''}" data-act="setOpt" data-k="vatReg" data-v="${x}">${x}</button>`).join('')}</div></div>
      ${settings.vatReg === 'Yes' ? fld('set', 'vatRate', 'VAT rate (%)', { mode: 'decimal' }) + fld('set', 'vatNumber', 'VAT number') : ''}
      ${fld('set', 'invFooter', 'Message at the bottom of invoices', { area: 1, rows: 2 })}</div>
    <h2>Bank details (shown on invoices)</h2><div class="card">${fld('set', 'bankName', 'Bank')}${fld('set', 'accName', 'Account name')}${fld('set', 'sortCode', 'Sort code', { mode: 'numeric' })}${fld('set', 'accNo', 'Account number', { mode: 'numeric' })}</div>
    <h2>Customers</h2><div class="card">${fld('set', 'defaultFreq', 'Default weeks between cleans', { mode: 'numeric' })}${fld('set', 'omwText', '"On my way" text', { area: 1, rows: 3, hint: 'Use {name} and {business}.' })}${fld('set', 'payText', 'Payment text (for customers with no email)', { area: 1, rows: 6, hint: 'Use {name}, {amount}, {bank}, {ref} and {business}.' })}${fld('set', 'remText', 'Reminder text', { area: 1, rows: 3, hint: 'Use {name}, {business} and {when}.' })}</div>
    <h2>Account and data</h2><div class="card"><div class="small muted" id="syncMsg" style="margin-bottom:10px"></div>
      ${CLOUD.on ? `<div class="small muted" style="margin-bottom:10px">Signed in as ${esc(CLOUD.email())}</div><button class="btn block" data-act="syncNow">Sync now</button><div class="gap"></div>` : ''}
      <button class="btn block" data-act="backup">Download a backup</button><div class="gap"></div>
      <label class="btn block" style="cursor:pointer">Restore from a backup<input type="file" id="restoreFile" accept=".json,application/json" hidden></label>
      ${CLOUD.on && CLOUD.signedIn() ? `<div class="gap"></div><button class="btn danger block" data-act="logout">Log out</button>` : ''}
      <p class="small muted" style="margin-bottom:0">Version ${APP_VERSION}</p></div>
    <button class="btn ghost block" data-act="tab" data-v="round">Back to the round</button>`;
}

const VIEWS = { round: renderRound, remind: renderRemind, cal: renderCal, cust: renderCust, custEdit: renderCustEdit, sales: renderSales, inv: renderInvEdit, settings: renderSettings };

/* ---------- actions ---------- */
const ACT = {
  tab: d => go(d.v, { search: '', pickDay: false }),
  goSettings: () => go('settings'),
  complete: d => completeStop(d.id, ui.roundDate),
  undoJob: d => undoJob(d.id),
  pay: d => { const i = invoices.find(x => x.id === d.id); if (i) setPaid(i, d.m); },
  payHere: d => setPaid(ui.inv, d.m),
  openInv: d => { const i = invoices.find(x => x.id === d.id); if (i) go('inv', { inv: i }); },
  dayPrev: () => { ui.roundDate = addDays(ui.roundDate, -1); render(); },
  dayNext: () => { ui.roundDate = addDays(ui.roundDate, 1); render(); },
  dayToday: () => { ui.roundDate = todayISO(); render(); },
  plan: () => planRoute(),
  moveStop: d => { ui.moveId = d.id; render(); },
  cancelMove: () => { ui.moveId = ''; render(); },
  doMove: d => { const c = customers.find(x => x.id === d.id), nd = $('#moveDate').value; if (!c || !nd) return; c.next = nd; touch(c); saveC(); ui.moveId = ''; toast('Moved to ' + ukDate(nd)); render(); },
  skipStop: d => { const c = customers.find(x => x.id === d.id); if (!c) return; c.next = c.freq > 0 ? addDays(ui.roundDate, c.freq * 7) : ''; touch(c); saveC(); toast('Skipped – next ' + (c.next ? ukDate(c.next) : 'none')); render(); },
  addToRound: () => { ui.pickDay = true; go('cust', { search: '', pickDay: true }); toast('Tap a customer to put them on ' + ukDate(ui.roundDate)); },
  remind: () => go('remind'),
  smsSent: d => { const i = invoices.find(x => x.id === d.id); if (i) { i.sent = Date.now(); i.sentTo = 'SMS'; touch(i); saveI(); } setTimeout(render, 400); },
  remSent: d => { ui.remSent[d.k] = true; setTimeout(render, 400); },
  sendAll: async () => { const L = invoices.filter(i => !i.sent && i.customer.email && !pending[i.id]); let n = 0; for (const i of L) if (await sendInvoiceEmail(i)) n++; toast(n + ' of ' + L.length + ' emailed'); },
  calPrev: () => { if (--ui.calM < 0) { ui.calM = 11; ui.calY--; } render(); },
  calNext: () => { if (++ui.calM > 11) { ui.calM = 0; ui.calY++; } render(); },
  calDay: d => go('round', { roundDate: d.d }),
  newCust: () => go('custEdit', { custNew: true, cust: { id: uid(), name: '', phone: '', email: '', address: '', postcode: '', price: settings.defaultPrice || '', freq: parseInt(settings.defaultFreq, 10) || 4, next: ui.roundDate, notes: '', active: true, created: Date.now() } }),
  editCust: d => {
    const c = customers.find(x => x.id === d.id); if (!c) return;
    if (ui.pickDay) { ui.pickDay = false; c.next = ui.roundDate; touch(c); saveC(); toast(c.name + ' added to ' + ukDate(ui.roundDate)); go('round'); return; }
    go('custEdit', { custNew: false, cust: Object.assign(JSON.parse(JSON.stringify(c)), { paused: c.active === false }) });
  },
  setFreq: d => { ui.cust.freq = +d.n; render(); },
  saveCust: () => {
    const c = ui.cust; c.name = String(c.name || '').trim(); if (!c.name) { toast('Please enter a name'); return; }
    c.postcode = String(c.postcode || '').toUpperCase().trim(); c.active = !c.paused; delete c.paused; touch(c);
    const k = customers.findIndex(x => x.id === c.id); if (k >= 0) customers[k] = c; else customers.push(c);
    saveC(); toast('Saved'); go('cust');
  },
  delCust: () => { if (!confirm('Delete ' + ui.cust.name + '? Their past invoices stay.')) return; customers = customers.filter(x => x.id !== ui.cust.id); saveC(); CLOUD.del('customer', ui.cust.id); go('cust'); },
  salesTab: d => { ui.salesTab = d.t; render(); },
  invFilter: d => { ui.invFilter = d.f; render(); },
  statsYear: d => { ui.statsYear = +d.y; render(); },
  newInv: () => { const i = makeInvoice(null); invoices.unshift(i); saveI(); go('inv', { inv: i }); },
  emailInv: () => sendInvoiceEmail(ui.inv, true),
  viewInv: () => openInvPdf(ui.inv),
  addLine: () => { ui.inv.lines.push({ d: '', q: '1', p: '' }); touch(ui.inv); saveI(); render(); },
  rmLine: d => { ui.inv.lines.splice(+d.i, 1); touch(ui.inv); saveI(); render(); },
  delInv: () => { if (!confirm('Delete ' + ui.inv.number + '?')) return; const id = ui.inv.id; clearTimeout(pending[id]); invoices = invoices.filter(x => x.id !== id); saveI(); CLOUD.del('invoice', id); go('sales'); },
  csvOut: exportCSV,
  setOpt: d => { settings[d.k] = d.v; saveS(); render(); },
  syncNow: () => CLOUD.sync(),
  logout: () => { if (confirm('Log out? Your data stays safe in the cloud.')) CLOUD.signOut(); },
  backup: () => downloadFile('sparkles-backup-' + todayISO() + '.json', 'application/json', JSON.stringify({ app: 'swm', v: 1, settings, customers, jobs, invoices })),
  toastUndo: () => { }
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const f = ACT[b.dataset.act]; if (!f) return;
  if (b.tagName !== 'A' || !b.getAttribute('href') || b.getAttribute('href') === '#') e.preventDefault();
  f(b.dataset, b, e);
});
/* typing in forms: update the data without redrawing (so the keyboard stays up) */
function onInput(e) {
  const el = e.target;
  if (el.id === 'custSearch') { ui.search = el.value; paintCustList(); return; }
  const b = el.dataset && el.dataset.b; if (!b) return;
  const o = b === 'cust' ? ui.cust : b === 'inv' ? ui.inv : settings; if (!o) return;
  const v = el.type === 'checkbox' ? el.checked : el.value;
  setP(o, el.dataset.n, v);
  if (b === 'set') { saveS(); if (el.dataset.n === 'businessName') applyBrand(); }
  if (b === 'inv') { touch(ui.inv); clearTimeout(onInput._t); onInput._t = setTimeout(saveI, 400); const t = $('#invTotals'); if (t) t.innerHTML = invTotalsHtml(ui.inv); }
}
document.addEventListener('input', onInput);
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'csvFile' && el.files[0]) { const r = new FileReader(); r.onload = () => importCSV(String(r.result)); r.readAsText(el.files[0]); el.value = ''; }
  if (el.id === 'restoreFile' && el.files[0]) {
    const r = new FileReader(); r.onload = () => {
      try {
        const j = JSON.parse(String(r.result)); if (j.app !== 'swm') throw new Error('not a backup from this app');
        if (!confirm('Replace everything on this phone with this backup?')) return;
        settings = Object.assign({}, DEFAULTS, j.settings); customers = j.customers || []; jobs = j.jobs || []; invoices = j.invoices || [];
        const t = Date.now(); [settings, ...customers, ...jobs, ...invoices].forEach(o => { o.updated = t; });
        LS.set('swm_settings', settings); LS.set('swm_customers', customers); LS.set('swm_jobs', jobs); LS.set('swm_invoices', invoices); CLOUD.changed(); toast('Backup restored'); render();
      } catch (ex) { toast('That file is not a valid backup: ' + ex.message); }
    }; r.readAsText(el.files[0]); el.value = '';
  }
  if (el.dataset && el.dataset.b === 'cust' && el.dataset.n === 'paused') ui.cust.paused = el.checked;
});

/* ---------- start ---------- */
applyBrand(); render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
