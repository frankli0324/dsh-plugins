# Version test matrix (2026-10-29T08:24:25.119Z)

Baseline: cordis 4.0.5 · schemastery 3.18.5 · dsh-llm 0.2.1-rc.4. Tests: harness-base + harness-claude + harness-codex unit suites (mock CLIs).

| dsh-llm | cordis | schemastery | result | time |
|---|---|---|---|---|
| 0.2.1-rc.2 | 4.0.1 | 3.18.1 | FAIL (3) | 0.7s |
| 0.2.1-rc.2 | 4.0.1 | 3.18.6-alpha.1 | pass | 8.6s |
| 0.2.1-rc.2 | 4.0.6-alpha.1 | 3.18.1 | FAIL (3) | 0.7s |
| 0.2.1-rc.2 | 4.0.6-alpha.1 | 3.18.6-alpha.1 | pass | 8.6s |
| 0.2.2-alpha.2 | 4.0.1 | 3.18.1 | FAIL (3) | 0.7s |
| 0.2.2-alpha.2 | 4.0.1 | 3.18.6-alpha.1 | pass | 8.5s |
| 0.2.2-alpha.2 | 4.0.6-alpha.1 | 3.18.1 | FAIL (3) | 0.7s |
| 0.2.2-alpha.2 | 4.0.6-alpha.1 | 3.18.6-alpha.1 | pass | 8.5s |
| 0.2.1-rc.4 | 4.0.5 | 3.18.5 | pass | 8.6s |
