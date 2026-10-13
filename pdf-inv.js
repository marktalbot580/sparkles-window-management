/* Invoice PDF – portrait A4, water blue. Uses jsPDF (lib/jspdf.umd.min.js). */
'use strict';

const money = n => '£' + (Math.round((+n || 0) * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numOf = v => { const n = parseFloat(String(v ?? '').replace(/[£,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const addrLine = a => String(a || '').split(/\r?\n/).map(x => x.trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
const fmtSort = v => (String(v || '').replace(/\D/g, '').slice(0, 6).match(/.{1,2}/g) || []).join('-');

/* subtotal, discount, VAT and total for an invoice (all rounded to the penny) */
function invTotals(inv) {
  const sub = r2((inv.lines || []).reduce((a, l) => a + r2(numOf(l.q || 1) * numOf(l.p)), 0));
  const entered = Math.max(numOf(inv.disc), 0);
  const disc = Math.min(Math.max(inv.discMode === '%' ? r2(sub * Math.min(entered, 100) / 100) : r2(entered), 0), Math.max(sub, 0));
  const net = r2(sub - disc);
  const rate = numOf(inv.vatRate);
  const vat = rate > 0 ? r2(net * rate / 100) : 0;
  return { sub, disc, net, rate, vat, total: r2(net + vat) };
}

/* the little droplet logo, drawn onto a canvas so it can go in the PDF */
let _logo = null;
async function getLogo() {
  if (_logo) return _logo;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'logo.svg'; });
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    cv.getContext('2d').drawImage(img, 0, 0, 256, 256);
    _logo = cv.toDataURL('image/png');
  } catch (e) { _logo = ''; }
  return _logo;
}

async function buildInvPdf(inv, s) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 12, CW = W - 2 * M, FOOT = 16;
  const BLUE = [11, 31, 58], BLUE_D = [22, 54, 94], SKY = [47, 211, 227], PALE = [221, 248, 251];
  const INK = [11, 31, 58], GREY = [91, 107, 128], LINE = [220, 229, 238], GREEN = [31, 174, 122];
  const logo = await getLogo();
  const ukd = iso => (iso ? iso.split('-').reverse().join('/') : '');
  const T = invTotals(inv), vatOn = T.rate > 0;
  const lh = fs => fs * 0.4;
  let y = 0;
  const wrap = (text, w, fs, style) => { doc.setFont('helvetica', style || 'normal'); doc.setFontSize(fs); return String(text ?? '').split('\n').flatMap(l => doc.splitTextToSize(l || ' ', w)); };

  function band(first) {
    const bh = first ? 28 : 12;
    doc.setFillColor(...BLUE); doc.rect(0, 0, W, bh, 'F');
    doc.setFillColor(...SKY); doc.rect(0, bh, W, 1.2, 'F');
    if (first) {
      if (logo) doc.addImage(logo, 'PNG', M, 4, 20, 20);
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
      doc.text('INVOICE', 36, 14.5);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(225, 244, 252);
      doc.text(s.businessName || 'Your business', 36, 20.5);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...PALE);
      doc.text('INVOICE NO.', W - M - 38, 9.5, { align: 'right' }); doc.text('INVOICE DATE', W - M - 38, 18.5, { align: 'right' });
      doc.setFontSize(11); doc.setTextColor(255, 255, 255);
      doc.text(inv.number, W - M, 9.5, { align: 'right' }); doc.text(ukd(inv.date), W - M, 18.5, { align: 'right' });
      y = bh + 7;
    } else {
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text('INVOICE (continued)', M, 8); doc.text(inv.number, W - M, 8, { align: 'right' });
      y = bh + 7;
    }
  }
  const ensure = h => { if (y + h > H - FOOT) { doc.addPage(); band(false); } };
  const BAR = 5.8;
  function bar(title, x, w, yy) {
    doc.setFillColor(...BLUE_D); doc.rect(x, yy, w, BAR, 'F');
    doc.setTextColor(...PALE); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.4);
    doc.text(title, x + 2.4, yy + 3.9);
  }
  function box(title, x, w, yy, lines, minH, dry) {
    const pad = 2.6, out = [];
    lines.forEach(l => { const fs = l.fs || 8.8; wrap(l.t, w - 2 * pad, fs, l.b ? 'bold' : 'normal').forEach(t => out.push({ t, fs, b: l.b, c: l.c })); });
    const step = o => lh(o.fs) + 1.2;
    const h = Math.max(minH || 0, BAR + pad * 2 + out.reduce((a, o) => a + step(o), 0) - 0.6);
    if (dry) return h;
    bar(title, x, w, yy); doc.setDrawColor(...LINE); doc.setLineWidth(0.25); doc.rect(x, yy + BAR, w, h - BAR);
    let ty = yy + BAR + pad + 2.4;
    out.forEach(o => { doc.setFont('helvetica', o.b ? 'bold' : 'normal'); doc.setFontSize(o.fs); doc.setTextColor(...(o.c || INK)); doc.text(o.t, x + pad, ty); ty += step(o); });
    return h;
  }

  band(true);

  /* from / bill to */
  const g = 4, bw = (CW - g) / 2, blank = '________________';
  const from = [{ t: s.businessName || 'Your business', b: 1, fs: 9.6 }];
  if (s.address) from.push({ t: addrLine(s.address) });
  if (s.phone) from.push({ t: 'Tel: ' + s.phone });
  if (s.email) from.push({ t: s.email });
  if (numOf(inv.vatRate) > 0 && inv.vatNumber) from.push({ t: 'VAT No: ' + inv.vatNumber });
  const to = [{ t: inv.customer.name || blank, b: 1, fs: 9.6 }];
  const billAddr = addrLine(inv.customer.billing || inv.jobAddress || '');
  if (billAddr) to.push({ t: billAddr });
  if (inv.customer.email) to.push({ t: inv.customer.email });
  if (inv.customer.phone) to.push({ t: 'Tel: ' + inv.customer.phone });
  const bh = Math.max(box('', 0, bw, 0, from, 0, true), box('', 0, bw, 0, to, 0, true));
  box('FROM', M, bw, y, from, bh); box('BILL TO', M + bw + g, bw, y, to, bh);
  y += bh + 4;

  /* job + due */
  const job = [{ t: addrLine(inv.jobAddress || '') || '–', b: 1 }, { t: 'Date of work: ' + ukd(inv.workDate || inv.date) }];
  const due = [{ t: inv.paid ? 'PAID' + (inv.paidDate ? ' on ' + ukd(inv.paidDate) : '') : ukd(inv.due), b: 1, fs: 11, c: inv.paid ? GREEN : INK }];
  if (inv.paid && inv.payMethod) due.push({ t: 'Paid by ' + inv.payMethod.toLowerCase() });
  due.push({ t: 'Reference: ' + inv.number });
  const jh = Math.max(box('', 0, bw, 0, job, 0, true), box('', 0, bw, 0, due, 0, true));
  box('PROPERTY CLEANED', M, bw, y, job, jh); box(inv.paid ? 'PAYMENT STATUS' : 'PAYMENT DUE BY', M + bw + g, bw, y, due, jh);
  y += jh + 5;

  /* line items */
  const cols = [{ h: 'Service', w: 98 }, { h: 'Qty', w: 14, a: 'c' }, { h: vatOn ? 'Unit price (ex VAT)' : 'Unit price', w: 34, a: 'r' }, { h: vatOn ? 'Amount (ex VAT)' : 'Amount', w: 34, a: 'r' }];
  const k = CW / cols.reduce((a, c) => a + c.w, 0); cols.forEach(c => (c.w *= k));
  const padX = 2, fsH = 7, fsB = 9;
  const colX = i => M + cols.slice(0, i).reduce((a, c) => a + c.w, 0);
  const cell = (c, i, txt, yy) => {
    const tx = c.a === 'r' ? colX(i) + c.w - padX : c.a === 'c' ? colX(i) + c.w / 2 : colX(i) + padX;
    doc.text(txt, tx, yy, { align: c.a === 'r' ? 'right' : c.a === 'c' ? 'center' : 'left' });
  };
  const head = () => {
    const hh = 7;
    doc.setFillColor(...PALE); doc.rect(M, y, CW, hh, 'F'); doc.setDrawColor(...LINE); doc.setLineWidth(0.25);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(fsH); doc.setTextColor(...INK);
    cols.forEach((c, i) => { doc.rect(colX(i), y, c.w, hh); cell(c, i, c.h, y + 4.7); });
    y += hh;
  };
  ensure(BAR + 7 + 12); bar('SERVICES', M, CW, y); y += BAR; head();
  (inv.lines || []).forEach(l => {
    const q = numOf(l.q || 1), amt = r2(q * numOf(l.p));
    const dl = wrap(l.d || '–', cols[0].w - 2 * padX, fsB, 'normal');
    const rh = Math.max(dl.length * lh(fsB) * 1.15 + 4.6, 8.4);
    if (y + rh > H - FOOT) { doc.addPage(); band(false); bar('SERVICES (continued)', M, CW, y); y += BAR; head(); }
    doc.setDrawColor(...LINE);
    cols.forEach((c, i) => doc.rect(colX(i), y, c.w, rh));
    doc.setFont('helvetica', 'normal'); doc.setFontSize(fsB); doc.setTextColor(...INK);
    dl.forEach((t, j) => doc.text(t, colX(0) + padX, y + 5.4 + j * lh(fsB) * 1.15));
    cell(cols[1], 1, String(q % 1 ? q : Math.round(q)), y + 5.4);
    cell(cols[2], 2, money(numOf(l.p)), y + 5.4);
    doc.setFont('helvetica', 'bold'); cell(cols[3], 3, money(amt), y + 5.4);
    y += rh;
  });
  y += 4;

  /* totals */
  const rows = [['Subtotal', money(T.sub)]];
  if (T.disc > 0) rows.push([inv.discLabel || 'Discount', '-' + money(T.disc), GREEN]);
  if (vatOn) { if (T.disc > 0) rows.push(['Total before VAT', money(T.net)]); rows.push([`VAT at ${T.rate % 1 ? T.rate : Math.round(T.rate)}%`, money(T.vat)]); }
  const tw = 78, tx = W - M - tw;
  ensure(rows.length * 7 + 20);
  rows.forEach(([a, b, c]) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY); doc.text(a, tx, y + 4.4);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...(c || INK)); doc.text(b, W - M - 2, y + 4.4, { align: 'right' });
    doc.setDrawColor(222, 236, 243); doc.line(tx, y + 6.6, W - M, y + 6.6);
    y += 7;
  });
  y += 2;
  doc.setFillColor(...BLUE); doc.rect(tx, y, tw, 12, 'F'); doc.setFillColor(...SKY); doc.rect(tx, y, tw, 0.9, 'F');
  doc.setTextColor(...PALE); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text((inv.paid ? 'TOTAL PAID' : 'TOTAL DUE') + (vatOn ? ' (INC VAT)' : ''), tx + 3, y + 7.6);
  doc.setTextColor(255, 255, 255); doc.setFontSize(14); doc.text(money(T.total), W - M - 3, y + 8, { align: 'right' });
  y += 12;
  if (inv.paid) {   // PAID stamp on the left of the totals
    doc.setTextColor(...GREEN); doc.setDrawColor(...GREEN);
    doc.setLineWidth(1.1); doc.roundedRect(M, y - 27, 50, 20, 2.5, 2.5);
    doc.setLineWidth(0.3); doc.roundedRect(M + 1.6, y - 25.4, 46.8, 16.8, 1.8, 1.8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(27); doc.text('PAID', M + 25, y - 14.2, { align: 'center' });
    if (inv.paidDate) { doc.setFontSize(7.5); doc.text(ukd(inv.paidDate), M + 25, y - 10.2, { align: 'center' }); }
    doc.setLineWidth(0.25);
  }
  y += 8;

  /* payment details */
  const pay = [];
  if (!inv.paid) {
    pay.push({ t: `Please pay by ${ukd(inv.due)} using reference ${inv.number}.`, b: 1 });
    if (s.accName || s.sortCode || s.accNo) {
      if (s.bankName) pay.push({ t: 'Bank: ' + s.bankName });
      if (s.accName) pay.push({ t: 'Account name: ' + s.accName });
      if (s.sortCode) pay.push({ t: 'Sort code: ' + fmtSort(s.sortCode) });
      if (s.accNo) pay.push({ t: 'Account number: ' + s.accNo });
    }
  } else {
    pay.push({ t: 'Thank you – this invoice has been paid in full.', b: 1 });
    if (inv.payMethod) pay.push({ t: `Paid by ${inv.payMethod.toLowerCase()}${inv.paidDate ? ' on ' + ukd(inv.paidDate) : ''}.` });
  }
  if (inv.notes) pay.push({ t: inv.notes, c: GREY });
  if (s.invFooter) pay.push({ t: s.invFooter, c: GREY });
  const ph = box('', 0, CW, 0, pay, 0, true);
  ensure(ph + 2);
  box(inv.paid ? 'THANK YOU' : 'PAYMENT DETAILS', M, CW, y, pay, ph);

  /* footer */
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.25); doc.line(M, H - 11.5, W - M, H - 11.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(...GREY);
    doc.text(s.businessName || '', M, H - 6.5);
    doc.text(`${inv.number}${pages > 1 ? `  ·  Page ${p} of ${pages}` : ''}`, W - M, H - 6.5, { align: 'right' });
  }
  doc.setProperties({ title: `Invoice ${inv.number}`, subject: inv.jobAddress, author: s.businessName || 'Your business' });
  return doc.output('blob');
}
