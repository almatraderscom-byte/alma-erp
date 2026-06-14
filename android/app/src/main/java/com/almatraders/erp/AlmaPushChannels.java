package com.almatraders.erp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/** Native Android channel for Alma ERP push (HIGH importance, lock-screen visible, notification sound). */
public final class AlmaPushChannels {
    public static final String ALMA_ALERTS_ID = "alma_alerts";

    private AlmaPushChannels() {}

    public static void ensureCreated(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel existing = manager.getNotificationChannel(ALMA_ALERTS_ID);
        if (existing != null) {
            // Recreate if an older build left the channel without sound.
            if (existing.getSound() != null) return;
            manager.deleteNotificationChannel(ALMA_ALERTS_ID);
        }

        NotificationChannel channel = new NotificationChannel(
                ALMA_ALERTS_ID,
                "Alma Alerts",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Important Alma ERP alerts for staff");
        channel.enableLights(true);
        channel.setLightColor(Color.parseColor("#C9A84C"));
        channel.enableVibration(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        Uri soundUri = resolveNotificationSound(context);
        channel.setSound(
                soundUri,
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
        );

        manager.createNotificationChannel(channel);
    }

    /** Custom alma_alert in res/raw if present; otherwise system default notification tone. */
    private static Uri resolveNotificationSound(Context context) {
        int customId = context.getResources().getIdentifier("alma_alert", "raw", context.getPackageName());
        if (customId != 0) {
            return Uri.parse("android.resource://" + context.getPackageName() + "/" + customId);
        }
        Uri fallback = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return fallback != null ? fallback : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    }
}
