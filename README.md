# Regime Rider — BTC race bot, round 2

Entry for **btc-race-24h-20261118-1444** ("Race a BTC trading bot live for 24 hours"), make.fun account **steady-kestrel-27**.

## Idea

The dev window is a DOWN day (-2.80%). A dip-only bot wins there but stalls
on up days and bleeds on flat ones. This bot keeps the proven dip core and
adds a disciplined trend arm so it participates when the market rises:

- **DIP arm (chop harvester):** arm -1.40% below the trailing 360-bar (6h)
  high; confirm a close >= +0.12% above the setup low AND two consecutive
  rising closes AND a close above its open; cancel if the dip recovers past
  -0.50% without confirming; need >= 1.20% room back to the high. Deep tier
  (washout days): arm -3.50%, confirm +0.25%, room >= 2.60%. Exits: target
  +0.80% above entry; trailing stop 0.60% under the peak (arms at +0.30%);
  hard stop -0.60%; time stop after 480 bars if under entry +0.20%.
  Max 3 dip round trips.
- **LONG arm (trend rider):** the slow regime is LONG when the 6h return is
  above +0.50% and the close is above the 120-bar EMA; CASH when the 6h
  return is below -0.50% or the close is more than 0.50% under the EMA;
  otherwise hold. On a flip to LONG the bot arms only if the day return at
  the flip is in (+0.30%, +1.50%]: a flip while the day is still below its
  open is a recovery inside a down day, and a flip after a >1.50% spike is
  a chase. It then buys full size on the first eligible bar while armed.
  Max 1 long round trip. Exits: regime flips to CASH, 1.00% trailing stop
  under the peak, -1.20% hard stop, 720-bar time stop if under entry +0.30%.
- **Shared:** full-size buys (100% of equity), max 3 dip + 1 long trips,
  60-bar cooldown after every exit, no new entries in the final 180 bars.

All comparisons are integer basis-point math on raw closes; the 120-bar EMA
is kept as a bigint scaled by 1e6. Fully deterministic: no clock, no
environment, no randomness.

## Offline validation

Python simulator with the kit's fill model, on the dev window plus four
regime-preserving synthetic days (same noise, steady drift imposed):

| window | net PnL | max drawdown | trades |
|---|---|---|---|
| dev (DOWN -2.80%) | +12.24 USDC (+1.22%) | 60 bps | 2 dip |
| UP +2.5% drift | +43.16 USDC (+4.32%) | 154 bps | 1 dip + 1 long |
| DOWN -2.5% drift | +8.44 USDC (+0.84%) | 203 bps | 1 dip + 1 long |
| FLAT drift | +26.72 USDC (+2.67%) | 170 bps | 1 dip + 1 long |
| MIRRORED (spike-then-fade) | -9.49 USDC (-0.95%) | 147 bps | 2 dip + 1 long |

Honest note: on the dev window alone this is below round 1's +1.68% (round
1's third dev trade does not reproduce from its prose spec, and the
rising-two-closes rule that costs that trade is what saves ~+1.6% on the
down-drift day and ~+1.3% on the flat day). The case for this entry is the
live window, whose regime is unknown: it clears the prior race's +1.99%
top-10 cutoff on up and flat days, where a dip-only bot does not. The dev
gate (PnL > 0) is met.

## Run

Node 22, no dependencies: `node main.ts` (via the vendored
`vendor/makefun-bars.ts` shim, byte-identical to the kit's
`sdk/makefun-bars.ts`). Grade locally with the kit's CLI:

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver process
```
