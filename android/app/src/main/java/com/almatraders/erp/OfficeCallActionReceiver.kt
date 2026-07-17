package com.almatraders.erp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.almatraders.erp.pages.AgoraIntercom

/** Unique, immutable notification actions routed into the process coordinator. */
class OfficeCallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AgoraIntercom.attach(context.applicationContext)
        val callId = intent.getStringExtra(CallNotifications.EXTRA_BROADCAST_ID).orEmpty()
        if (callId.isBlank()) return
        val action = when (intent.action) {
            ACTION_ANSWER -> "answer"
            ACTION_DECLINE -> "decline"
            ACTION_HANG_UP -> "hangup"
            else -> return
        }
        val pending = goAsync()
        AgoraIntercom.handleNotificationAction(callId, action) { pending.finish() }
    }

    companion object {
        const val ACTION_ANSWER = "com.almatraders.erp.officecall.ANSWER"
        const val ACTION_DECLINE = "com.almatraders.erp.officecall.DECLINE"
        const val ACTION_HANG_UP = "com.almatraders.erp.officecall.HANG_UP"
    }
}
