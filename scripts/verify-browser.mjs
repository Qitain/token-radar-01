import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Standard-library CDP smoke tests. Uses only local files and local DevTools.
const profile = mkdtempSync(join(tmpdir(), 'token-radar-browser-'));
const chrome = spawn(process.env.RADAR_CHROME ?? '/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,1008', 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(done => setTimeout(done, ms));
let socket, counter = 0;
const pending = new Map(), errors = [], requests = [], checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
async function call(method, params = {}) {
  const id = ++counter;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : done(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression: `{ ${expression} }`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}
async function screenshot(name) {
  if (!process.argv.includes('--screenshots')) return;
  const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(resolve('screenshots', name), Buffer.from(r.data, 'base64'));
}
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await delay(100); }
  }
  if (!port) throw new Error('Chrome did not start');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Network.requestWillBeSent' && /^https?:/.test(m.params.request.url)) requests.push(m.params.request.url);
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1008, deviceScaleFactor: 1, mobile: false });
  const page = pathToFileURL(resolve('out/dashboard/index.html')).href;
  await call('Page.navigate', { url: page });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("document.querySelectorAll('#board-body tr').length === 200")) break;
    await delay(50);
  }
  check('initial board renders', await evaluate("document.querySelectorAll('#board-body tr').length===200"));
  check('English offline schema', await evaluate("document.documentElement.lang==='en' && globalThis.__TOKEN_RADAR__.schema==='token-radar/v2'"));
  check('validation panels populated', await evaluate("['forms-table','ablation-table','category-errors','outer-validation','odds-validation','interval-summary'].every(id=>document.getElementById(id).innerText.trim().length>10)"));
  check('integrity passes', await evaluate("document.getElementById('integrity-status').textContent.includes('PASS')"));
  await screenshot('1-board.png');
  await evaluate("window.scrollTo(0,500);document.querySelector('#board-body .protocol-button').focus({preventScroll:true});globalThis.__beforeRadarY=scrollY;document.querySelector('#board-body .protocol-button').click()");
  check('modal opens without page jump', await evaluate("!document.getElementById('detail-panel').classList.contains('hidden') && scrollY===__beforeRadarY && document.activeElement.id==='close-detail'"));
  check('modal six steps and explicit economics', await evaluate("document.querySelectorAll('#farm-steps li').length===6 && document.getElementById('detail-economics').innerText.length>100 && document.getElementById('detail-summary').innerText.includes('P10')"));
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8 });
  check('modal focus stays inside with Shift-Tab', await evaluate("document.getElementById('detail-panel').contains(document.activeElement)"));
  await screenshot('2-detail.png');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  check('Escape closes and restores focus', await evaluate("document.getElementById('detail-panel').classList.contains('hidden') && scrollY===__beforeRadarY && document.activeElement.classList.contains('protocol-button')"));
  await evaluate("document.querySelector('#board-body .protocol-button').click();document.getElementById('detail-panel').click()");
  check('backdrop closes', await evaluate("document.getElementById('detail-panel').classList.contains('hidden')"));
  await evaluate("document.querySelector('#board-body .protocol-button').click();document.getElementById('close-detail').click()");
  check('close button closes', await evaluate("document.getElementById('detail-panel').classList.contains('hidden')"));
  await evaluate("document.querySelector('[data-sort=implied_value_usd]').click();document.querySelector('[data-sort=implied_value_usd]').click()");
  check('value sorting toggles', await evaluate("document.querySelector('[data-sort=implied_value_usd]').closest('th').getAttribute('aria-sort')==='ascending' && document.querySelector('#board-body .protocol-button').dataset.slug===__TOKEN_RADAR__.board.at(-1).slug"));
  await evaluate("const input=document.getElementById('search-input');input.value='steakhouse';input.dispatchEvent(new Event('input',{bubbles:true}))");
  check('live search filters', await evaluate("document.querySelectorAll('#board-body tr').length===1"));
  await evaluate("document.getElementById('clear-filters').click();const input=document.getElementById('search-input');input.value='zzzz-no-result';input.dispatchEvent(new Event('input',{bubbles:true}))");
  check('empty state', await evaluate("document.querySelectorAll('#board-body tr').length===0 && !document.getElementById('empty-state').classList.contains('hidden')"));
  await evaluate("document.getElementById('clear-filters').click();document.getElementById('category-filter').value='Lending';document.getElementById('category-filter').dispatchEvent(new Event('change',{bubbles:true}))");
  check('category filter', await evaluate("document.querySelectorAll('#board-body tr').length===__TOKEN_RADAR__.board.filter(r=>r.category==='Lending').length"));
  await evaluate("document.getElementById('clear-filters').click();document.getElementById('chain-filter').value='Ethereum';document.getElementById('chain-filter').dispatchEvent(new Event('change',{bubbles:true}))");
  check('chain filter', await evaluate("document.querySelectorAll('#board-body tr').length===__TOKEN_RADAR__.board.filter(r=>r.chains.includes('Ethereum')).length"));
  await evaluate("document.getElementById('clear-filters').click();document.getElementById('issued-tab').click()");
  check('issued inventory view', await evaluate("document.querySelectorAll('#issued-body tr').length===416 && document.getElementById('board-view').classList.contains('hidden')"));
  await evaluate("document.querySelector('#issued-body .protocol-button').click()");
  check('issued modal', await evaluate("!document.getElementById('detail-panel').classList.contains('hidden') && !document.getElementById('detail-title').textContent.includes('undefined')"));
  await evaluate("document.getElementById('close-detail').click();document.getElementById('board-tab').click();document.getElementById('validation').scrollIntoView()");
  await screenshot('3-validation.png');
  await evaluate("document.getElementById('outer-validation').closest('.two-column').scrollIntoView()");
  await screenshot('7-outer-audit.png');
  await evaluate("document.querySelector('.odds-panel').scrollIntoView()");
  await screenshot('5-probabilities.png');
  await evaluate("document.getElementById('planner').scrollIntoView()");
  check('default planner honestly empty', await evaluate("document.getElementById('planner-note').innerText.length>50 && globalThis.TokenRadarPlanner.plan(__TOKEN_RADAR__.board,{budget:1e9,weeklyHours:1e3}).selected.length===0"));
  const plan = await evaluate("(()=>{const d=__TOKEN_RADAR__,p=TokenRadarPlanner.plan(d.board,{budget:10000,weeklyHours:5,payoutScale:10,timeValue:d.model.farm_assumptions.time_value_usd_per_hour});return{n:p.selected.length,cash:p.totals.reserve_usd,hours:p.totals.weekly_hours,valid:p.selected.every(x=>x.scenario.verdict!=='SKIP'),stable:JSON.stringify(p)===JSON.stringify(TokenRadarPlanner.plan(d.board,{budget:10000,weeklyHours:5,payoutScale:10,timeValue:d.model.farm_assumptions.time_value_usd_per_hour}))}})()");
  check('scenario planner respects budgets and P10', plan.n>0 && plan.cash<=10000 && plan.hours<=5 && plan.valid && plan.stable, plan);
  await evaluate("document.getElementById('allocation-input').value=10;document.getElementById('allocation-input').dispatchEvent(new Event('input',{bubbles:true}))");
  check('planner inputs recalculate visible selection', await evaluate("document.querySelectorAll('#planner-table .protocol-button').length>0 && document.getElementById('allocation-output').textContent.includes('10.0')"));
  await screenshot('4-planner.png');
  await evaluate("document.getElementById('audit').scrollIntoView();document.querySelector('#audit details').open=true");
  check('full excluded audit visible', await evaluate("document.querySelectorAll('#audit-table tbody')[0].children.length===__TOKEN_RADAR__.audit.length"));
  await screenshot('6-universe-audit.png');
  for (const [name, mutation] of [
    ['row count','__TOKEN_RADAR__.board.pop()'],
    ['rank sequence','__TOKEN_RADAR__.board[1].rank=1'],
    ['value uniqueness','__TOKEN_RADAR__.board[1].implied_value_usd=__TOKEN_RADAR__.board[0].implied_value_usd'],
    ['watchlist','__TOKEN_RADAR__.board.find(r=>r.watchlist).watchlist=false'],
    ['token evidence',"__TOKEN_RADAR__.board[0].symbol='TEST'"],
    ['full accounting','__TOKEN_RADAR__.audit.pop()'],
  ]) {
    const result=await evaluate("(()=>{const d=__TOKEN_RADAR__,b=structuredClone(d.board),a=structuredClone(d.audit);"+mutation+";document.getElementById('clear-filters').click();const failed=document.getElementById('integrity-status').textContent==='FAIL'&&document.querySelector('.integrity-shell').classList.contains('failed');d.board.splice(0,d.board.length,...b);d.audit.splice(0,d.audit.length,...a);document.getElementById('clear-filters').click();return failed&&document.getElementById('integrity-status').textContent==='PASS'})()");
    check('visible red integrity: '+name,result);
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("window.scrollTo(0,0)");
  check('mobile page has no horizontal overflow', await evaluate("document.documentElement.scrollWidth<=innerWidth"));
  await evaluate("document.querySelector('#board-body .protocol-button').click()");
  check('mobile modal fits', await evaluate("(()=>{const r=document.querySelector('.detail-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"));
  await evaluate("document.getElementById('close-detail').click()");
  check('no browser errors', errors.length===0, errors);
  check('no external network requests', requests.length===0, requests);
} catch (error) { check('browser test execution', false, String(error)); }
finally {
  if (socket) socket.close();
  chrome.kill();
  await delay(200);
  rmSync(profile, { recursive: true, force: true });
}
const report={ passed:checks.every(x=>x.pass), checks, errors, external_requests:requests };
writeFileSync(resolve('out/browser-verification.json'), JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed?'PASS':'FAIL'} browser verification (${checks.filter(x=>x.pass).length}/${checks.length})`);
if(!report.passed)process.exitCode=1;
