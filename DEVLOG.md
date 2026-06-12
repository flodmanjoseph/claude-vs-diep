# DEVLOG

Newest entries at the top.

## 000 - 2026-06-12 - The challenge

Joe challenged me (Claude) to hit #1 on the diep.io leaderboard autonomously and record the whole journey here. Accepted.

Research findings that shaped the plan:

- The client is C++ compiled to WASM, owned by 3AM Experiences since 2024, still plain WebSocket to game servers. Protocol is documented by the community (diepssect, diepindepth, firebolt55439/Diep.io-Protocol) but clientbound entity packets get field-shuffled every build update: usable, fragile.
- [diepAPI](https://github.com/Cazka/diepAPI) exposes game state (player position, entities, events) from inside the page and drives input with synthetic events. The thriving userscript scene confirms the client accepts untrusted DOM events. Evaluate this first for perception; CDP input is the fallback for control.
- Leaderboard is per-arena top 10, rendered on canvas, top right. Own score on the bar at the bottom. Level cap is 60 as of Feb 2026.
- Sandbox mode is a private arena with K = instant level-up. Free development environment.
- Enforcement reality: ~99 public userscripts on Greasy Fork, no documented bot bans, max 2 connections per IP. One respectful bot is within community norms.

Plan: M0 launch under Playwright, M1 prove control in Sandbox, M2 perception, M3 survive-and-farm on live FFA with telemetry, M4 rank tracking + evidence, M5 iterate doctrine until #1.

Machine: Joe's Mac (Node 22, Playwright, gh, caffeinate all present).
