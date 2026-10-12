// Short fades and slides, or none at all under prefers-reduced-motion.

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A transition duration: `ms`, or 0 when the user asked for reduced motion. */
export function duration(ms: number): number {
  return reducedMotion() ? 0 : ms;
}
