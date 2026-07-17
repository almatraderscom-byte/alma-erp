package com.almatraders.erp

import android.content.Context
import android.annotation.SuppressLint
import android.net.Uri
import android.os.Build
import android.telecom.DisconnectCause
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import com.almatraders.erp.pages.AgoraIntercom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Process-level Android Telecom owner for Office calls. Compose screens and
 * notification receivers issue intents to this object; they never own a call.
 */
object OfficeCallTelecom {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @SuppressLint("StaticFieldLeak") // CallsManager receives applicationContext only; process ownership is intentional.
    private var manager: CallsManager? = null
    private var addCallJob: Job? = null
    private var control: CallControlScope? = null
    private var registeredCallId: String? = null
    private var availableEndpoints: List<CallEndpointCompat> = emptyList()
    private var pendingAnswer = false
    private var pendingActive = false
    private var pendingDisconnect: DisconnectCause? = null

    fun initialize(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        if (manager != null) return
        runCatching {
            CallsManager(context.applicationContext).also {
                it.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
            }
        }.onSuccess {
            manager = it
        }.onFailure {
            AgoraIntercom.onTelecomFailure("", it.message ?: it.javaClass.simpleName)
        }
    }

    fun reportCall(context: Context, callId: String, peer: String, incoming: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        initialize(context)
        if (registeredCallId == callId && addCallJob?.isActive == true) return
        clearLocalRegistration()
        registeredCallId = callId
        val direction = if (incoming) {
            CallAttributesCompat.DIRECTION_INCOMING
        } else {
            CallAttributesCompat.DIRECTION_OUTGOING
        }
        val attributes = CallAttributesCompat(
            peer,
            Uri.parse("almaerp://office/calls/$callId"),
            direction,
            CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            CallAttributesCompat.SUPPORTS_SET_INACTIVE,
        )
        val callsManager = manager ?: run {
            AgoraIntercom.onTelecomFailure(callId, "telecom_registration_failed")
            clearLocalRegistration(callId)
            return
        }
        addCallJob = scope.launch {
            runCatching {
                callsManager.addCall(
                    attributes,
                    onAnswer = { _ -> AgoraIntercom.answerFromSystem(callId) },
                    onDisconnect = { cause ->
                        AgoraIntercom.endFromSystem(callId, reasonFor(cause))
                    },
                    onSetActive = { AgoraIntercom.onTelecomActive() },
                    onSetInactive = { AgoraIntercom.onTelecomInactive() },
                    block = {
                        val callControl = this
                        control = callControl
                        if (pendingAnswer) {
                            pendingAnswer = false
                            scope.launch { callControl.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) }
                        }
                        if (pendingActive) {
                            pendingActive = false
                            scope.launch { callControl.setActive() }
                        }
                        pendingDisconnect?.let { cause ->
                            pendingDisconnect = null
                            scope.launch { performDisconnect(callId, callControl, cause) }
                        }
                        callControl.launch {
                            callControl.currentCallEndpoint.collectLatest {
                                AgoraIntercom.onAudioEndpointChanged(it.type, it.name.toString())
                            }
                        }
                        callControl.launch {
                            callControl.availableEndpoints.collectLatest { endpoints ->
                                OfficeCallTelecom.availableEndpoints = endpoints
                            }
                        }
                        callControl.launch {
                            callControl.isMuted.collectLatest { muted ->
                                AgoraIntercom.setMutedFromSystem(muted)
                            }
                        }
                    },
                )
            }.onFailure { error ->
                if (error is CancellationException) return@onFailure
                AgoraIntercom.onTelecomFailure(callId, error.message ?: error.javaClass.simpleName)
                clearLocalRegistration(callId)
            }
        }
    }

    fun answer(callId: String) {
        if (registeredCallId != callId) return
        val current = control
        if (current == null) pendingAnswer = true
        else scope.launch { current.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) }
    }

    fun setActive(callId: String) {
        if (registeredCallId != callId) return
        val current = control
        if (current == null) pendingActive = true
        else scope.launch { current.setActive() }
    }

    fun disconnect(callId: String, reason: String) {
        if (registeredCallId != callId) return
        val cause = when (reason) {
            "DECLINED" -> DisconnectCause(DisconnectCause.REJECTED)
            "CANCELLED" -> DisconnectCause(DisconnectCause.CANCELED)
            "COMPLETED" -> DisconnectCause(DisconnectCause.LOCAL)
            "MISSED", "TIMED_OUT" -> DisconnectCause(DisconnectCause.MISSED)
            "BUSY" -> DisconnectCause(DisconnectCause.BUSY)
            else -> DisconnectCause(DisconnectCause.ERROR)
        }
        val current = control
        if (current == null) pendingDisconnect = cause
        else scope.launch { performDisconnect(callId, current, cause) }
    }

    @androidx.annotation.RequiresApi(26)
    fun requestSpeaker(enabled: Boolean) {
        val target = if (enabled) {
            availableEndpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }
        } else {
            availableEndpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_BLUETOOTH }
                ?: availableEndpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_WIRED_HEADSET }
                ?: availableEndpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_EARPIECE }
        } ?: return
        scope.launch { control?.requestEndpointChange(target) }
    }

    fun finish(callId: String) = clearLocalRegistration(callId)

    private fun clearLocalRegistration(callId: String? = null) {
        if (callId != null && registeredCallId != callId) return
        addCallJob?.cancel()
        addCallJob = null
        control = null
        registeredCallId = null
        availableEndpoints = emptyList()
        pendingAnswer = false
        pendingActive = false
        pendingDisconnect = null
    }

    private suspend fun performDisconnect(callId: String, current: CallControlScope, cause: DisconnectCause) {
        val result = current.disconnect(cause)
        if (result is CallControlResult.Error) {
            AgoraIntercom.onTelecomFailure(callId, "disconnect_failed")
        }
        clearLocalRegistration(callId)
    }

    private fun reasonFor(cause: DisconnectCause): String = when (cause.code) {
        DisconnectCause.REJECTED -> "DECLINED"
        DisconnectCause.CANCELED -> "CANCELLED"
        DisconnectCause.LOCAL, DisconnectCause.REMOTE -> "COMPLETED"
        else -> "FAILED"
    }
}
