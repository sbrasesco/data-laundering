import { supabase } from './supabase';

export interface CreateJobParams {
  user_id: string;
  client_id: string;
  period_month: number;
  period_year: number;
}

export interface CreateJobResult {
  data: { id: string } | null;
  error: string | null;
}

/**
 * Crea un nuevo registro en pdf_jobs
 * Nota: organization_id se asigna automáticamente por RLS/default en Supabase
 */
export async function createPdfJob(params: CreateJobParams): Promise<CreateJobResult> {
  try {
    const { data, error } = await supabase
      .from('pdf_jobs')
      .insert({
        user_id: params.user_id,
        client_id: params.client_id,
        period_month: params.period_month,
        period_year: params.period_year,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) {
      return { data: null, error: error.message };
    }

    return { data: data as { id: string }, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Error desconocido al crear el proceso',
    };
  }
}

/**
 * Sube un archivo al webhook de n8n con el job_id
 */
export async function uploadFileToN8n(
  file: File,
  jobId: string
): Promise<{ success: boolean; error: string | null }> {
  const n8nWebhookUrl = import.meta.env.VITE_N8N_WEBHOOK_URL;

  if (!n8nWebhookUrl) {
    return {
      success: false,
      error: 'VITE_N8N_WEBHOOK_URL no está configurada en las variables de entorno',
    };
  }

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('job_id', jobId);

    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Error desconocido');
      return {
        success: false,
        error: `Error al enviar el archivo al webhook: ${errorText}`,
      };
    }

    return { success: true, error: null };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Error desconocido al subir el archivo',
    };
  }
}

