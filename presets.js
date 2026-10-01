/* Scenario presets: a shared workload plus two NodePool configs (A vs B) to compare. */
(function (root) {
  'use strict';

  const ALL = ['c5', 'm5', 'r5'];
  const DS = { cpu: 150, mem: 200, pods: 3 };

  function pool(overrides) {
    return Object.assign({
      consolidationPolicy: 'WhenEmptyOrUnderutilized',
      consolidateAfter: '1m',
      budgets: [{ nodes: '10%', reasons: [], schedule: null }],
      families: ALL.slice(),
      sizes: ['large', 'xlarge', '2xlarge'],
      schedulerScoring: 'LeastAllocated',
      expireAfter: '720h',
      terminationGracePeriod: '',
    }, overrides);
  }

  root.KSimPresets = [
    {
      id: 'daily',
      name: 'Daily traffic cycle: WhenEmpty vs WhenEmptyOrUnderutilized',
      description: 'Traffic peaks mid-afternoon and falls overnight. With WhenEmpty, nodes only go away when every pod has left them, which rarely happens once pods are spread out. WhenEmptyOrUnderutilized repacks pods onto fewer, cheaper nodes.',
      scenario: {
        durationHours: 24,
        daemonset: DS,
        workloads: [
          { name: 'web', cpu: 250, mem: 512, shape: { type: 'daily', min: 8, max: 60, peakHour: 14 }, pdb: { maxUnavailable: 2 }, doNotDisrupt: false },
          { name: 'worker', cpu: 500, mem: 1024, shape: { type: 'daily', min: 4, max: 24, peakHour: 15 }, pdb: null, doNotDisrupt: false },
        ],
      },
      a: pool({ consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s' }),
      b: pool({ consolidationPolicy: 'WhenEmptyOrUnderutilized', consolidateAfter: '1m' }),
    },
    {
      id: 'spiky',
      name: 'Spiky load: consolidateAfter 0s vs 20m',
      description: 'A burst every 30 minutes. With consolidateAfter: 0s, Karpenter consolidates between bursts and relaunches on the next one, causing constant evictions and pending pods. A longer consolidateAfter trades a little cost for stability.',
      scenario: {
        durationHours: 6,
        daemonset: DS,
        workloads: [
          { name: 'api', cpu: 500, mem: 1024, shape: { type: 'spiky', base: 10, peak: 50, everyMin: 30, forMin: 10 }, pdb: { maxUnavailable: 5 }, doNotDisrupt: false },
        ],
      },
      a: pool({ consolidateAfter: '0s' }),
      b: pool({ consolidateAfter: '20m' }),
    },
    {
      id: 'budget-window',
      name: 'Business-hours budget freeze',
      description: 'B adds a budget of nodes: 0 for Underutilized from 09:00 to 17:00, so consolidation pauses during business hours. Empty nodes can still be removed. Watch the savings pile up after 17:00.',
      scenario: {
        durationHours: 24,
        daemonset: DS,
        workloads: [
          { name: 'web', cpu: 250, mem: 512, shape: { type: 'daily', min: 10, max: 70, peakHour: 11 }, pdb: { maxUnavailable: 3 }, doNotDisrupt: false },
        ],
      },
      a: pool(),
      b: pool({
        budgets: [
          { nodes: '10%', reasons: [], schedule: null },
          { nodes: '0', reasons: ['Underutilized'], schedule: { startHour: 9, durationHours: 8 } },
        ],
      }),
    },
    {
      id: 'scale-down',
      name: 'Big scale-down: budget 10% vs 50%',
      description: 'A batch finishes at hour 1 and replicas drop from 120 to 15, leaving capacity stranded. The disruption budget caps how many nodes can be disrupted at once, so it controls how fast cost comes down.',
      scenario: {
        durationHours: 4,
        daemonset: DS,
        workloads: [
          { name: 'batch', cpu: 1000, mem: 2048, shape: { type: 'step', from: 120, to: 15, atHour: 1 }, pdb: null, doNotDisrupt: false },
        ],
      },
      a: pool({ families: ['m5'], sizes: ['xlarge'], budgets: [{ nodes: '10%', reasons: [], schedule: null }] }),
      b: pool({ families: ['m5'], sizes: ['xlarge'], budgets: [{ nodes: '50%', reasons: [], schedule: null }] }),
    },
    {
      id: 'blockers',
      name: 'Blockers: do-not-disrupt pods and a strict PDB',
      description: 'Same workloads on both sides. In B, ml-job pods carry karpenter.sh/do-not-disrupt and zookeeper has a PDB with minAvailable = replicas (0 disruptions allowed). They arrive while traffic is falling, and LeastAllocated scheduling spreads them onto different nodes. Those nodes are then pinned, so cost stays high after the load drops. Look for "can\'t be disrupted" in the log.',
      scenario: {
        durationHours: 12,
        daemonset: DS,
        workloads: [
          { name: 'web', cpu: 250, mem: 512, shape: { type: 'daily', min: 10, max: 80, peakHour: 0 }, pdb: { maxUnavailable: 2 }, doNotDisrupt: false },
          { name: 'ml-job', cpu: 200, mem: 256, shape: { type: 'step', from: 0, to: 6, atHour: 2 }, pdb: null, doNotDisrupt: false, onlyIn: 'a' },
          { name: 'zookeeper', cpu: 500, mem: 1024, shape: { type: 'step', from: 0, to: 3, atHour: 2 }, pdb: { maxUnavailable: 1 }, doNotDisrupt: false, onlyIn: 'a' },
          { name: 'ml-job', cpu: 200, mem: 256, shape: { type: 'step', from: 0, to: 6, atHour: 2 }, pdb: null, doNotDisrupt: true, onlyIn: 'b' },
          { name: 'zookeeper', cpu: 500, mem: 1024, shape: { type: 'step', from: 0, to: 3, atHour: 2 }, pdb: { minAvailable: 3 }, doNotDisrupt: false, onlyIn: 'b' },
        ],
      },
      a: pool(),
      b: pool(),
    },
    {
      id: 'expiry-budget',
      name: 'Expiring servers use up the Empty budget',
      description: 'Servers reach their expireAfter age at hour 4. Six of them run do-not-disrupt jobs, so they stay in "shutting down" until terminationGracePeriod runs out at hour 10. Those six count against the Empty budget. When a batch job finishes at hour 6 and leaves six servers empty, A (Empty budget 30%) has nothing left to spend, so the empty servers stay up, and real Karpenter logs nothing about it. B (Empty budget 100%) removes them straight away. Empty servers run no apps, so 100% is safe.',
      scenario: {
        durationHours: 12,
        daemonset: DS,
        workloads: [
          { name: 'web', cpu: 500, mem: 1024, shape: { type: 'steady', replicas: 30 }, pdb: null, doNotDisrupt: false },
          { name: 'ray-head', cpu: 2000, mem: 4096, shape: { type: 'steady', replicas: 6 }, pdb: null, doNotDisrupt: true },
          { name: 'batch', cpu: 1700, mem: 2048, shape: { type: 'step', from: 12, to: 0, atHour: 6 }, pdb: null, doNotDisrupt: false },
        ],
      },
      a: pool({
        consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s', sizes: ['large', 'xlarge'], expireAfter: '4h', terminationGracePeriod: '6h',
        budgets: [{ nodes: '30%', reasons: ['Empty'], schedule: null }, { nodes: '0', reasons: ['Underutilized'], schedule: null }],
      }),
      b: pool({
        consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s', sizes: ['large', 'xlarge'], expireAfter: '4h', terminationGracePeriod: '6h',
        budgets: [{ nodes: '100%', reasons: ['Empty'], schedule: null }, { nodes: '0', reasons: ['Underutilized'], schedule: null }],
      }),
    },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
