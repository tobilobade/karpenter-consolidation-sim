/*
 * Karpenter consolidation simulator — engine.
 *
 * A discrete-time model of Karpenter v1 provisioning + consolidation on a single
 * NodePool. Pure logic, no DOM: runs in the browser and under `jsc` for tests.
 *
 * Each tick (10s, roughly Karpenter's disruption poll interval):
 *   1. workloads reconcile to their desired replica count
 *   2. launching nodes become Ready; finished replacements start draining candidates
 *   3. kube-scheduler binds pending pods; Karpenter provisions nodes for the rest
 *   4. draining nodes evict pods (respecting PDBs), terminate when empty
 *   5. the disruption controller validates / computes one consolidation command
 *   6. cost and metrics are accounted
 */
(function (root) {
  'use strict';

  const STEP = 10;               // seconds per tick
  const NODE_STARTUP = 60;       // launch -> Ready
  const VALIDATION_DELAY = 15;   // Karpenter re-validates consolidation commands after 15s
  const REEVALUATE_AFTER = 300;  // re-run disruption even if cluster state hasn't changed
  const MULTI_NODE_MAX = 100;    // multi-node consolidation considers at most 100 candidates
  const SAMPLE_EVERY = 60;
  const VM_MEMORY_OVERHEAD = 0.075; // Karpenter's default vmMemoryOverheadPercent
  const MAX_LOG = 20000;
  const NOTE_COOLDOWN = 1800;

  // us-east-1 on-demand prices (approximate, $/hr).
  const CATALOG = [
    { name: 'c5.large', family: 'c5', cpu: 2, mem: 4, price: 0.085 },
    { name: 'c5.xlarge', family: 'c5', cpu: 4, mem: 8, price: 0.17 },
    { name: 'c5.2xlarge', family: 'c5', cpu: 8, mem: 16, price: 0.34 },
    { name: 'c5.4xlarge', family: 'c5', cpu: 16, mem: 32, price: 0.68 },
    { name: 'm5.large', family: 'm5', cpu: 2, mem: 8, price: 0.096 },
    { name: 'm5.xlarge', family: 'm5', cpu: 4, mem: 16, price: 0.192 },
    { name: 'm5.2xlarge', family: 'm5', cpu: 8, mem: 32, price: 0.384 },
    { name: 'm5.4xlarge', family: 'm5', cpu: 16, mem: 64, price: 0.768 },
    { name: 'm5.8xlarge', family: 'm5', cpu: 32, mem: 128, price: 1.536 },
    { name: 'r5.large', family: 'r5', cpu: 2, mem: 16, price: 0.126 },
    { name: 'r5.xlarge', family: 'r5', cpu: 4, mem: 32, price: 0.252 },
    { name: 'r5.2xlarge', family: 'r5', cpu: 8, mem: 64, price: 0.504 },
    { name: 'r5.4xlarge', family: 'r5', cpu: 16, mem: 128, price: 1.008 },
  ];

  // ENI-based max pods for these families.
  function maxPodsFor(cores) { return cores <= 2 ? 29 : cores <= 8 ? 58 : 234; }

  // EKS kube-reserved CPU: 6% of 1st core, 1% of 2nd, 0.5% of cores 3-4, 0.25% above.
  function kubeReservedCpu(cores) {
    let m = 60;
    if (cores > 1) m += 10;
    if (cores > 2) m += 5 * Math.min(cores - 2, 2);
    if (cores > 4) m += 2.5 * (cores - 4);
    return m;
  }

  const SIZES = ['large', 'xlarge', '2xlarge', '4xlarge', '8xlarge'];

  // families / sizes mirror karpenter.k8s.aws/instance-family and instance-size requirements.
  function buildInstanceTypes(families, sizes, ds) {
    const sizeOf = (t) => t.name.split('.')[1];
    return CATALOG.filter((t) => families.includes(t.family) && (!sizes || !sizes.length || sizes.includes(sizeOf(t)))).map((t) => {
      const maxPods = maxPodsFor(t.cpu);
      const memMi = Math.floor(t.mem * 1024 * (1 - VM_MEMORY_OVERHEAD)) - (255 + 11 * maxPods) - 100;
      return Object.assign({}, t, {
        maxPods,
        allocCpu: t.cpu * 1000 - kubeReservedCpu(t.cpu) - ds.cpu,
        allocMem: memMi - ds.mem,
        podSlots: maxPods - ds.pods,
      });
    }).sort((a, b) => a.price - b.price || a.cpu - b.cpu);
  }

  function desiredReplicas(shape, t) {
    const h = t / 3600;
    switch (shape.type) {
      case 'steady': return shape.replicas;
      case 'daily': {
        const f = (1 + Math.cos((2 * Math.PI * (h - shape.peakHour)) / 24)) / 2;
        return Math.round(shape.min + (shape.max - shape.min) * f);
      }
      case 'spiky': {
        const m = t / 60;
        return m % shape.everyMin < shape.forMin ? shape.peak : shape.base;
      }
      case 'step': return h < shape.atHour ? shape.from : shape.to;
      default: throw new Error('unknown shape ' + shape.type);
    }
  }

  // "30s", "5m", "1h30m", "0s", "Never" -> seconds | null
  function parseDuration(s) {
    s = String(s).trim();
    if (/^never$/i.test(s)) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
    let total = 0, matched = '', m;
    while ((m = re.exec(s))) {
      total += parseFloat(m[1]) * { h: 3600, m: 60, s: 1 }[m[2]];
      matched += m[0];
    }
    if (!matched || matched !== s) throw new Error('invalid duration "' + s + '"');
    return total;
  }

  // Like parseDuration, but empty / missing means "not set".
  function optionalDuration(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return v;
    return String(v).trim() === '' ? null : parseDuration(v);
  }

  // Karpenter scales percentages against the NodePool's node count, rounding up.
  function budgetValue(nodes, total) {
    const s = String(nodes).trim();
    if (s.endsWith('%')) return Math.ceil((total * parseFloat(s)) / 100);
    return parseInt(s, 10);
  }

  function inWindow(schedule, t) {
    if (!schedule) return true;
    const h = (t / 3600) % 24;
    const start = schedule.startHour, end = schedule.startHour + schedule.durationHours;
    return (h >= start && h < end) || (h + 24 >= start && h + 24 < end);
  }

  function tgpClock(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function bySizeDesc(a, b) { return b.cpu - a.cpu || b.mem - a.mem || a.id - b.id; }

  function fmtMoney(x) { return '$' + x.toFixed(3); }

  // ---------------------------------------------------------------------------

  function Sim(config, scenario) {
    this.cfg = Object.assign({}, config, {
      consolidateAfter: typeof config.consolidateAfter === 'string' ? parseDuration(config.consolidateAfter) : config.consolidateAfter,
      expireAfter: optionalDuration(config.expireAfter),
      terminationGracePeriod: optionalDuration(config.terminationGracePeriod),
    });
    config = this.cfg;
    this.sc = scenario;
    this.types = buildInstanceTypes(config.families, config.sizes, scenario.daemonset);
    if (!this.types.length) throw new Error('NodePool requirements match no instance types');
    this.typeByName = new Map(this.types.map((t) => [t.name, t]));
    this.t = 0;
    this.nodes = [];
    this.live = [];
    this.nodeById = new Map();
    this.pods = new Map();
    this.wls = scenario.workloads
      .filter((w) => !w.onlyIn || !config.side || w.onlyIn === config.side)
      .map((w, i) => Object.assign({}, w, { idx: i, pods: new Set(), running: 0 }));
    this.pendingSet = new Set();
    this.notRunning = 0;
    this.nextPodId = 1;
    this.nextNodeId = 1;
    this.version = 0;
    this.lastEvalVersion = -1;
    this.lastEvalTime = -Infinity;
    this.pendingCmd = null;
    this.replacements = [];
    this.log = [];
    this.samples = [];
    this.notes = new Map();
    this.budgetSig = '';
    this.stats = {
      cost: 0, evictions: 0, pendingPodSeconds: 0, nodesLaunched: 0, nodesDisrupted: 0, nodesExpired: 0, abandoned: 0,
      commands: { Emptiness: 0, MultiNodeConsolidation: 0, SingleNodeConsolidation: 0 },
    };
  }

  Sim.prototype.emit = function (kind, msg) {
    if (this.log.length < MAX_LOG) this.log.push({ t: this.t, kind, msg });
  };

  // Log a recurring condition (e.g. a blocked node) at most once per NOTE_COOLDOWN for the same message.
  Sim.prototype.note = function (key, kind, msg) {
    if (!msg) return;
    const prev = this.notes.get(key);
    if (prev && prev.msg === msg && this.t - prev.t < NOTE_COOLDOWN) return;
    this.notes.set(key, { msg, t: this.t });
    this.emit(kind, msg);
  };

  Sim.prototype.run = function () {
    const end = this.sc.durationHours * 3600;
    if (this.cfg.consolidateAfter === null) this.emit('info', 'consolidateAfter: Never — consolidation disabled');
    for (this.t = 0; this.t <= end; this.t += STEP) this.tick();
    return this.result();
  };

  Sim.prototype.tick = function () {
    this.reconcileWorkloads();
    this.progressNodes();
    this.expire();
    this.schedule();
    this.drain();
    this.disrupt();
    this.account();
  };

  // --- pods -------------------------------------------------------------------

  Sim.prototype.createPod = function (wl) {
    const p = { id: this.nextPodId++, wl: wl.idx, cpu: wl.cpu, mem: wl.mem, node: null, state: 'pending', created: this.t };
    this.pods.set(p.id, p);
    wl.pods.add(p.id);
    this.pendingSet.add(p);
    this.notRunning++;
    this.version++;
  };

  Sim.prototype.deletePod = function (p) {
    if (p.node !== null) this.unbind(p);
    if (p.state === 'running') this.wls[p.wl].running--; else this.notRunning--;
    this.pendingSet.delete(p);
    this.pods.delete(p.id);
    this.wls[p.wl].pods.delete(p.id);
    this.version++;
  };

  // All pod state changes go through here so the running / pending counters stay exact.
  Sim.prototype.setState = function (p, state) {
    const wl = this.wls[p.wl];
    if (p.state === 'running') wl.running--; else this.notRunning--;
    if (p.state === 'pending') this.pendingSet.delete(p);
    p.state = state;
    if (state === 'running') wl.running++; else this.notRunning++;
    if (state === 'pending') this.pendingSet.add(p);
  };

  Sim.prototype.bind = function (p, n, state) {
    p.node = n.id;
    this.setState(p, state);
    n.pods.add(p.id);
    n.cpu += p.cpu;
    n.mem += p.mem;
    n.lastPodEvent = this.t;
    this.version++;
  };

  Sim.prototype.unbind = function (p) {
    const n = this.nodeById.get(p.node);
    n.pods.delete(p.id);
    n.cpu -= p.cpu;
    n.mem -= p.mem;
    n.lastPodEvent = this.t;
    p.node = null;
    this.setState(p, 'pending');
  };

  Sim.prototype.reconcileWorkloads = function () {
    for (const wl of this.wls) {
      const desired = Math.max(0, desiredReplicas(wl.shape, this.t));
      const current = wl.pods.size;
      if (desired > current) {
        for (let i = current; i < desired; i++) this.createPod(wl);
      } else if (desired < current) {
        // ReplicaSet scale-down ranking: unscheduled first, then pods on the node with the
        // most replicas of this workload, newest first.
        const k = current - desired;
        const victims = [];
        const byNode = new Map();
        const unscheduled = { pending: [], nominated: [] };
        for (const id of wl.pods) {
          const p = this.pods.get(id);
          if (p.state === 'running') {
            if (!byNode.has(p.node)) byNode.set(p.node, []);
            byNode.get(p.node).push(p); // creation order, so newest is last
          } else unscheduled[p.state].push(p);
        }
        for (const p of unscheduled.pending.reverse().concat(unscheduled.nominated.reverse())) {
          if (victims.length < k) victims.push(p);
        }
        while (victims.length < k) {
          let best = null;
          for (const arr of byNode.values()) if (arr.length && (!best || arr.length > best.length)) best = arr;
          if (!best) break;
          victims.push(best.pop());
        }
        for (const p of victims) this.deletePod(p);
      }
    }
  };

  Sim.prototype.pdbAllowed = function (wl) {
    if (!wl.pdb) return Infinity;
    const healthy = wl.running;
    const desired = desiredReplicas(wl.shape, this.t);
    const minHealthy = wl.pdb.minAvailable != null ? wl.pdb.minAvailable : desired - wl.pdb.maxUnavailable;
    return healthy - minHealthy;
  };

  // --- nodes ------------------------------------------------------------------

  Sim.prototype.launchNode = function (type, origin) {
    const id = this.nextNodeId++;
    const n = {
      id, name: 'node-' + id, type, createdAt: this.t, readyAt: this.t + NODE_STARTUP, terminatedAt: null,
      state: 'launching', pods: new Set(), cpu: 0, mem: 0, lastPodEvent: this.t, origin, endReason: null,
    };
    this.nodes.push(n);
    this.live.push(n);
    this.nodeById.set(id, n);
    this.stats.nodesLaunched++;
    this.version++;
    return n;
  };

  Sim.prototype.terminate = function (n) {
    n.state = 'terminated';
    n.terminatedAt = this.t;
    this.live = this.live.filter((x) => x !== n);
    this.version++;
    this.emit('terminate', `${n.name}/${n.type.name} terminated` + (n.endReason ? ` (${n.endReason})` : ''));
  };

  Sim.prototype.progressNodes = function () {
    for (const n of this.live) {
      if (n.state === 'launching' && this.t >= n.readyAt) {
        n.state = 'ready';
        n.lastPodEvent = this.t;
        for (const id of n.pods) this.setState(this.pods.get(id), 'running');
        this.version++;
      }
    }
    this.replacements = this.replacements.filter((r) => {
      if (r.replacement.state !== 'ready') return true;
      for (const c of r.candidates) this.startDrain(c);
      this.emit('disrupt', `replacement ${r.replacement.name}/${r.replacement.type.name} is ready, draining ${r.candidates.map((c) => c.name).join(', ')}`);
      return false;
    });
  };

  Sim.prototype.startDrain = function (n) {
    n.state = 'draining';
    n.drainStart = this.t;
    this.version++;
  };

  // expireAfter is forceful: it ignores disruption budgets, do-not-disrupt and PDBs when
  // deciding to start, and no replacement is pre-launched. Draining still respects them,
  // up to terminationGracePeriod.
  Sim.prototype.expire = function () {
    const after = this.cfg.expireAfter;
    if (after === null) return;
    for (const n of this.live) {
      if ((n.state !== 'ready' && n.state !== 'launching') || this.t - n.createdAt < after) continue;
      n.endReason = 'Expired';
      this.stats.nodesExpired++;
      this.startDrain(n);
      this.emit('expire', `${n.name}/${n.type.name} reached expireAfter, draining ${n.pods.size} pod(s)`);
    }
  };

  Sim.prototype.fits = function (n, p) {
    return n.type.allocCpu - n.cpu >= p.cpu && n.type.allocMem - n.mem >= p.mem && n.pods.size < n.type.podSlots;
  };

  Sim.prototype.cheapestFitting = function (cpu, mem, count) {
    for (const t of this.types) if (t.allocCpu >= cpu && t.allocMem >= mem && t.podSlots >= count) return t;
    return null;
  };

  // kube-scheduler NodeResourcesFit scoring. LeastAllocated (the default) spreads pods.
  Sim.prototype.pickNode = function (p, nodes) {
    let best = null, bestScore = -Infinity;
    const most = this.cfg.schedulerScoring === 'MostAllocated';
    for (const n of nodes) {
      if (!this.fits(n, p)) continue;
      const free = ((n.type.allocCpu - n.cpu - p.cpu) / n.type.allocCpu + (n.type.allocMem - n.mem - p.mem) / n.type.allocMem) / 2;
      const score = most ? -free : free;
      if (score > bestScore) { best = n; bestScore = score; }
    }
    return best;
  };

  Sim.prototype.schedule = function () {
    if (!this.pendingSet.size) return;
    const pending = [...this.pendingSet];
    pending.sort(bySizeDesc);
    const ready = this.live.filter((n) => n.state === 'ready');
    const inflight = this.live.filter((n) => n.state === 'launching');
    const leftover = [];
    for (const p of pending) {
      const target = this.pickNode(p, ready);
      if (target) { this.bind(p, target, 'running'); continue; }
      const nominated = inflight.find((n) => this.fits(n, p));
      if (nominated) { this.bind(p, nominated, 'nominated'); continue; }
      leftover.push(p);
    }
    if (leftover.length) this.provision(leftover);
  };

  // Karpenter bin-packing: keep adding pods to an in-flight NodeClaim while some allowed
  // instance type still fits them all, then launch the cheapest type that fits.
  Sim.prototype.provision = function (pods) {
    const bins = [];
    for (const p of pods) {
      let bin = bins.find((b) => this.cheapestFitting(b.cpu + p.cpu, b.mem + p.mem, b.pods.length + 1));
      if (!bin) {
        if (!this.cheapestFitting(p.cpu, p.mem, 1)) {
          this.note('unschedulable:' + p.wl, 'warn', `pods of ${this.wls[p.wl].name} don't fit any allowed instance type`);
          continue;
        }
        bin = { cpu: 0, mem: 0, pods: [] };
        bins.push(bin);
      }
      bin.cpu += p.cpu;
      bin.mem += p.mem;
      bin.pods.push(p);
    }
    for (const b of bins) {
      const type = this.cheapestFitting(b.cpu, b.mem, b.pods.length);
      const n = this.launchNode(type, 'provisioning');
      for (const p of b.pods) this.bind(p, n, 'nominated');
      this.emit('provision', `created ${n.name}/${type.name} for ${b.pods.length} pending pod(s)`);
    }
  };

  Sim.prototype.drain = function () {
    for (const n of this.live.slice()) {
      if (n.state !== 'draining') continue;
      const tgp = this.cfg.terminationGracePeriod;
      if (tgp !== null && this.t >= n.drainStart + tgp && n.pods.size) {
        this.emit('terminate', `${n.name}: terminationGracePeriod elapsed, force-deleting ${n.pods.size} remaining pod(s)`);
        for (const id of [...n.pods]) { this.stats.evictions++; this.deletePod(this.pods.get(id)); }
      }
      for (const id of [...n.pods]) {
        const p = this.pods.get(id);
        const wl = this.wls[p.wl];
        if (wl.doNotDisrupt) {
          this.note('drain:' + n.id, 'blocked', `${n.name}: drain waiting on do-not-disrupt pod of ${wl.name}` +
            (tgp !== null ? ` (force-deleted at ${tgpClock(n.drainStart + tgp)})` : ' (no terminationGracePeriod, so it waits forever)'));
          continue;
        }
        if (p.state === 'running' && this.pdbAllowed(wl) <= 0) {
          this.note('drain:' + n.id, 'blocked', `${n.name}: eviction of ${wl.name} pod blocked by PDB, retrying`);
          continue;
        }
        this.stats.evictions++;
        this.deletePod(p);
      }
      if (n.pods.size === 0) this.terminate(n);
    }
  };

  // --- disruption -------------------------------------------------------------

  // Nodes being deleted for ANY reason (consolidation, expiry, ...) use up the budget.
  Sim.prototype.budgetInfo = function (reason) {
    const total = this.live.length;
    let disrupting = 0;
    for (const n of this.live) if (n.state === 'draining' || n.state === 'tainted') disrupting++;
    let configured = Infinity;
    for (const b of this.cfg.budgets) {
      if (b.reasons && b.reasons.length && !b.reasons.includes(reason)) continue;
      if (!inWindow(b.schedule, this.t)) continue;
      configured = Math.min(configured, budgetValue(b.nodes, total));
    }
    const allowed = configured === Infinity ? Infinity : Math.max(0, configured - disrupting);
    return { allowed, configured, disrupting };
  };

  Sim.prototype.allowedDisruptions = function (reason) { return this.budgetInfo(reason).allowed; };

  // Real Karpenter only reports a blocked budget when the configured value is 0, not when
  // in-flight deletions have used it up, so we call that case out explicitly.
  Sim.prototype.budgetMessage = function (reason, waiting, info) {
    if (info.configured === 0) return `${waiting} waiting: disruption budget for ${reason} is set to 0`;
    return `${waiting} waiting: ${reason} budget is ${info.configured} node(s), but ${info.disrupting} node(s) are already ` +
      `being deleted, so 0 are left. Real Karpenter logs nothing here (it only reports budgets set to 0)`;
  };

  Sim.prototype.budgetSignature = function () {
    return this.cfg.budgets.map((b) => (inWindow(b.schedule, this.t) ? 1 : 0)).join('');
  };

  Sim.prototype.candidates = function (logBlocked) {
    const out = [];
    const pdbCache = new Map();
    const pdbAllowed = (wl) => {
      if (!pdbCache.has(wl.idx)) pdbCache.set(wl.idx, this.pdbAllowed(wl));
      return pdbCache.get(wl.idx);
    };
    for (const n of this.live) {
      if (n.state !== 'ready') continue;
      if (this.t < n.lastPodEvent + this.cfg.consolidateAfter) continue;
      const pods = [...n.pods].map((id) => this.pods.get(id));
      let reason = null;
      for (const p of pods) {
        const wl = this.wls[p.wl];
        if (wl.doNotDisrupt) { reason = `pod of ${wl.name} has karpenter.sh/do-not-disrupt annotation`; break; }
        if (wl.pdb && pdbAllowed(wl) <= 0) { reason = `pdb ${wl.name} prevents pod evictions`; break; }
      }
      if (logBlocked) this.note('blocked:' + n.id, 'blocked', reason && `${n.name} can't be disrupted: ${reason}`);
      if (reason) continue;
      out.push({ node: n, pods, price: n.type.price, cost: pods.length });
    }
    // Karpenter orders candidates by disruption cost (roughly: pods to evict).
    out.sort((a, b) => a.cost - b.cost || a.node.id - b.node.id);
    return out;
  };

  // Can the candidates' pods fit on the rest of the cluster plus at most one new, cheaper node?
  // Free capacity on every schedulable node, after pending pods have claimed their share.
  // Built once per evaluation; simulate() works on copies.
  Sim.prototype.snapshotCapacity = function () {
    const nodes = this.live.filter((n) => n.state === 'ready' || n.state === 'launching');
    const cpu = new Float64Array(nodes.length), mem = new Float64Array(nodes.length), slots = new Int32Array(nodes.length);
    const index = new Map();
    nodes.forEach((n, i) => {
      cpu[i] = n.type.allocCpu - n.cpu; mem[i] = n.type.allocMem - n.mem; slots[i] = n.type.podSlots - n.pods.size;
      index.set(n.id, i);
    });
    const pending = [...this.pendingSet].sort(bySizeDesc);
    for (const p of pending) {
      for (let i = 0; i < nodes.length; i++) {
        if (cpu[i] >= p.cpu && mem[i] >= p.mem && slots[i] >= 1) { cpu[i] -= p.cpu; mem[i] -= p.mem; slots[i]--; break; }
      }
    }
    let freeCpu = 0, freeMem = 0;
    for (let i = 0; i < nodes.length; i++) { freeCpu += Math.max(0, cpu[i]); freeMem += Math.max(0, mem[i]); }
    this.cap = { cpu, mem, slots, index, freeCpu, freeMem };
  };

  // Cheap check: even in the best case, can these candidates be deleted or replaced more cheaply?
  Sim.prototype.mightConsolidate = function (c) {
    const cap = this.cap, i = cap.index.get(c.node.id);
    let cpu = 0, mem = 0;
    for (const p of c.pods) { cpu += p.cpu; mem += p.mem; }
    const otherCpu = cap.freeCpu - Math.max(0, cap.cpu[i]), otherMem = cap.freeMem - Math.max(0, cap.mem[i]);
    const restCpu = cpu - otherCpu, restMem = mem - otherMem;
    if (restCpu <= 0 && restMem <= 0) return true;
    const t = this.cheapestFitting(Math.max(0, restCpu), Math.max(0, restMem), 1);
    return !!t && t.price < c.price;
  };

  Sim.prototype.simulate = function (cands) {
    const cap = this.cap;
    const cpu = cap.cpu.slice(), mem = cap.mem.slice(), slots = cap.slots.slice();
    for (const c of cands) { const i = cap.index.get(c.node.id); if (i !== undefined) cpu[i] = -Infinity; }
    const n = cpu.length;
    const take = (p) => {
      for (let i = 0; i < n; i++) {
        if (cpu[i] >= p.cpu && mem[i] >= p.mem && slots[i] >= 1) { cpu[i] -= p.cpu; mem[i] -= p.mem; slots[i]--; return true; }
      }
      return false;
    };

    const pods = [].concat(...cands.map((c) => c.pods)).sort(bySizeDesc);
    const bins = [];
    for (const p of pods) {
      if (take(p)) continue;
      let b = bins.find((b) => this.cheapestFitting(b.cpu + p.cpu, b.mem + p.mem, b.n + 1));
      if (!b) {
        if (!this.cheapestFitting(p.cpu, p.mem, 1)) return { ok: false, why: 'pods cannot be rescheduled' };
        b = { cpu: 0, mem: 0, n: 0 };
        bins.push(b);
      }
      b.cpu += p.cpu; b.mem += p.mem; b.n++;
    }
    const price = cands.reduce((s, c) => s + c.price, 0);
    const candidates = cands.map((c) => c.node.id);
    if (!bins.length) return { ok: true, decision: 'delete', candidates, savings: price };
    if (bins.length > 1) return { ok: false, why: `would need ${bins.length} new nodes` };
    const type = this.cheapestFitting(bins[0].cpu, bins[0].mem, bins[0].n);
    if (type.price >= price) return { ok: false, why: `replacement ${type.name} not cheaper` };
    return { ok: true, decision: 'replace', replacementType: type.name, candidates, savings: price - type.price };
  };

  Sim.prototype.emptiness = function (cands) {
    const empty = cands.filter((c) => c.pods.length === 0);
    if (!empty.length) return null;
    const info = this.budgetInfo('Empty');
    const allowed = info.allowed;
    this.note('budget:Empty', 'budget', allowed <= 0 && this.budgetMessage('Empty', `${empty.length} empty node(s)`, info));
    if (allowed <= 0) return null;
    const chosen = empty.slice(0, allowed);
    return { method: 'Emptiness', decision: 'delete', candidates: chosen.map((c) => c.node.id), savings: chosen.reduce((s, c) => s + c.price, 0) };
  };

  Sim.prototype.multiNode = function (cands) {
    const allowed = this.allowedDisruptions('Underutilized');
    const pool = cands.slice(0, Math.min(allowed, MULTI_NODE_MAX));
    if (pool.length < 2) return null;
    // Binary search for the largest prefix that can be consolidated.
    let lo = 2, hi = pool.length, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.simulate(pool.slice(0, mid));
      if (r.ok) { best = r; lo = mid + 1; } else hi = mid - 1;
    }
    return best && Object.assign({ method: 'MultiNodeConsolidation' }, best);
  };

  Sim.prototype.singleNode = function (cands) {
    const info = this.budgetInfo('Underutilized');
    const allowed = info.allowed;
    this.note('budget:Underutilized', 'budget', allowed <= 0 && cands.length > 0 &&
      this.budgetMessage('Underutilized', `${cands.length} candidate(s)`, info));
    if (allowed <= 0) return null;
    for (const c of cands) {
      if (!this.mightConsolidate(c)) continue;
      const r = this.simulate([c]);
      if (r.ok) return Object.assign({ method: 'SingleNodeConsolidation' }, r);
    }
    return null;
  };

  Sim.prototype.disrupt = function () {
    if (this.cfg.consolidateAfter === null) return;
    if (this.pendingCmd) {
      if (this.t >= this.pendingCmd.validateAt) {
        const cmd = this.pendingCmd;
        this.pendingCmd = null;
        this.validateAndExecute(cmd);
      }
      return;
    }
    for (const n of this.live) {
      const at = n.lastPodEvent + this.cfg.consolidateAfter;
      if (n.state === 'ready' && at > this.t - STEP && at <= this.t) this.version++; // became consolidatable
    }
    const sig = this.budgetSignature();
    if (sig !== this.budgetSig) { this.budgetSig = sig; this.version++; }
    if (this.version === this.lastEvalVersion && this.t - this.lastEvalTime < REEVALUATE_AFTER) return;
    this.lastEvalVersion = this.version;
    this.lastEvalTime = this.t;

    this.snapshotCapacity();
    const cands = this.candidates(true);
    let cmd = this.emptiness(cands);
    if (!cmd && this.cfg.consolidationPolicy === 'WhenEmptyOrUnderutilized') {
      cmd = this.multiNode(cands) || this.singleNode(cands);
    }
    if (cmd) {
      cmd.validateAt = this.t + VALIDATION_DELAY;
      this.pendingCmd = cmd;
    }
  };

  Sim.prototype.validateAndExecute = function (cmd) {
    this.snapshotCapacity();
    const fresh = new Map(this.candidates(false).map((c) => [c.node.id, c]));
    const chosen = cmd.candidates.map((id) => fresh.get(id));
    const abandon = (why) => {
      this.stats.abandoned++;
      this.emit('abandon', `abandoning ${cmd.method} command after validation: ${why}`);
    };
    if (chosen.some((c) => !c)) return abandon('candidate no longer eligible (pods changed or now blocked)');
    const reason = cmd.method === 'Emptiness' ? 'Empty' : 'Underutilized';
    if (chosen.length > this.allowedDisruptions(reason)) return abandon('disruption budget exceeded');
    if (cmd.method === 'Emptiness') {
      if (chosen.some((c) => c.pods.length)) return abandon('node is no longer empty');
    } else {
      const r = this.simulate(chosen);
      if (!r.ok || r.decision !== cmd.decision) return abandon('re-simulation gave a different result' + (r.why ? ` (${r.why})` : ''));
      cmd.replacementType = r.replacementType;
      cmd.savings = r.savings;
    }
    this.execute(cmd, chosen);
  };

  Sim.prototype.execute = function (cmd, chosen) {
    this.stats.commands[cmd.method]++;
    this.stats.nodesDisrupted += chosen.length;
    const podCount = chosen.reduce((s, c) => s + c.pods.length, 0);
    const names = chosen.map((c) => `${c.node.name}/${c.node.type.name}`).join(', ');
    const reason = cmd.method === 'Emptiness' ? 'empty' : 'underutilized';
    const head = `[${cmd.method}] disrupting via ${cmd.decision} (reason: ${reason}), terminating ${chosen.length} node(s) (${podCount} pods) ${names}`;
    for (const c of chosen) c.node.endReason = cmd.method;
    if (cmd.decision === 'delete') {
      for (const c of chosen) this.startDrain(c.node);
      this.emit('disrupt', `${head}, saving ${fmtMoney(cmd.savings)}/hr`);
    } else {
      const replacement = this.launchNode(this.typeByName.get(cmd.replacementType), 'replacement');
      for (const c of chosen) c.node.state = 'tainted';
      this.replacements.push({ replacement, candidates: chosen.map((c) => c.node) });
      this.emit('disrupt', `${head} and replacing with ${replacement.name}/${cmd.replacementType}, saving ${fmtMoney(cmd.savings)}/hr`);
    }
    this.version++;
  };

  // --- metrics ----------------------------------------------------------------

  Sim.prototype.account = function () {
    let price = 0, alloc = 0, req = 0;
    for (const n of this.live) { price += n.type.price; alloc += n.type.allocCpu; req += n.cpu; }
    const pending = this.notRunning;
    this.stats.cost += (price * STEP) / 3600;
    this.stats.pendingPodSeconds += pending * STEP;
    if (this.t % SAMPLE_EVERY === 0) {
      this.samples.push({
        t: this.t, nodes: this.live.length, costHr: price, cost: this.stats.cost,
        util: alloc ? req / alloc : 0, pending, evictions: this.stats.evictions,
      });
    }
  };

  Sim.prototype.result = function () {
    const s = this.samples;
    const withNodes = s.filter((x) => x.nodes > 0);
    const c = this.stats.commands;
    return {
      durationHours: this.sc.durationHours,
      summary: {
        totalCost: this.stats.cost,
        avgNodes: s.reduce((a, x) => a + x.nodes, 0) / s.length,
        peakNodes: Math.max(0, ...s.map((x) => x.nodes)),
        avgUtil: withNodes.length ? withNodes.reduce((a, x) => a + x.util, 0) / withNodes.length : 0,
        evictions: this.stats.evictions,
        podPendingMinutes: this.stats.pendingPodSeconds / 60,
        nodesLaunched: this.stats.nodesLaunched,
        nodesDisrupted: this.stats.nodesDisrupted,
        commands: Object.assign({}, c),
        totalCommands: c.Emptiness + c.MultiNodeConsolidation + c.SingleNodeConsolidation,
        abandoned: this.stats.abandoned,
        nodesExpired: this.stats.nodesExpired,
      },
      samples: s,
      nodes: this.nodes.map((n) => ({
        id: n.id, name: n.name, type: n.type.name, family: n.type.family, price: n.type.price,
        createdAt: n.createdAt, readyAt: n.readyAt, terminatedAt: n.terminatedAt, origin: n.origin, endReason: n.endReason,
      })),
      log: this.log,
    };
  };

  function simulate(config, scenario) { return new Sim(config, scenario).run(); }

  root.KSim = { Sim, simulate, SIZES, desiredReplicas, parseDuration, optionalDuration, buildInstanceTypes, CATALOG, STEP };
})(typeof window !== 'undefined' ? window : globalThis);
