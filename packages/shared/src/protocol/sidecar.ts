/**
 * Legacy bridge sidecar methods — plan §10 dual-path routing contract.
 *
 * The Gateway does not serve these RPCs (non-agent domains: image,
 * voice, dictation, translation, diagnostics, runtime.config,
 * workspace.harness, local.file, mcp reload, skills archive).
 * account.login.* and account.logout left this set — the Gateway serves
 * them via provider.feature.codex.account.* (chromex-pnk). During
 * gatewayMode migration the extension routes the rest to the legacy
 * bridge process over the native-host sidecar channel. Single source
 * of truth: the bridge compat layer rejects them explicitly and the
 * extension picks the transport.
 *
 * COMPAT(legacy-rpc): remove with LEGACY_COMPAT after 2026-12-31.
 */
export const LEGACY_SIDECAR_METHODS: ReadonlySet<string> = new Set([
  "apps.list",
  "plugins.list",
  "mcp.servers.reload",
  "skills.external.list",
  "skills.archive.install",
  "workspace.harness.read",
  "runtime.config.read",
  "runtime.config.update",
  "image.generate.start",
  "image.edit.start",
  "image.edit.preview",
  "image.asset.read",
  "image.asset.delete",
  "image.asset.folder",
  "image.asset.folder.open",
  "local.file.reveal",
  "diagnostics.log.write",
  "diagnostics.log.folder",
  "diagnostics.log.folder.open",
  "voice.session.start",
  "voice.session.append_text",
  "voice.session.append_audio",
  "voice.session.stop",
  "dictation.transcription.start",
  "dictation.transcription.append_audio",
  "dictation.transcription.stop",
  "translation.api_key.save",
  "translation.api_key.clear",
  "translation.client_secret.create",
  "profile.list",
  "profile.select",
]);
