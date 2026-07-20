# SPEC-158 Unresolved Risks
1. Timeout is a deterministic post-hoc elapsed check; a hard in-flight abort
   (AbortController) is a documented production seam.
2. Quota is in-memory per process; a shared/distributed quota store is a seam.
No unresolved **critical** risks. Count: 0.
