// Pump.fun Paper Sprint bot — agent-fun/replay/v2.
//
// Strategy: early-entry patient tickets on young bonding curves.
//   - Enter a curve once, early: age <= 7200 slots, real SOL reserves >= 1 SOL,
//     at least 2 buys from at least 2 distinct buyers, never a mint traded before.
//   - Size: min(1% of real reserves, 0.2 SOL), always >= 0.01 SOL, so every
//     completed round trip counts toward the 20-coin minimum bar.
//   - Exits per position, all in bigint cross-multiplied rationals (no floats):
//     take profit at +200% (3x entry), trailing stop 40% below the peak once the
//     price has doubled, stop-loss at -70%, time exit after 20000 slots.
//   - Probe guardrail: while round trips are below 20 and behind pace
//     (< 2 qualifying trips per 10,000 elapsed slots), relax entry to >= 1 buy /
//     >= 1 buyer / age <= 14400 slots and buy exactly 0.01 SOL, so the minimum
//     bar is still met on a slow window.
//   - One shot per mint: a buy that is rejected or fails marks the mint
//     attempted and is never retried.
//   - Fully deterministic: no clock, no random, no network; every decision
//     comes from the harness state alone.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, Curve, OrderInput } from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;
const NORMAL_BUY = 200_000_000n; // 0.2 SOL
const PROBE_BUY = 10_000_000n; // 0.01 SOL, the round-trip minimum
const MIN_REAL_QUOTE_RESERVES = 1_000_000_000n; // 1 SOL
const MAX_AGE_SLOTS = 7200;
const PROBE_MAX_AGE_SLOTS = 14400;
const MIN_BUYS = 2;
const PROBE_MIN_BUYS = 1;
const MIN_BUYERS = 2;
const PROBE_MIN_BUYERS = 1;
const TIME_EXIT_SLOTS = 20000;
const SLIPPAGE_BPS = 500;
// Exits are "get out now" orders (take-profit, trailing stop, stop-loss, time
// exit): they must execute even when the price is moving fast against the
// sale, because a rejected exit leaves the bot holding a falling coin for
// another batch. Buys keep the tighter 500 bps: a buy that would fill more
// than 5% worse than the decision-time reserves is a bad entry, and
// rejecting it costs nothing.
const SELL_SLIPPAGE_BPS = 2000;
const ROUND_TRIP_TARGET = 20;
const PACE_TRIPS_PER_10K_SLOTS = 2;
const MAX_ORDERS_PER_BATCH = 16;

interface PositionRecord {
  mint: string;
  entryVq: bigint;
  entryVt: bigint;
  peakVq: bigint;
  peakVt: bigint;
  entrySlot: number;
}

interface PendingEntry {
  entrySlot: number;
}

interface MintStats {
  createdSlot: number | null;
  buys: number;
  buyers: Set<string>;
}

// Is curVq/curVt >= (num/den) * (refVq/refVt)? All bigint, no floats.
function priceAtLeast(
  curVq: bigint,
  curVt: bigint,
  refVq: bigint,
  refVt: bigint,
  num: bigint,
  den: bigint,
): boolean {
  return curVq * refVt * num >= refVq * curVt * den;
}

// Is curVq/curVt <= (num/den) * (refVq/refVt)? All bigint, no floats.
function priceAtMost(
  curVq: bigint,
  curVt: bigint,
  refVq: bigint,
  refVt: bigint,
  num: bigint,
  den: bigint,
): boolean {
  return curVq * refVt * den <= refVq * curVt * num;
}

// Entry gate: young enough, real reserves deep enough to size a qualifying
// buy, enough buys from enough distinct buyers, and a priceable curve.
function qualifiesForEntry(
  st: MintStats,
  curve: Curve | undefined,
  slot: number,
  maxAge: number,
  minBuys: number,
  minBuyers: number,
): boolean {
  if (curve === undefined || curve.complete) return false;
  if (st.createdSlot === null) return false;
  if (slot - st.createdSlot > maxAge) return false;
  if (curve.real_quote_reserves < MIN_REAL_QUOTE_RESERVES) return false;
  if (st.buys < minBuys || st.buyers.size < minBuyers) return false;
  if (curve.virtual_quote_reserves <= 0n || curve.virtual_token_reserves <= 0n) return false;
  return true;
}

const stats = new Map<string, MintStats>();
const attempted = new Set<string>();
const pendingEntries = new Map<string, PendingEntry>();
const positions = new Map<string, PositionRecord>();
let roundTrips = 0;
let startSlot: number | null = null;

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  if (startSlot === null) startSlot = batch.slot;
  const orders: OrderInput[] = [];

  // 1. Per-mint stats from this batch's events. Buy/buyer counts are capped:
  // only the >=2 thresholds matter, so a hot coin's buyer set stays tiny.
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const st = stats.get(e.mint) ?? {
        createdSlot: null,
        buys: 0,
        buyers: new Set<string>(),
      };
      if (st.createdSlot === null) st.createdSlot = e.slot;
      stats.set(e.mint, st);
    } else if (e.event === "TradeEvent" && e.is_buy) {
      const st = stats.get(e.mint) ?? {
        createdSlot: null,
        buys: 0,
        buyers: new Set<string>(),
      };
      if (st.buys < 3) st.buys += 1;
      if (st.buyers.size < 3) st.buyers.add(e.user);
      stats.set(e.mint, st);
    }
  }

  // 2. Fold fills in. A filled buy promotes its pending entry to a position
  // record, with the entry price taken from the fill itself: SOL actually
  // spent (fees included) per token received. That is the true cost basis;
  // the decision-time curve price is stale by the 2-slot latency and would
  // trigger the stop-loss later than -70% of what was really paid. A rejected
  // or failed buy drops the pending entry (the mint stays in `attempted`:
  // one shot per mint, no retry loop).
  for (const f of batch.fills) {
    if (f.side !== "buy") continue;
    const pending = pendingEntries.get(f.mint);
    if (pending === undefined) continue;
    if (f.status === "filled") {
      const spent = BigInt(f.quote_lamports);
      const tokens = BigInt(f.token_amount);
      if (spent > 0n && tokens > 0n) {
        positions.set(f.mint, {
          mint: f.mint,
          entryVq: spent,
          entryVt: tokens,
          peakVq: spent,
          peakVt: tokens,
          entrySlot: pending.entrySlot,
        });
      }
    }
    pendingEntries.delete(f.mint);
  }

  // 3. Reconcile position records against the account the harness reports.
  // A record whose mint is no longer held was closed (own sell, or a harness
  // close: _complete_ / _flatten_ / _writeoff_) and counts as a round trip.
  for (const mint of [...positions.keys()]) {
    if (!state.positions.has(mint)) {
      positions.delete(mint);
      roundTrips += 1;
    }
  }
  for (const [mint, holding] of state.positions) {
    if (positions.has(mint) || holding.token_amount <= 0n) continue;
    const pending = pendingEntries.get(mint);
    if (pending !== undefined) {
      // Buy decided but its fill has not been seen yet; leave the record to
      // the fill handler (step 2), which uses the fill's true cost basis.
      continue;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    positions.set(mint, {
      mint,
      entryVq: curve.virtual_quote_reserves,
      entryVt: curve.virtual_token_reserves,
      peakVq: curve.virtual_quote_reserves,
      peakVt: curve.virtual_token_reserves,
      entrySlot: batch.slot,
    });
  }

  // 4. Exits: take profit +200%, trailing stop 40% below peak once doubled,
  // stop-loss -70%, time exit after 20000 slots. Sell the whole holding.
  for (const [mint, rec] of positions) {
    const holding = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (holding === undefined || curve === undefined || curve.complete) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vq <= 0n || vt <= 0n || rec.entryVt <= 0n) continue;
    // Track the peak price seen since entry.
    if (priceAtLeast(vq, vt, rec.peakVq, rec.peakVt, 1n, 1n)) {
      rec.peakVq = vq;
      rec.peakVt = vt;
    }
    const takeProfit = priceAtLeast(vq, vt, rec.entryVq, rec.entryVt, 3n, 1n);
    const doubled = priceAtLeast(rec.peakVq, rec.peakVt, rec.entryVq, rec.entryVt, 2n, 1n);
    const trailedOff =
      doubled && priceAtMost(vq, vt, rec.peakVq, rec.peakVt, 3n, 5n);
    const stoppedOut = priceAtMost(vq, vt, rec.entryVq, rec.entryVt, 3n, 10n);
    const timedOut = batch.slot - rec.entrySlot >= TIME_EXIT_SLOTS;
    if (takeProfit || trailedOff || stoppedOut || timedOut) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // 5. Entries. Probe mode while round trips are below target and behind pace.
  const elapsed = batch.slot - (startSlot ?? batch.slot);
  const behindPace = roundTrips * 10000 < PACE_TRIPS_PER_10K_SLOTS * elapsed;
  const probe = roundTrips < ROUND_TRIP_TARGET && behindPace;
  const maxAge = probe ? PROBE_MAX_AGE_SLOTS : MAX_AGE_SLOTS;
  const minBuys = probe ? PROBE_MIN_BUYS : MIN_BUYS;
  const minBuyers = probe ? PROBE_MIN_BUYERS : MIN_BUYERS;
  const maxOpen = state.hello.caps.max_open_positions;
  const txFee = state.txFeeLamports();
  let plannedBuys = 0;
  let plannedSpend = 0n;
  for (const [mint, st] of stats) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    if (attempted.has(mint) || positions.has(mint) || pendingEntries.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (!qualifiesForEntry(st, curve, batch.slot, maxAge, minBuys, minBuyers)) continue;
    if (state.committedPositionCount() + plannedBuys >= maxOpen) break;
    const cap = state.maxBuyLamports(mint);
    const want = probe ? PROBE_BUY : NORMAL_BUY;
    const size = cap < want ? cap : want;
    if (size < PROBE_BUY) continue;
    if (state.freeCashLamports() - plannedSpend < size + txFee) continue;
    orders.push({
      side: "buy",
      mint,
      quote_lamports: size,
      max_slippage_bps: SLIPPAGE_BPS,
    });
    attempted.add(mint);
    pendingEntries.set(mint, {
      entrySlot: batch.slot,
    });
    plannedBuys += 1;
    plannedSpend += size + txFee;
  }

  // 6. Prune stats for mints that can never qualify again (age past the probe
  // window, not held, no pending buy). Attempted mints stay attempted forever.
  for (const [mint, st] of stats) {
    if (st.createdSlot === null) continue;
    if (batch.slot - st.createdSlot <= PROBE_MAX_AGE_SLOTS) continue;
    if (positions.has(mint) || pendingEntries.has(mint)) continue;
    stats.delete(mint);
  }

  return orders;
}

await runBot({ onBatch });
