/**
 * Core domain types for Network Data Workbench (@wiredata/core)
 */

export type ULID = string;
export type JSONPointer = string; // RFC 6901 (e.g. "/data/orders/0/id" or "/")

export type LogicalType =
  | 'BOOLEAN'
  | 'BIGINT'
  | 'DOUBLE'
  | 'DECIMAL'
  | 'VARCHAR'
  | 'DATE'
  | 'TIMESTAMP'
  | 'JSON';

export type DeduplicationPolicy = 'keep_all' | 'keep_first' | 'keep_latest';
export type NestedObjectPolicy = 'flatten' | 'json';
export type NestedArrayPolicy = 'json' | 'child_dataset';

export type SessionStatus =
  | 'new'
  | 'capturing'
  | 'stopped'
  | 'finalizing'
  | 'complete'
  | 'recovered';

export interface PageContext {
  page_context_id: ULID;
  session_id: ULID;
  page_url: string;
  sanitized_page_url: string;
  navigation_sequence: number;
  captured_at: string; // ISO 8601
}

export interface SanitizedHeader {
  name: string;
  value: string;
  is_redacted: boolean;
}

export type CaptureMode = 'page' | 'devtools';

export interface SanitizedQueryParam {
  name: string;
  value: string;
  is_redacted: boolean;
}

export interface CapturedRequestDetails {
  url: string; // strictly sanitized URL
  sanitized_url: string;
  route_template?: string;
  method: string;
  query_parameters: SanitizedQueryParam[];
  headers?: SanitizedHeader[]; // omitted entirely in 'page' mode
  body_sanitized?: string; // omitted in 'page' mode
  body_hash?: string;
  graphql_operation_name?: string;
}

export interface CapturedResponseDetails {
  status: number;
  status_text: string;
  mime_type: string;
  headers?: SanitizedHeader[];
  body_size: number;
  body_hash: string;
  body_object_ref: string; // SHA-256 of canonical body
}

export interface CapturedTiming {
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

export interface CapturedRequest {
  capture_id: ULID;
  session_id: ULID;
  capture_mode: CaptureMode;
  page_context_id?: ULID;
  request: CapturedRequestDetails;
  response: CapturedResponseDetails;
  timing: CapturedTiming;
  classification: {
    json_candidate: boolean;
    parse_status: 'parsed' | 'skipped_large' | 'invalid_json' | 'unsupported_mime' | 'body_unavailable';
    /**
     * JSON Pointers of response body keys that look credential-shaped
     * (e.g. "/data/token"). The response body itself is stored exactly as
     * received — this is a non-destructive flag for the UI, not a redaction.
     */
    sensitive_response_fields?: string[];
  };
}

export interface CandidateCollection {
  pointer: JSONPointer;
  display_path: string;
  row_count: number;
  field_count: number;
  confidence: 'high' | 'medium' | 'low';
  confidence_score: number;
  sample_keys: string[];
  suggested_name: string;
}

export interface DatasetCandidate {
  capture_id: ULID;
  normalized_route: string;
  graphql_operation?: string;
  collections: CandidateCollection[];
}

export interface ColumnDefinition {
  name: string;
  original_name?: string;
  source_pointer_template?: string; // e.g. "/customer/address/city"
  logical_type: LogicalType;
  json_pointer?: JSONPointer;
  inferred_type: LogicalType;
  type_override?: LogicalType;
  is_visible: boolean;
  order: number;
}

export interface TypeAnomaly {
  column_name: string;
  expected_type: LogicalType;
  incompatible_count: number;
  null_count: number;
  valid_count: number;
  sample_anomalies: Array<{
    row_id: ULID;
    value: unknown;
    record_pointer: JSONPointer;
  }>;
}

export interface DatasetSourceRule {
  method: string;
  route_pattern: string;
  query_shape?: Record<string, string>;
  graphql_operation?: string;
}

export interface ExtractionConfig {
  record_pointer: JSONPointer; // e.g. "/data/orders" or "/"
  nested_object_policy: NestedObjectPolicy;
  nested_array_policy: NestedArrayPolicy;
  flatten_delimiter: string; // default "__"
}

export interface DatasetDefinition {
  id: string; // e.g. "ds_orders"
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
  sources: DatasetSourceRule[];
  extraction: ExtractionConfig;
  identity_columns: string[]; // empty = no identity
  deduplication: DeduplicationPolicy;
  columns: Record<string, ColumnDefinition>;
  parent_dataset_id?: string;
}

export interface RowLineage {
  row_id: ULID;
  session_id: ULID;
  capture_id: ULID;
  capture_mode: CaptureMode;
  response_hash: string;
  record_pointer: JSONPointer;
  page_context_id?: ULID;
  request_url: string; // strictly sanitized URL
  captured_at: string;
  suppressed_source_rows?: RowLineage[];
}

export interface FieldLineage {
  column_name: string;
  source_pointer: JSONPointer;
  raw_value: unknown;
  transformed_value: unknown;
  operations: string[];
}

export interface ExtractedRow {
  row_id: ULID;
  values: Record<string, unknown>;
  lineage: RowLineage;
  field_lineage: Record<string, FieldLineage>;
}

export interface ColumnProfile {
  column_name: string;
  logical_type: LogicalType;
  total_count: number;
  null_count: number;
  null_percentage: number;
  distinct_count: number;
  min?: string | number;
  max?: string | number;
  average?: number;
  min_length?: number;
  max_length?: number;
  sample_values: unknown[];
}

export interface CoverageSummary {
  reported_total?: number;
  observed_unique_rows: number;
  coverage_percentage?: number;
  status: 'complete' | 'partial' | 'unknown';
}

export interface DatasetSnapshot {
  snapshot_id: ULID;
  dataset_id: string;
  definition_version: number;
  created_at: string;
  row_count: number;
  column_count: number;
  contributing_capture_ids: ULID[];
  schema: Record<string, ColumnDefinition>;
  coverage: CoverageSummary;
  duplicate_count: number;
  type_anomalies: TypeAnomaly[];
}

export interface CaptureSession {
  session_id: ULID;
  name: string;
  started_at: string;
  ended_at?: string;
  initial_page_url: string;
  navigation_history: PageContext[];
  capture_count: number;
  body_bytes: number;
  application_version: string;
  status: SessionStatus;
}

export interface WorkspaceMetadata {
  format_version: number;
  workspace_id: ULID;
  created_at: string;
  last_opened_at: string;
  application_version: string;
}

export interface SavedQuery {
  query_id: ULID;
  name: string;
  sql_text: string;
  created_at: string;
  updated_at: string;
  input_dataset_snapshot_ids: Record<string, ULID>; // dataset_name -> snapshot_id
}
