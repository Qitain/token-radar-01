(function () {
  'use strict';
  const data = globalThis.__TOKEN_RADAR__;
  if (!data || !Array.isArray(data.board)) return;
  const valuation = data.model.valuation;
  const assumptions = data.model.farm_assumptions;
  const odds = data.model.odds;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  const number = (value, digits = 2) => finite(value) ? Number(value).toLocaleString('en-US', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const money = value => {
    if (!finite(value)) return '—';
    const n = Number(value), abs = Math.abs(n), sign = n < 0 ? '−' : '';
    if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'K';
    return sign + '$' + abs.toFixed(2);
  };
  const exactMoney = value => finite(value) ? '$' + number(value, 2) : '—';
  const pct = (value, digits = 1) => finite(value) ? number(Number(value) * 100, digits) + '%' : '—';
  const share = value => pct(value, 5);
  const factor = value => finite(value) ? '×' + number(value, 2) : '—';
  const metricFactor = metric => factor(metric?.median_error_factor);
  const signClass = value => value >= 0 ? 'positive' : 'negative';
  const termName = term => ({category:'Category',growth:'Growth momentum',maturity:'Maturity',multi_chain:'Multi-chain',completeness:'Data completeness'}[term] || term);
  const badge = verdict => '<span class="verdict ' + esc(String(verdict).toLowerCase()) + '">' + esc(verdict) + '</span>';
  const table = (headers, rows) => '<table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr' + (row.selected ? ' class="selected"' : '') + '>' + (row.cells || row).map(cell => '<td' + (typeof cell === 'object' ? ' class="' + esc(cell.class || '') + '"' : '') + '>' + (typeof cell === 'object' ? cell.html : cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
  const numeric = html => ({html, class:'numeric'});
  const state = {view:'board',search:'',category:'',chain:'',verdict:'',sort:'rank',direction:1};
  const rowBySlug = new Map([...data.board, ...data.issued].map(row => [row.slug,row]));
  const pathValue = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
  const isPreToken = row => row.mcap_usd === null && row.gecko_id === null && row.symbol === null;
  const protocolButton = (row, subtitle = false) => '<button class="protocol-button" type="button" data-slug="' + esc(row.slug) + '" aria-label="Open details for ' + esc(row.name) + '"><span>' + esc(row.name) + (row.watchlist ? '<span class="watch-tag">WATCH</span>' : '') + '</span><span class="protocol-slug">' + esc(subtitle ? (row.category || 'Uncategorized') + ' · ' + (row.chains?.[0] || 'Chain unrecorded') + (row.chains?.length > 1 ? ' +' + (row.chains.length - 1) : '') : row.slug) + '</span></button>';

  function runtimeIntegrity() {
    const b = data.board, issued = data.issued, excluded = data.audit;
    const sourceChecks = data.integrity.checks;
    const expected = id => sourceChecks.find(check => check.id === id)?.expected;
    const all = [...b,...issued,...excluded];
    const universe = new Set(all.map(row => row.slug));
    const sourceSlugs = data.integrity.source_slugs;
    const selectedSlugs = data.integrity.selected_slugs;
    const expectedWatchlist = data.snapshot.watchlist || data.integrity.expected_watchlist;
    const watched = b.filter(row => row.watchlist);
    const watchPass = expectedWatchlist
      ? expectedWatchlist.every(slug => b.some(row => row.slug === slug && row.watchlist)) && b.every(row => row.watchlist === expectedWatchlist.includes(row.slug))
      : watched.length === data.snapshot.watchlist_count;
    const runtime = {
      rows:b.length === Number(expected('rows')),
      ranks:b.every((row, index) => row.rank === index + 1),
      order:b.every((row, index) => finite(row.implied_value_usd) && row.implied_value_usd > 0 && (!index || b[index - 1].implied_value_usd > row.implied_value_usd)),
      watchlist:watchPass && watched.length === data.snapshot.watchlist_count,
      tokens:b.every(row => isPreToken(row) && row.has_token === false),
      accounting:all.length === data.snapshot.protocol_count && universe.size === all.length && Array.isArray(sourceSlugs) && sourceSlugs.length === all.length && sourceSlugs.every(slug => universe.has(slug)) && excluded.every(isPreToken),
      selection:Array.isArray(selectedSlugs) && selectedSlugs.length === b.length && b.every(row => selectedSlugs.includes(row.slug)),
      issued:issued.length === Number(expected('issued')) && issued.every(row => !isPreToken(row)),
      steps:b.every(row => row.farm_steps?.length === 6 && row.farm_steps.every(step => typeof step === 'string' && step.length >= 20 && step.length <= 600)),
    };
    const checks = sourceChecks.map(check => ({...check,pass:check.pass && runtime[check.id] !== false}));
    const counts = {ranked:b.length,issued:issued.length,excluded:excluded.length,total:all.length};
    const titles = {
      rows:b.length + ' rows', ranks:'Ranks 1–' + b.length, order:new Set(b.map(row => row.implied_value_usd)).size + ' unique values',
      watchlist:watched.length + '/' + data.snapshot.watchlist_count + ' watchlist',tokens:b.filter(row => !isPreToken(row)).length + ' issued tokens',accounting:all.length + ' accounted',
    };
    const descriptions = {rows:'Fixed opportunity set',ranks:'Continuous in row order',order:'Strictly decreasing',watchlist:'Exact source identities',tokens:'Board is pre-token',accounting:b.length + ' + ' + issued.length + ' + ' + excluded.length};
    $('integrity-strip').innerHTML = checks.filter(check => titles[check.id]).map(check => '<div class="integrity-check ' + (check.pass ? '' : 'fail') + '" title="' + esc(check.label + ': ' + (check.pass ? 'PASS' : 'FAIL') + '; expected ' + check.expected) + '"><b><span class="check-icon">' + (check.pass ? '✓' : '✕ FAIL') + '</span>' + esc(titles[check.id]) + '</b><small>' + esc(descriptions[check.id]) + '</small></div>').join('');
    const pass = checks.every(check => check.pass) && data.schema === 'token-radar/v2';
    $('integrity-status').textContent = pass ? 'PASS' : 'FAIL';
    document.querySelector('.integrity-shell').classList.toggle('failed', !pass);
    return {checks,counts,pass};
  }

  function renderMeta() {
    const v = valuation.validation, outer = v.nested_audit, fit = valuation.fit;
    $('snapshot-note').textContent = 'SEALED / ' + data.snapshot.as_of + ' / ' + data.snapshot.protocol_count + ' RECORDS';
    $('footer-date').textContent = data.snapshot.as_of;
    $('footer-source').textContent = 'Source: DefiLlama · Offline, no live refresh';
    $('board-count').textContent = data.board.length;
    $('issued-count').textContent = data.issued.length;
    const c = fit.coefficients;
    $('model-formula').textContent = c?.length ? 'log(mcap) = ' + number(c[0],3) + ' + ' + number(c[1],3) + 'z' + (c.length > 2 ? ' + ' + number(c[2],5) + 'z²' : '') : valuation.selected.equation;
    $('model-summary').textContent = valuation.sample_count + ' positive market-cap / TVL comparables. ' + (c?.length ? 'z = log(TVL) − ' + number(fit.center_log_tvl,3) + '. ' : '') + valuation.selected.terms.length + ' of ' + valuation.ablation.terms.length + ' v1 multipliers retained; ' + valuation.bootstrap.refits + ' bootstrap refits.';
    const cards = [[metricFactor(v.loo),'LOO median error','n = ' + v.loo.n + ' · selection diagnostic'],[metricFactor(v.walk_forward),'Chronological median error','n = ' + v.walk_forward.n + ' · selection diagnostic'],[metricFactor(outer?.metrics),'Untouched outer median error','n = ' + (outer?.test_n ?? '—') + ' · selection performed inside train'],[pct(valuation.intervals.walk_forward_coverage),'Chronological interval coverage',pct(valuation.intervals.target_coverage,0) + ' target · uncertainty is imperfect']];
    $('metric-strip').innerHTML = cards.map(card => '<div class="metric"><b>' + esc(card[0]) + '</b><span>' + esc(card[1]) + '</span><small>' + esc(card[2]) + '</small></div>').join('');
    const verdicts = ['FARM','THIN','SKIP'].map(verdict => data.board.filter(row => row.farm.verdict === verdict).length + ' ' + verdict).join(' / ');
    $('board-footnote').textContent = 'Base scenario: ' + verdicts + '. Farm P10 uses min(predictive P10, bootstrap fit P10). P10 means a low valuation scenario weighted by empirical prevalence, not a 90% chance of making money. The snapshot records no launch date, reward program or eligibility. Break-even is the personal allocation share required to cover gas + valued time.';
    data.categories.forEach(value => $('category-filter').append(new Option(value,value)));
    data.chains.forEach(value => $('chain-filter').append(new Option(value,value)));
    runtimeIntegrity();
  }

  function filtered() {
    return (state.view === 'board' ? data.board : data.issued).filter(row => (!state.search || (row.name + ' ' + row.slug).toLowerCase().includes(state.search.toLowerCase())) && (!state.category || row.category === state.category) && (!state.chain || row.chains.includes(state.chain)) && (state.view !== 'board' || !state.verdict || row.farm.verdict === state.verdict)).sort((a,b) => {
      const av = pathValue(a,state.sort), bv = pathValue(b,state.sort);
      if (av == null) return bv == null ? a.slug.localeCompare(b.slug) : 1;
      if (bv == null) return -1;
      const order = typeof av === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv);
      return order * state.direction || (a.rank || 0) - (b.rank || 0) || a.slug.localeCompare(b.slug);
    });
  }

  function renderBoard() {
    const rows = filtered();
    $('view-title').textContent = state.view === 'board' ? 'Pre-token ranking board' : 'Issued-token inventory';
    $('board-view').classList.toggle('hidden',state.view !== 'board');
    $('issued-view').classList.toggle('hidden',state.view !== 'issued');
    $('empty-state').classList.toggle('hidden',rows.length > 0);
    $('result-count').textContent = rows.length + ' / ' + (state.view === 'board' ? data.board.length : data.issued.length) + ' protocols';
    $('verdict-filter').disabled = state.view !== 'board';
    if (state.view === 'board') $('board-body').innerHTML = rows.map(row => '<tr><td class="rank">' + row.rank + '<small>' + row.rank_p10 + '–' + row.rank_p90 + '</small></td><td>' + protocolButton(row,true) + '</td><td>' + money(row.tvl_usd) + '</td><td class="' + (row.change_7d === null ? 'muted' : signClass(row.change_7d)) + '">' + (row.change_7d === null ? '—' : number(row.change_7d,1) + '%') + '</td><td class="value-cell"><strong>' + money(row.implied_value_usd) + '</strong><span class="row-sub">' + money(row.implied_p10_usd) + '–' + money(row.implied_p90_usd) + '</span><span class="row-sub">Fit ' + money(row.bootstrap_p10_usd) + '–' + money(row.bootstrap_p90_usd) + '</span></td><td><span class="probability">' + pct(row.token_probability) + '</span><span class="probability-bar"><i style="width:' + Math.max(0,Math.min(100,row.token_probability * 100)) + '%"></i></span><span class="row-sub">' + row.odds.cell_issued + '/' + row.odds.cell_n + ' peers issued</span></td><td><b class="' + signClass(row.farm.net_per_hour) + '">' + money(row.farm.net_per_hour) + '</b><span class="row-sub ' + signClass(row.farm.p10_net_per_hour) + '">P10 ' + money(row.farm.p10_net_per_hour) + '</span></td><td>' + share(row.farm.break_even_share) + '<span class="row-sub">P10 ' + share(row.farm.p10_break_even_share) + '</span></td><td>' + badge(row.farm.verdict) + '<span class="row-sub">P10 net ' + money(row.farm.p10_net_usd) + '</span></td></tr>').join('');
    else $('issued-body').innerHTML = rows.map(row => '<tr><td>' + protocolButton(row) + '</td><td>' + esc(row.category || 'Uncategorized') + '</td><td>' + esc(row.symbol || 'Not recorded') + '</td><td>' + money(row.tvl_usd) + '</td><td>' + money(row.mcap_usd) + '</td></tr>').join('');
    document.querySelectorAll('.sort-button').forEach(button => {
      const active = button.dataset.sort === state.sort;
      const direction = state.direction === 1 ? 'ascending' : 'descending';
      button.setAttribute('aria-pressed',String(active));
      button.querySelector('span').textContent = active ? (state.direction === 1 ? '↑' : '↓') : '↕';
      button.closest('th').setAttribute('aria-sort',active ? direction : 'none');
      button.setAttribute('aria-label','Sort by ' + button.textContent.replace(/[↑↓↕]/g,'').trim() + (active ? ', ' + direction : ''));
    });
    document.querySelectorAll('.tab').forEach(button => {const active = button.dataset.view === state.view;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex = active ? 0 : -1;});
    runtimeIntegrity();
  }

  function renderEvidence() {
    const v = valuation.validation, chronology = v.chronology, interval = valuation.intervals, boot = valuation.bootstrap, outer = v.nested_audit;
    $('validation-method').textContent = 'Error factor = exp(median |log(predicted mcap / observed mcap)|), equivalent to the error in mcap/TVL. LOO refits without each target. Chronological stress test: ' + chronology.train_n + ' earlier listings through ' + chronology.cutoff + ' train; ' + chronology.test_n + ' later listings test; ' + chronology.undated_excluded + ' undated comparables excluded from this split. Listing dates are not token launch dates. These contemporaneous fields cannot reconstruct a historical backtest.';
    $('forms-table').innerHTML = table(['Curve form','LOO error','Time error','Within 2× LOO / time'],valuation.curves.map(curve => ({selected:curve.chosen,cells:[esc(curve.form) + (curve.chosen ? '<span class="row-sub positive">SELECTED</span>' : ''),numeric(metricFactor(curve.loo)),numeric(metricFactor(curve.walk_forward)),numeric(pct(curve.loo.within_2x) + ' / ' + pct(curve.walk_forward.within_2x))]})));
    $('form-note').textContent = 'Forms use the same comparable pool and folds. Lowest sum of the two median absolute log errors chooses the form. Primary LOO and chronological tests are reused for selection; the outer audit below tests the selection procedure separately. In-sample R² = ' + number(valuation.fit.r2_log_mcap,3) + '.';
    $('interval-summary').innerHTML = '<div class="proof-cards"><div class="proof-card"><b>' + pct(interval.calibration_coverage) + '</b><span>Full-pool residual calibration · n=' + interval.calibration_n + '</span></div><div class="proof-card"><b>' + pct(interval.walk_forward_coverage) + '</b><span>Earlier-only calibration → later cohort · n=' + interval.walk_forward_n + '</span></div></div><div class="uncertainty-note"><strong>Predictive P10–P90 · ' + pct(interval.target_coverage,0) + ' nominal coverage</strong>' + esc(interval.method) + ' Residual quantiles: ' + number(interval.residual_p10,4) + ' to ' + number(interval.residual_p90,4) + '. Coverage is measured, not guaranteed.</div><div class="uncertainty-note"><strong>' + boot.refits + ' bootstrap refits · value + rank bands</strong>' + esc(boot.interpretation) + ' Seed ' + boot.seed + '. Each protocol dossier reports both value ranges.</div>';
    $('ablation-note').textContent = valuation.ablation.rule;
    $('ablation-table').innerHTML = table(['v1 term','LOO with / without','Time with / without','Applied','Decision & reason'],valuation.ablation.terms.map(term => [esc(termName(term.term)),numeric(metricFactor(term.with_term.loo) + ' / ' + metricFactor(term.without_term.loo)),numeric(metricFactor(term.with_term.walk_forward) + ' / ' + metricFactor(term.without_term.walk_forward)),numeric(term.retained ? 'Fitted v1 term' : '×1.000'),{html:'<span class="term-status ' + (term.retained ? '' : 'cut') + '">' + (term.retained ? 'RETAINED' : 'CUT') + '</span><span class="row-sub">' + esc(term.reason) + '</span>',class:'reason'}]));
    const configs = valuation.ablation.configurations || [];
    $('ablation-table').insertAdjacentHTML('beforeend','<details><summary>Inspect all ' + configs.length + ' term configurations</summary><div class="bounded">' + table(['Configuration','LOO error','Time error','Eligible','Chosen'],configs.map(config => ({selected:config.chosen,cells:[esc(config.name),numeric(metricFactor(config.loo)),numeric(metricFactor(config.walk_forward)),esc(config.eligible ? 'Yes' : 'No'),esc(config.chosen ? 'Yes' : 'No')]}))) + '</div></details>');
    $('category-errors').innerHTML = table(['Category','n','LOO error','Within 2×'],v.by_category.map(row => [esc(row.category),numeric(row.n),numeric(metricFactor(row)),numeric(pct(row.within_2x))]));
    $('outer-validation').innerHTML = outer ? '<div class="proof-cards"><div class="proof-card"><b>' + metricFactor(outer.metrics) + '</b><span>Median error on ' + outer.test_n + ' untouched later comparables</span></div><div class="proof-card"><b>' + pct(outer.interval.coverage) + '</b><span>Predictive coverage · ' + pct(interval.target_coverage,0) + ' target</span></div></div><p class="panel-note">All curve and term selection runs inside ' + outer.train_n + ' earlier dated records (through ' + esc(outer.cutoff) + '). The selected inner design is ' + esc(outer.selected.form) + ', ' + outer.selected.terms.length + ' retained terms. Final full-pool selection may differ. Within 2×: ' + pct(outer.metrics.within_2x) + '.</p><p class="caveat">' + esc(outer.limitation) + '</p>' : '<p class="caveat">An untouched outer audit is unavailable.</p>';
    const ov = odds.validation;
    $('odds-cohort').textContent = odds.issued_n + ' issued / ' + odds.cohort_n + ' records';
    $('odds-method').textContent = odds.method + ' ' + odds.strength_method + ' ' + odds.target_exclusion;
    const losses = metric => [numeric(number(metric.brier,4) + ' / ' + number(metric.base_brier,4)),numeric(number(metric.log_loss,4) + ' / ' + number(metric.base_log_loss,4))];
    $('odds-validation').innerHTML = table(['Probability test','n','Brier model / base ↓','Log loss model / base ↓','Predicted / observed'],[['Leave one out',numeric(ov.loo.n),...losses(ov.loo),numeric(pct(ov.loo.mean_probability) + ' / ' + pct(ov.loo.observed_rate))],['Earlier → later listings',numeric(ov.walk_forward.test_n),...losses(ov.walk_forward),numeric(pct(ov.walk_forward.mean_probability) + ' / ' + pct(ov.walk_forward.observed_rate))]]);
    $('odds-caveat').textContent = odds.caveat + ' Earlier→later split: ' + ov.walk_forward.train_n + ' train / ' + ov.walk_forward.test_n + ' test, cutoff ' + ov.walk_forward.cutoff + '. Mean predicted prevalence ' + pct(ov.walk_forward.mean_probability) + ' versus observed ' + pct(ov.walk_forward.observed_rate) + ': ' + (ov.walk_forward.mean_probability > ov.walk_forward.observed_rate ? 'the model overestimates this newer cohort.' : 'the model underestimates this newer cohort.') + ' Missing age: ' + odds.missing_age.n + ' records, ' + odds.missing_age.issued + ' issued, explicitly bucketed.';
    $('odds-buckets').innerHTML = table(['Category × age × TVL cell','Issued / total','Shrunk prevalence'],odds.buckets.map(row => [esc(row.cell),numeric(row.issued + ' / ' + row.n),numeric(pct(row.rate))]));
  }

  function renderAssumptions() {
    $('farm-formula').textContent = 'Expected airdrop = implied market cap × empirical token prevalence × (farmer pool / qualifying wallets). Net $/hour = (expected airdrop − gas − time × hourly value) / active hours.';
    const items = [['Hypothetical farmer pool',pct(assumptions.pool_fraction) + ' of market cap'],['Hypothetical qualifying wallets',number(assumptions.qualifying_wallets,0) + ' · equal allocation'],['Personal share under base scenario',share(assumptions.farmer_share)],['Assumed gas per transaction',exactMoney(assumptions.gas_per_transaction_usd) + ' · uniform across chains'],['Assumed value of active time',exactMoney(assumptions.time_value_usd_per_hour) + ' / hour'],['Assumed hold and monitoring',assumptions.hold_weeks + ' weeks · step hours / weeks'],['Refundable capital sizing',assumptions.capital_formula],['Net-cost accounting',assumptions.cost_formula],['P10 verdict thresholds',assumptions.verdict_rule]];
    $('farm-assumptions').innerHTML = items.map(item => '<div class="assumption"><b>' + esc(item[0]) + '</b><span>' + esc(item[1]) + '</span></div>').join('');
    $('farm-caveat').textContent = assumptions.label + ' ' + assumptions.caveat + ' Farm steps are proposed workflows. Neither the listed deposits nor a transaction count establish reward eligibility.';
    const ordered = [...data.board].sort((a,b) => a.farm.reserve_usd - b.farm.reserve_usd);
    const defaultCount = Math.max(1,Math.ceil(Math.sqrt(data.board.length)));
    const initial = ordered.slice(0,defaultCount);
    $('budget-input').value = Math.ceil(initial.reduce((sum,row) => sum + row.farm.reserve_usd,0));
    $('hours-input').value = number(initial.reduce((sum,row) => sum + row.farm.weekly_hours,0),2).replace(/,/g,'');
    $('time-input').max = Math.max(1,assumptions.time_value_usd_per_hour * 3);
    $('time-input').value = assumptions.time_value_usd_per_hour;
    const scaleToFirst = Math.min(...data.board.filter(row => row.farm.p10_airdrop_usd > 0).map(row => row.farm.total_cost_usd / row.farm.p10_airdrop_usd));
    $('allocation-input').max = Math.max(10,Math.ceil(scaleToFirst * 2));
  }

  function renderPlanner() {
    const scale = Number($('allocation-input').value), timeValue = Number($('time-input').value);
    $('allocation-output').textContent = number(scale,1) + '× base';
    $('time-output').textContent = money(timeValue) + '/h';
    const plan = globalThis.TokenRadarPlanner.plan(data.board,{budget:Number($('budget-input').value),weeklyHours:Number($('hours-input').value),payoutScale:scale,timeValue});
    const t = plan.totals;
    const metrics = [[number(plan.selected.length,0),'Positions / ' + plan.eligible_count + ' scenario-eligible'],[money(t.reserve_usd),'Reserve: capital + gas'],[number(t.weekly_hours,2) + ' h','Weekly time'],[money(t.expected_airdrop_usd),'Expected payout scenario'],[money(t.net_usd),'Net after gas + valued time'],[money(t.p10_net_usd),'Sum of P10 scenario nets']];
    $('planner-metrics').innerHTML = metrics.map(item => '<div class="plan-metric"><b>' + esc(item[0]) + '</b><span>' + esc(item[1]) + '</span></div>').join('');
    $('planner-table').innerHTML = plan.selected.length ? table(['Selected protocol','Reserve','Hours / wk','Expected net','P10 net','Scenario'],plan.selected.map(item => [protocolButton(item.row),numeric(money(item.scenario.reserve_usd)),numeric(number(item.scenario.weekly_hours,2)),numeric(money(item.scenario.net_usd)),numeric(money(item.scenario.p10_net_usd)),badge(item.scenario.verdict)])) : '<div class="empty-state">' + (plan.eligible_count ? 'No whole position fits both budgets. Increase capital or weekly hours.' : 'No farm covers its P10 scenario costs under these assumptions. A valid plan is to allocate nothing. Change the allocation or time-value scenario to inspect the break-even conditions.') + '</div>';
    const shares = data.board.filter(row => row.farm.p10_airdrop_usd > 0).map(row => ({row,required:(row.farm.gas_usd + row.farm.time_hours * timeValue) / (row.farm.conservative_value_usd * row.token_probability)})).sort((a,b) => a.required - b.required || a.row.rank - b.row.rank);
    const first = shares[0];
    $('planner-note').textContent = plan.optimizer + ' Scenario allocation: ' + share(assumptions.farmer_share * scale) + ' per wallet' + (scale > 0 ? ' (at the fixed ' + pct(assumptions.pool_fraction,0) + ' pool, ' + number(assumptions.qualifying_wallets / scale,0) + ' hypothetical wallets)' : ' (zero distribution scenario)') + '; time ' + exactMoney(timeValue) + '/h. Principal ' + money(t.capital_usd) + ', gas ' + money(t.gas_usd) + ', valued time ' + money(t.time_cost_usd) + '. Unused reserve ' + money(plan.unused_budget) + '; unused weekly hours ' + number(plan.unused_weekly_hours,2) + '. Current scenario verdicts are recalculated before selection, including previously skipped rows. Sum of marginal P10 scenarios is not a portfolio 10th percentile; correlated outcomes and zero payouts are possible.' + (first ? ' Lowest P10 break-even allocation: ' + first.row.name + ' at ' + share(first.required) + ' per wallet (' + number(first.required / assumptions.farmer_share,2) + '× base).' : '');
  }

  function renderAudit() {
    const check = runtimeIntegrity(), c = check.counts;
    $('audit-total').textContent = new Set([...data.board,...data.issued,...data.audit].map(row => row.slug)).size + ' / ' + data.snapshot.protocol_count + ' unique source records';
    const block = (n,label) => '<div class="audit-block">' + esc(n) + '<small>' + esc(label) + '</small></div>';
    $('audit-equation').innerHTML = block(c.ranked,'On the board') + '<span class="audit-operator">+</span>' + block(c.issued,'Already issued') + '<span class="audit-operator">+</span>' + block(c.excluded,'Excluded with a reason') + '<span class="audit-operator">=</span>' + block(c.total,'Sealed universe');
    $('audit-method').textContent = 'Selection preserves the original ' + data.snapshot.watchlist_count + '-protocol watchlist plus the highest-TVL ' + (data.board.length - data.snapshot.watchlist_count) + ' other pre-token records below the ' + money(data.snapshot.floor_usd) + ' TVL floor. Exclusion below means outside this fixed board selection; it is not a claim that a protocol is ineligible for a token. All ' + data.issued.length + ' issued records are available in the Issued tokens tab.';
    $('audit-summary').textContent = 'Inspect all ' + data.audit.length + ' excluded pre-token records and every integrity check';
    $('audit-table').innerHTML = table(['Protocol','Category','TVL','Reason outside the board'],data.audit.map(row => [esc(row.name) + '<span class="row-sub">' + esc(row.slug) + '</span>',esc(row.category || 'Uncategorized'),numeric(money(row.tvl_usd)),esc(row.reason)])) + table(['Integrity check','Result','Observed','Required'],check.checks.map(row => [esc(row.label),'<b class="' + (row.pass ? 'positive' : 'negative') + '">' + (row.pass ? 'PASS' : 'FAIL') + '</b>',esc(row.id === 'seal' ? 'SHA-256 verified at build' : row.actual),esc(row.id === 'seal' ? 'Original sealed bytes' : row.expected)]));
    $('snapshot-hash').textContent = data.integrity.snapshot_sha256;
  }

  let lastTrigger = null, previousBodyOverflow = '', previousHtmlOverflow = '';
  function openDetail(slug, trigger) {
    const row = rowBySlug.get(slug);
    if (!row) return;
    lastTrigger = trigger || document.activeElement;
    $('detail-title').textContent = row.name;
    $('detail-title').title = row.name;
    $('detail-subtitle').textContent = (row.category || 'Uncategorized') + ' · ' + (row.chains.join(', ') || 'Chain unrecorded');
    const f = row.farm, details = row.valuation_details;
    $('detail-summary').innerHTML = f ? [[money(row.implied_value_usd),'Implied market cap',money(row.implied_p10_usd) + '–' + money(row.implied_p90_usd) + ' predictive'],[pct(row.token_probability),'Empirical token probability',row.odds.cell_issued + '/' + row.odds.cell_n + ' issued peers'],[money(f.net_per_hour),'Expected net / active hour','P10 ' + money(f.p10_net_per_hour)],[f.verdict,'P10 scenario verdict','P10 net ' + money(f.p10_net_usd)]].map(item => '<div class="detail-stat"><b>' + esc(item[0]) + '</b><span>' + esc(item[1]) + '</span><small>' + esc(item[2]) + '</small></div>').join('') : '';
    const fields = [['Slug',row.slug],['Category',row.category || 'Uncategorized'],['Chains',row.chains.join(', ') || 'Not recorded'],['TVL',exactMoney(row.tvl_usd)],['7d change',row.change_7d === null ? 'Missing' : number(row.change_7d,4) + '%'],['Listed at',row.listed_at || 'Missing'],['Age at sealed snapshot',row.age_days === null ? 'Missing' : row.age_days + ' days'],['Has token',row.has_token ? 'Yes' : 'No'],['Market cap',exactMoney(row.mcap_usd)],['Token symbol',row.symbol || 'None'],['Token identifier',row.gecko_id || 'None']];
    if (f) fields.push(['Rank',row.rank],['Watchlist',row.watchlist ? 'Yes' : 'No'],['Selection',row.selection_reason],['Predictive P10–P90',exactMoney(row.implied_p10_usd) + ' – ' + exactMoney(row.implied_p90_usd)],['Bootstrap value P10–P90',exactMoney(row.bootstrap_p10_usd) + ' – ' + exactMoney(row.bootstrap_p90_usd)],['Bootstrap rank P10–P90',row.rank_p10 + ' – ' + row.rank_p90],['Market-cap / TVL prediction',number(details.predicted_multiple,6) + '×'],['Refundable principal',exactMoney(f.capital_usd)],['Gas reserve',exactMoney(f.gas_usd)],['Active / weekly hours',number(f.time_hours,4) + ' / ' + number(f.weekly_hours,4)],['Expected / P10 payout',exactMoney(f.expected_airdrop_usd) + ' / ' + exactMoney(f.p10_airdrop_usd)],['Net / P10 net',exactMoney(f.net_usd) + ' / ' + exactMoney(f.p10_net_usd)],['Break-even farmer share',share(f.break_even_share)],['P10 break-even farmer share',share(f.p10_break_even_share)]);
    $('detail-fields').innerHTML = fields.map(item => '<dl class="field"><dt>' + esc(item[0]) + '</dt><dd>' + esc(item[1]) + '</dd></dl>').join('');
    if (f) {
      const o = row.odds;
      $('detail-odds').innerHTML = '<h3>Reproduce this probability</h3><p>' + esc(o.cell) + '. This target is excluded from all ' + o.training_n + ' training records.</p><p class="equation">(' + o.cell_issued + ' + ' + number(o.prior_strength,6) + ' × ' + number(o.prior_rate,6) + ') / (' + o.cell_n + ' + ' + number(o.prior_strength,6) + ') = ' + pct(row.token_probability,4) + '<br>Parent prior = (' + o.parent_issued + ' + ' + number(o.parent_prior_strength,6) + ' × ' + number(o.global_rate,6) + ') / (' + o.parent_n + ' + ' + number(o.parent_prior_strength,6) + ')</p><p>' + esc(odds.caveat) + '</p>';
      $('detail-economics').innerHTML = '<h3>Reproduce the valuation and farm economics</h3><p class="equation">' + esc(details.equation) + '<br>log(TVL) = ' + number(details.log_tvl,8) + '; fitted log value = ' + number(details.predicted_log_value,8) + '<br>Predictive interval = exp(fitted log value + [' + number(details.predictive_interval.residual_p10,8) + ', ' + number(details.predictive_interval.residual_p90,8) + '])</p><p>' + Object.entries(details.multipliers).map(([term,m]) => esc(termName(term)) + ': raw ' + factor(m.raw) + ', applied ' + factor(m.applied) + ' (' + (m.retained ? 'retained' : 'cut') + ')').join(' · ') + '</p><p class="equation">Personal share = ' + pct(assumptions.pool_fraction,2) + ' / ' + number(assumptions.qualifying_wallets,0) + ' = ' + share(f.farmer_share) + '<br>Expected payout = ' + exactMoney(row.implied_value_usd) + ' × ' + number(row.token_probability,8) + ' × ' + number(f.farmer_share,8) + ' = ' + exactMoney(f.expected_airdrop_usd) + '<br>Conservative valuation = min(predictive P10 ' + exactMoney(row.implied_p10_usd) + ', bootstrap fit P10 ' + exactMoney(row.bootstrap_p10_usd) + ') = ' + exactMoney(f.conservative_value_usd) + '<br>P10 payout = ' + exactMoney(f.conservative_value_usd) + ' × ' + number(row.token_probability,8) + ' × ' + number(f.farmer_share,8) + ' = ' + exactMoney(f.p10_airdrop_usd) + '<br>Cost = ' + f.transactions + ' transactions × ' + exactMoney(assumptions.gas_per_transaction_usd) + ' + ' + number(f.time_hours,6) + ' h × ' + exactMoney(assumptions.time_value_usd_per_hour) + '/h = ' + exactMoney(f.total_cost_usd) + '<br>Net / hour = (' + exactMoney(f.expected_airdrop_usd) + ' − ' + exactMoney(f.total_cost_usd) + ') / ' + number(f.time_hours,6) + ' = ' + exactMoney(f.net_per_hour) + '/h<br>P10 net / hour = (' + exactMoney(f.p10_airdrop_usd) + ' − ' + exactMoney(f.total_cost_usd) + ') / ' + number(f.time_hours,6) + ' = ' + exactMoney(f.p10_net_per_hour) + '/h<br>Break-even share = cost / (implied × probability) = ' + share(f.break_even_share) + '<br>P10 break-even share = cost / (conservative valuation × probability) = ' + share(f.p10_break_even_share) + '</p><p>' + esc(assumptions.verdict_rule) + '. ' + esc(f.assumptions) + '</p><p>Nearest traded comparables (display only): ' + details.comparables.map(comp => esc(comp.name) + ' ' + factor(comp.multiple) + ' mcap/TVL').join('; ') + '.</p>';
    } else {$('detail-odds').innerHTML = '';$('detail-economics').innerHTML = '';}
    const steps = f?.steps || [];
    document.querySelector('.step-count').textContent = steps.length + ' steps';
    $('farm-steps').innerHTML = steps.length ? steps.map(step => '<li>' + esc(step.text) + '<span class="step-numbers">' + step.minutes + ' active min · ' + step.transactions + ' transactions · ' + exactMoney(step.gas_usd) + ' assumed gas</span></li>').join('') : '<li>Issued-token records anchor the evidence. They have no pre-token farming plan.</li>';
    previousBodyOverflow = document.body.style.overflow;
    previousHtmlOverflow = document.documentElement.style.overflow;
    document.querySelector('.detail-grid').scrollTop = 0;
    $('detail-panel').classList.remove('hidden');
    $('detail-panel').setAttribute('aria-hidden','false');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    $('close-detail').focus({preventScroll:true});
  }

  function closeDetail() {
    if ($('detail-panel').classList.contains('hidden')) return;
    $('detail-panel').classList.add('hidden');
    $('detail-panel').setAttribute('aria-hidden','true');
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
    lastTrigger?.focus({preventScroll:true});
    lastTrigger = null;
  }
  function bind() {
    document.querySelectorAll('.tab').forEach(button => button.addEventListener('click',() => {
      state.view = button.dataset.view;state.sort = state.view === 'board' ? 'rank' : 'mcap_usd';state.direction = state.view === 'board' ? 1 : -1;renderBoard();const view = $(state.view + '-view');view.scrollTop = 0;view.scrollLeft = 0;
    }));
    document.querySelector('.tabs').addEventListener('keydown',event => {if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {event.preventDefault();const tabs = [...document.querySelectorAll('.tab')];const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(tab => tab.dataset.view !== state.view);next.click();next.focus({preventScroll:true});}});
    document.querySelectorAll('.sort-button').forEach(button => button.addEventListener('click',() => {const key = button.dataset.sort;if(state.sort === key) state.direction *= -1;else {state.sort = key;state.direction = key === 'rank' || key === 'farm.break_even_share' ? 1 : -1;}renderBoard();}));
    [['search-input','search','input'],['category-filter','category','change'],['chain-filter','chain','change'],['verdict-filter','verdict','change']].forEach(([id,key,event]) => $(id).addEventListener(event,e => {state[key] = e.target.value.trim();renderBoard();}));
    $('clear-filters').addEventListener('click',() => {['search','category','chain','verdict'].forEach(key => {state[key] = '';});['search-input','category-filter','chain-filter','verdict-filter'].forEach(id => {$(id).value = '';});renderBoard();});
    ['budget-input','hours-input','allocation-input','time-input'].forEach(id => $(id).addEventListener('input',renderPlanner));
    document.body.addEventListener('click',event => {const button = event.target.closest('.protocol-button');if(button) openDetail(button.dataset.slug,button);});
    $('close-detail').addEventListener('click',closeDetail);
    $('detail-panel').addEventListener('click',event => {if(event.target === $('detail-panel')) closeDetail();});
    document.addEventListener('keydown',event => {
      if ($('detail-panel').classList.contains('hidden')) return;
      if (event.key === 'Escape') {closeDetail();return;}
      if (event.key !== 'Tab') return;
      const focusable = [...$('detail-panel').querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])')].filter(element => !element.disabled);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !$('detail-panel').contains(document.activeElement))) {event.preventDefault();last.focus({preventScroll:true});}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus({preventScroll:true});}
    });
  }
  renderMeta();renderEvidence();renderAssumptions();renderPlanner();renderAudit();bind();renderBoard();
})();
