// Stall the real host event loop after a socket connects, before Nx can send
// its load message. Workers keep running with their actual sockets and timers.
import { channel } from "node:diagnostics_channel";

if (!process.argv[1]?.endsWith("plugin-worker.js")) {
  let stalled = false;
  channel("net.client.socket").subscribe(({ socket }) => {
    socket.prependOnceListener("connect", () => {
      if (stalled) return;
      stalled = true;
      process.stderr.write("stalling Nx host past worker load deadline\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12_000);
    });
  });
}
