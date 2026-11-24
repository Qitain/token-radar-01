(function(){
  const data=globalThis.__TOKEN_RADAR__;
  const state={view:'board',sort:'rank',direction:1,search:'',category:'',chain:''};
  const labels={slug:'Slug',name:'Protocol',category:'Category',chains:'Chains',tvl_usd:'TVL (USD)',change_7d:'7d change (%)',mcap_usd:'Market cap (USD)',listed_at:'Listed at',gecko_id:'Gecko ID',symbol:'Token symbol',age_days:'Age (days)',category_multiplier:'Category multiplier',growth_momentum:'Growth momentum',maturity_factor:'Maturity',multi_chain_factor:'Multi-chain factor',data_completeness:'Data completeness',implied_value_usd:'Implied value (USD)',rank:'Rank',has_token:'Has token',watchlist:'Watchlist',selection_reason:'Selection reason'};
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const money=value=>{if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';const n=Number(value);if(Math.abs(n)>=1e9)return '$'+(n/1e9).toFixed(2)+'B';if(Math.abs(n)>=1e6)return '$'+(n/1e6).toFixed(2)+'M';if(Math.abs(n)>=1e3)return '$'+(n/1e3).toFixed(1)+'K';return '$'+Math.round(n).toLocaleString('en-US')};
  const percent=value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`;
  const factor=value=>value===null||value===undefined?'—':Number(value).toFixed(4);
  const valueText=(key,value)=>{if(value===null||value===undefined)return '—';if(Array.isArray(value))return value.length?value.join(', '):'None';if(key.endsWith('_usd'))return money(value);if(key==='change_7d')return percent(value);if(['category_multiplier','growth_momentum','maturity_factor','multi_chain_factor','data_completeness'].includes(key))return factor(value);if(key==='has_token'||key==='watchlist')return value?'Yes':'No';return String(value)};
  const protocolButton=row=>`<button class="protocol-button" type="button" data-slug="${esc(row.slug)}" aria-label="Open details for ${esc(row.name)}"><span>${esc(row.name)}${row.watchlist?'<span class="watch-tag">Watch</span>':''}<span class="protocol-slug">${esc(row.slug)}</span></span></button>`;
  const matches=row=>{const search=state.search.toLowerCase();return (!search||row.name.toLowerCase().includes(search)||row.slug.toLowerCase().includes(search))&&(!state.category||row.category===state.category)&&(!state.chain||row.chains.includes(state.chain))};
  const sourceRows=()=>state.view==='board'?data.board:data.issued;
  const filtered=()=>sourceRows().filter(matches).sort((a,b)=>{const key=state.sort;let av=a[key],bv=b[key];if(av===null||av===undefined)av=-Infinity;if(bv===null||bv===undefined)bv=-Infinity;if(typeof av==='string')return state.direction*((av<bv?-1:av>bv?1:0));return state.direction*(Number(av)-Number(bv))});

  let lastTrigger=null;
  let previousBodyOverflow='';
  let previousDocumentElementOverflow='';

  function populateFilters(){
    data.categories.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;$('category-filter').append(option)});
    data.chains.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;$('chain-filter').append(option)});
  }

  function renderMeta(){
    const s=data.snapshot;
    $('snapshot-note').textContent=`Snapshot ${s.as_of} · ${s.source}`;
    $('footer-date').textContent=s.as_of;
    $('footer-source').textContent=`Source: ${s.source}`;
    $('board-count').textContent=data.board.length;
    $('issued-count').textContent=data.issued.length;
    $('parameter-grid').innerHTML='<div>Growth: 7d momentum</div><div>Maturity: protocol age</div><div>Multi-chain: chain count</div><div>Completeness: data quality</div>';
    $('metric-strip').innerHTML=[['200','Ranking board protocols'],[data.snapshot.watchlist_count,'Watchlist coverage'],[data.model.calibration.sample_count,'Calibration samples'],[money(data.snapshot.floor_usd),'TVL floor']].map(item=>`<div class="metric"><b>${esc(item[0])}</b><span>${esc(item[1])}</span></div>`).join('');
  }

  function renderBoard(rows){
    $('board-body').innerHTML=rows.map(row=>`<tr><td class="rank">${row.rank}</td><td>${protocolButton(row)}</td><td><span class="category-tag">${esc(row.category||'Uncategorized')}</span></td><td><span class="chain-tag">${esc(row.chains.join(', ')||'Not recorded')}</span></td><td>${money(row.tvl_usd)}</td><td class="${row.change_7d===null?'muted':row.change_7d>=0?'positive':'negative'}">${percent(row.change_7d)}</td><td><strong>${money(row.implied_value_usd)}</strong></td></tr>`).join('');
  }

  function renderIssued(rows){
    $('issued-body').innerHTML=rows.map(row=>`<tr><td>${protocolButton(row)}</td><td><span class="category-tag">${esc(row.category||'Uncategorized')}</span></td><td><span class="issued-tag">${esc(row.symbol||'Not recorded')}</span></td><td><strong>${money(row.mcap_usd)}</strong></td></tr>`).join('');
  }

  function updateSortIndicators(){
    document.querySelectorAll('.sort-button').forEach(button=>{
      const active=button.dataset.sort===state.sort;
      const direction=state.direction===1?'ascending':'descending';
      const arrow=button.querySelector('span');
      button.setAttribute('aria-pressed',String(active));
      button.setAttribute('aria-label',`Sort by ${button.textContent.replace(/[↕↑↓]/g,'').trim()}${active?`, ${direction}`:''}`);
      if(arrow)arrow.textContent=active?(state.direction===1?'↑':'↓'):'↕';
      const header=button.closest('th');
      if(header)header.setAttribute('aria-sort',active?direction:'none');
    });
  }

  function updateTabs(){
    document.querySelectorAll('.tab').forEach(button=>{
      const active=button.dataset.view===state.view;
      button.classList.toggle('active',active);
      button.setAttribute('aria-selected',String(active));
    });
  }

  function render(){
    const rows=filtered();
    $('view-title').textContent=state.view==='board'?'Pre-token ranking board':'Issued-token protocols (market cap)';
    $('board-view').classList.toggle('hidden',state.view!=='board');
    $('issued-view').classList.toggle('hidden',state.view!=='issued');
    $('empty-state').classList.toggle('hidden',rows.length!==0);
    if(state.view==='board')renderBoard(rows);else renderIssued(rows);
    updateSortIndicators();
    updateTabs();
  }

  function resetTableScroll(){
    const table=state.view==='board'?$('board-view'):$('issued-view');
    table.scrollTop=0;
    table.scrollLeft=0;
  }

  function openDetail(slug,trigger){
    const row=[...data.board,...data.issued].find(item=>item.slug===slug);
    if(!row)return;
    const detailPanel=$('detail-panel').querySelector('.detail-panel');
    const detailScroller=detailPanel.querySelector('.detail-grid');
    lastTrigger=trigger||document.activeElement;
    $('detail-title').textContent=row.name;
    $('detail-title').title=row.name;
    $('detail-subtitle').textContent=`${row.category||'Uncategorized'} · ${row.chains.join(', ')||'Chain info missing'}`;
    $('detail-subtitle').title=$('detail-subtitle').textContent;
    const fields=Object.entries(row).filter(([key])=>key!=='farm_steps');
    $('detail-fields').innerHTML=fields.map(([key,value])=>`<dl class="field"><dt>${esc(labels[key]||key)}</dt><dd>${esc(valueText(key,value))}</dd></dl>`).join('');
    const steps=row.farm_steps||[];
    document.querySelector('.step-count').textContent=`${steps.length} steps`;
    $('farm-steps').innerHTML=steps.length?steps.map(step=>`<li>${esc(step)}</li>`).join(''):'<li>Issued-token protocols do not have pre-token farming steps.</li>';
    const panel=$('detail-panel');
    previousBodyOverflow=document.body.style.overflow;
    previousDocumentElementOverflow=document.documentElement.style.overflow;
    detailScroller.scrollTop=0;
    detailPanel.classList.remove('is-scrolled');
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
    document.documentElement.style.overflow='hidden';
    $('close-detail').focus({preventScroll:true});
  }

  function closeDetail(){
    const panel=$('detail-panel');
    if(panel.classList.contains('hidden'))return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden','true');
    document.body.style.overflow=previousBodyOverflow;
    document.documentElement.style.overflow=previousDocumentElementOverflow;
    if(lastTrigger&&document.contains(lastTrigger))lastTrigger.focus({preventScroll:true});
    lastTrigger=null;
  }

  function trapModalFocus(event){
    if(event.key!=='Tab'||$('detail-panel').classList.contains('hidden'))return;
    const focusable=[...$('detail-panel').querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(item=>!item.disabled);
    if(!focusable.length)return;
    const first=focusable[0];
    const last=focusable[focusable.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus({preventScroll:true})}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus({preventScroll:true})}
  }

  function bind(){
    const detailPanel=$('detail-panel').querySelector('.detail-panel');
    const detailScroller=detailPanel.querySelector('.detail-grid');
    detailScroller.tabIndex=0;
    detailScroller.setAttribute('role','region');
    detailScroller.setAttribute('aria-label','Protocol details and farming plan');
    // Keep a gap between thresholds so the header transition cannot toggle itself.
    detailScroller.addEventListener('scroll',()=>{
      const scrolled=detailPanel.classList.contains('is-scrolled');
      if(!scrolled&&detailScroller.scrollTop>20)detailPanel.classList.add('is-scrolled');
      else if(scrolled&&detailScroller.scrollTop<8)detailPanel.classList.remove('is-scrolled');
    },{passive:true});
    document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>{
      state.view=button.dataset.view;
      state.sort=state.view==='board'?'rank':'mcap_usd';
      state.direction=state.view==='board'?1:-1;
      render();
      resetTableScroll();
    }));
    document.querySelectorAll('.sort-button').forEach(button=>button.addEventListener('click',()=>{
      const key=button.dataset.sort;
      if(state.sort===key)state.direction*=-1;
      else{state.sort=key;state.direction=key==='rank'?1:-1}
      render();
    }));
    $('search-input').addEventListener('input',event=>{state.search=event.target.value.trim();render()});
    $('category-filter').addEventListener('change',event=>{state.category=event.target.value;render()});
    $('chain-filter').addEventListener('change',event=>{state.chain=event.target.value;render()});
    $('clear-filters').addEventListener('click',()=>{$('search-input').value='';$('category-filter').value='';$('chain-filter').value='';state.search='';state.category='';state.chain='';render()});
    document.body.addEventListener('click',event=>{const button=event.target.closest('.protocol-button');if(button)openDetail(button.dataset.slug,button)});
    $('close-detail').addEventListener('click',closeDetail);
    $('detail-panel').addEventListener('click',event=>{if(event.target===$('detail-panel'))closeDetail()});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDetail();else trapModalFocus(event)});
  }

  $('detail-panel').setAttribute('aria-hidden','true');
  populateFilters();
  renderMeta();
  bind();
  render();
})();
