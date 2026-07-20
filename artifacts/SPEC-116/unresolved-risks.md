# SPEC-116 Unresolved Risks
Critical unresolved risks: **0**.

Notes: destination/rowCount/sensitive are read from the action descriptor (populated by the gateway from validated args). Every unknown fails closed (require_approval), so a missing scope or destination can never leak data autonomously.
