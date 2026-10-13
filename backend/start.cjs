// Startup file for hosts that load the app with require(), such as cPanel's
// "Setup Node.js App" (Passenger / LiteSpeed). src/server.js is an ES module with
// top-level await, which require() cannot load, so import it instead.
import('./src/server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
