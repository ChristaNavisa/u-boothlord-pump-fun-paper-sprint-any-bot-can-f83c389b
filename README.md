[![Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ChristaNavisa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ChristaNavisa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint bot

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program, `main.ts` (Node 22), speaking the `agent-fun/replay/v2` protocol over stdin/stdout: it reads the harness `hello` and `batch` messages and answers every batch with its `orders`.

## Strategy

- **Momentum entries**: buy young bonding curves showing real buy pressure — net SOL inflow, several distinct buyers, price rising and holding near its window high — once the real SOL reserve is big enough for a meaningful (≥0.01 SOL) buy.
- **Pyramid into strength only**: add to a position while the price is at or above the last buy and inflow is still positive, up to 0.4 SOL per coin.
- **Fast exits**: stop-loss at −15% of cost, trailing stop 25% below peak once 10% up, full take-profit at a double, a hold cap, and a fade exit when sellers take over.
- **Pace guardrail**: tiny 0.01 SOL probe round trips keep the run on pace for the 20-coin / 0.01-SOL minimum bar even in a quiet window.
- **Small stakes**: at most 5 open positions, at most ~2 SOL deployed against 10 SOL capital, so max drawdown stays far under the 50% guardrail.

Fully deterministic: no clock, no randomness, no network, no environment. Two runs produce byte-identical action logs.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
