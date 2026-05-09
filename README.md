# Career-Ops (Slagathore Fork)

> **A more aggressive, GUI-first take on job hunting.**
> Forked from [santifer/career-ops](https://github.com/santifer/career-ops) and pushed in a different direction: full graphical UI, deeper customization, more analytical insight, and a faster, broader funnel.

<p align="center">
  <img src="https://img.shields.io/badge/Fork_of-santifer%2Fcareer--ops-orange?style=flat" alt="Fork">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/Web_UI-orange?style=flat" alt="Web UI">
  <img src="https://img.shields.io/badge/Dashboard_TUI-blue?style=flat" alt="TUI">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
</p>

---

## What This Fork Is About

The original `career-ops` is a careful, "quality over quantity" filter — it deliberately tells you *not* to apply to anything below 4.0/5. That's a great philosophy for a senior IC who already has leverage.

This fork is for a different situation: **you want to cast a wider net, see more of the market, and make the system tell you what's actually worth chasing — visually.** Same evaluation engine underneath, very different posture on top.

What changed:

- **Full graphical UI** — a local web interface (`webui/`) on top of the existing terminal dashboard (`dashboard/`). Browse, filter, sort, evaluate, and act on offers from a browser. No more squinting at TSV files.
- **More aggressive funnel** — wider scanning, lower skip thresholds (configurable), and a pipeline view that surfaces *everything* and lets you triage fast instead of pre-filtering you down to 5 jobs.
- **Deeper customization** — extended profile schema, more scoring knobs, archetype overrides, and per-portal weighting you can tune from the GUI.
- **More insight** — analytics across your pipeline: rejection patterns, response-rate by company size / archetype / comp band, follow-up cadence, time-to-response heatmaps. The original ships analyzers; this fork promotes them to first-class GUI views.
- **Investor / outreach pipeline** — a parallel tracker for non-job outreach (advisors, investors, warm intros), because for a lot of people the job search is bundled with founder/consulting motion.

Everything in the upstream still works. `/career-ops`, evaluation modes, batch processing, ATS PDF generation, Greenhouse/Ashby/Lever scanning — all intact.

## Why "Aggressive"

Aggressive does **not** mean spam.

It means:

1. **Look at more of the market.** Don't pre-filter at the scanner. Score everything, sort visually, *then* decide.
2. **Faster cycle time.** GUI triage is seconds-per-listing instead of minutes. You see more, you decide more, you don't lose context.
3. **Lower the floor, not the bar.** You can override the 4.0/5 default if a 3.6 is in the right city or pays right or is a strategic stepping stone — but you do it with eyes open, with the score and the reasoning visible.
4. **Track outreach, not just applications.** Cold DMs, referrals, investor pitches, advisory calls — same pipeline, same dashboard.

The system still refuses to auto-submit anything. You always click the button. Recruiters' time still matters.

## Features

| Feature | Source | Status |
|---------|--------|--------|
| **Web UI** | this fork | local browser-based pipeline view |
| **Investor / outreach tracker** | this fork | parallel pipeline for non-job contacts |
| **Dashboard TUI** | upstream + extended | filter, sort, lazy-load previews |
| **A-F Evaluation** | upstream | 10-dimension scoring, archetype detection |
| **ATS PDF Generation** | upstream | tailored CVs per JD |
| **Portal Scanner** | upstream | 45+ companies on Greenhouse / Ashby / Lever |
| **Batch Processing** | upstream | parallel evals via headless workers |
| **Pipeline Integrity** | upstream | merge / dedup / status normalization |
| **Pattern Analysis** | upstream + GUI surface | response rates, rejection patterns |
| **Human-in-the-loop** | upstream | system never auto-submits |

## Quick Start

```bash
# Clone
git clone https://github.com/Slagathore/career-ops.git
cd career-ops && npm install
npx playwright install chromium

# Sanity check
npm run doctor

# Configure
cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml
# Create cv.md in the project root with your CV in markdown

# Open the AI agent in this directory and let it personalize the system
claude   # or: codex / gemini / opencode / qwen / copilot

# Build the GUIs
cd dashboard && go build -o dashboard . && cd ..
cd webui && go build -o webui . && cd ..

# Run the web UI
./webui/webui --path .
# Then open the URL it prints

# Or run the TUI
./dashboard/dashboard --path .
```

## Usage

The CLI surface is unchanged from upstream — the agent still drives evaluation, PDF generation, scanning, and batch processing. The GUIs are layered on top:

```
Web UI   → browse / filter / triage from your browser
TUI      → keyboard-driven pipeline view with grouping and previews
Agent    → /career-ops, paste a URL, paste a JD, batch-evaluate, scan
```

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide. All upstream slash commands work as documented in [AGENTS.md](AGENTS.md).

## Project Structure

```
career-ops/
├── webui/                       # NEW — local web GUI (Go + embedded HTML)
├── dashboard/                   # Extended TUI (investors screen added)
├── AGENTS.md                    # Canonical agent instructions
├── CLAUDE.md                    # Wrapper that imports AGENTS.md
├── modes/                       # Skill modes (eval, scan, batch, apply, ...)
├── templates/                   # CV templates, portals example, canonical states
├── batch/                       # Headless batch worker prompt and runner
├── data/                        # Tracking data (gitignored)
├── reports/                     # Evaluation reports (gitignored)
├── output/                      # Generated PDFs (gitignored)
├── config/profile.example.yml   # Profile template
└── docs/                        # Setup, customization, architecture
```

## Customization

Same rule as upstream: **personalization lives in user-layer files, never in system-layer files.** When you ask the agent to change archetypes, scoring weights, narrative, or negotiation scripts, it edits `modes/_profile.md` or `config/profile.yml` — so upstream pulls don't blow your settings away.

See [DATA_CONTRACT.md](DATA_CONTRACT.md) for the full split.

## Staying In Sync With Upstream

This fork tracks `santifer/career-ops` as `upstream`. To pull new system improvements:

```bash
git fetch upstream
git merge upstream/main
# resolve conflicts in modes/_shared.md, AGENTS.md, etc.
```

Your `cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/`, and `reports/` are all gitignored — they stay yours.

## Credits

The evaluation engine, modes, scanner, ATS template, batch system, and the entire `career-ops` foundation are by **[Santiago Fernández](https://santifer.io)** and the [contributors of santifer/career-ops](https://github.com/santifer/career-ops/graphs/contributors). This fork is a different posture on top of their work — go star the original.

The "career-ops" name is governed by the [upstream Trademark Policy](TRADEMARK.md).

## License

MIT, same as upstream. See [LICENSE](LICENSE).

## Disclaimer

Same caveats as upstream. This is a local tool. Your data stays on your machine. The agent does not auto-submit. AI evaluations are recommendations, not truth. You comply with the ToS of any portal you interact with. See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md).
