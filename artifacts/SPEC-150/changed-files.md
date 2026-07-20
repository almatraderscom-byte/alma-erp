# SPEC-150 changed files
```
 src/agent/browser-runtime/__tests__/chaos.test.ts |  20 +++
 src/agent/browser-runtime/chaos.ts                | 114 +++++++++++++++++
 src/agent/browser-runtime/index.ts                |   1 +
 src/worker/queues/__tests__/chaos.test.ts         |  20 +++
 src/worker/queues/chaos.ts                        | 148 ++++++++++++++++++++++
 src/worker/queues/index.ts                        |   1 +
 6 files changed, 304 insertions(+)
```
Additive across both owned zones (chaos.ts + chaos.test.ts + barrels). No pre-existing base file touched.
