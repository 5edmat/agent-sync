/**
 * Control plane contract — the web app manages everything.
 *
 * ARCHITECTURE REVISION
 * ---------------------
 * The earlier sketch used a git repo as the sync bus with the SPA and CLI as
 * independent clients that never talk. That is dead the moment you want to
 * *manage* devices from the web rather than merely author files: you need
 * device identity, liveness, drift reporting, and a push channel. So:
 *
 *   web app  ── writes ──▶  DESIRED state  ──┐
 *                                             ├──▶ device reconciles
 *   device   ── writes ──▶  OBSERVED state ──┘         and reports back
 *
 * Desired vs observed vs reconcile — the Kubernetes model, and it fits well:
 * the device is always the executor (it owns the filesystem), the web app only
 * ever edits intent. Drift is just `desired != observed`, which is also exactly
 * what the device matrix renders. Git remains available as a user-owned mirror
 * of desired state, but it is no longer the transport.
 *
 * THE SECURITY PROBLEM THIS FILE EXISTS TO SOLVE
 * ----------------------------------------------
 * Claude Code hooks are shell commands. MCP servers are `command` + `args`.
 * `env` feeds both. All three are arbitrary code execution on a developer
 * machine — and developer machines hold source, cloud credentials, and prod
 * access.
 *
 * So a naive "web app pushes config to devices" design means: whoever controls
 * our backend gets remote code execution on every customer's laptop. That is a
 * supply-chain compromise with us as the vector. It is not an acceptable
 * residual risk for a public product, and "we'll secure the backend" is not a
 * mitigation — it's a hope.
 *
 * The mitigation is that the backend must be structurally incapable of it:
 *
 *   1. Desired state is signed by a key the USER holds. The backend stores and
 *      relays; it cannot mint. Devices reject unsigned or badly-signed bundles.
 *   2. Code-execution-class changes (hooks, mcpServers.command, env) require an
 *      explicit per-item human approval that is itself part of the signed
 *      payload. A silent auto-apply of a hook is never possible.
 *   3. Devices hold a local policy ceiling — `autoApply` classes they will
 *      accept without interactive confirmation. Default excludes code-execution.
 *
 * Under this model a full backend breach degrades to denial of service and
 * metadata disclosure, not RCE. That is the difference between an incident and
 * an extinction event.
 */

import type { Change, HostEnv, Plan, ToolId } from './types.js'
import type { SealedSecret, ServerVaultRecord } from './vault.js'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface Device {
  deviceId: string
  label: string // user-editable; NOT the identity
  host: HostEnv
  /** Ed25519 public key, generated on-device at pairing. Private key never leaves. */
  devicePublicKey: string
  agentVersion: string
  lastSeenAt: string
  status: 'active' | 'stale' | 'revoked'
}

/**
 * Pairing: device generates a keypair, shows a short code, user confirms in the
 * web app. The backend never sees a device private key, and a stolen enrollment
 * token can't be replayed after first use.
 */
export interface PairingRequest {
  deviceId: string
  devicePublicKey: string
  host: HostEnv
  shortCode: string // 8 chars, single-use, 5 min TTL
}

// ---------------------------------------------------------------------------
// Desired state (authored in the web app, signed by the user)
// ---------------------------------------------------------------------------

export type LayerId = 'base' | `os:${string}` | `machine:${string}` | 'local'

export interface DesiredBundle {
  bundleId: string
  revision: number
  /** Layers, lowest precedence first. `local` is never present here by design. */
  layers: Array<{ id: LayerId; tool: ToolId; data: unknown }>
  /** Per-item human approvals for code-execution changes, inside the signature. */
  approvals: ChangeApproval[]
  createdAt: string
  createdBy: string
}

export interface ChangeApproval {
  /** Stable hash of (storeId, path, after-value). Approval does not survive edits. */
  changeFingerprint: string
  approvedBy: string
  approvedAt: string
  risk: Change['risk']
}

/**
 * The wire object. The device verifies `signature` over `canonicalJson(bundle)`
 * using a user signing key it pinned at pairing time — NOT a backend key.
 */
export interface SignedBundle {
  bundle: DesiredBundle
  signature: string // Ed25519 over canonical bytes
  signingKeyId: string
}

// ---------------------------------------------------------------------------
// Observed state (reported by devices, powers the matrix + drift views)
// ---------------------------------------------------------------------------

export interface ObservedReport {
  deviceId: string
  reportedAt: string
  tools: Array<{
    toolId: ToolId
    installed: boolean
    version?: string
    stores: Array<{
      storeId: string
      exists: boolean
      hash: string
      /** Populated for managed scopes so the UI can attribute unfixable drift. */
      policyControlled?: boolean
    }>
  }>
  /** Which secret backend this host actually resolved to. Surfaced in the UI
   *  because "headless Linux, no keyring, using encrypted file" changes what a
   *  user should expect. */
  secretBackend: 'keychain' | 'dpapi' | 'libsecret' | 'encrypted-file' | 'none'
}

// ---------------------------------------------------------------------------
// Device-side policy ceiling
// ---------------------------------------------------------------------------

export interface DevicePolicy {
  /** Risk classes this device will apply without interactive confirmation.
   *  'code-execution' is deliberately NOT a default. */
  autoApply: Array<Change['risk']> // default: ['none']
  /** Refuse any bundle not signed by one of these key ids. */
  trustedSigningKeys: string[]
  /** Hard local veto — paths or tools this device will never let us touch. */
  excludeStores: string[]
  /** If true, never apply while a Claude Code session is running. */
  deferWhileSessionActive: boolean
  enumeration: EnumerationPolicy
}

// ---------------------------------------------------------------------------
// Master device + auto-sync
// ---------------------------------------------------------------------------

/**
 * ── V1 PRIMITIVE ───────────────────────────────────────────────────────────
 *
 * A single, explicit, user-initiated push: take this config, from here, to
 * these devices, now.
 *
 * This ships first and deliberately. Everything the master role would provide
 * is expressible here already — choose a source, choose targets, choose stores.
 * What master adds on top is *automation*, not capability, so building this
 * first means the harder feature becomes a scheduler over a proven primitive
 * rather than a second code path with its own bugs.
 *
 * It is also the honest order for the risk: every push in v1 has a human at the
 * moment of the push, which is the property auto-sync gives up.
 */
export interface PushRequest {
  /** Where the config comes from: a device's observed state, or authored intent. */
  source: { kind: 'device'; deviceId: string } | { kind: 'authored'; bundleId: string }
  targets: { kind: 'all' } | { kind: 'selected'; deviceIds: string[] }
  /** Which stores participate — push MCP servers without dragging keybindings. */
  stores: { kind: 'all' } | { kind: 'selected'; storeIds: string[] }
  /** Whether sealed secret values ride along. Targets must be vault-enrolled. */
  includeSecrets: boolean
  /**
   * Approvals for code-execution changes, collected in the review step and
   * carried inside the signature. A push containing an unapproved
   * code-execution change is rejected by the device, not by the UI.
   */
  approvals: ChangeApproval[]
  /** Hold until the target device is idle rather than interrupting a session. */
  deferWhileSessionActive: boolean
}

export interface PushResult {
  pushId: string
  /** One plan per target — each device diffs against its OWN observed state, so
   *  the same push produces different changes on a Mac and a Windows box. */
  plans: Array<{ deviceId: string; plan: Plan; status: 'queued' | 'applied' | 'rejected' | 'deferred' }>
}

/**
 * ── DEFERRED (post-v1) ─────────────────────────────────────────────────────
 *
 * A designated master whose config auto-propagates. Kept in the model because
 * the shape informs v1 — but it is explicitly NOT in the first release.
 *
 * When it ships it should be implemented as a saved `PushRequest` that fires on
 * master-side change, not as parallel machinery.
 *
 * The risk it carries, recorded here so it isn't rediscovered later: hooks, MCP
 * `command`, and `env` are arbitrary code execution, so unconditional auto-push
 * means compromising the master yields code execution on every other device.
 * `autoApplyRisk` defaulting to ['none'] is the valve — ordinary config flows
 * freely, the code-execution slice still waits for a human. Opting in to
 * unattended code-execution propagation must be stated in the UI in those words.
 */
export interface AutoSyncPolicy {
  masterDeviceId: string | null
  enabled: boolean
  /** The saved push this fires. Same primitive, same validation, same signing. */
  template: Omit<PushRequest, 'approvals'>
  autoApplyRisk: Array<Change['risk']>
}

/**
 * Promotion is an explicit event, recorded for audit. Changing which machine
 * is authoritative is exactly the action an attacker would want, so it is never
 * implicit and never silent.
 */
export interface MasterPromotion {
  previousMasterDeviceId: string | null
  newMasterDeviceId: string
  /** Adopt the new master's observed state as desired state immediately. */
  adoptObservedState: boolean
  at: string
  by: string
}

// ---------------------------------------------------------------------------
// Daemon enumeration scope
// ---------------------------------------------------------------------------

export type EnumerationMode =
  /** Only paths the adapters declare. Smallest attack surface. */
  | 'declared'
  /** Declared paths plus roots the user added ON the device itself. */
  | 'declared-plus-user'
  /** Arbitrary browsing driven from the web app. */
  | 'full'

/**
 * Paths that are NEVER enumerated, readable, or syncable — including in 'full'
 * mode. This is a floor, not a default: without it, 'full' turns the daemon
 * into a credential harvester that a backend compromise could drive.
 *
 * These are the highest-value targets on a developer machine and none of them
 * are agent config, so excluding them costs the product nothing.
 */
export const NEVER_ENUMERATE: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.kube',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/Library/Keychains',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/.mozilla',
  '~/.config/google-chrome',
  '%APPDATA%/Microsoft/Crypto',
  '**/.env',
  '**/.env.*',
  '**/id_rsa',
  '**/id_ed25519',
  '**/*.pem',
  '**/*.p12',
]

export interface EnumerationPolicy {
  mode: EnumerationMode
  /** Extra roots. In 'declared-plus-user' these must be confirmed ON the device
   *  — a web-only grant would let a compromised backend widen its own access. */
  userAddedRoots: string[]
  /** Always enforced, regardless of mode. Not user-editable downward. */
  neverEnumerate: readonly string[]
  /** 'full' is powerful enough that the UI should require re-confirmation. */
  fullModeAcknowledgedAt?: string
}

export const DEFAULT_ENUMERATION: EnumerationPolicy = {
  mode: 'declared',
  userAddedRoots: [],
  neverEnumerate: NEVER_ENUMERATE,
}

// ---------------------------------------------------------------------------
// API surface — deliberately small
// ---------------------------------------------------------------------------

/**
 * Open-core tenancy: solo is free and single-tenant, teams are paid and add
 * shared bundles, roles, and audit.
 *
 * Modeled from day one even though solo ships first — retrofitting an owner
 * onto resources that assumed a single user is a migration nobody enjoys. A
 * solo account is just an org with one member and one seat.
 */
export interface Account {
  accountId: string
  kind: 'solo' | 'team'
  /** Seats are billed; devices are not. A person with five laptops pays once. */
  seats: number
  members: Member[]
}

export interface Member {
  userId: string
  email: string
  role: 'owner' | 'admin' | 'member'
  /** Devices belong to a member, not to the org — even on team plans. An admin
   *  can see that a device exists and is drifted; they cannot read its local
   *  layer or unseal its secrets. */
  deviceIds: string[]
}

export interface ControlPlaneApi {
  // pairing
  requestPairing(req: PairingRequest): Promise<{ pairingId: string }>
  confirmPairing(pairingId: string, shortCode: string): Promise<Device>
  revokeDevice(deviceId: string): Promise<void>
  renameDevice(deviceId: string, label: string): Promise<Device>
  listDevices(): Promise<Device[]>

  // selective push — the v1 sync surface
  /** Dry run: compute per-target plans WITHOUT applying. Drives the review UI. */
  previewPush(req: PushRequest): Promise<PushResult>
  /** Execute. Rejects if any code-execution change lacks a matching approval. */
  push(req: PushRequest): Promise<PushResult>

  // auto-sync / master — post-v1, implemented as a saved push
  getAutoSync?(): Promise<AutoSyncPolicy | null>
  setAutoSync?(policy: AutoSyncPolicy): Promise<AutoSyncPolicy>
  promoteMaster?(promotion: Omit<MasterPromotion, 'at' | 'by'>): Promise<AutoSyncPolicy>

  // enumeration scope (read here, but widening must be confirmed on-device)
  getEnumerationPolicy(deviceId: string): Promise<EnumerationPolicy>
  requestEnumerationChange(deviceId: string, mode: EnumerationMode): Promise<{ confirmOnDevice: true }>

  // vault — server only ever handles wrapped keys and ciphertext
  getVault(): Promise<ServerVaultRecord | null>
  putSealedSecret(secret: SealedSecret): Promise<void>
  deleteSealedSecret(ref: string): Promise<void>

  // backup / restore
  createSnapshot(deviceId: string, label?: string): Promise<Snapshot>
  listSnapshots(deviceId: string): Promise<Snapshot[]>
  restoreSnapshot(snapshotId: string): Promise<Plan>

  // desired state
  getDesired(deviceId: string): Promise<SignedBundle | null>
  putDesired(bundle: DesiredBundle, signature: string): Promise<{ revision: number }>

  // observed state
  report(report: ObservedReport): Promise<{ desiredRevision: number }>

  /**
   * Server-side dry run for the web UI. Computed from the LAST observed report,
   * so it is advisory only — the device recomputes its own plan before applying
   * and aborts if disk has moved (baseHashes mismatch). The web app must label
   * this as a preview, never as a guarantee.
   */
  previewPlan(deviceId: string, toolId: ToolId): Promise<Plan>

  // audit
  listEvents(deviceId: string, since?: string): Promise<ApplyEvent[]>
}

/**
 * A point-in-time capture of a device's config, for backup and rollback.
 *
 * Secrets are captured as sealed blobs, never plaintext — so a snapshot is safe
 * to store server-side, and restoring it on a device that isn't enrolled in the
 * vault yields a clear "3 secrets could not be restored on this device" rather
 * than silently writing broken config.
 */
export interface Snapshot {
  snapshotId: string
  deviceId: string
  label?: string
  createdAt: string
  /** Content hash per store at capture time. */
  storeHashes: Record<string, string>
  /** Sealed secret refs included, so restore can report what it cannot resolve. */
  secretRefs: string[]
  /** Set when the snapshot was taken automatically before an apply. */
  automatic: boolean
  sizeBytes: number
}

export interface ApplyEvent {
  eventId: string
  deviceId: string
  bundleRevision: number
  at: string
  outcome: 'applied' | 'partial' | 'failed' | 'rejected-signature' | 'deferred'
  changeCount: number
  rollbackId?: string
  error?: string
}

/**
 * Transport note: devices long-poll `report()` and receive `desiredRevision` in
 * the response. If it differs from what they hold, they fetch and reconcile.
 * No inbound connections to developer machines, no websocket infrastructure,
 * works behind corporate NAT and VPN, and degrades to a slow poll rather than
 * failing. Push latency of a few seconds is fine for config.
 */
