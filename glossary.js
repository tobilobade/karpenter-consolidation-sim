/* Plain-language glossary shown in the sidebar. `id` is referenced by data-term="..." buttons. */
(function (root) {
  'use strict';

  root.KSimGlossary = [
    {
      group: 'The basics',
      terms: [
        {
          id: 'karpenter', term: 'Karpenter',
          body: 'A tool that adds servers when your apps need more room, and removes servers when they\'re not needed.',
        },
        {
          id: 'node', term: 'Node',
          body: 'One server. You pay for it every hour, even if it\'s almost empty.',
        },
        {
          id: 'pod', term: 'Pod',
          body: 'One copy of your app. Pods live on nodes.',
        },
        {
          id: 'nodepool', term: 'NodePool',
          body: 'Your settings for Karpenter: which servers it can buy, and when it can remove them. Config A and Config B are two versions of these settings.',
        },
        {
          id: 'requests', term: 'CPU (m) and Mem (Mi)',
          body: 'How much space each pod reserves on a node. 1000m = 1 CPU, so 250m is a quarter of a CPU. 1024Mi is about 1 GB of memory.',
          example: 'Karpenter looks at what pods <b>reserve</b>, not what they actually use.',
        },
        {
          id: 'pending', term: 'Pending pod',
          body: 'A pod that is waiting because there\'s no room for it yet. This makes Karpenter add a node.',
        },
      ],
    },
    {
      group: 'Settings',
      terms: [
        {
          id: 'consolidation', term: 'Consolidation',
          body: 'Saving money by moving pods onto fewer servers, then switching off the extra ones.',
          example: 'Like moving items from 5 half-full boxes into 2 full boxes and throwing away 3 boxes.',
        },
        {
          id: 'whenEmpty', term: 'WhenEmpty',
          body: 'Only remove a server when it has <b>no</b> pods left. Karpenter never moves your pods. It\'s safe, but you can end up paying for lots of half-empty servers.',
          example: '10 servers with 2 pods each: nothing gets removed.',
        },
        {
          id: 'whenUnderutilized', term: 'WhenEmptyOrUnderutilized',
          body: 'Remove empty servers, <b>and</b> move pods around to free up half-empty ones. It saves more money, but your pods get restarted when they move.',
          example: '10 servers with 2 pods each: pods are packed onto about 2 servers and the other 8 are removed.',
        },
        {
          id: 'underutilized', term: 'Underutilized',
          body: 'A server whose pods could fit somewhere else, or on a cheaper server. Removing it saves money.',
        },
        {
          id: 'consolidateAfter', term: 'consolidateAfter',
          body: 'How long to wait after pods change on a server before Karpenter may clean it up.',
          example: '<b>0s</b> cleans up right away (can cause a lot of moving). <b>10m</b> waits 10 quiet minutes. <b>Never</b> turns cleanup off.',
        },
        {
          id: 'budgets', term: 'Disruption budget',
          body: 'A speed limit: how many servers Karpenter may remove at the same time.',
          example: '<b>10%</b> means 1 in 10 servers at a time. <b>0</b> means don\'t remove any.',
        },
        {
          id: 'reasons', term: 'Budget reasons',
          body: 'Choose what the speed limit applies to. <b>Empty</b> covers removing empty servers. <b>Underutilized</b> covers moving pods to save money. If nothing is ticked, it applies to both.',
        },
        {
          id: 'schedule', term: 'Scheduled budget',
          body: 'A speed limit that only applies at certain hours.',
          example: 'Budget 0 from 09:00 for 8h means "don\'t move my pods during work hours".',
        },
        {
          id: 'instanceReqs', term: 'Instance family and size',
          body: 'Which server types Karpenter may buy. <b>c5</b> = more CPU, <b>m5</b> = balanced, <b>r5</b> = more memory. <b>large</b> is small (2 CPUs), and each step up doubles it, up to <b>8xlarge</b> (32 CPUs). Karpenter picks the cheapest one that fits.',
        },
        {
          id: 'scoring', term: 'Scheduler scoring',
          body: 'Where Kubernetes puts a new pod. <b>LeastAllocated</b> (the default) puts it on the emptiest server, so pods spread out. <b>MostAllocated</b> puts it on the fullest server that has room, so pods pack together and it\'s easier to free up servers.',
        },
      ],
    },
    {
      group: 'Words in the log',
      terms: [
        {
          id: 'methods', term: 'Emptiness / Multi-node / Single-node',
          body: 'The three ways Karpenter looks for savings, in order. <b>Emptiness</b> removes empty servers. <b>Multi-node</b> asks "can I swap several servers for one?". <b>Single-node</b> asks "can I remove or shrink this one server?".',
        },
        {
          id: 'deleteReplace', term: 'Delete vs Replace',
          body: '<b>Delete</b>: the pods fit on other servers, so this one is switched off. <b>Replace</b>: a smaller, cheaper server is started first, the pods move there, then the old one is switched off.',
        },
        {
          id: 'validation', term: 'Abandoned',
          body: 'Karpenter waits 15 seconds to double-check before acting. If things changed in that time, it cancels the plan and tries again later.',
        },
        {
          id: 'eviction', term: 'Eviction',
          body: 'A pod being kicked off a server that\'s being removed. A new copy starts on another server. Each eviction is a restart for your app.',
        },
        {
          id: 'pdb', term: 'PDB (PodDisruptionBudget)',
          body: 'Your app\'s rule for how many of its pods can be down at once. <b>maxUnavailable: 2</b> means at most 2 down. <b>minAvailable: 3</b> means at least 3 must stay up.',
          example: 'If the rule says no pod can go down, Karpenter can\'t touch servers running that app.',
        },
        {
          id: 'doNotDisrupt', term: 'do-not-disrupt',
          body: 'A label on a pod that says "don\'t remove my server". Good for long jobs that can\'t restart. But that server stays, even if it\'s nearly empty.',
        },
        {
          id: 'blocked', term: 'Blocked',
          body: 'Karpenter wanted to remove a server but wasn\'t allowed to, because of a do-not-disrupt pod, a PDB, or a budget of 0.',
        },
      ],
    },
    {
      group: 'Results',
      terms: [
        {
          id: 'allocatable', term: 'Allocatable',
          body: 'The part of a server your pods can actually use. Some space is kept for the system.',
        },
        {
          id: 'daemonset', term: 'DaemonSet overhead',
          body: 'Small helper pods that run on <b>every</b> server, like networking and logging. They take a bit of space on each one.',
        },
        {
          id: 'utilization', term: 'CPU requested / allocatable',
          body: 'How full the servers are. Higher means less waste.',
        },
        {
          id: 'pendingMinutes', term: 'Pod-minutes pending',
          body: 'Total time pods spent waiting to run. 10 pods waiting 1 minute each = 10 pod-minutes. Lower is better for your app.',
        },
        {
          id: 'shapes', term: 'Replicas over time',
          body: 'How many pods the app wants during the day. <b>Steady</b>: always the same. <b>Daily cycle</b>: busy by day, quiet at night. <b>Spikes</b>: short bursts. <b>Step change</b>: a sudden jump up or down.',
        },
        {
          id: 'runsIn', term: 'Runs in',
          body: 'Run a workload in only A or only B, to test "what if I add this?".',
        },
      ],
    },
  ];
})(window);
