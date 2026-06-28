#!/usr/bin/env python3
"""Generate the three headline figures for PAPER.md from the audited benchmark numbers.
All values are read from the committed .arbor artifacts (see PAPER.md appendix)."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import os

OUT = os.path.dirname(os.path.abspath(__file__))
plt.rcParams.update({"font.size": 11, "figure.dpi": 140, "savefig.bbox": "tight"})
ID_COLOR = "#1f6f3f"     # intelligent db green
BLIND_COLOR = "#b0b0b0"  # trust-blind grey
ACCENT = "#c0392b"       # red for "raw / breached"

# --- Figure 1: Sybil resistance (poison-correct rate, /24) -------------------
engines = ["node:sqlite", "better-sqlite3", "lmdb", "duckdb", "vector-\nbruteforce",
           "Qdrant", "pgvector", "Redis", "Intelligent\nDB"]
correct = [0, 0, 0, 0, 0, 0, 0, 0, 24]
colors = [BLIND_COLOR]*8 + [ID_COLOR]
fig, ax = plt.subplots(figsize=(8.2, 3.8))
bars = ax.bar(engines, correct, color=colors, edgecolor="black", linewidth=0.6)
ax.set_ylabel("Poison-correct trials (/24)")
ax.set_title("Sybil-corroboration resistance: 9 systems under a poisoning attack")
ax.set_ylim(0, 26)
for b, v in zip(bars, correct):
    ax.text(b.get_x()+b.get_width()/2, v+0.4, f"{v}/24", ha="center", fontsize=9,
            fontweight="bold" if v else "normal")
ax.axhline(24, ls="--", lw=0.8, color=ID_COLOR, alpha=0.5)
plt.xticks(rotation=30, ha="right", fontsize=9)
fig.text(0.5, -0.06, "All 8 trust-blind stores answer the false majority; only Intelligent DB resists "
         "(contingent on the external independence signal).", ha="center", fontsize=8.5, style="italic")
fig.savefig(os.path.join(OUT, "fig1_sybil_resistance.png"))
plt.close(fig)

# --- Figure 2: Flat recall latency vs memory size ---------------------------
sizes = ["1k", "10k", "100k", "1M"]
x = range(len(sizes))
p50 = [1.925, 1.905, 1.912, 2.081]
p99 = [2.285, 2.497, 2.788, 3.658]
fig, ax = plt.subplots(figsize=(7.4, 3.8))
ax.plot(x, p50, "-o", color=ID_COLOR, lw=2, label="recall p50 (ms)")
ax.plot(x, p99, "--s", color="#2980b9", lw=1.6, label="recall p99 (ms)")
ax.fill_between(x, p50, p99, color=ID_COLOR, alpha=0.07)
ax.set_xticks(list(x)); ax.set_xticklabels(sizes)
ax.set_xlabel("Stored facts (1000x growth left to right)")
ax.set_ylabel("Recall latency (ms)")
ax.set_title("Recall is O(local web), not O(total memory)")
ax.set_ylim(0, 10)
ax.axhline(10, ls=":", lw=0.8, color="grey")
ax.text(0.05, 9.2, "10 ms ceiling (never reached)", fontsize=8, color="grey")
for xi, v in zip(x, p50):
    ax.text(xi, v-0.55, f"{v:.2f}", ha="center", fontsize=8.5, color=ID_COLOR)
ax.legend(loc="upper left", fontsize=9, frameon=False)
fig.text(0.5, -0.04, "Lit-set fixed at ~77 strands across all sizes: recall p50 moves 1.93->2.08 ms over a 1000x data increase.",
         ha="center", fontsize=8.5, style="italic")
fig.savefig(os.path.join(OUT, "fig2_flat_recall.png"))
plt.close(fig)

# --- Figure 3: Contradiction integrity, raw vs adjudicated ------------------
models = ["qwen2.5:7b", "llama3.1:8b"]
raw = [0.00, 0.15]
adj = [0.95, 1.00]
xi = range(len(models)); w = 0.34
fig, ax = plt.subplots(figsize=(6.8, 3.8))
b1 = ax.bar([i-w/2 for i in xi], raw, w, label="Raw retrieval (Sybil majority)", color=ACCENT, edgecolor="black", linewidth=0.6)
b2 = ax.bar([i+w/2 for i in xi], adj, w, label="Intelligent DB (adjudicated)", color=ID_COLOR, edgecolor="black", linewidth=0.6)
ax.set_xticks(list(xi)); ax.set_xticklabels(models)
ax.set_ylabel("Answer accuracy (fraction correct)")
ax.set_title("Answer integrity under a Sybil flood (n=20, K=5)")
ax.set_ylim(0, 1.15)
for bars in (b1, b2):
    for b in bars:
        ax.text(b.get_x()+b.get_width()/2, b.get_height()+0.02, f"{b.get_height():.2f}", ha="center", fontsize=9, fontweight="bold")
ax.legend(loc="upper center", fontsize=9, frameon=False, ncol=1)
fig.text(0.5, -0.04, "Same underlying memory; routing it through Intelligent DB's adjudication recovers correct answers both readers got wrong raw.",
         ha="center", fontsize=8.2, style="italic")
fig.savefig(os.path.join(OUT, "fig3_contradiction_integrity.png"))
plt.close(fig)

print("wrote:", [f for f in os.listdir(OUT) if f.endswith(".png")])
