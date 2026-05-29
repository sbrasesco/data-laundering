/**
 * types.ts — Contratos de tipos del Queue Service
 * Data Laundering V2.0 — TASK-7 / DEC-007
 */

export interface OCEntry {
  numero_oc: string;
  nombre_adjunto: string | null;
  codigo_obra: string | null;
}

export type FileType = 'pdf' | 'jpg' | 'jpeg' | 'png';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'dead';
export type JobSource = 'frontend_upload' | 'integration_drive' | 'integration_remote' | 'api_direct';

export interface QueueJob {
  // Identidad
  job_id: string;           // UUID v4 — referencia a pdf_jobs.id en Supabase
  organization_id: string;  // UUID del tenant — requerido para RLS

  // Documento
  file_url: string;         // URL de Supabase Storage (no path de disco, no URL firmada)
  file_type: FileType;
  file_hash: string;        // SHA256 para deduplicación
  original_filename: string;
  file_size_bytes: number;

  // Contexto de extracción (para el sub-workflow n8n)
  client_cuit: string | null;
  client_name: string | null;
  oc_entries: OCEntry[];

  // Control
  priority?: number;        // 1-10, mayor = más urgente. Default: 5

  // Metadata
  metadata: {
    source: JobSource;
    worker_version?: string;
  };
}

export interface JobStatusResult {
  id: string;
  status: string;
  attempts: number;
  failed_reason?: string;
}
