package com.almatraders.erp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OfficeCallPolicyTest {
    @Test fun ringingEndReasonDependsOnDirection() {
        assertEquals("CANCELLED", OfficeCallPolicy.localEndReason("RINGING", outgoing = true))
        assertEquals("DECLINED", OfficeCallPolicy.localEndReason("RINGING", outgoing = false))
        assertEquals("COMPLETED", OfficeCallPolicy.localEndReason("CONNECTED", outgoing = false))
    }

    @Test fun peerPromotionNeverSkipsAnsweredOrConnecting() {
        assertNull(OfficeCallPolicy.nextPeerPromotion("RINGING"))
        assertEquals("CONNECTING", OfficeCallPolicy.nextPeerPromotion("ANSWERED"))
        assertEquals("CONNECTED", OfficeCallPolicy.nextPeerPromotion("CONNECTING"))
        assertEquals("CONNECTED", OfficeCallPolicy.nextPeerPromotion("RECONNECTING"))
    }

    @Test fun peerLossOnlyReconnectsAnEstablishedCallWithNoPeer() {
        assertTrue(OfficeCallPolicy.shouldBeginReconnect("CALLING", 0))
        assertFalse(OfficeCallPolicy.shouldBeginReconnect("RINGING", 0))
        assertFalse(OfficeCallPolicy.shouldBeginReconnect("CALLING", 1))
    }

    @Test fun isoParserSupportsProviderTimestampsOnApi24() {
        assertEquals(1_784_311_445_123L, OfficeCallTime.parseMillis("2026-07-17T18:04:05.123Z"))
        assertNull(OfficeCallTime.parseMillis("not-a-time"))
    }
}
