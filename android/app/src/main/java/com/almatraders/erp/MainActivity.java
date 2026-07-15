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

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AlmaPushChannels.ensureCreated(this);
        // Background reminder refresh (iOS BackgroundRefresh parity): keep the owner's
        // reminders fresh + scheduled even if the app isn't opened for days.
        ReminderRefresh.INSTANCE.enqueue(this);
        super.onCreate(savedInstanceState);

        // Bring up OneSignal from NATIVE code. It used to be initialised only by a React
        // component inside the WebView, which a native-first shell never renders — so the
        // SDK logged "no appId provided", never registered, and every Android push was
        // dropped. See NativePush for the full story.
        com.almatraders.erp.shell.NativePush.INSTANCE.init(this);
        com.almatraders.erp.shell.AlmaSession.INSTANCE.attach(this);
        // Android 14+ needs a separate grant before a call can take over the screen.
        com.almatraders.erp.shell.NativePush.INSTANCE.ensureFullScreenCallAccess(this);

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
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), 7321);
        }
    }
}
