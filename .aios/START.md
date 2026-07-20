# START — Alma ERP AIOS

## Group execution

A coding session receives only:

```text
Read .aios/START.md
RUN GROUP G01
```

The session must then read:

1. repository `CLAUDE.md`
2. repository `CODING_STANDARDS.md`
3. `.aios/GLOBAL_AGENT_CONTRACT.md`
4. `.aios/PARALLEL_GROUP_PLAN.md`
5. `.aios/G01/RUNNER.md`
6. all ten specs inside `.aios/G01/`

A group session executes its ten specs sequentially and stops after group certification.

## Wave integration

```text
Read .aios/START.md
INTEGRATE WAVE 1
```

The integration session must read `.aios/WAVE_INTEGRATOR.md`.

## Stop conditions

Stop on any PARTIAL/FAIL verdict, ownership conflict, failed rollback, missing proof, architecture bypass, unmeasured cost regression, or unmet prerequisite.
