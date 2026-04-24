/**
 * Reference plugin — computes a trivial "coverage score" given chunk counts.
 * Demonstrates the plugin contract: a module that exports functions, invoked
 * by the host via PluginRegistryService.invoke(name, fn, ...args).
 */
module.exports = {
  name: 'test-coverage',

  estimate: function (totalMethods, coveredMethods) {
    if (!totalMethods) return { coveragePercent: 0, verdict: 'no-methods' };
    const pct = Math.round((coveredMethods / totalMethods) * 100);
    const verdict = pct >= 80 ? 'good' : pct >= 50 ? 'ok' : 'poor';
    host.log(`test-coverage: ${coveredMethods}/${totalMethods} = ${pct}% (${verdict})`);
    return { coveragePercent: pct, verdict };
  },
};
