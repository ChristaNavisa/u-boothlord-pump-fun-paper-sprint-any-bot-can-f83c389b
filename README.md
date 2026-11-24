# Pump.fun Paper Sprint: Any Bot Can Win — Patient Tickets Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ChristaNavisa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ChristaNavisa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. It replays 6 hours of real pump.fun market data; highest net PnL takes the pot.

## Strategy: early-entry patient tickets

- **Enter young curves, once:** age ≤ 7,200 slots, real SOL reserves ≥ 1 SOL, at least 2 buys from at least 2 distinct buyers. One shot per mint — a rejected or failed buy is never retried.
- **Size:** min(1% of real reserves, 0.2 SOL), always ≥ 0.01 SOL, so every completed round trip counts toward the 20-coin minimum bar.
- **Exits (all in bigint cross-multiplied rationals, no floats):** take profit at +200% (3× entry), trailing stop 40% below the peak once the price has doubled, stop-loss at −70%, time exit after 20,000 slots.
- **Probe guardrail:** while round trips are below 20 and behind pace (< 2 qualifying trips per 10,000 elapsed slots), entry relaxes to ≥ 1 buy / ≥ 1 buyer / age ≤ 14,400 slots and buys exactly 0.01 SOL, so the minimum bar is still met on a slow window.
- **Fully deterministic:** no clock, no random, no network. Every decision comes from the harness state alone, so the two grading executions produce byte-identical action logs.

## Files

- `main.ts` — the strategy (Node 22, runs via the vendored `agent-fun/replay/v2` shim).
- `vendor/makefun-bot.ts` — the kit's zero-dependency replay shim.
- `LICENSE` — MIT.

## Run

Grade locally with the kit (from the kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process --worktree
```
