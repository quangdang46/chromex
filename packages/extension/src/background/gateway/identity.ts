/**
 * Extension identity — plan §11 / P1-08.
 *
 * `profileId` + `clientId` are generated once per extension INSTALLATION
 * and persisted in `chrome.storage.local`. They are stable across
 * service-worker restarts but LOST on uninstall / storage clear /
 * profile reset — a reinstall gets fresh ids (documented limitation,
 * never claimed durable-forever).
 *
 * `browserInstanceId` is NOT generated here: the native host derives it
 * per Chrome run (B6) and injects it into `hello` — the extension only
 * echoes it back if it wants binding continuity.
 */

const STORAGE_KEY = "chromex.identity.v1";

export interface ExtensionIdentity {
  profileId: string;
  clientId: string;
  createdAt: number;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function loadOrCreateIdentity(
  storage: Pick<typeof chrome.storage.local, "get" | "set">,
): Promise<ExtensionIdentity> {
  const got = await storage.get(STORAGE_KEY);
  const existing = got[STORAGE_KEY] as ExtensionIdentity | undefined;
  if (
    existing &&
    typeof existing.profileId === "string" &&
    typeof existing.clientId === "string"
  ) {
    return existing;
  }
  const identity: ExtensionIdentity = {
    profileId: randomId("prof"),
    clientId: randomId("cli"),
    createdAt: Date.now(),
  };
  await storage.set({ [STORAGE_KEY]: identity });
  return identity;
}
