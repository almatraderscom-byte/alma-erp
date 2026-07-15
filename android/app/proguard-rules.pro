# ALMA ERP — R8 keep rules for the release (minified + resource-shrunk) build.
#
# The app is a Capacitor shell: Capacitor discovers plugins and bridges JS↔native
# by REFLECTION and annotations, so those classes/members must survive R8 or the
# WebView bridge (login, push, camera, voice, intercom …) breaks at runtime. Native
# libs (Agora, OneSignal) call back into Java by name via JNI — keep them whole.
# Third-party AndroidX/OkHttp/Coil/Kotlin libs ship their own consumer rules; the
# entries here cover Capacitor, our own reflection entry points, and defensive dontwarns.

# ── Capacitor core + plugins (reflection + @CapacitorPlugin / @PluginMethod) ──
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep class org.apache.cordova.** { *; }

# JS → native bridges exposed to the WebView.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── Our own reflection entry points ──
# WorkManager instantiates the worker by class name via the default WorkerFactory.
-keep class com.almatraders.erp.ReminderRefreshWorker { <init>(...); }
# (MainActivity + ReminderAlarmReceiver + AlmaPushChannels are manifest components →
#  AGP keeps them automatically.)
#
# OneSignal loads the notification service extension REFLECTIVELY (Class.newInstance)
# from the <meta-data android:value="..."> class NAME — a plain string AGP can't see as
# a class reference. R8 therefore found no caller and stripped the no-arg constructor,
# so OneSignal's init threw
#     InstantiationException: ... has no zero argument constructor
# which aborted bootstrapServices ENTIRELY: no FCM token was ever minted, so the app
# received NO pushes at all (calls included). Keep the class AND its constructor.
-keep class * implements com.onesignal.notifications.INotificationServiceExtension { <init>(); *; }
-keep class com.almatraders.erp.CallNotificationExtension { <init>(); *; }

# ── Native SDKs that call back via JNI / reflection ──
-keep class io.agora.** { *; }
-dontwarn io.agora.**
-keep class com.onesignal.** { *; }
-dontwarn com.onesignal.**

# ── Defensive dontwarns for optional deps referenced by OkHttp/Okio/etc. ──
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**

# Keep crash-trace line info (renamed via mapping.txt).
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,Exceptions,InnerClasses
-renamesourcefileattribute SourceFile
