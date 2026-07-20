# SPEC-071 — Cost before/after

| metric              | before | after | delta |
|---------------------|--------|-------|-------|
| model calls         | 0      | 0     | 0     |
| input tokens        | 0      | 0     | 0     |
| cached input tokens | 0      | 0     | 0     |
| output/reasoning tk | 0      | 0     | 0     |
| tool calls          | 0      | 0     | 0     |
| estimated USD       | 0      | 0     | 0     |
| actual USD          | 0      | 0     | 0     |
| latency (query)     | n/a    | O(1)–O(n) in-memory | negligible |

The inventory boundary performs **zero** model/provider/network/DB calls at
runtime (INV-01, INV-03). Query latency is a Map lookup (`get`) or a single pass
over 326 rows (`byX`/`summary`) — sub-millisecond, no I/O.

The dev-time generator (`build-inventory.ts`) imports the monolith once; it never
runs in production and adds no request-path cost.

No cost increase. PASS.
