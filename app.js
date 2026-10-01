/* UI: forms bound to `state`, re-run both simulations on every change, render results. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { clock, hover } = KCharts;

  const SHAPES = {
    steady: { label: 'Steady', defaults: { replicas: 10 }, params: [['replicas', 'replicas']] },
    daily: { label: 'Daily cycle', defaults: { min: 5, max: 40, peakHour: 14 }, params: [['min', 'min'], ['max', 'max'], ['peakHour', 'peak at h']] },
    spiky: { label: 'Spikes', defaults: { base: 10, peak: 40, everyMin: 30, forMin: 10 }, params: [['base', 'base'], ['peak', 'peak'], ['everyMin', 'every min'], ['forMin', 'for min']] },
    step: { label: 'Step change', defaults: { from: 40, to: 10, atHour: 1 }, params: [['from', 'from'], ['to', 'to'], ['atHour', 'at h']] },
  };
  const FAMILIES = ['c5', 'm5', 'r5'];
  const LOG_KINDS = [
    ['all', 'All'], ['disrupt', 'Disruptions'], ['provision', 'Provisioning'], ['terminate', 'Terminations'],
    ['blocked', 'Blocked'], ['budget', 'Budget'], ['abandon', 'Abandoned'],
  ];
  const MAX_LOG_LINES = 1500;
  const POLICY_HINTS = {
    WhenEmpty: 'Only removes servers with no pods left. Never moves your pods.',
    WhenEmptyOrUnderutilized: 'Also moves pods to free up half-empty servers. Saves more, but restarts pods.',
  };
  const help = (id, label) => `<button type="button" class="help" data-term="${id}" aria-label="Explain ${label || id}">?</button>`;

  let state;
  let results = null;
  let logKind = 'all';
  let logQuery = '';

  // --- state ------------------------------------------------------------------

  function fromPreset(id) {
    const p = KSimPresets.find((x) => x.id === id) || KSimPresets[0];
    return { presetId: p.id, scenario: clone(p.scenario), a: clone(p.a), b: clone(p.b) };
  }

  function loadHash() {
    if (location.hash.length < 2) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1))))); } catch (e) { return null; }
  }

  function saveHash() {
    history.replaceState(null, '', '#' + btoa(unescape(encodeURIComponent(JSON.stringify(state)))));
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  // --- rendering: inputs -------------------------------------------------------

  function renderPreset() {
    $('#preset').innerHTML = KSimPresets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('#preset').value = state.presetId;
    const p = KSimPresets.find((x) => x.id === state.presetId);
    $('#preset-desc').textContent = p ? p.description : '';
  }

  function bindStatic() {
    document.querySelectorAll('[data-path]').forEach((el) => {
      if (el.closest('#workloads, .config')) return;
      el.value = getPath(state, el.dataset.path);
    });
  }

  function num(path, cls) {
    return `<input type="number" class="${cls || 'narrow'}" data-path="${path}" data-type="number" value="${esc(getPath(state, path))}">`;
  }

  function renderWorkloads() {
    const rows = state.scenario.workloads.map((w, i) => {
      const p = `scenario.workloads.${i}`;
      const shape = SHAPES[w.shape.type];
      const pdbKind = !w.pdb ? 'none' : w.pdb.minAvailable != null ? 'minAvailable' : 'maxUnavailable';
      return `<tr>
        <td><input type="text" data-path="${p}.name" value="${esc(w.name)}" style="width:110px"></td>
        <td>${num(p + '.cpu')}</td>
        <td>${num(p + '.mem')}</td>
        <td>
          <select data-action="shape-type" data-i="${i}">
            ${Object.keys(SHAPES).map((k) => `<option value="${k}"${k === w.shape.type ? ' selected' : ''}>${SHAPES[k].label}</option>`).join('')}
          </select>
          <span class="shape-params">${shape.params.map(([k, label]) => `${label} ${num(p + '.shape.' + k)}`).join(' ')}</span>
        </td>
        <td>
          <select data-action="pdb-kind" data-i="${i}">
            ${['none', 'maxUnavailable', 'minAvailable'].map((k) => `<option value="${k}"${k === pdbKind ? ' selected' : ''}>${k === 'none' ? 'no PDB' : k}</option>`).join('')}
          </select>
          ${pdbKind === 'none' ? '' : num(`${p}.pdb.${pdbKind}`)}
        </td>
        <td style="text-align:center"><input type="checkbox" data-path="${p}.doNotDisrupt" data-type="bool"${w.doNotDisrupt ? ' checked' : ''} aria-label="do-not-disrupt"></td>
        <td>
          <select data-path="${p}.onlyIn" data-type="opt">
            <option value=""${!w.onlyIn ? ' selected' : ''}>A and B</option>
            <option value="a"${w.onlyIn === 'a' ? ' selected' : ''}>A only</option>
            <option value="b"${w.onlyIn === 'b' ? ' selected' : ''}>B only</option>
          </select>
        </td>
        <td><button type="button" class="link" data-action="remove-workload" data-i="${i}" aria-label="Remove workload">remove</button></td>
      </tr>`;
    }).join('');
    $('#workloads').innerHTML = `<tr><th>Name ${help('pod', 'pod')}</th><th>CPU (m) ${help('requests', 'CPU and memory')}</th><th>Mem (Mi)</th><th>Replicas over time ${help('shapes', 'replicas over time')}</th><th>PDB ${help('pdb', 'PDB')}</th><th>do-not-disrupt ${help('doNotDisrupt', 'do-not-disrupt')}</th><th>Runs in ${help('runsIn', 'runs in')}</th><th></th></tr>${rows}`;
  }

  function renderConfig(side) {
    const c = state[side];
    const opt = (v, cur, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label || v}</option>`;
    const check = (path, v, list) => `<label><input type="checkbox" data-path="${path}" data-type="set" value="${v}"${(list || []).includes(v) ? ' checked' : ''}>${v}</label>`;
    const budgets = c.budgets.map((b, j) => {
      const p = `${side}.budgets.${j}`;
      return `<div class="budget">
        <label class="shape-params">nodes <input type="text" data-path="${p}.nodes" data-validate="budget" value="${esc(b.nodes)}" style="width:60px"></label>
        <span class="shape-params">reasons ${help('reasons', 'budget reasons')}</span>
        <span class="checks">${check(p + '.reasons', 'Empty', b.reasons)}${check(p + '.reasons', 'Underutilized', b.reasons)}</span>
        <label class="shape-params"><input type="checkbox" data-action="budget-sched" data-side="${side}" data-j="${j}"${b.schedule ? ' checked' : ''}>scheduled</label>${help('schedule', 'scheduled budgets')}
        ${b.schedule ? `<span class="shape-params">from ${num(p + '.schedule.startHour')}:00 for ${num(p + '.schedule.durationHours')}h</span>` : ''}
        <button type="button" class="link" data-action="remove-budget" data-side="${side}" data-j="${j}">remove</button>
      </div>`;
    }).join('');

    $('#config-' + side).innerHTML = `
      <h2><span class="key ${side}"></span>Config ${side.toUpperCase()}</h2>
      <div class="fields">
        <div class="field">
          <span>consolidationPolicy ${help(c.consolidationPolicy === 'WhenEmpty' ? 'whenEmpty' : 'whenUnderutilized', 'consolidation policy')}</span>
          <select data-path="${side}.consolidationPolicy" aria-label="consolidationPolicy">${opt('WhenEmptyOrUnderutilized', c.consolidationPolicy)}${opt('WhenEmpty', c.consolidationPolicy)}</select>
          <span class="hint" id="policy-hint-${side}">${POLICY_HINTS[c.consolidationPolicy]}</span>
        </div>
        <div class="field">
          <span>consolidateAfter ${help('consolidateAfter', 'consolidateAfter')} <span class="muted">e.g. 0s, 30s, 5m, Never</span></span>
          <input type="text" data-path="${side}.consolidateAfter" data-validate="duration" value="${esc(c.consolidateAfter)}" aria-label="consolidateAfter">
        </div>
        <div class="field">
          <span>kube-scheduler scoring ${help('scoring', 'scheduler scoring')}</span>
          <select data-path="${side}.schedulerScoring" aria-label="kube-scheduler scoring">${opt('LeastAllocated', c.schedulerScoring, 'LeastAllocated (default)')}${opt('MostAllocated', c.schedulerScoring)}</select>
        </div>
      </div>
      <div class="fields">
        <div class="field"><span>instance-family ${help('instanceReqs', 'instance family')}</span><span class="checks">${FAMILIES.map((f) => check(side + '.families', f, c.families)).join('')}</span></div>
        <div class="field"><span>instance-size ${help('instanceReqs', 'instance size')}</span><span class="checks">${KSim.SIZES.map((s) => check(side + '.sizes', s, c.sizes)).join('')}</span></div>
      </div>
      <h3>Disruption budgets ${help('budgets', 'disruption budgets')} <span class="muted" style="font-weight:400">(no reasons checked = all reasons)</span></h3>
      ${budgets || '<p class="muted">No budgets, so disruption is unlimited.</p>'}
      <button type="button" data-action="add-budget" data-side="${side}" style="margin-top:6px">+ Add budget</button>
      <details style="margin-top:12px"><summary>NodePool YAML</summary><pre class="yaml" id="yaml-${side}"></pre></details>`;
    renderYaml(side);
  }

  function renderYaml(side) {
    const c = state[side];
    const list = (xs) => '[' + xs.map((x) => `"${x}"`).join(', ') + ']';
    let y = `apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ${list(c.families)}
`;
    if (c.sizes && c.sizes.length) {
      y += `        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ${list(c.sizes)}
`;
    }
    y += `        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
  disruption:
    consolidationPolicy: ${c.consolidationPolicy}
    consolidateAfter: ${c.consolidateAfter}
`;
    if (c.budgets.length) {
      y += '    budgets:\n';
      for (const b of c.budgets) {
        y += `      - nodes: "${b.nodes}"\n`;
        if (b.reasons && b.reasons.length) y += `        reasons: ${list(b.reasons)}\n`;
        if (b.schedule) y += `        schedule: "0 ${b.schedule.startHour} * * *"\n        duration: ${b.schedule.durationHours}h\n`;
      }
    } else {
      y += '    budgets: []\n';
    }
    if (c.schedulerScoring === 'MostAllocated') {
      y += '# kube-scheduler: NodeResourcesFit scoringStrategy MostAllocated (scheduler config, not the NodePool)\n';
    }
    const el = $('#yaml-' + side);
    if (el) el.textContent = y;
  }

  function renderInputs() {
    renderPreset();
    bindStatic();
    renderWorkloads();
    renderConfig('a');
    renderConfig('b');
  }

  // --- input handling -----------------------------------------------------------

  function validate(el) {
    const v = el.value.trim();
    try {
      if (el.dataset.validate === 'duration') KSim.parseDuration(v);
      if (el.dataset.validate === 'budget' && !/^\d+%?$/.test(v)) throw new Error('bad budget');
      el.classList.remove('invalid');
      return true;
    } catch (e) {
      el.classList.add('invalid');
      return false;
    }
  }

  function onInput(e) {
    const el = e.target;
    const path = el.dataset.path;
    if (!path) return;
    let value;
    switch (el.dataset.type) {
      case 'number':
        if (el.value === '' || isNaN(Number(el.value))) { el.classList.add('invalid'); return; }
        el.classList.remove('invalid');
        value = Number(el.value);
        break;
      case 'bool': value = el.checked; break;
      case 'opt': value = el.value || null; break;
      case 'set': {
        const cur = new Set(getPath(state, path) || []);
        if (el.checked) cur.add(el.value); else cur.delete(el.value);
        value = [...cur];
        break;
      }
      default:
        if (el.dataset.validate && !validate(el)) return;
        value = el.value.trim();
    }
    setPath(state, path, value);
    const side = path[0];
    if (path === side + '.consolidationPolicy') renderConfig(side);
    else if (path.startsWith('a.') || path.startsWith('b.')) renderYaml(side);
    scheduleRun();
  }

  function onAction(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const i = Number(el.dataset.i), j = Number(el.dataset.j), side = el.dataset.side;
    const wls = state.scenario.workloads;
    switch (el.dataset.action) {
      case 'shape-type': wls[i].shape = Object.assign({ type: el.value }, SHAPES[el.value].defaults); renderWorkloads(); break;
      case 'pdb-kind': wls[i].pdb = el.value === 'none' ? null : { [el.value]: 1 }; renderWorkloads(); break;
      case 'remove-workload': wls.splice(i, 1); renderWorkloads(); break;
      case 'add-budget': state[side].budgets.push({ nodes: '10%', reasons: [], schedule: null }); renderConfig(side); break;
      case 'remove-budget': state[side].budgets.splice(j, 1); renderConfig(side); break;
      case 'budget-sched': state[side].budgets[j].schedule = el.checked ? { startHour: 9, durationHours: 8 } : null; renderConfig(side); break;
      default: return;
    }
    scheduleRun();
  }

  let runTimer = null;
  function scheduleRun() {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, 250);
  }

  // --- simulation + results -----------------------------------------------------

  function showError(msg) {
    const el = $('#error');
    el.style.display = msg ? 'block' : 'none';
    el.textContent = msg ? 'Simulation error: ' + msg : '';
  }

  function run() {
    if (document.querySelector('input.invalid')) return showError('fix the highlighted fields');
    let a, b;
    try {
      a = KSim.simulate(Object.assign({ side: 'a' }, state.a), state.scenario);
      b = KSim.simulate(Object.assign({ side: 'b' }, state.b), state.scenario);
    } catch (e) {
      return showError(e.message);
    }
    showError(null);
    results = { a, b };
    renderSummary();
    renderCharts();
    renderLogs();
    saveHash();
  }

  const money = (x, d) => '$' + x.toFixed(d === undefined ? 2 : d);
  const int = (x) => Math.round(x).toLocaleString();
  const pct = (x) => Math.round(x * 100) + '%';
  const last = (r) => r.samples[r.samples.length - 1];

  const METRICS = [
    ['Total cost', (r) => r.summary.totalCost, money, 'lower'],
    ['Cost/hr at end', (r) => last(r).costHr, (x) => money(x, 3), 'lower'],
    ['Average nodes', (r) => r.summary.avgNodes, (x) => x.toFixed(1), 'lower'],
    ['Peak nodes', (r) => r.summary.peakNodes, int, null],
    ['Avg CPU requested / allocatable', (r) => r.summary.avgUtil, pct, 'higher', 'utilization'],
    ['Consolidation commands', (r) => r.summary.totalCommands, int, null, 'consolidation'],
    ['  Emptiness / multi-node / single-node', (r) => r.summary.commands, (c) => `${c.Emptiness} / ${c.MultiNodeConsolidation} / ${c.SingleNodeConsolidation}`, 'none', 'methods'],
    ['Commands abandoned at validation', (r) => r.summary.abandoned, int, null, 'validation'],
    ['Nodes launched', (r) => r.summary.nodesLaunched, int, null],
    ['Pod evictions', (r) => r.summary.evictions, int, 'lower', 'eviction'],
    ['Pod-minutes pending', (r) => r.summary.podPendingMinutes, int, 'lower', 'pendingMinutes'],
  ];

  function delta(va, vb, fmt, better) {
    if (better === 'none' || typeof va !== 'number') return '';
    const d = vb - va;
    if (Math.abs(d) < 1e-9) return '<span class="muted">same</span>';
    const rel = va ? ` (${d > 0 ? '+' : '−'}${Math.round(Math.abs(d / va) * 100)}%)` : '';
    const text = (d > 0 ? '▲ +' : '▼ −') + fmt(Math.abs(d)) + rel;
    const cls = !better ? '' : (d < 0) === (better === 'lower') ? 'good' : 'bad';
    return `<span class="delta ${cls}">${text}</span>`;
  }

  function renderSummary() {
    const { a, b } = results;
    $('#summary').innerHTML =
      '<tr><th>Metric</th><th class="num"><span class="key a"></span>A</th><th class="num"><span class="key b"></span>B</th><th class="num">B vs A</th></tr>' +
      METRICS.map(([label, get, fmt, better, term]) => {
        const va = get(a), vb = get(b);
        const name = label.startsWith('  ') ? '<span class="muted" style="padding-left:12px">' + label.trim() + '</span>' : label;
        return `<tr><td>${name}${term ? ' ' + help(term, label.trim()) : ''}</td>
          <td class="num">${fmt(va)}</td><td class="num">${fmt(vb)}</td><td class="num">${delta(va, vb, fmt, better)}</td></tr>`;
      }).join('');

    const ca = a.summary.totalCost, cb = b.summary.totalCost;
    const rel = ca ? (cb - ca) / ca : 0;
    let v = Math.abs(rel) < 0.005
      ? `A and B cost about the same (${money(ca)})`
      : `B costs <b>${Math.round(Math.abs(rel) * 100)}% ${rel < 0 ? 'less' : 'more'}</b> than A (${money(cb)} vs ${money(ca)})`;
    const ev = b.summary.evictions - a.summary.evictions;
    const pend = b.summary.podPendingMinutes - a.summary.podPendingMinutes;
    const parts = [];
    if (ev) parts.push(`${int(Math.abs(ev))} ${ev > 0 ? 'more' : 'fewer'} pod evictions`);
    if (Math.abs(pend) >= 5) parts.push(`${int(Math.abs(pend))} ${pend > 0 ? 'more' : 'fewer'} pod-minutes pending`);
    if (parts.length) v += ', with ' + parts.join(' and ');
    $('#verdict').innerHTML = v + '.';
  }

  function renderCharts() {
    if (!results) return;
    const { a, b } = results;
    const duration = state.scenario.durationHours;
    const series = (get) => [
      { label: 'A', cls: 'a', values: a.samples.map(get) },
      { label: 'B', cls: 'b', values: b.samples.map(get) },
    ];
    const base = { duration, sampleEvery: 60 };
    hover.clear();
    hover.pinned = false;
    KCharts.lineChart($('#chart-cost'), Object.assign({}, base, {
      title: 'Cost ($/hr)', series: series((s) => s.costHr),
      yFormat: (v) => '$' + v.toFixed(v < 10 ? 2 : 0), tipFormat: (v) => '$' + v.toFixed(3) + '/hr',
    }));
    KCharts.lineChart($('#chart-nodes'), Object.assign({}, base, {
      title: 'Nodes', series: series((s) => s.nodes), yFormat: (v) => String(v), tipFormat: String,
    }));
    KCharts.lineChart($('#chart-util'), Object.assign({}, base, {
      title: 'CPU requested / allocatable', series: series((s) => s.util), minMax: 1,
      yFormat: (v) => Math.round(v * 100) + '%', tipFormat: (v) => (v * 100).toFixed(1) + '%',
    }));
    KCharts.lineChart($('#chart-pending'), Object.assign({}, base, {
      title: 'Pods not running (pending or waiting for a node)', series: series((s) => s.pending), minMax: 1,
      yFormat: (v) => String(v), tipFormat: String,
    }));
    for (const side of ['a', 'b']) {
      const r = results[side];
      KCharts.timeline($('#timeline-' + side), {
        title: `<span class="key ${side}"></span>${side.toUpperCase()}: ${r.nodes.length} nodes launched`,
        nodes: r.nodes, duration, cls: side,
      });
    }
  }

  function renderLogs() {
    $('#filters').innerHTML = LOG_KINDS.map(([k, label]) =>
      `<button type="button" class="chip" data-kind="${k}" aria-pressed="${k === logKind}">${label}</button>`).join('') +
      `<input type="text" id="log-search" placeholder="Search log (e.g. node-3)" value="${esc(logQuery)}" style="margin-left:8px;width:220px">`;
    const q = logQuery.toLowerCase();
    for (const side of ['a', 'b']) {
      const entries = results[side].log.filter((l) =>
        (logKind === 'all' || l.kind === logKind) && (!q || l.msg.toLowerCase().includes(q)));
      const shown = entries.slice(0, MAX_LOG_LINES);
      $('#log-' + side).innerHTML = (shown.map((l) =>
        `<div data-t="${l.t}"><span class="t">${clock(l.t, true)}</span><span class="k">${l.kind}</span><span>${esc(l.msg)}</span></div>`).join('') ||
        '<div class="empty">No matching events.</div>') +
        (entries.length > shown.length ? `<div class="empty">… ${entries.length - shown.length} more (narrow the filter)</div>` : '');
    }
  }

  // --- glossary -----------------------------------------------------------------

  function renderGlossary(query) {
    const q = query.trim().toLowerCase();
    const html = KSimGlossary.map((g) => {
      const terms = g.terms.filter((t) => !q || (t.term + ' ' + t.body).toLowerCase().includes(q));
      if (!terms.length) return '';
      return `<h3>${g.group}</h3>` + terms.map((t) => `<dl id="term-${t.id}"><dt>${t.term}</dt><dd>${t.body}</dd>` +
        (t.example ? `<dd class="example">${t.example}</dd>` : '') + '</dl>').join('');
    }).join('');
    $('#glossary-body').innerHTML = html || '<p class="muted">No matching terms.</p>';
  }

  function openGlossary(id) {
    const wasOpen = document.body.classList.contains('glossary-open');
    document.body.classList.add('glossary-open');
    $('#glossary').setAttribute('aria-hidden', 'false');
    if (!id) { if (wasOpen) closeGlossary(); else $('#glossary-search').focus(); return; }
    if ($('#glossary-search').value) { $('#glossary-search').value = ''; renderGlossary(''); }
    const el = document.getElementById('term-' + id);
    if (!el) return;
    const panel = $('#glossary');
    panel.scrollTo({ top: el.offsetTop - $('.g-sticky').offsetHeight - 8, behavior: wasOpen ? 'smooth' : 'auto' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    if (!wasOpen) setTimeout(renderCharts, 260); // the page got narrower
  }

  function closeGlossary() {
    if (!document.body.classList.contains('glossary-open')) return;
    document.body.classList.remove('glossary-open');
    $('#glossary').setAttribute('aria-hidden', 'true');
    setTimeout(renderCharts, 260);
  }

  // --- wiring -------------------------------------------------------------------

  function init() {
    state = loadHash() || fromPreset(KSimPresets[0].id);
    renderInputs();

    $('#preset').addEventListener('change', (e) => { state = fromPreset(e.target.value); renderInputs(); run(); });
    $('#add-workload').addEventListener('click', () => {
      state.scenario.workloads.push({ name: 'app-' + (state.scenario.workloads.length + 1), cpu: 500, mem: 1024, shape: { type: 'steady', replicas: 10 }, pdb: null, doNotDisrupt: false });
      renderWorkloads();
      scheduleRun();
    });
    $('#copy-link').addEventListener('click', (e) => {
      saveHash();
      navigator.clipboard.writeText(location.href).then(() => {
        e.target.textContent = 'Copied';
        setTimeout(() => { e.target.textContent = 'Copy share link'; }, 1500);
      });
    });
    document.addEventListener('input', onInput);
    document.addEventListener('change', (e) => {
      if (e.target.dataset.action) return onAction(e);
      if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') onInput(e);
    });
    document.addEventListener('click', (e) => {
      const helpBtn = e.target.closest('[data-term]');
      if (helpBtn) { e.preventDefault(); openGlossary(helpBtn.dataset.term); return; }
      if (e.target.closest('button[data-action]')) onAction(e);
      const chip = e.target.closest('.chip');
      if (chip) { logKind = chip.dataset.kind; renderLogs(); }
      const line = e.target.closest('.log div[data-t]');
      if (line) hover.set(Number(line.dataset.t), true);
    });
    $('#filters').addEventListener('input', (e) => {
      if (e.target.id !== 'log-search') return;
      logQuery = e.target.value;
      const pos = e.target.selectionStart;
      renderLogs();
      const s = $('#log-search');
      s.focus();
      s.setSelectionRange(pos, pos);
    });
    $('#glossary-close').addEventListener('click', closeGlossary);
    $('#glossary-search').addEventListener('input', (e) => renderGlossary(e.target.value));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGlossary(); });
    renderGlossary('');
    let resizeTimer = null;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 150); });
    run();
  }

  init();
})();
