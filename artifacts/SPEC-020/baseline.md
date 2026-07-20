# SPEC-020 Baseline — Admission bypass CI gate
No enforcement that the gateway is the only door. This spec adds an executable
scanner: outsiders must use public entrypoints (gateway/task-envelope), never
internal stage modules. Analogous to G01's forbidden-import gate. Zero model.
