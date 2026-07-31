package app.hostdeck.talkbackobserver;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@SuppressWarnings("deprecation")
public final class HostDeckTalkBackObserver {
  private static final String CHROME_PACKAGE = "com.android.chrome";
  private static final String PERMISSION_PACKAGE_SUFFIX = ".permissioncontroller";
  private static final int MAX_EVENTS = 128;
  private static final int MAX_COORDINATE = 10_000;
  private static final long MAX_RUNTIME_MS = 240_000;
  private static final String SESSION_NAME = "physical-pairing-review";

  private final AtomicInteger sequence = new AtomicInteger();
  private final AtomicBoolean overflowed = new AtomicBoolean();

  private HostDeckTalkBackObserver() {}

  public static void main(String[] args) {
    if (args.length != 0) {
      fixedError("arguments");
      return;
    }
    HostDeckTalkBackObserver observer = new HostDeckTalkBackObserver();
    observer.run();
  }

  private void run() {
    Object connection = null;
    UiAutomation automation = null;
    try {
      Looper.prepareMainLooper();
      connection = newConnection();
      automation = newAutomation(connection);
      invoke(automation, "connect", new Class<?>[] {int.class},
          UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
      automation.setOnAccessibilityEventListener(this::onAccessibilityEvent);
      fixedOutput("HOSTDECK_OBSERVER_READY");
      Thread timeout = new Thread(this::awaitTimeout, "HostDeckTalkBackObserverTimeout");
      timeout.setDaemon(true);
      timeout.start();
      Looper.loop();
      automation.setOnAccessibilityEventListener(null);
    } catch (Throwable error) {
      fixedError("runtime");
    } finally {
      disconnect(automation);
      shutdown(connection);
    }
  }

  private void awaitTimeout() {
    try {
      Thread.sleep(MAX_RUNTIME_MS);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      return;
    }
    fixedError("timeout");
    quitMainLooper();
  }

  private static void quitMainLooper() {
    Looper main = Looper.getMainLooper();
    if (main != null) main.quitSafely();
  }

  private void onAccessibilityEvent(AccessibilityEvent event) {
    int type = event.getEventType();
    if (type != AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED
        && type != AccessibilityEvent.TYPE_VIEW_CLICKED) {
      return;
    }
    String packageName = chars(event.getPackageName());
    if (!CHROME_PACKAGE.equals(packageName) && !isPermissionPackage(packageName)) {
      return;
    }
    int current = sequence.incrementAndGet();
    if (current > MAX_EVENTS) {
      if (overflowed.compareAndSet(false, true)) {
        fixedOutput("HOSTDECK_OBSERVER_OVERFLOW");
      }
      return;
    }
    AccessibilityNodeInfo source = event.getSource();
    Rect bounds = new Rect();
    if (source != null) source.getBoundsInScreen(bounds);
    String kind = type == AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED
        ? "focus"
        : "click";
    try {
      fixedOutput(
          "HOSTDECK_EVENT="
              + current
              + "|" + kind
              + "|" + classify(packageName, event, source)
              + "|" + classCategory(source)
              + "|" + flag(source != null && source.isClickable())
              + "|" + flag(source != null && source.isEnabled())
              + "|" + flag(source != null && source.isFocusable())
              + "|" + flag(source != null && source.isVisibleToUser())
              + "|" + bounded(bounds.left)
              + "|" + bounded(bounds.top)
              + "|" + bounded(bounds.right)
              + "|" + bounded(bounds.bottom));
    } finally {
      if (source != null) source.recycle();
    }
  }

  private static Object newConnection() throws Exception {
    Class<?> type = Class.forName("android.app.UiAutomationConnection");
    Constructor<?> constructor = type.getDeclaredConstructor();
    constructor.setAccessible(true);
    return constructor.newInstance();
  }

  private static UiAutomation newAutomation(Object connection) throws Exception {
    for (Constructor<?> constructor : UiAutomation.class.getDeclaredConstructors()) {
      Class<?>[] parameters = constructor.getParameterTypes();
      if (parameters.length == 2
          && parameters[0] == Looper.class
          && parameters[1].isInstance(connection)) {
        constructor.setAccessible(true);
        return (UiAutomation) constructor.newInstance(Looper.getMainLooper(), connection);
      }
    }
    throw new IllegalStateException("Unsupported UiAutomation constructor.");
  }

  private static Object invoke(
      Object target,
      String name,
      Class<?>[] parameterTypes,
      Object... arguments) throws Exception {
    Method method = target.getClass().getDeclaredMethod(name, parameterTypes);
    method.setAccessible(true);
    return method.invoke(target, arguments);
  }

  private static void disconnect(UiAutomation automation) {
    if (automation == null) return;
    try {
      invoke(automation, "disconnect", new Class<?>[0]);
    } catch (Throwable ignored) {
      fixedError("disconnect");
    }
  }

  private static void shutdown(Object connection) {
    if (connection == null) return;
    try {
      invoke(connection, "shutdown", new Class<?>[0]);
    } catch (Throwable ignored) {
      fixedError("shutdown");
    }
  }

  private static String classify(
      String packageName,
      AccessibilityEvent event,
      AccessibilityNodeInfo source) {
    if (isPermissionPackage(packageName)) {
      return hasExactLabel(event, source, "Deny") ? "platform_deny" : "platform_permission";
    }
    if (source == null) return "unknown";
    String viewId = source == null ? "" : chars(source.getViewIdResourceName());
    if (viewId.startsWith("com.android.chrome:id/")) return "chrome_control";
    if (hasExactLabel(event, source, "Mission Control")) return "mission_control";
    if (hasAnyExactLabel(
        event,
        source,
        "Host and access status",
        "Remote ready",
        "Remote access ready",
        "Read & write",
        "Write")) {
      return "remote_status";
    }
    if (hasExactLabel(event, source, SESSION_NAME)) {
      return source.isClickable() ? "selected_session" : "session_detail";
    }
    if (hasAnyExactLabel(event, source, SESSION_NAME + " activity", "Session Detail")) {
      return "session_detail";
    }
    if (hasAnyExactLabel(
        event,
        source,
        "Approved once",
        "Approved",
        "The selected request was approved once.")) {
      return "approval_result";
    }
    if (hasExactLabel(event, source, "/model for " + SESSION_NAME)) return "model_trigger";
    if (hasExactLabel(event, source, "/model")) return "model_dialog";
    if (hasExactLabel(event, source, "Close model control")) return "model_close";
    if (hasExactLabel(event, source, "Model settings")) return "model_settings";
    if (hasAnyExactLabel(event, source, "Model state", "Current", "No pending change")) {
      return "model_state";
    }
    if (hasExactLabel(event, source, "Back to Mission Control")) return "back_to_mission";
    return "known_hostdeck";
  }

  private static boolean isPermissionPackage(String packageName) {
    return packageName.endsWith(PERMISSION_PACKAGE_SUFFIX);
  }

  private static boolean hasAnyExactLabel(
      AccessibilityEvent event,
      AccessibilityNodeInfo source,
      String... labels) {
    for (String label : labels) {
      if (hasExactLabel(event, source, label)) return true;
    }
    return false;
  }

  private static boolean hasExactLabel(
      AccessibilityEvent event,
      AccessibilityNodeInfo source,
      String expected) {
    if (expected.equals(chars(event.getContentDescription()))) return true;
    List<CharSequence> eventText = event.getText();
    for (CharSequence value : eventText) {
      if (expected.equals(chars(value))) return true;
    }
    return source != null
        && (expected.equals(chars(source.getText()))
            || expected.equals(chars(source.getContentDescription())));
  }

  private static String classCategory(AccessibilityNodeInfo source) {
    String className = source == null ? "" : chars(source.getClassName());
    if ("android.widget.Button".equals(className)) return "button";
    if ("android.widget.EditText".equals(className)) return "edit";
    if ("android.widget.TextView".equals(className)) return "text";
    if ("android.view.View".equals(className)) return "view";
    return "other";
  }

  private static int bounded(int value) {
    return Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value));
  }

  private static String flag(boolean value) {
    return value ? "1" : "0";
  }

  private static String chars(CharSequence value) {
    return value == null ? "" : value.toString();
  }

  private static synchronized void fixedOutput(String value) {
    System.out.println(value);
    System.out.flush();
  }

  private static void fixedError(String stage) {
    fixedOutput("HOSTDECK_OBSERVER_ERROR=" + stage);
  }
}
