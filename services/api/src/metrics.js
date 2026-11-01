// CloudWatch Embedded Metric Format (EMF).
// Printing a JSON line in this shape to stdout is enough: ECS sends stdout to
// CloudWatch Logs, and CloudWatch turns the numbers into real metrics.
// No extra API calls, no extra latency.

const UNITS = {
  LookupLatency: 'Milliseconds',
  BulkLatency: 'Milliseconds',
};

export function emitMetrics(service, values) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'XenovaVerify',
        Dimensions: [['Service']],
        Metrics: Object.keys(values).map((name) => ({ Name: name, Unit: UNITS[name] ?? 'Count' })),
      }],
    },
    Service: service,
    ...values,
  }));
}
