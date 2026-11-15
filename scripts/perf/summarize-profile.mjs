/** Self time per function from a .cpuprofile (time-weighted by timeDeltas). */
export function summarizeCpuProfile(profile, limit = 10) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const self = new Map();
  let totalUs = 0;
  let idleUs = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const n = nodes.get(samples[i]);
    if (!n) continue;
    // Chrome's delta[i] is the gap *before* sample i; the next gap is the
    // time attributed to sample i.
    const us = deltas[i + 1] ?? deltas[i] ?? 0;
    const cf = n.callFrame ?? {};
    const name = cf.functionName || "(anonymous)";
    const key = `${name}\u0000${cf.url ?? ""}\u0000${cf.lineNumber ?? ""}\u0000${cf.columnNumber ?? ""}`;
    const row = self.get(key) ?? { name, url: cf.url ?? "", line: cf.lineNumber ?? null, col: cf.columnNumber ?? null, selfUs: 0, samples: 0 };
    row.selfUs += us;
    row.samples += 1;
    self.set(key, row);
    totalUs += us;
    if (name === "(idle)") idleUs += us;
  }
  const busyUs = Math.max(1, totalUs - idleUs);
  const rows = [...self.values()]
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, limit)
    .map((r) => ({
      name: r.name,
      url: r.url,
      line: r.line,
      col: r.col,
      selfMs: r.selfUs / 1000,
      samples: r.samples,
      pctTotal: (100 * r.selfUs) / Math.max(1, totalUs),
      pctBusy: r.name === "(idle)" ? null : (100 * r.selfUs) / busyUs,
    }));
  return { top: rows, totalMs: totalUs / 1000, idleMs: idleUs / 1000, sampleCount: samples.length };
}
