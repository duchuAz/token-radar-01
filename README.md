[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/duchuAz/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/duchuAz/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Bounty: [make.fun/bounty/token-radar-01](https://make.fun/bounty/token-radar-01)

# Launch Radar

A pre-token value desk for make.fun's **token-radar-01** bounty: a Node 22/24 program that reads the
sealed DefiLlama snapshot, fits a comps model on the snapshot's own live-token protocols, ranks every
tokenless protocol by an implied value, and writes a static dashboard with a costed farm plan for each
row.

## Run

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The program writes `board.json` (198 rows), `data.js` (`window.RADAR`), `dashboard/` (the page and its
source), `screenshots/` (three 1440x900 images) and `dossier.json` (the `makefun/dossier/v1` bundle).
It uses only the Node standard library; no install, no network, no clock, no randomness. Two runs on
the same snapshot write byte-identical output.

## What it does

- **Universe.** Pre-token means `mcap_usd`, `gecko_id` and `symbol` are all null. The board covers all
  40 watchlist slugs, adds 20 more at or above the $50M floor that the watchlist leaves off, and 138
  below the floor: 198 rows. Versioned pools, the named bridge/liquid-staking/restaking categories,
  wrapped/staked names and CEX products are dropped by the same rule.
- **Model.** `y = log10(mcap / TVL)` on 102 live comps, winsorized at p1/p99, against log10 TVL, the
  clamped seven-day change, log10(1 + age/365) and chains/8. OLS normal equations, three Huber IRLS
  rounds, then a shrunk median residual per category (`n/(n+8)`, clamped to [-1, 1]). Every row's
  implied value is `TVL x 10^(fit + category adj)`, clamped to [0.02, 8], never a hard-coded name.
- **Validation.** Five deterministic folds (`fnv1a(slug) % 5`), out-of-fold MAE 0.551 log10, R2 0.288,
  80% interval coverage 76.5%, Spearman rank IC 0.516, calibration slope 0.899.
- **Farm plans.** Every row has seven concrete steps (wallet, funding, the category action, weekly
  activity, the hold, the claim check, the netting line), each with a cost and a time, plus position,
  gas, bridge, opportunity cost, break-even airdrop and net at 10/25/50%.

The full method, coefficients, validation table, category multiples and limitations are generated into
`out/dashboard/00-model.md` so the judge reads the reasoning before the page source.

## Layout

```
main.ts                 the program
lib/model.ts            the comps fit, board and farm economics
vendor/makefun-board.ts the bounty's dossier library, copied byte for byte
dashboard/              static page: index.html, app.css, app.js
screenshots/            board, detail and filtered views (1440x900 PNG)
.makefun/owner.json     the wallet claim
```

No framework, no build step, no network calls in `dashboard/`; classic scripts only, works from
`file://`.

## License

MIT. See `LICENSE`.
