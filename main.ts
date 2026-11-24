// Pump.fun Paper Sprint bot — agent-fun/replay/v2.
//
// Reads the harness stream on stdin (hello, then one batch per slot-group, then
// done) and answers every batch with a reply carrying that batch's orders.
// Fully deterministic: no clock, no randomness, no network, no environment.
// Iteration follows the input stream's own order, so two runs agree byte for byte.
//
// Strategy, in one paragraph: buy young bonding curves early — before the
// spike, not after it — once they show a little real life (a few buys from a
// few distinct wallets and a real reserve big enough for a countable buy),
// then be patient: bank a triple, trail a runner once it doubles, cut only a
// deep bleed, and otherwise let the position sit until a long time exit frees
// the slot. A pace guardrail fires tiny probe round trips so the run always
// clears the 20-coin / 0.01-SOL minimum bar even when the main book is quiet.
// Stakes stay small against the 10 SOL capital, so drawdown stays far under
// the 50% guardrail while each ticket keeps lottery upside: the dev window's
// own data says momentum-chasing and tight stops bleed out (the house pilot
// loses 9.5 SOL there), while early entries' later price peaks regularly
// exceed +100% — so the edge, if any, is catching a spike, not churning.

import * as readline from 'node:readline';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = 1e9;

// ---- tunables (SOL unless noted, slots are chain slots) -------------------
const WINDOW_SLOTS = 600; // lookback for the fade check
const MAX_AGE_SLOTS = 7200; // only buy curves younger than this (~48 min)
const MIN_BUYS = 2; // buy trades seen before an entry
const MIN_BUYERS = 2; // distinct buying wallets seen before an entry
const MIN_RQ_SOL = 1.0; // real SOL reserve bounds at entry (cap = 1% of it)
const MAX_RQ_SOL = 80;
const INITIAL_SOL = 0.05; // first (and only) buy per coin
const MIN_BUY_SOL = 0.01; // a buy below this cannot count toward the bar
const MAX_MAIN = 4; // momentum slots; the 5th open slot is kept for probes
// Re-entry limits, tried and reverted (v3): a cooldown + max-entries cap made
// the dev score worse (-0.486 vs -0.368 SOL) — re-buying a survivor that still
// shows life beats rotating to a fresh coin. Left effectively off.
const MAX_ENTRIES = 1000;
const COOLDOWN_SLOTS = 0;
const STOP_LOSS = 0.7; // sell only on a deep bleed
const TRAIL_ARM = 1.0; // trailing stop arms once value has doubled
const TRAIL = 0.4; // sell 40% below the peak value
const TAKE_PROFIT = 2.0; // bank the triple
const MAX_HOLD_SLOTS = 20000; // time exit, unless well up
const HOLD_IF_UP = 0.4; // the time exit does not apply while up this much
const TARGET_COINS = 30; // guardrail pacing target (the bar is 20)
const TARGET_FILLS = 240;
const PACE_SECS = 14400;
const PROBE_SOL = 0.01;
const MAX_SLIPPAGE_BPS = 10000;

const FEE_BPS = 125; // protocol 95 + creator 30, charged on each side
const TX_FEE_LAMPORTS = 105000n; // base 5000 + priority 100000

type Trade = { slot: number; buy: boolean; sol: number; user: string; price: number };

type Curve = {
  createdSlot: number;
  complete: boolean;
  lastPrice: number;
  lastSlot: number;
  realSolLamports: bigint;
  trades: Trade[];
};

type HeldMeta = {
  openedSlot: number;
  peakValueSol: number;
  lastBuyPrice: number;
  entries: number;
  probe: boolean;
};

type Pending = { mint: string; side: 'buy' | 'sell'; quoteLamports: bigint };

const curves = new Map<string, Curve>();
const heldMeta = new Map<string, HeldMeta>();
const entriesCount = new Map<string, number>();
const lastExitSlot = new Map<string, number>();
const pending = new Map<string, Pending>(); // client_id -> pending order
const pendingBuyMint = new Set<string>();
const pendingSellMint = new Set<string>();

let hello: any = null;
let orderCounter = 0;
let firstBatchTs: number | null = null;
const everBought = new Set<string>();
let fillsSeen = 0;
let coinsTraded = 0;

function priceOf(c: Curve): number {
  return c.lastPrice;
}

/** Net SOL (buys minus sells) and friends over the trailing slot window. */
function windowStats(c: Curve, nowSlot: number, span: number) {
  const from = nowSlot - span;
  let net = 0;
  let buys = 0;
  let startPrice = 0;
  let high = 0;
  const buyers = new Set<string>();
  for (const t of c.trades) {
    if (t.slot < from) continue;
    if (startPrice === 0) startPrice = t.price;
    if (t.price > high) high = t.price;
    if (t.buy) {
      net += t.sol;
      buys += 1;
      buyers.add(t.user);
    } else {
      net -= t.sol;
    }
  }
  return { net, buys, buyers: buyers.size, startPrice, high };
}

function prune(c: Curve, nowSlot: number): void {
  const keepFrom = nowSlot - WINDOW_SLOTS - 600;
  while (c.trades.length > 0 && c.trades[0].slot < keepFrom) c.trades.shift();
}

/** Value of `tokens` at `price`, net of the sell-side curve fee and one tx fee. */
function sellValueSol(tokens: bigint, price: number): number {
  const gross = (Number(tokens) * price) / SOL;
  return gross * (1 - FEE_BPS / 10000) - Number(TX_FEE_LAMPORTS) / SOL;
}

function lamports(sol: number): bigint {
  return BigInt(Math.floor(sol * SOL));
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'hello') {
      hello = msg;
      continue;
    }
    if (msg.type === 'done') break;
    if (msg.type !== 'batch') continue;

    const batch = msg;
    const slot: number = batch.slot;
    const orders: any[] = [];
    const seenThisBatch: string[] = [];

    // --- ingest events: keep every curve's tape and reserves current -------
    for (const e of batch.events as any[]) {
      if (e.event === 'CreateEvent') {
        let c = curves.get(e.mint);
        if (c === undefined) {
          c = {
            createdSlot: e.slot,
            complete: false,
            lastPrice: Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves),
            lastSlot: e.slot,
            realSolLamports: 0n,
            trades: [],
          };
          curves.set(e.mint, c);
        }
        if (!seenThisBatch.includes(e.mint)) seenThisBatch.push(e.mint);
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const c = curves.get(e.mint);
        if (c !== undefined) c.complete = true;
        heldMeta.delete(e.mint);
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      let c = curves.get(e.mint);
      if (c === undefined) {
        c = {
          createdSlot: e.slot,
          complete: false,
          lastPrice: 0,
          lastSlot: e.slot,
          realSolLamports: 0n,
          trades: [],
        };
        curves.set(e.mint, c);
      }
      const price = Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves);
      c.lastPrice = price;
      c.lastSlot = e.slot;
      c.realSolLamports = BigInt(e.real_sol_reserves);
      c.trades.push({
        slot: e.slot,
        buy: e.is_buy === true,
        sol: Number(e.sol_amount) / SOL,
        user: e.user,
        price,
      });
      if (!seenThisBatch.includes(e.mint)) seenThisBatch.push(e.mint);
    }

    // --- ingest fills: clear pending, count coins and fills ----------------
    for (const f of batch.fills as any[]) {
      const p = pending.get(f.client_id);
      if (p === undefined) continue;
      pending.delete(f.client_id);
      if (p.side === 'buy') pendingBuyMint.delete(p.mint);
      else pendingSellMint.delete(p.mint);
      if (f.status === 'filled') {
        fillsSeen += 1;
        if (p.side === 'buy') {
          const meta = heldMeta.get(p.mint);
          if (meta !== undefined) {
            meta.entries += 1;
            const c = curves.get(p.mint);
            if (c !== undefined) meta.lastBuyPrice = c.lastPrice;
          }
        } else {
          heldMeta.delete(p.mint);
          lastExitSlot.set(p.mint, slot);
        }
      }
    }

    // --- authoritative positions from the harness --------------------------
    const positions = new Map<string, { tokens: bigint; cost: bigint }>();
    for (const pos of batch.account.positions as any[]) {
      positions.set(pos.mint, { tokens: BigInt(pos.token_amount), cost: BigInt(pos.cost_lamports) });
    }
    for (const mint of [...heldMeta.keys()]) {
      if (!positions.has(mint)) heldMeta.delete(mint);
    }
    for (const [mint, pos] of positions) {
      if (!heldMeta.has(mint)) {
        const c = curves.get(mint);
        const value = c !== undefined ? sellValueSol(pos.tokens, c.lastPrice) : 0;
        heldMeta.set(mint, {
          openedSlot: slot,
          peakValueSol: value,
          lastBuyPrice: c !== undefined ? c.lastPrice : 0,
          entries: 1,
          probe: false,
        });
      }
    }

    if (firstBatchTs === null) {
      const first = (batch.events as any[])[0];
      firstBatchTs = first !== undefined ? Number(first.timestamp) : 0;
    }
    const nowTs = (batch.events as any[]).length > 0
      ? Number((batch.events as any[])[(batch.events as any[]).length - 1].timestamp)
      : firstBatchTs;
    const elapsedSecs = Math.max(1, nowTs - (firstBatchTs ?? nowTs));

    let cash = BigInt(batch.account.cash_lamports);
    for (const p of pending.values()) {
      if (p.side === 'buy') cash -= p.quoteLamports + TX_FEE_LAMPORTS;
    }
    const openCount = positions.size + pendingBuyMint.size;
    const maxOpen: number = hello.caps.max_open_positions;
    const maxOrders: number = hello.caps.max_orders_per_batch;

    const pushBuy = (mint: string, amountLamports: bigint): void => {
      if (orders.length >= maxOrders) return;
      const id = `o${orderCounter}`;
      orderCounter += 1;
      orders.push({
        side: 'buy',
        client_id: id,
        mint,
        quote_lamports: amountLamports.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pending.set(id, { mint, side: 'buy', quoteLamports: amountLamports });
      pendingBuyMint.add(mint);
      entriesCount.set(mint, (entriesCount.get(mint) ?? 0) + 1);
      cash -= amountLamports + TX_FEE_LAMPORTS;
    };

    const pushSell = (mint: string, tokens: bigint): void => {
      if (orders.length >= maxOrders) return;
      const id = `o${orderCounter}`;
      orderCounter += 1;
      orders.push({
        side: 'sell',
        client_id: id,
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pending.set(id, { mint, side: 'sell', quoteLamports: 0n });
      pendingSellMint.add(mint);
    };

    // --- exits first: free slots and bank winners before buying ------------
    for (const [mint, pos] of positions) {
      if (pendingSellMint.has(mint)) continue;
      const c = curves.get(mint);
      if (c === undefined || c.lastPrice <= 0) continue;
      const meta = heldMeta.get(mint);
      if (meta === undefined) continue;
      const costSol = Number(pos.cost) / SOL;
      const value = sellValueSol(pos.tokens, c.lastPrice);
      if (value > meta.peakValueSol) meta.peakValueSol = value;
      const up = costSol > 0 ? value / costSol - 1 : 0;
      let exit = false;
      if (up <= -STOP_LOSS) exit = true; // stop-loss
      else if (up >= TAKE_PROFIT) exit = true; // bank the double
      else if (meta.peakValueSol > costSol * (1 + TRAIL_ARM) && value < meta.peakValueSol * (1 - TRAIL)) exit = true; // trailing stop
      else if (slot - meta.openedSlot > MAX_HOLD_SLOTS && up < HOLD_IF_UP) exit = true; // time exit
      if (exit) pushSell(mint, pos.tokens);
      prune(c, slot);
    }

    // --- entries: young curves with a little real life, bought before the ---
    // --- spike, not after it; one buy per coin, no pyramiding -------------
    const mainOpen = [...positions.keys()].filter((m) => {
      const meta = heldMeta.get(m);
      return meta !== undefined && !meta.probe;
    }).length + [...pendingBuyMint].filter((m) => {
      const meta = heldMeta.get(m);
      return meta === undefined || !meta.probe;
    }).length;
    let mainSlots = MAX_MAIN - mainOpen;

    for (const mint of seenThisBatch) {
      if (orders.length >= maxOrders) break;
      const c = curves.get(mint);
      if (c === undefined || c.complete) continue;
      if (positions.has(mint) || pendingBuyMint.has(mint)) continue;
      // fresh entry
      if (mainSlots <= 0) continue;
      if ((entriesCount.get(mint) ?? 0) >= MAX_ENTRIES) continue;
      const lastExit = lastExitSlot.get(mint);
      if (lastExit !== undefined && slot - lastExit < COOLDOWN_SLOTS) continue;
      if (slot - c.createdSlot > MAX_AGE_SLOTS) continue;
      const rqSol = Number(c.realSolLamports) / SOL;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      const w = windowStats(c, slot, WINDOW_SLOTS);
      if (w.buys < MIN_BUYS || w.buyers < MIN_BUYERS) continue;
      const cap = (c.realSolLamports * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10000n;
      let amount = lamports(INITIAL_SOL);
      if (amount > cap) amount = cap;
      if (amount < lamports(MIN_BUY_SOL)) continue;
      if (cash < amount + TX_FEE_LAMPORTS) continue;
      pushBuy(mint, amount);
      heldMeta.set(mint, {
        openedSlot: slot,
        peakValueSol: 0,
        lastBuyPrice: c.lastPrice,
        entries: 0,
        probe: false,
      });
      mainSlots -= 1;
    }

    // --- probe guardrail: stay on pace for the 20-coin minimum bar ---------
    const expectedCoins = (TARGET_COINS * elapsedSecs) / PACE_SECS;
    const expectedFills = (TARGET_FILLS * elapsedSecs) / PACE_SECS;
    if (
      openCount + pendingBuyMint.size < maxOpen &&
      (coinsTraded < expectedCoins - 2 || fillsSeen < expectedFills - 10) &&
      orders.length < maxOrders
    ) {
      // most liquid unheld curve makes the cheapest probe
      let best: string | null = null;
      let bestRq = 0n;
      for (const [mint, c] of curves) {
        if (c.complete || positions.has(mint) || pendingBuyMint.has(mint)) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && slot - lastExit < COOLDOWN_SLOTS) continue;
        if (c.realSolLamports > bestRq) {
          bestRq = c.realSolLamports;
          best = mint;
        }
      }
      if (best !== null && bestRq >= lamports(1)) {
        const amount = lamports(PROBE_SOL);
        if (cash >= amount + TX_FEE_LAMPORTS) {
          pushBuy(best, amount);
          heldMeta.set(best, {
            openedSlot: slot,
            peakValueSol: 0,
            lastBuyPrice: curves.get(best)?.lastPrice ?? 0,
            entries: 0,
            probe: true,
          });
        }
      }
    }

    // probes sell as soon as the buy lands
    for (const [mint, pos] of positions) {
      const meta = heldMeta.get(mint);
      if (meta === undefined || !meta.probe) continue;
      if (pendingSellMint.has(mint) || pendingBuyMint.has(mint)) continue;
      pushSell(mint, pos.tokens);
    }

    // count distinct coins we have ever bought, for the pace guardrail
    for (const o of orders) {
      if (o.side === 'buy') everBought.add(o.mint);
    }
    coinsTraded = everBought.size;

    process.stdout.write(JSON.stringify({ type: 'reply', seq: batch.seq, orders }) + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
