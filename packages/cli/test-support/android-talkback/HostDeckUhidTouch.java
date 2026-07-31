package app.hostdeck.talkbackobserver;

import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

public final class HostDeckUhidTouch {
  private static final int UHID_DESTROY = 1;
  private static final int UHID_CREATE2 = 11;
  private static final int UHID_INPUT2 = 12;
  private static final int BUS_VIRTUAL = 6;
  private static final int COORDINATE_MAX = 10_000;
  private static final byte[] REPORT_DESCRIPTOR = new byte[] {
    0x05, 0x0d,
    0x09, 0x04,
    (byte) 0xa1, 0x01,
    (byte) 0x85, 0x01,
    0x09, 0x54,
    0x15, 0x00,
    0x25, 0x01,
    0x75, 0x08,
    (byte) 0x95, 0x01,
    (byte) 0x81, 0x02,
    0x09, 0x22,
    (byte) 0xa1, 0x02,
    0x09, 0x42,
    0x15, 0x00,
    0x25, 0x01,
    0x75, 0x01,
    (byte) 0x95, 0x01,
    (byte) 0x81, 0x02,
    0x09, 0x32,
    (byte) 0x81, 0x02,
    0x09, 0x51,
    0x25, 0x3f,
    0x75, 0x06,
    (byte) 0x81, 0x02,
    0x05, 0x01,
    0x09, 0x30,
    0x16, 0x00, 0x00,
    0x26, 0x10, 0x27,
    0x36, 0x00, 0x00,
    0x46, 0x10, 0x27,
    0x75, 0x10,
    (byte) 0x95, 0x01,
    (byte) 0x81, 0x02,
    0x09, 0x31,
    (byte) 0x81, 0x02,
    (byte) 0xc0,
    (byte) 0xc0
  };

  private HostDeckUhidTouch() {}

  public static void main(String[] args) throws Exception {
    if (args.length == 0) {
      fail("Missing gesture command.");
    }
    try (FileOutputStream output = new FileOutputStream("/dev/uhid")) {
      create(output);
      Thread.sleep(700);
      switch (args[0]) {
        case "swipe":
          requireArgumentCount(args, 7);
          swipe(
            output,
            coordinate(args[1]),
            coordinate(args[2]),
            coordinate(args[3]),
            coordinate(args[4]),
            boundedInteger(args[5], 4, 40, "steps"),
            boundedInteger(args[6], 8, 80, "step delay")
          );
          break;
        case "doubletap":
          requireArgumentCount(args, 3);
          doubleTap(output, coordinate(args[1]), coordinate(args[2]));
          break;
        case "hold":
          requireArgumentCount(args, 2);
          Thread.sleep(boundedInteger(args[1], 1_000, 20_000, "hold delay"));
          break;
        default:
          fail("Unsupported gesture command.");
      }
      Thread.sleep(220);
      destroy(output);
    }
  }

  private static void create(FileOutputStream output) throws IOException {
    byte[] name = "HostDeck temporary touchscreen".getBytes(StandardCharsets.US_ASCII);
    ByteBuffer event = buffer(4 + 128 + 64 + 64 + 2 + 2 + 16 + REPORT_DESCRIPTOR.length);
    event.putInt(UHID_CREATE2);
    event.put(name);
    event.position(4 + 128 + 64 + 64);
    event.putShort((short) REPORT_DESCRIPTOR.length);
    event.putShort((short) BUS_VIRTUAL);
    event.putInt(0x1209);
    event.putInt(0x4844);
    event.putInt(1);
    event.putInt(0);
    event.put(REPORT_DESCRIPTOR);
    write(output, event);
  }

  private static void destroy(FileOutputStream output) throws IOException {
    ByteBuffer event = buffer(4);
    event.putInt(UHID_DESTROY);
    write(output, event);
  }

  private static void swipe(
    FileOutputStream output,
    int startX,
    int startY,
    int endX,
    int endY,
    int steps,
    int delayMs
  ) throws Exception {
    report(output, true, startX, startY);
    for (int index = 1; index <= steps; index += 1) {
      Thread.sleep(delayMs);
      int x = startX + ((endX - startX) * index) / steps;
      int y = startY + ((endY - startY) * index) / steps;
      report(output, true, x, y);
    }
    Thread.sleep(delayMs);
    report(output, false, endX, endY);
  }

  private static void doubleTap(FileOutputStream output, int x, int y) throws Exception {
    tap(output, x, y);
    Thread.sleep(110);
    tap(output, x, y);
  }

  private static void tap(FileOutputStream output, int x, int y) throws Exception {
    report(output, true, x, y);
    Thread.sleep(55);
    report(output, false, x, y);
    Thread.sleep(55);
  }

  private static void report(FileOutputStream output, boolean down, int x, int y)
      throws IOException {
    ByteBuffer event = buffer(4 + 2 + 7);
    event.putInt(UHID_INPUT2);
    event.putShort((short) 7);
    event.put((byte) 1);
    event.put((byte) (down ? 1 : 0));
    event.put((byte) (down ? 3 : 0));
    event.putShort((short) (down ? x : 0));
    event.putShort((short) (down ? y : 0));
    write(output, event);
  }

  private static ByteBuffer buffer(int size) {
    return ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);
  }

  private static void write(FileOutputStream output, ByteBuffer event) throws IOException {
    output.write(event.array(), 0, event.position());
    output.flush();
  }

  private static int coordinate(String value) {
    return boundedInteger(value, 0, COORDINATE_MAX, "coordinate");
  }

  private static int boundedInteger(String value, int minimum, int maximum, String name) {
    final int parsed;
    try {
      parsed = Integer.parseInt(value);
    } catch (NumberFormatException error) {
      throw new IllegalArgumentException("Invalid " + name + ".", error);
    }
    if (parsed < minimum || parsed > maximum) {
      throw new IllegalArgumentException("Out-of-range " + name + ".");
    }
    return parsed;
  }

  private static void requireArgumentCount(String[] args, int expected) {
    if (args.length != expected) {
      fail("Invalid gesture arguments.");
    }
  }

  private static void fail(String message) {
    throw new IllegalArgumentException(message);
  }
}
