import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real loopback HTTP server described by a `fetch`-shaped handler.
 *
 * The consumer journeys below were written against a runtime that supplies one of
 * these built in; this repository runs them on Node, so the same handler shape is
 * served by `node:http` here. It is a transport, not a stand-in for the client: the
 * requests the client makes cross a real socket and the responses come back off one,
 * which is the whole point of exercising the package export this way.
 */
export interface LoopbackServer {
  /** The port the kernel chose, so a client can be pointed at it. */
  readonly port: number;
  /** Close the listener and every connection still held open. */
  stop(): Promise<void>;
}

/** Start one, on a port the kernel picks, and resolve once it is listening. */
export function serveLoopback(
  handler: (request: Request) => Response,
): Promise<LoopbackServer> {
  const server: Server = createServer((incoming, outgoing) => {
    const response = handler(
      new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        method: incoming.method,
      }),
    );
    response
      .arrayBuffer()
      .then((body) => {
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        );
        outgoing.end(Buffer.from(body));
      })
      .catch(() => {
        outgoing.writeHead(500);
        outgoing.end();
      });
  });
  return new Promise<LoopbackServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        stop: () =>
          new Promise<void>((closed) => {
            // Held-open keep-alive sockets would otherwise keep the listener from
            // closing until their idle timeout, long after the last assertion.
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}
