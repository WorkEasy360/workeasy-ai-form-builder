/**
 * @workeasy/files: server-only upload handling (FIL-01, docs/06 §3).
 * Never import from browser code; it holds storage credentials.
 */
export { detectType, DOCX, safeFileName, SNIFF_BYTES, XLSX } from "./detect.js";
export { expireStaleUploads, processScanJob, SCAN_LEASE_SECONDS, scanPendingUploads, type ScanDeps } from "./scan-jobs.js";
export { parseClamdReply, pingScanner, scanStream, ScannerUnavailableError, type ScannerConfig, type ScanResult } from "./scanner.js";
export { attachmentDisposition, createObjectStore, type ObjectInfo, type ObjectStore, type ObjectStoreConfig } from "./storage.js";
