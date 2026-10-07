// minute, hour, day of month, month, day of week (Sunday = 0)
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/** The values a field such as `*`, `5`, `1-5`, `1,3`, `* /15` or `0-30/10` allows within `min..max`. */
function values(field: string, min: number, max: number): Set<number> {
  const allowed = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    const lo = m?.[1] === undefined ? min : Number(m[1]);
    const hi = m?.[1] === undefined ? max : Number(m[2] ?? m[1]);
    const step = Number(m?.[3] ?? 1);
    if (!m || lo < min || hi > max || lo > hi || step < 1) throw new Error(`invalid cron: bad field "${field}"`);
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

/** The first minute strictly after `after` that matches the 5-field cron `expr`, in local time. */
export function nextAfter(expr: string, after: number): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("invalid cron: expected 5 fields");
  const [minute, hour, day, month, weekday] = fields.map((f, i) => values(f, ...RANGES[i]!));
  const t = new Date(after);
  t.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (
      minute!.has(t.getMinutes()) &&
      hour!.has(t.getHours()) &&
      day!.has(t.getDate()) &&
      month!.has(t.getMonth() + 1) &&
      weekday!.has(t.getDay())
    ) {
      return t.getTime();
    }
  }
  throw new Error("invalid cron: never matches");
}
