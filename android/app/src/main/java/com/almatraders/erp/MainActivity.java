package com.almatraders.erp;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import java.util.ArrayList;
import java.util.List;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.almatraders.erp.shell.NativeShell;
import com.almatraders.erp.pages.AgoraIntercom;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AlmaPushChannels.ensureCreated(this);
        // Background reminder refresh (iOS BackgroundRefresh parity): keep the owner's
        // reminders fresh + scheduled even if the app isn't opened for days.
        ReminderRefresh.INSTANCE.enqueue(this);
        // Refresh/register the direct FCM token on every launch. Registration is
        // installation-bound and retried by WorkManager after login/network recovery.
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token ->
                OfficeCallPushRegistration.INSTANCE.enqueue(this, token));
        super.onCreate(savedInstanceState);
        AgoraIntercom.INSTANCE.attach(getApplicationContext());

        // ALMA native shell (Compose tab bar + native Lifestyle screens wrapping the
        // Capacitor app — Android twin of the iOS SwiftUI program). Behind the
        // "Native স্ক্রিন" flag (default ON); OFF = the plain Capacitor app as before.
        NativeShell.install(this);

        // Runtime permissions requested once on launch:
        //  • RECORD_AUDIO — the ALMA voice orb + WebView getUserMedia. Capacitor's
        //    WebChromeClient only grants the web audio-capture request when the app
        //    ALREADY holds this, so without it voice fails with NotAllowedError.
        //  • POST_NOTIFICATIONS (Android 13+) — WITHOUT it every notification (OneSignal
        //    push AND the native reminder alarms) is silently dropped. This was missing,
        //    so push/reminders never showed on Android 13+ devices. Request both together.
        List<String> needed = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), 7321);
        }
    }
}
