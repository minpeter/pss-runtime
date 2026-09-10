import { Server } from "node:http";

// Keep the production CLI's nonzero-port contract, but let the OS allocate
// an ephemeral port atomically for this real recorder process.
const listen = Server.prototype.listen;
Server.prototype.listen = function listenOnEphemeralPort(port, host, callback) {
  this.once("listening", () => {
    process.send({ address: this.address(), requestedPort: port });
  });
  return listen.call(this, 0, host, callback);
};

// The parent subscribes to readiness before triggering the CLI import.
process.once("message", async () => {
  await import("./loopback-recorder.mjs");
});
