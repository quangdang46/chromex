// Shared gate for scripts that launch real browsers, gateways, or
// fixture servers on the user's machine. Default-off; opt in with
// CHROMEX_ACCEPTANCE_ENABLE=1 (same flag as scripts/acceptance/).
if (process.env.CHROMEX_ACCEPTANCE_ENABLE !== "1") {
  console.error(
    "[chromex] browser-spawning script disabled. " +
      "Set CHROMEX_ACCEPTANCE_ENABLE=1 to run it.",
  );
  process.exit(3);
}
