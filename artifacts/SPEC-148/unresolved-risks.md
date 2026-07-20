# SPEC-148 unresolved risks
- observationHash quality (collision resistance / stability) is the caller's responsibility; a poor hash could mask real progress as a stall or vice-versa. Mitigated by pairing with cursor. 0 critical risks in the counter core.
