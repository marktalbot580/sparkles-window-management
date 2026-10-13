"""End-to-end test: python3 -m http.server 8766 (in the app folder), then python3 tests/run.py
Opens every screen on a phone-sized browser, runs a whole round and checks the results. Exits non-zero on failure."""
import json, os, sys, datetime, tempfile
from playwright.sync_api import sync_playwright

SHOTS = os.environ.get('SHOTS', tempfile.gettempdir())
BASE = 'http://localhost:8766/index.html'
today = datetime.date.today().isoformat()
fails, errors = [], []

def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' – ' + str(extra) if (extra and not cond) else ''))
    if not cond: fails.append(name)

csv = f"""name,address,postcode,phone,email,price,freq,next
Anne Archer,"12 Oak Road, Lincoln",LN1 1AA,07700 900001,anne@example.com,12,4,{today}
Bob Brown,5 Elm Street,LN2 2BB,07700 900002,bob@example.com,15,4,{today}
Cara Cole,8 Pine Close,LN6 3CC,07700 900003,,10,6,{today}
Dan Dale,3 Ash Lane,LN1 4DD,07700 900004,dan@example.com,18,8,{today}
Eve Eden,9 Birch Way,LN5 5EE,,eve@example.com,14,4,{(datetime.date.today()+datetime.timedelta(days=3)).isoformat()}
"""
with open(os.path.join(tempfile.gettempdir(), 'swm-test.csv'), 'w') as f: f.write(csv)

def fake_geo(route):
    body = json.loads(route.request.post_data)
    res = []
    for pc in body['postcodes']:
        h = sum(ord(c) * (i + 1) for i, c in enumerate(pc))
        res.append({'query': pc, 'result': {'latitude': 53.2 + (h % 97) / 500, 'longitude': -0.55 + (h % 89) / 400}})
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'status': 200, 'result': res}))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
    pg.route('https://api.postcodes.io/postcodes', fake_geo)
    pg.route('**/config.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body="window.SWM_CONFIG={url:'',key:''};"))   # test the local-only app
    pg.goto(BASE); pg.wait_for_selector('#nav button')
    check('app opens on the Round screen', 'Round' in pg.inner_text('#barSub'))

    # settings
    pg.click('#setBtn'); pg.wait_for_selector('input[data-n="businessName"]')
    pg.fill('input[data-n="businessName"]', 'Sparkles Window Management')
    pg.fill('input[data-n="homePostcode"]', 'LN1 3AA'); pg.fill('input[data-n="email"]', 'mark@example.com')
    check('app name shows in the header', 'Window Round Pro' in pg.inner_text('#barName'))
    pg.screenshot(path=f'{SHOTS}/settings.png', full_page=True)

    # import customers from CSV
    pg.click('#nav button:has-text("Customers")'); pg.wait_for_selector('#csvFile', state='attached')
    pg.set_input_files('#csvFile', os.path.join(tempfile.gettempdir(), 'swm-test.csv'))
    pg.wait_for_selector('#custList .item')
    check('five customers imported', pg.locator('#custList .item').count() == 5, pg.locator('#custList .item').count())
    pg.fill('#custSearch', 'brown'); check('search filters the list', pg.locator('#custList .item').count() == 1)
    pg.fill('#custSearch', ''); pg.screenshot(path=f'{SHOTS}/customers.png', full_page=True)

    # the round
    pg.click('#nav button:has-text("Round")'); pg.wait_for_selector('.stop')
    check('four houses on today\'s round', pg.locator('.stop').count() == 4, pg.locator('.stop').count())
    pg.click('button[data-act="plan"]'); pg.wait_for_selector('text=miles')
    check('route planned with a mileage', 'miles' in pg.inner_text('.card'))
    names = pg.eval_on_selector_all('.stop .nm', 'els=>els.map(e=>e.textContent.trim())')
    check('route has all four stops', len(names) == 4, names)
    check('maps link for the whole route', pg.locator('a:has-text("Maps: stops 1–4")').count() == 1)
    pg.screenshot(path=f'{SHOTS}/round.png', full_page=True)

    # complete the first stop
    first = names[0]
    pg.click('button[data-act="complete"] >> nth=0'); pg.wait_for_selector('.stop.done')
    check('stop moves to Done', pg.locator('.stop.done').count() == 1 and pg.locator('.stop:not(.done)').count() == 3)
    inv = pg.evaluate('invoices[0]'); cust = pg.evaluate('(n)=>customers.find(c=>c.name.startsWith(n))', first.split(' (')[0].replace('overdue', '').strip())
    check('invoice INV-001 created', inv['number'] == 'INV-001', inv['number'])
    check('next clean rolled forward', cust['next'] > today, cust['next'])
    pg.click('.stop.done button[data-m="Cash"]')
    check('Cash marks it paid', pg.evaluate('invoices[0].paid') and pg.evaluate('invoices[0].payMethod') == 'Cash')
    pg.click('.stop.done button[data-m="Cash"]')
    check('tapping Cash again marks it unpaid', not pg.evaluate('invoices[0].paid'))
    pg.click('.stop.done button[data-m="Bank transfer"]')
    check('Bank transfer marks it paid', pg.evaluate('invoices[0].payMethod') == 'Bank transfer')
    pg.screenshot(path=f'{SHOTS}/round-done.png', full_page=True)

    # undo a second completion
    pg.click('button[data-act="complete"] >> nth=0'); pg.wait_for_selector('#toast.show button')
    check('second invoice is INV-002', pg.evaluate('invoices[0].number') == 'INV-002')
    pg.click('#toast button'); pg.wait_for_timeout(300)
    check('undo removes the invoice and gives the number back', pg.evaluate('invoices.length') == 1 and pg.evaluate('settings.invNext') == '2')
    check('undo puts the house back on the round', pg.locator('.stop:not(.done)').count() == 3)

    # sales
    pg.click('#nav button:has-text("Sales")'); pg.wait_for_selector('button[data-act="openInv"]')
    check('invoice listed with bank transfer', 'Bank transfer' in pg.inner_text('#view'))
    pg.screenshot(path=f'{SHOTS}/sales.png', full_page=True)
    pg.click('button[data-act="openInv"]'); pg.wait_for_selector('button[data-act="payHere"]')
    pg.click('button[data-act="payHere"][data-m="Card"]')
    check('can change how it was paid on the invoice page', pg.evaluate('invoices[0].payMethod') == 'Card')
    pg.screenshot(path=f'{SHOTS}/invoice.png', full_page=True)
    ok = pg.evaluate('''async()=>{const b=await buildInvPdf(invoices[0],settings);const t=await b.slice(0,5).text();return [b.size,t]}''')
    check('invoice PDF builds', ok[0] > 3000 and ok[1].startswith('%PDF'), ok)
    pdf = pg.evaluate('''async()=>{const b=await buildInvPdf(invoices[0],settings);return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(b)})}''')
    import base64; open(f'{SHOTS}/invoice.pdf', 'wb').write(base64.b64decode(pdf))

    # stats
    pg.click('button[data-act="tab"][data-v="sales"]'); pg.click('button[data-act="salesTab"][data-t="stats"]'); pg.wait_for_selector('.bars')
    check('statistics show one house cleaned', pg.evaluate("document.querySelector('.card .big').textContent.trim()") == '1')
    pg.screenshot(path=f'{SHOTS}/stats.png', full_page=True)
    with pg.expect_download() as d:
        pg.click('button[data-act="salesTab"][data-t="inv"]'); pg.click('button[data-act="csvOut"]')
    check('accountant CSV downloads', d.value.suggested_filename == 'invoices.csv')

    # calendar and add to round
    pg.click('#nav button:has-text("Calendar")'); pg.wait_for_selector('.calg')
    pg.screenshot(path=f'{SHOTS}/calendar.png', full_page=True)
    pg.click(f'button[data-d="{(datetime.date.today()+datetime.timedelta(days=3)).isoformat()}"]'); pg.wait_for_selector('.stop')
    check('calendar day opens that day\'s round', pg.locator('.stop').count() == 1)
    check('reminder texts offered for a future day', pg.locator('button[data-act="remind"]').count() == 1)
    pg.click('button[data-act="remind"]'); pg.wait_for_selector('text=Reminder texts')

    # new customer form + persistence
    pg.click('#nav button:has-text("Customers")'); pg.click('button[data-act="newCust"]'); pg.wait_for_selector('input[data-n="name"]')
    pg.fill('input[data-n="name"]', 'Fred Fox'); pg.fill('input[data-n="price"]', '20'); pg.fill('textarea[data-n="address"]', '1 Test St'); pg.fill('input[data-n="postcode"]', 'ln3 3ff')
    pg.click('button[data-act="saveCust"]'); pg.wait_for_selector('#custList .item')
    check('new customer saved (postcode upper-cased)', pg.evaluate("customers.find(c=>c.name==='Fred Fox').postcode") == 'LN3 3FF')
    pg.reload(); pg.wait_for_selector('#nav button')
    check('data survives a reload', pg.evaluate('customers.length') == 6 and pg.evaluate('invoices.length') == 1)
    b.close()

check('no browser errors', not errors, errors)
print('\nRESULT:', 'ALL PASSED' if not fails else f'{len(fails)} FAILED: {fails}')
sys.exit(1 if fails else 0)
