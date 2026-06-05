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
        status: 'processing', // Estado inicial: el proceso está siendo encolado en el Worker
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
 * Marca un pdf_job como fallido con un mensaje de error
 */
export async function failPdfJob(
  jobId: string,
  errorMessage: string,
  errorType: 'processing' | 'credits' = 'processing'
): Promise<void> {
  const { error } = await supabase
    .from('pdf_jobs')
    .update({ status: 'error', error_message: errorMessage, error_type: errorType })
    .eq('id', jobId);

  if (error) {
    console.error('[failPdfJob] No se pudo actualizar el job a error:', error.message);
  }
}

/**
 * Sube un archivo al pipeline del worker:
 * 1. Sube el archivo a Supabase Storage (bucket facturas)
 * 2. Llama al Worker Gateway con job_id + file_url
 */
export async function uploadFileToWorker(
  file: File,
  jobId: string,
  clientName?: string,
  clientCuit?: string | null,
  organizationId?: string | null
): Promise<{ success: boolean; error: string | null }> {
  const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://automation.aignition.net/worker';
  const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';

  try {
    // 1. Subir archivo a Supabase Storage
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'zip';
    const storageKey = `${jobId}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('facturas')
      .upload(storageKey, file, { upsert: true });

    if (uploadError) {
      return { success: false, error: `Error subiendo archivo: ${uploadError.message}` };
    }

    const { data: { publicUrl } } = supabase.storage.from('facturas').getPublicUrl(storageKey);

    // 2. Llamar al Worker Gateway
    const orgId = organizationId ?? null;

    const response = await fetch(`${workerGatewayUrl}/api/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${workerApiKey}`,
      },
      body: JSON.stringify({
        job_id: jobId,
        organization_id: orgId,
        file_url: publicUrl,
        file_type: ['jpg', 'jpeg'].includes(ext) ? 'jpg' : (['png'].includes(ext) ? 'png' : (ext === 'pdf' ? 'pdf' : (['zip', 'rar'].includes(ext) ? ext : 'zip'))),
        original_filename: file.name,
        client_name: clientName ?? null,
        client_cuit: clientCuit ?? null,
        input_source: 'frontend_upload',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Error desconocido');
      return { success: false, error: `Error llamando al gateway: ${errorText}` };
    }

    return { success: true, error: null };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Error desconocido al subir el archivo',
    };
  }
}

