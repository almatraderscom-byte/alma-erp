package com.almatraders.erp;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.almatraders.erp.shell.NativeShell;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AlmaPushChannels.ensureCreated(this);
        super.onCreate(savedInstanceState);

        // ALMA native shell (Compose tab bar + native Lifestyle screens wrapping the
        // Capacitor app — Android twin of the iOS SwiftUI program). Behind the
        // "Native স্ক্রিন" flag (default ON); OFF = the plain Capacitor app as before.
        NativeShell.install(this);

        // Voice input (the ALMA assistant orb) drives the WebView's getUserMedia.
        // Capacitor's WebChromeClient only grants that audio-capture request when
        // the app ALREADY holds the Android RECORD_AUDIO runtime permission. No
        // other code path requests it, so on Android 6+ it stays denied and
        // getUserMedia throws NotAllowedError — voice fails while typing still
        // works (exactly the reported bug). Request it once on launch so the OS
        // prompts the user; after Allow, voice works.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this, new String[]{ Manifest.permission.RECORD_AUDIO }, 7321);
        }
    }
}
