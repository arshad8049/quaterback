/**
 * preload-clock-jump.js — `node --require` hook (TEST ONLY) that moves this
 * process's wall clock (Date.now / new Date) by QB_TEST_CLOCK_JUMP_MS, after
 * QB_TEST_CLOCK_JUMP_AFTER_MS of real time. Monotonic time is untouched, as in
 * a real wall-clock change. Used for the T-LIFE clock-jump variant (§11.2).
 */
const RealDate = Date;
const realNow = RealDate.now;
let shift = 0;

class JumpedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(realNow() + shift); }
  static now() { return realNow() + shift; }
}
global.Date = JumpedDate;

const offset = Number(process.env.QB_TEST_CLOCK_JUMP_MS || 0);
if (offset) setTimeout(() => { shift = offset; }, Number(process.env.QB_TEST_CLOCK_JUMP_AFTER_MS || 0)).unref();
