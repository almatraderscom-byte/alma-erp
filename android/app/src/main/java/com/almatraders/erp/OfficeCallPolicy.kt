package com.almatraders.erp

/** Pure client policy kept independently testable from Android/Agora classes. */
object OfficeCallPolicy {
    fun localEndReason(canonicalState: String, outgoing: Boolean): String =
        if (canonicalState == "RINGING") {
            if (outgoing) "CANCELLED" else "DECLINED"
        } else {
            "COMPLETED"
        }

    /** Next legal server transition after peer media appears. Null means wait. */
    fun nextPeerPromotion(canonicalState: String): String? = when (canonicalState) {
        "ANSWERED" -> "CONNECTING"
        "CONNECTING", "RECONNECTING" -> "CONNECTED"
        "CONNECTED" -> "CONNECTED"
        else -> null
    }

    fun shouldBeginReconnect(mode: String, remainingRemotePeers: Int): Boolean =
        remainingRemotePeers == 0 && (mode == "CALLING" || mode == "RECONNECTING")
}
