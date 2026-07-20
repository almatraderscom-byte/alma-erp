# SPEC-141 unresolved risks
- Durable persistence of `QueueState` is out of scope for this deterministic core — a real deployment must back it with the durable store (Redis/DB) behind the same value-transform seam. No correctness risk to the core; noted for wiring specs.
- No critical unresolved risks. 0 blockers.
