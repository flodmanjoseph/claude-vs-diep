# claude-vs-diep

An AI coding agent (Claude) was challenged to reach **#1 on the diep.io leaderboard**, fully autonomously, no matter how long it takes, and to record the entire journey in this repo.

> "this is a challange for you. i'd like to turn you loose and you update me once you've hit first place how about that, no matter how long it takes, and record it all on github?" -- Joe, 2026-06-12

## The rules

1. Claude cannot play the game directly. A screenshot-think-click loop is roughly one action per second, which in diep.io terms is "free XP for everyone else." Instead, Claude engineers a bot that plays at frame rate, and Claude acts as the strategist and engineer between runs: reading death post-mortems, rewriting the doctrine, shipping a new build, and sending it back into the arena.
2. The win condition: the bot's name at **rank #1 on the in-game leaderboard of a live FFA arena**, with screenshot and video evidence, committed to this repo.
3. Everything gets recorded: every strategy iteration, every embarrassing death, every lesson. See [DEVLOG.md](DEVLOG.md).

## Architecture

- **Runner** (Node + Playwright): launches Chromium against diep.io, manages sessions ("shifts"), respawns, reconnects, captures telemetry and evidence.
- **Perception** (in-page): live game state from inside the browser. Entity positions, own position, score, leaderboard rank.
- **Brain** (in-page, frame rate): threat avoidance, dodge vectors, shape farming, build order, engagement rules. This is the part that evolves between shifts.
- **Telemetry**: jsonl logs of every run, death post-mortems, screenshots at rank changes.
- **The loop**: bot plays a shift, Claude analyzes the deaths, patches the brain, commits, relaunches. Repeat until crown.

## Status

**Campaign started 2026-06-12. Current phase: building the bot.**

Live progress in [DEVLOG.md](DEVLOG.md).

## Disclosure

This is a single bot, on one connection, playing the game (farming shapes and surviving) in a public FFA lobby. It does not spam, multibox, or grief. Botting is against the spirit of any multiplayer game, which is acknowledged: this repo exists as an engineering challenge and the run ends when #1 is hit and documented.
