// Prescription rules. Pure functions with no database access, so they can be tested directly.
// Every finding states the evidence it is based on. Thresholds are deliberately simple and visible here.
export const THRESH = {
  rise: 0.2,          // a service that grows by at least 20% is flagged
  riseMinUsd: 5,      // ...but only if the increase is at least $5
  bigRise: 0.5,       // growth of 50% or more is high severity
  unallocated: 0.3,   // more than 30% of AWS spend not linked to any customer
  cpuLow: 15,         // shared server averaging under 15% CPU is over-sized
  cpuHigh: 60,        // averaging over 60% CPU is tight
  storageMb: 1024,    // a customer storing over 1 GB
  networkGb: 5,       // a customer moving over 5 GB
  lowRequests: 50,    // fewer than 50 requests in a month
  allocRatio: 3,      // shared infrastructure cost over 3x the customer's own usage
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${Math.round(n * 100)}%`;

export function serviceAdvice(service = '') {
  if (/Compute Cloud|EC2 - Instances|Elastic Compute/i.test(service)) {
    return 'Check whether the server was resized, left running after testing, or runs more hours than expected. Stop or downsize what is not needed. Consider a Savings Plan only after usage has been steady for several months.';
  }
  if (/Elastic Block Store|EC2 - Other/i.test(service)) {
    return 'Delete storage volumes that are not attached to anything, and old snapshots. Check how long backups are kept.';
  }
  if (/Data Transfer/i.test(service)) {
    return 'Outbound data is billed. Check for large downloads, compress responses, and look for unusual traffic.';
  }
  if (/Transcribe/i.test(service)) {
    return 'Transcription is billed per audio minute. Check how many long recordings were processed, and keep test recordings short.';
  }
  if (/Simple Storage Service|S3/i.test(service)) {
    return 'Move old recordings to a cheaper storage class with a lifecycle rule, and delete backups that are no longer needed.';
  }
  if (/CloudWatch/i.test(service)) {
    return 'Shorten log retention and reduce the number of logs or metrics stored.';
  }
  return 'Open this service in AWS Cost Explorer, group by usage type, and find the item that changed.';
}

export function buildFindings(input) {
  const findings = [];
  const add = (f) => findings.push(f);
  const { aws, prevAws, unallocated, sync, client, fleet } = input;

  // Data quality first: every other number depends on the AWS sync.
  if (!sync || sync.status !== 'ok') {
    add({
      severity: 'high', area: 'Data', title: 'AWS costs are not up to date',
      why: sync?.message || 'The AWS cost sync has not succeeded yet, so AWS figures may be missing or incomplete.',
      action: 'Fix the AWS permissions shown on the Usage & Billing page, then click Sync AWS costs.',
      evidence: `Sync status: ${sync?.status || 'never run'}`, estimate: null,
    });
  }

  if (client) {
    if (client.expectedBudget != null) {
      const diff = client.estimatedBill - client.expectedBudget;
      if (diff > 0.005) {
        const larger = client.allocatedAws >= client.usageCharges ? 'shared AWS infrastructure' : 'its own usage';
        add({
          severity: diff / Math.max(client.expectedBudget, 1) > 0.2 ? 'high' : 'medium', area: 'Budget',
          title: `Estimated bill is ${usd(diff)} above the expected ${usd(client.expectedBudget)}`,
          why: `The estimate is made of usage charges ${usd(client.usageCharges)}, shared AWS infrastructure ${usd(client.allocatedAws)} and a platform fee ${usd(client.platformFee)}. The larger part is ${larger}.`,
          action: 'Compare the expected figure with these three parts. If the expected figure did not include shared infrastructure, that explains most of the gap. Otherwise follow the findings below.',
          evidence: `Expected ${usd(client.expectedBudget)}, estimated ${usd(client.estimatedBill)}`, estimate: null,
        });
      } else {
        add({
          severity: 'info', area: 'Budget', title: 'Within the expected budget',
          why: `The estimated bill ${usd(client.estimatedBill)} is at or below the expected ${usd(client.expectedBudget)}.`,
          action: 'No action needed.', evidence: `Expected ${usd(client.expectedBudget)}, estimated ${usd(client.estimatedBill)}`, estimate: null,
        });
      }
    }
    if (client.requests === 0 && client.runningHours === 0) {
      add({
        severity: 'info', area: 'Usage', title: 'No usage recorded for this month yet',
        why: 'The usage collector has not recorded activity for this customer in the selected month.',
        action: 'Check the collector status in Usage & Billing, or select a different month.', evidence: 'Requests 0, running hours 0', estimate: null,
      });
    } else if (client.status === 'ready' && client.requests < THRESH.lowRequests && client.runningHours > 0) {
      add({
        severity: 'low', area: 'Usage', title: 'Very little use this month',
        why: 'A ready workspace costs about the same whether or not it is used, so low use means the cost is spread over few activities.',
        action: 'Ask whether the customer still needs this workspace. If not, archive it from the Customers page. Its data is kept and it can be restored.',
        evidence: `${client.requests} requests in the month`, estimate: null,
      });
    }
    if (client.storageMb > THRESH.storageMb) {
      const growth = client.prevStorageMb > 0 ? (client.storageMb - client.prevStorageMb) / client.prevStorageMb : null;
      add({
        severity: growth !== null && growth > THRESH.bigRise ? 'high' : 'medium', area: 'Storage',
        title: `This customer stores ${(client.storageMb / 1024).toFixed(1)} GB`,
        why: 'Recordings and database content grow with every meeting, and storage is billed continuously.',
        action: 'Remove recordings that are no longer needed (Remove on each meeting). Agree a retention rule with the customer, then delete older meetings.',
        evidence: growth === null ? `Stored ${Math.round(client.storageMb)} MB` : `Stored ${Math.round(client.storageMb)} MB, previous month ${Math.round(client.prevStorageMb)} MB (${pct(growth)} change)`,
        estimate: null,
      });
    }
    if (client.networkGb > THRESH.networkGb) {
      add({
        severity: 'medium', area: 'Network', title: `High data transfer: ${client.networkGb.toFixed(1)} GB`,
        why: 'Data sent out of AWS is billed. Large downloads or many file transfers increase this quickly.',
        action: serviceAdvice('Data Transfer'), evidence: `${client.networkGb.toFixed(1)} GB transferred`, estimate: null,
      });
    }
    if (client.allocatedAws >= 5 && client.allocatedAws > client.usageCharges * THRESH.allocRatio) {
      add({
        severity: 'low', area: 'Pricing', title: 'Shared infrastructure cost is much higher than this customer’s usage',
        why: 'Most of this customer’s estimated bill is its share of the shared server and storage, not its own activity.',
        action: 'Reduce shared infrastructure first (see the server and service findings). Also check the agreed price still covers the customer’s share.',
        evidence: `Allocated ${usd(client.allocatedAws)} against usage charges ${usd(client.usageCharges)}`, estimate: null,
      });
    }
  }

  // Account-level findings: AWS services, unlinked spend, and the shared server.
  const prevByName = new Map((prevAws?.services || []).map((s) => [s.service, s.amount]));
  for (const s of aws.services || []) {
    const before = prevByName.get(s.service) || 0;
    const increase = s.amount - before;
    if (increase < THRESH.riseMinUsd) continue;
    const change = before > 0 ? increase / before : null;
    if (change !== null && change < THRESH.rise) continue;
    const high = change === null ? s.amount >= 50 : change >= THRESH.bigRise;
    add({
      severity: high ? 'high' : 'medium', area: 'AWS service',
      title: change === null ? `New cost: ${s.service}` : `${s.service} cost rose ${pct(change)}`,
      why: change === null
        ? `${s.service} was not billed last month and now costs ${usd(s.amount)}.`
        : `The cost increased by ${usd(increase)}, from ${usd(before)} to ${usd(s.amount)}.`,
      action: serviceAdvice(s.service),
      evidence: `This month ${usd(s.amount)}, previous month ${usd(before)}`, estimate: null,
    });
  }

  if (aws.total > 5 && unallocated / aws.total > THRESH.unallocated) {
    add({
      severity: 'medium', area: 'Shared',
      title: `${pct(unallocated / aws.total)} of AWS spending is not linked to any customer`,
      why: 'This is shared cost: the shared server and database, backups, snapshots and services that no single customer uses. It is not included in any customer’s bill.',
      action: 'Review the service list for items that are not needed, such as old snapshots, unused volumes and idle services. Reduce shared infrastructure where possible.',
      evidence: `${usd(unallocated)} of ${usd(aws.total)} unlinked`, estimate: null,
    });
  }

  if (fleet && fleet.readyCount > 0 && aws.ec2 > 0 && fleet.cpuAvg !== null) {
    if (fleet.cpuAvg < THRESH.cpuLow) {
      add({
        severity: 'medium', area: 'Compute',
        title: `The shared server averages ${Math.round(fleet.cpuAvg)}% CPU`,
        why: 'The server is mostly idle, so a large part of its cost pays for capacity that is not used.',
        action: 'Check the peak CPU over several weeks. Then move to a smaller instance type during a quiet period, and check every customer still works. An instance one size smaller usually costs about half as much. Verify the figure on the AWS pricing page.',
        evidence: `Average CPU ${fleet.cpuAvg.toFixed(1)}% across ${fleet.readyCount} ready customers; EC2 cost ${usd(aws.ec2)}`,
        estimate: `up to about ${usd(aws.ec2 * 0.5)} a month, if a smaller instance is confirmed safe`,
      });
    } else if (fleet.cpuAvg >= THRESH.cpuHigh) {
      add({
        severity: 'medium', area: 'Compute',
        title: `The shared server averages ${Math.round(fleet.cpuAvg)}% CPU`,
        why: 'Sustained high CPU slows processing for every customer. This is a capacity decision, so it increases cost rather than reducing it.',
        action: 'Plan a larger instance before users notice slow processing. Compare the cost with the performance benefit.',
        evidence: `Average CPU ${fleet.cpuAvg.toFixed(1)}% across ${fleet.readyCount} ready customers`, estimate: null,
      });
    }
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
