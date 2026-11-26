// Fake claude for wrapper tests: reads stdin until it closes, then prints an init line, one rate_limit_event line and a result, and exits 0.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write('{"type":"system","subtype":"init"}\n');
  process.stdout.write('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792075800,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":1792075800},"seven_day":{"utilization":0.64,"resetsAt":1792180800}}}}\n');
  process.stdout.write('{"type":"result","result":"ok"}\n');
});
