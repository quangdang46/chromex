// Shared gate for scripts that launch real browsers, gateways, or
// fixture servers on the user's machine. Default-off. To arm a run,
// create the token file once per session:
//   echo "$(uuidgen)" > /tmp/chromex-acceptance-token
// then run with:
//   CHROMEX_ACCEPTANCE_TOKEN=$(cat /tmp/chromex-acceptance-token) node ...
// The token is never committed and is not guessable, so automation
// cannot self-authorize browser spawning.
import { readFileSync } from "node:fs";

const TOKEN_PATH = "/tmp/chromex-acceptance-token";
let expected = null;
try {
  expected = readFileSync(TOKEN_PATH, "utf8").trim();
} catch {
  /* no token file → disabled */
}
if (!expected || process.env.CHROMEX_ACCEPTANCE_TOKEN !== expected) {
  console.error("[chromex] browser-spawning script disabled.");
  process.exit(3);
}
