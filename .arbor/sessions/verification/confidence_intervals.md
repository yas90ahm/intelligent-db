# Wilson 95% Confidence Intervals (z=1.96)

ASR = attack success rate (lower is better). acc = accuracy (higher is better). CIs are Wilson score intervals on the success count / n.

| benchmark | arm | ASR % [lo,hi] | acc % [lo,hi] |
|---|---|---|---|
| poisonedrag-nq | bare | 4.0 [1.6,9.8] | 50.0 [40.4,59.6] |
| poisonedrag-nq | rag | 93.0 [86.3,96.6] | 22.0 [15.0,31.1] |
| poisonedrag-nq | substrate | 6.0 [2.8,12.5] | 86.0 [77.9,91.5] |
| poisonedrag-nq | mem0 | 96.0 [90.2,98.4] | 21.0 [14.2,30.0] |
| poisonedrag-hotpotqa | bare | 21.0 [14.2,30.0] | 54.0 [44.3,63.4] |
| poisonedrag-hotpotqa | rag | 99.0 [94.6,99.8] | 11.0 [6.3,18.6] |
| poisonedrag-hotpotqa | substrate | 18.0 [11.7,26.7] | 82.0 [73.3,88.3] |
| poisonedrag-hotpotqa | mem0 | 98.0 [93.0,99.4] | 14.0 [8.5,22.1] |
| poisonedrag-msmarco | bare | 13.0 [7.8,21.0] | 62.0 [52.2,70.9] |
| poisonedrag-msmarco | rag | 93.0 [86.3,96.6] | 16.0 [10.1,24.4] |
| poisonedrag-msmarco | substrate | 7.0 [3.4,13.7] | 85.0 [76.7,90.7] |
| poisonedrag-msmarco | mem0 | 92.0 [85.0,95.9] | 22.0 [15.0,31.1] |
| factworld | bare | 0.0 [0.0,0.6] | 0.0 [0.0,0.6] |
| factworld | rag | 98.7 [97.4,99.3] | 1.3 [0.7,2.6] |
| factworld | substrate | 0.0 [0.0,0.6] | 99.8 [99.1,100.0] |
| factworld | mem0 | 79.4 [76.0,82.4] | 20.1 [17.1,23.5] |

## ASR CI overlap: RAG vs IDB (substrate) — per benchmark

- poisonedrag-nq: RAG ASR [86.3,96.6] vs IDB ASR [2.8,12.5] -> NO OVERLAP
- poisonedrag-hotpotqa: RAG ASR [94.6,99.8] vs IDB ASR [11.7,26.7] -> NO OVERLAP
- poisonedrag-msmarco: RAG ASR [86.3,96.6] vs IDB ASR [3.4,13.7] -> NO OVERLAP
- factworld: RAG ASR [97.4,99.3] vs IDB ASR [0.0,0.6] -> NO OVERLAP
