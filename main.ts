// "Regime Rider" — BTC race bot, round 2 (btc-race-24h-20261118-1444).
//
// Two arms, one state machine. The dev window is a DOWN day (-2.80%), and
// the prior round's dip-only bot made +1.68% on it but stalls on up days and
// bleeds on flat ones. This bot keeps the dip core and adds a disciplined
// trend arm so it participates when the market rises:
//
//   DIP arm (chop harvester): arm -1.40% below the trailing 360-bar (6h)
//   high; confirm a close >= +0.12% above the setup low AND two consecutive
//   rising closes AND a close above its open (the second rising close is
//   what keeps one-bar blips in a waterfall from firing); cancel if the dip
//   recovers past -0.50% without confirming; need >= 1.20% room back to the
//   high. Deep tier (washout days): arm -3.50%, confirm +0.25%, room >= 2.60%.
//   Exits: target +0.80% above entry; trailing stop 0.60% under the peak
//   (arms at +0.30%); hard stop -0.60%; time stop after 480 bars if under
//   entry +0.20%. Max 3 dip round trips.
//
//   LONG arm (trend rider): the slow regime is LONG when the 6h return is
//   above +0.50% and the close is above the 120-bar EMA; CASH when the 6h
//   return is below -0.50% or the close is more than 0.50% under the EMA;
//   otherwise hold. (Before 360 bars of history the 6h return is the day
//   return.) On a flip to LONG the bot arms only if the day return at the
//   flip is in (+0.30%, +1.50%]: a flip while the day is still below its
//   open is a recovery inside a down day, and a flip after a >1.50% spike
//   is a chase — both lost in offline testing. It then buys full size on
//   the first eligible bar while armed (arming survives a cooldown). Max 2
//   long round trips: a second genuine flip to LONG re-arms a second trip
//   (the old cap of 1 discarded a real signal — on the mirrored
//   spike-then-fade day the second trip turns -9.49 into +0.14, with no
//   change on dev or the other synthetic days; a cap of 3 is identical, so
//   2 is not a tuned spike). Exits: regime flips to CASH, 1.00% trailing
//   stop under the peak, -1.20% hard stop, 720-bar time stop if under entry
//   +0.30%.
//
//   Shared: full-size buys (100% of equity), max 3 dip + 2 long trips,
//   60-bar cooldown after every exit, no new entries in the final 180 bars.
//
// All comparisons are integer basis-point math on raw closes; the 120-bar
// EMA is kept as a bigint scaled by 1e6. Fully deterministic: no clock,
// no environment, no randomness.
//
// Offline validation (python simulator with the kit's fill model, on the
// dev window plus four regime-preserving synthetic days built from it by
// removing the trailing 360-bar mean of log returns and imposing a steady
// drift — same noise, different regime; dev = DOWN -2.80%):
//   dev (DOWN -2.80%):  +12.24 USDC (+1.22%), maxDD 60bps, 2 dip trades
//   UP +2.5% drift:     +43.16 USDC (+4.32%), maxDD 154bps, 1 dip + 1 long
//   DOWN -2.5% drift:   +8.44 USDC (+0.84%), maxDD 203bps, 1 dip + 1 long
//   FLAT drift:          +26.72 USDC (+2.67%), maxDD 170bps, 1 dip + 1 long
//   MIRRORED (spike-then-fade): +0.14 USDC (+0.01%), maxDD 172bps, 2 dip + 2 long
//   (was -9.49 with the 1-long cap; the second long trip, bought on a second
//   genuine flip to LONG at bar 1189, is flattened at the window close)
// Honest note: on the dev window alone this is below round 1's +1.68%
// (round 1's third dev trade does not reproduce from its prose spec — its
// exact confirm differs — and the rising-two-closes rule that costs that
// trade is what saves ~+1.6% on the down-drift day and ~+1.3% on the flat
// day). The case for this entry is the live window, whose regime is
// unknown: it clears the prior race's +1.99% top-10 cutoff on up and flat
// days, where a dip-only bot does not. Dev gate (PnL > 0) is met.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const TOTAL_BARS = 1440;
const CUTOFF_BARS = 180; // no new entries in the final 180 bars
const COOLDOWN_BARS = 60;
const MAX_DIP_TRIPS = 3;
const MAX_LONG_TRIPS = 2;
const MAX_SLIPPAGE_BPS = 200;
const SCALE6 = 1_000_000n;

// All thresholds in basis points.
const DIP_ARM = -140;
const DIP_DEEP_ARM = -350;
const DIP_CANCEL = -50;
const DIP_CONF_SHALLOW = 12;
const DIP_CONF_DEEP = 25;
const DIP_ROOM_SHALLOW = 120;
const DIP_ROOM_DEEP = 260;
const DIP_TARGET = 80;
const DIP_TRAIL_ARM = 30;
const DIP_TRAIL = 60;
const DIP_STOP = 60;
const DIP_TIME_BARS = 480;
const DIP_TIME_EXIT = 20;
const LONG_UP_RET6 = 50;
const LONG_DOWN_RET6 = -50;
const LONG_EMA_DOWN = 50;
const LONG_ARM_DAYRET_LO = 30;
const LONG_ARM_DAYRET_HI = 150;
const LONG_TRAIL = 100;
const LONG_STOP = 120;
const LONG_TIME_BARS = 720;
const LONG_TIME_EXIT = 30;

/** Integer basis points of x against y: (x - y) * 10000 / y. */
function bps(x: bigint, y: bigint): bigint {
  return ((x - y) * 10_000n) / y;
}

type Mode = 'dip' | 'long';

const closes: bigint[] = [];
const opens: bigint[] = [];
let ema6: bigint | null = null; // 120-bar EMA of closes, scaled by 1e6
let dayOpen: bigint | null = null; // close of the first scored bar
let scored = 0; // scored bars seen (excludes warm-up)

let regime: 'CASH' | 'LONG' = 'CASH';
let longArmed = false;

let dipArmed = false;
let dipLow = 0n;
let dipDeep = false;

let holding = false;
let holdMode: Mode | null = null;
let entry = 0n;
let peak = 0n;
let entryScored = 0;

let dipTrips = 0;
let longTrips = 0;
let cooldownUntil = 0;

let pendingBuyId: string | null = null;
let pendingBuyMode: Mode | null = null;
let pendingSellId: string | null = null;
let pendingSellMode: Mode | null = null;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Settle the previous batch's orders first: fills (or rejections) are
    // reported here, before any new decision is taken.
    for (const fill of batch.fills) {
      if (pendingBuyId !== null && fill.client_id === pendingBuyId) {
        if (fill.status === 'filled') {
          holding = true;
          holdMode = pendingBuyMode;
          entry = BigInt(fill.price);
          peak = entry;
          entryScored = scored;
        }
        pendingBuyId = null;
        pendingBuyMode = null;
      }
      if (pendingSellId !== null && fill.client_id === pendingSellId) {
        if (fill.status === 'filled') {
          holding = false;
          holdMode = null;
          if (pendingSellMode === 'dip') dipTrips += 1;
          else longTrips += 1;
          cooldownUntil = scored + COOLDOWN_BARS;
        }
        pendingSellId = null;
        pendingSellMode = null;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const open = BigInt(bar.o);
    closes.push(close);
    opens.push(open);
    ema6 = ema6 === null ? close * SCALE6 : ema6 + ((close * SCALE6 - ema6) * 2n) / 121n;

    // Warm-up batches build history only; no orders may be decided on them.
    if (state.warmingUp) return [];
    scored += 1;
    if (dayOpen === null) dayOpen = close;

    // --- slow regime (needs the 120-bar EMA) ---
    let flippedCash = false;
    if (scored >= 121 && ema6 !== null) {
      const dayRet = bps(close, dayOpen);
      const ret6 = closes.length >= 361 ? bps(close, closes[closes.length - 361]) : dayRet;
      const aboveEma = close * SCALE6 > ema6;
      const belowEmaBand = close * SCALE6 < (ema6 * BigInt(10_000 - LONG_EMA_DOWN)) / 10_000n;
      const up = ret6 > BigInt(LONG_UP_RET6) && aboveEma;
      const down = ret6 < BigInt(LONG_DOWN_RET6) || belowEmaBand;
      const next = up ? 'LONG' : down ? 'CASH' : regime;
      const flippedLong = regime !== 'LONG' && next === 'LONG';
      flippedCash = regime === 'LONG' && next === 'CASH';
      regime = next;
      if (flippedLong) {
        // Arm only on a genuine-trend flip: the day itself up a moderate
        // amount. Blocks recoveries inside down days (dayRet <= 0) and
        // spike chases (dayRet > 1.50%).
        longArmed = dayRet > BigInt(LONG_ARM_DAYRET_LO) && dayRet <= BigInt(LONG_ARM_DAYRET_HI);
      }
      if (flippedCash) longArmed = false;
    }

    // --- exits (while holding) ---
    if (holding && holdMode !== null) {
      if (close > peak) peak = close;
      let sell = false;
      if (holdMode === 'dip') {
        if (close >= (entry * BigInt(10_000 + DIP_TARGET)) / 10_000n) sell = true;
        else if (
          close >= (entry * BigInt(10_000 + DIP_TRAIL_ARM)) / 10_000n &&
          close <= (peak * BigInt(10_000 - DIP_TRAIL)) / 10_000n
        ) sell = true;
        else if (close <= (entry * BigInt(10_000 - DIP_STOP)) / 10_000n) sell = true;
        else if (
          scored - entryScored >= DIP_TIME_BARS &&
          close < (entry * BigInt(10_000 + DIP_TIME_EXIT)) / 10_000n
        ) sell = true;
      } else {
        if (flippedCash) sell = true;
        else if (close <= (peak * BigInt(10_000 - LONG_TRAIL)) / 10_000n) sell = true;
        else if (close <= (entry * BigInt(10_000 - LONG_STOP)) / 10_000n) sell = true;
        else if (
          scored - entryScored >= LONG_TIME_BARS &&
          close < (entry * BigInt(10_000 + LONG_TIME_EXIT)) / 10_000n
        ) sell = true;
      }
      if (sell && pendingSellId === null) {
        const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
        if (qty > 0n) {
          const id = state.clientId();
          pendingSellId = id;
          pendingSellMode = holdMode;
          return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
        }
      }
      return [];
    }

    // --- entries ---
    if (pendingBuyId !== null || pendingSellId !== null) return [];
    if (scored > TOTAL_BARS - CUTOFF_BARS) return [];
    if (scored <= cooldownUntil) return [];

    // LONG entry: first eligible bar while armed (arming survives a cooldown).
    if (longArmed && regime === 'LONG' && longTrips < MAX_LONG_TRIPS && scored >= 121) {
      const id = state.clientId();
      pendingBuyId = id;
      pendingBuyMode = 'long';
      longArmed = false;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
    }

    // DIP entries: only while the slow regime is CASH.
    if (regime === 'CASH' && dipTrips < MAX_DIP_TRIPS && closes.length >= 361) {
      let high = 0n;
      for (let i = closes.length - 361; i < closes.length; i++) {
        if (closes[i] > high) high = closes[i];
      }
      const dip = bps(close, high);
      if (!dipArmed && dip <= BigInt(DIP_ARM)) {
        dipArmed = true;
        dipLow = close;
        dipDeep = dip <= BigInt(DIP_DEEP_ARM);
      }
      if (dipArmed) {
        if (close < dipLow) dipLow = close;
        if (dip <= BigInt(DIP_DEEP_ARM)) dipDeep = true;
        if (dip > BigInt(DIP_CANCEL)) {
          dipArmed = false;
        } else {
          const conf = dipDeep ? DIP_CONF_DEEP : DIP_CONF_SHALLOW;
          const needRoom = dipDeep ? DIP_ROOM_DEEP : DIP_ROOM_SHALLOW;
          const room = bps(high, close);
          const n = closes.length;
          const rising2 =
            n >= 3 && close > closes[n - 2] && closes[n - 2] > closes[n - 3] && close > open;
          if (
            close >= (dipLow * BigInt(10_000 + conf)) / 10_000n &&
            rising2 &&
            room >= BigInt(needRoom)
          ) {
            const id = state.clientId();
            pendingBuyId = id;
            pendingBuyMode = 'dip';
            dipArmed = false;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
          }
        }
      }
    }

    return [];
  },
});
