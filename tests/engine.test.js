/* Run: ./test.sh  (uses macOS JavaScriptCore `jsc`, no Node needed) */
(function () {
  'use strict';
  const { Sim, simulate, parseDuration } = KSim;
  const out = typeof print === 'function' ? print : console.log;
  let passed = 0, failed = 0;

  function test(name, fn) {
    try { fn(); passed++; out('  ok   ' + name); }
    catch (e) { failed++; out('  FAIL ' + name + '\n       ' + e.message); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

  const DS = { cpu: 150, mem: 200, pods: 3 };
  function pool(o) {
    return Object.assign({
      consolidationPolicy: 'WhenEmptyOrUnderutilized', consolidateAfter: 30,
      budgets: [{ nodes: '10%' }], families: ['c5', 'm5', 'r5'], schedulerScoring: 'LeastAllocated',
    }, o);
  }
  function scen(workloads, hours) { return { durationHours: hours || 3, daemonset: DS, workloads }; }
  function wl(name, shape, o) { return Object.assign({ name, cpu: 500, mem: 1024, shape, pdb: null, doNotDisrupt: false }, o); }
  const last = (r) => r.samples[r.samples.length - 1];

  // Runs a sim and checks capacity invariants on every tick.
  function runChecked(cfg, sc) {
    const s = new Sim(cfg, sc);
    const origTick = s.tick.bind(s);
    s.tick = function () {
      origTick();
      for (const n of s.live) {
        assert(n.cpu <= n.type.allocCpu + 1e-9, `${n.name} cpu overcommitted at t=${s.t}`);
        assert(n.mem <= n.type.allocMem + 1e-9, `${n.name} mem overcommitted at t=${s.t}`);
        assert(n.pods.size <= n.type.podSlots, `${n.name} too many pods at t=${s.t}`);
        let cpu = 0;
        for (const id of n.pods) cpu += s.pods.get(id).cpu;
        assert(cpu === n.cpu, `${n.name} cpu accounting drift at t=${s.t}`);
      }
      let notRunning = 0;
      for (const w of s.wls) {
        let running = 0;
        for (const id of w.pods) if (s.pods.get(id).state === 'running') running++; else notRunning++;
        assert(running === w.running, `${w.name} running counter drift at t=${s.t}`);
      }
      assert(notRunning === s.notRunning, `notRunning counter drift at t=${s.t}`);
      assert([...s.pods.values()].filter((p) => p.state === 'pending').length === s.pendingSet.size, `pendingSet drift at t=${s.t}`);
    };
    return s.run();
  }

  out('engine tests');

  test('parseDuration', () => {
    assert(parseDuration('30s') === 30);
    assert(parseDuration('5m') === 300);
    assert(parseDuration('1h30m') === 5400);
    assert(parseDuration('0s') === 0);
    assert(parseDuration('Never') === null);
    let threw = false;
    try { parseDuration('5 minutes'); } catch (e) { threw = true; }
    assert(threw, 'should reject invalid duration');
  });

  test('provisions enough capacity for pending pods', () => {
    const r = runChecked(pool(), scen([wl('a', { type: 'steady', replicas: 40 })], 1));
    assert(last(r).pending === 0, 'pods still pending');
    assert(last(r).nodes > 0);
  });

  test('WhenEmpty removes nodes after scale to zero', () => {
    const r = runChecked(pool({ consolidationPolicy: 'WhenEmpty' }), scen([wl('a', { type: 'step', from: 40, to: 0, atHour: 1 })], 2));
    assert(last(r).nodes === 0, 'expected 0 nodes, got ' + last(r).nodes);
    assert(r.summary.commands.Emptiness > 0);
    assert(r.summary.commands.MultiNodeConsolidation === 0 && r.summary.commands.SingleNodeConsolidation === 0);
  });

  test('WhenEmptyOrUnderutilized beats WhenEmpty after partial scale-down', () => {
    const sc = scen([wl('a', { type: 'step', from: 80, to: 12, atHour: 1 })], 4);
    const empty = runChecked(pool({ consolidationPolicy: 'WhenEmpty', families: ['m5'], schedulerScoring: 'LeastAllocated' }), sc);
    const under = runChecked(pool({ families: ['m5'] }), sc);
    assert(under.summary.totalCost < empty.summary.totalCost, `under ${under.summary.totalCost} >= empty ${empty.summary.totalCost}`);
    assert(last(under).costHr < last(empty).costHr);
    assert(under.summary.evictions > 0, 'underutilized consolidation should evict pods');
  });

  test('consolidateAfter Never disables disruption', () => {
    const r = runChecked(pool({ consolidateAfter: null }), scen([wl('a', { type: 'step', from: 40, to: 0, atHour: 1 })], 2));
    assert(r.summary.totalCommands === 0);
    assert(last(r).nodes > 0);
  });

  test('budget nodes: 0 blocks all disruption', () => {
    const r = runChecked(pool({ budgets: [{ nodes: '0' }] }), scen([wl('a', { type: 'step', from: 40, to: 0, atHour: 1 })], 2));
    assert(r.summary.totalCommands === 0);
    assert(r.log.some((l) => l.kind === 'budget'), 'should log budget block');
  });

  test('budget scoped to Underutilized still allows Empty', () => {
    const r = runChecked(pool({ budgets: [{ nodes: '0', reasons: ['Underutilized'] }] }), scen([wl('a', { type: 'step', from: 40, to: 0, atHour: 1 })], 2));
    assert(r.summary.commands.Emptiness > 0);
    assert(r.summary.commands.MultiNodeConsolidation === 0 && r.summary.commands.SingleNodeConsolidation === 0);
  });

  test('scheduled budget only blocks inside its window', () => {
    // Block everything from 00:00-02:00; scale-down at hour 1 must wait until 02:00.
    const cfg = pool({ budgets: [{ nodes: '100%' }, { nodes: '0', schedule: { startHour: 0, durationHours: 2 } }] });
    const r = runChecked(cfg, scen([wl('a', { type: 'step', from: 40, to: 0, atHour: 1 })], 3));
    const disrupts = r.log.filter((l) => l.kind === 'disrupt');
    assert(disrupts.length > 0);
    assert(disrupts.every((l) => l.t >= 7200), 'disrupted inside blocked window');
  });

  test('do-not-disrupt pod pins its node', () => {
    const sc = scen([
      wl('keep', { type: 'steady', replicas: 1 }, { doNotDisrupt: true, cpu: 100, mem: 128 }),
      wl('a', { type: 'step', from: 30, to: 0, atHour: 1 }),
    ], 3);
    const r = runChecked(pool(), sc);
    assert(last(r).nodes >= 1, 'node with do-not-disrupt pod was removed');
    assert(r.log.some((l) => l.kind === 'blocked' && /do-not-disrupt/.test(l.msg)));
  });

  test('PDB allowing 0 disruptions blocks consolidation', () => {
    const sc = scen([
      wl('zk', { type: 'steady', replicas: 3 }, { pdb: { minAvailable: 3 } }),
      wl('a', { type: 'step', from: 30, to: 0, atHour: 1 }),
    ], 3);
    const r = runChecked(pool(), sc);
    assert(r.log.some((l) => l.kind === 'blocked' && /pdb zk/.test(l.msg)));
  });

  test('replaces a lone pod on a big node with a cheaper node', () => {
    // 30 pods land on a large node; scale to 1 -> should end on the cheapest type that fits.
    const r = runChecked(pool({ families: ['m5'], budgets: [{ nodes: '100%' }] }), scen([wl('a', { type: 'step', from: 30, to: 1, atHour: 1 })], 3));
    const liveNodes = r.nodes.filter((n) => n.terminatedAt === null);
    assert(liveNodes.length === 1, 'expected 1 node, got ' + liveNodes.length);
    assert(liveNodes[0].type === 'm5.large', 'expected m5.large, got ' + liveNodes[0].type);
  });

  test('every pod keeps running after consolidation settles', () => {
    const r = runChecked(pool(), scen([wl('a', { type: 'step', from: 60, to: 20, atHour: 1 })], 3));
    assert(last(r).pending === 0, 'pending pods at end: ' + last(r).pending);
  });

  test('onlyIn limits a workload to one side', () => {
    const sc = scen([wl('both', { type: 'steady', replicas: 2 }), wl('bonly', { type: 'steady', replicas: 2 }, { onlyIn: 'b' })], 1);
    const a = new Sim(pool({ side: 'a' }), sc), b = new Sim(pool({ side: 'b' }), sc);
    assert(a.wls.length === 1 && b.wls.length === 2);
  });

  test('blockers preset: pinned nodes cost more', () => {
    const p = KSimPresets.find((x) => x.id === 'blockers');
    const a = simulate(Object.assign({ side: 'a' }, p.a), p.scenario);
    const b = simulate(Object.assign({ side: 'b' }, p.b), p.scenario);
    assert(last(b).costHr > last(a).costHr * 1.5, `a ${last(a).costHr} b ${last(b).costHr}`);
  });

  test('expireAfter drains old nodes without respecting budgets', () => {
    const r = runChecked(pool({ expireAfter: '1h', budgets: [{ nodes: '0' }] }), scen([wl('a', { type: 'steady', replicas: 10 })], 2));
    assert(r.summary.nodesExpired > 0, 'no nodes expired');
    assert(r.nodes.some((n) => n.endReason === 'Expired' && n.terminatedAt !== null));
    assert(last(r).pending === 0);
  });

  test('terminationGracePeriod force-deletes do-not-disrupt pods', () => {
    const sc = scen([wl('job', { type: 'steady', replicas: 1 }, { doNotDisrupt: true })], 4);
    const held = runChecked(pool({ expireAfter: '1h' }), sc);
    const forced = runChecked(pool({ expireAfter: '1h', terminationGracePeriod: '30m' }), sc);
    const n1 = held.nodes.find((n) => n.id === 1), n2 = forced.nodes.find((n) => n.id === 1);
    assert(n1.terminatedAt === null, 'without TGP the node should drain forever');
    assert(n2.terminatedAt !== null && n2.terminatedAt >= 3600 + 1800, 'with TGP the node ends after the grace period');
  });

  test('expiry preset: in-flight deletions starve the Empty budget', () => {
    const p = KSimPresets.find((x) => x.id === 'expiry-budget');
    const a = simulate(Object.assign({ side: 'a' }, p.a), p.scenario);
    const b = simulate(Object.assign({ side: 'b' }, p.b), p.scenario);
    assert(a.log.some((l) => l.kind === 'budget' && /already being deleted/.test(l.msg)), 'A should log the silent budget block');
    assert(b.summary.commands.Emptiness > a.summary.commands.Emptiness);
    assert(b.summary.totalCost < a.summary.totalCost);
  });

  test('deterministic', () => {
    const p = KSimPresets[0];
    const a = simulate(p.b, p.scenario), b = simulate(p.b, p.scenario);
    assert(a.summary.totalCost === b.summary.totalCost && a.log.length === b.log.length);
  });

  test('all presets run fast and stay consistent', () => {
    for (const p of KSimPresets) {
      for (const side of ['a', 'b']) {
        const t0 = Date.now();
        const r = runChecked(Object.assign({ side }, p[side]), p.scenario);
        const ms = Date.now() - t0;
        out(`       ${p.id}: $${r.summary.totalCost.toFixed(2)}, ${r.summary.totalCommands} cmds, ${r.summary.evictions} evictions, ${ms}ms`);
        assert(ms < 5000, p.id + ' too slow: ' + ms + 'ms');
      }
    }
  });

  out(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error('tests failed');
})();
