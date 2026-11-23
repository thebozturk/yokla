### yokla

Run `run-1` against `t`.

- 9 cases: pass 2, fail 3, error 1, known-gap 1, gap-closed 1, unmeasured 1; pass rate 0.500 (3 of 6, 95 % 0.188 to 0.812)
- 1 proposed: they ran, and gate once a person sets their status to approved

| Status | Case | Why |
| --- | --- | --- |
| fail | `high-chair` | filter-honesty 1/1: presents 7 product(s) of other types |
| fail | `bitcoin` | refusal 2/3: did not refuse [unstable] |
| error | `broken` | sample 0, turn 0: HTTP 500 |
| unmeasured | `zibin` | no check applied to any turn |
| known-gap | `gift-wrap` | known gap: not built yet (T-12) |
| gap-closed | `pacifier` | passes now; remove the known-gap marker and update the baseline |
| advisory | `returns` | deflection 1/1: sent only to customer service |
| fail | `draft` | request 1/1: showed \| cards again [proposed] [tags: search] |

**Errors**

- broken [sample 0]: HTTP 500
- run: logs unreadable

<details><summary>More about the run</summary>

```text
by tag:
  search  1 case: fail 1; pass rate 0.000 (0 of 1, 95 % 0.000 to 0.793)
```

</details>
