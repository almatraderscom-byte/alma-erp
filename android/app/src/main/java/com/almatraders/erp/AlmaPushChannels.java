package com.almatraders.erp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;

/** Native Android channel for Alma ERP push (HIGH importance, lock-screen visible). */
public final class AlmaPushChannels {
    public static final String ALMA_ALERTS_ID = "alma_alerts";

    private AlmaPushChannels() {}

    public static void ensureCreated(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel existing = manager.getNotificationChannel(ALMA_ALERTS_ID);
        if (existing != null) return;

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
        manager.createNotificationChannel(channel);
    }
}
