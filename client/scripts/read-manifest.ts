// Reads a console manifest handed on standard input through bmo-ui's own reading (bmo-ui's console plugin
// contract, "What a service owes"), for the service's test (tests/console.rs): it prints the manifest as the
// reading fills it and ends 0, or prints the reading's fault, naming each field, and ends 1.
import { consoleManifest } from "bmo-ui/shared/console-manifest";

try {
  const read = consoleManifest(JSON.parse(await Bun.stdin.text()) as unknown);

  process.stdout.write(`${JSON.stringify(read)}\n`);
} catch (fault) {
  process.stderr.write(`${fault instanceof Error ? fault.message : String(fault)}\n`);
  process.exit(1);
}
