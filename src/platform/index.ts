/**
 * Platform primitives.
 *
 * Everything that has to be *correct* on macOS, Linux, WSL and Windows lives
 * here, behind an injectable `HostEnv` so the OS-specific branches are
 * testable from any one of them.
 */

export {
  canonicalJson,
  canonicalizeText,
  canonicalizeJsonText,
  canonicalHash,
  canonicalTextHash,
  canonicalEquals,
  compareKeys,
  sha256Hex,
  stripBom,
  CanonicalJsonError,
  type CanonicalJsonOptions,
  type CanonicalTextOptions,
} from './canonical.js'

export {
  parseTree,
  parseJsonc,
  tokenize,
  decodeString,
  getNodeAtPath,
  getPropertyAtPath,
  rootValue,
  nodeEnd,
  detectStyle,
  indentUnit,
  renderValue,
  editValue,
  editMany,
  setValue,
  insertKey,
  deleteKey,
  JsoncError,
  type JsoncNode,
  type JsoncNodeType,
  type JsoncComment,
  type JsoncStyle,
  type JsoncEdit,
  type Token,
  type TokenKind,
} from './jsonc.js'

export {
  atomicWriteFile,
  atomicWriteJson,
  withBackup,
  restore,
  discardBackup,
  withBackupTransaction,
  withRetry,
  computeBackoffDelay,
  isRetryableError,
  errnoCode,
  nodeFsOps,
  RETRYABLE_CODES,
  AtomicWriteError,
  RestoreError,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type AtomicFsOps,
  type BackupToken,
  type BackoffOptions,
  type RetryInfo,
  type RetryOptions,
  type WithBackupOptions,
} from './atomic.js'

export {
  materialize,
  readLinkTarget,
  resolveLinkTarget,
  relativeLinkTarget,
  planStrategies,
  stripWindowsExtendedPrefix,
  nodeLinkOps,
  MaterializeError,
  type LinkInfo,
  type LinkOps,
  type LinkStrategy,
  type LinkAttempt,
  type MaterializeOptions,
  type MaterializeResult,
} from './links.js'

export {
  validatePortablePath,
  validatePathSet,
  detectCaseCollisions,
  checkPathLength,
  isWindowsReservedName,
  suggestPortableName,
  WINDOWS_RESERVED_NAMES,
  NTFS_ILLEGAL_CHARS,
  type CaseCollision,
  type PathIssue,
  type PathIssueCode,
  type PathValidationResult,
  type PathSetValidationResult,
  type ValidatePortablePathOptions,
} from './paths.js'

export {
  selectSecretStore,
  MacosKeychainStore,
  WindowsDpapiStore,
  LinuxLibsecretStore,
  EncryptedFileStore,
  MemorySecretStore,
  parseSecretToolSearch,
  secretEquals,
  nodeExec,
  nodeSecretFsOps,
  SecretsError,
  SecretsNotSupportedError,
  NoSecretBackendError,
  type SecretStore,
  type SecretBackendId,
  type SecretBackendSelection,
  type SecretStoreCapabilities,
  type SelectSecretStoreOptions,
  type ExecFn,
  type ExecResult,
  type SecretFsOps,
} from './secrets.js'

export {
  detectHost,
  probeSymlinkSupport,
  probeKeyring,
  probeLongPaths,
  readOrCreateDeviceId,
  stateDir,
  hostStateDir,
  normalizeOS,
  normalizeArch,
  detectRuntime,
  detectShell,
  isWslProcVersion,
  linuxKeyringAvailable,
  parseLongPathsRegQuery,
  windowsDirs,
  envGet,
  isValidDeviceId,
  nodeHostIO,
  APP_DIR_NAME,
  type HostIO,
  type DetectHostOptions,
  type SymlinkProbeResult,
  type WindowsDirs,
} from './host.js'

// `crypto.ts` already re-exports argon2id and blake2b, so this one line covers
// the whole primitive surface. Re-exporting the sub-modules separately would
// give two import paths for the same function.
export * from './crypto.js'
