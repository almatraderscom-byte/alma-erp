# SPEC-147 cost before/after
Zero model/tool/USD in the transform. It REDUCES downstream model input tokens (element cap + label truncation + byte ceiling), i.e. a cost DECREASE for the perception fed to the model. Latency in-memory. Outcome rate 21/21. No regression.
