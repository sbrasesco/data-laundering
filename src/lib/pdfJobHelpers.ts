import { supabase } from './supabase';

export interface CreateJobParams {
  user_id: string;
  client_id: string;
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
        status: 'processing',
        input_source: 'frontend_upload',
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
 * 1. Sube el archivo a Supabase Storage (bucket `documents`, carpeta de la organización)
 * 2. Firma una URL con vencimiento y llama al Worker Gateway con job_id + file_url
 */
export async function uploadFileToWorker(
  file: File,
  jobId: string,
  clientName?: string,
  clientCuit?: string | null,
  organizationId?: string | null
): Promise<{ success: boolean; error: string | null }> {
  const workerGatewayUrl = import.meta.env.VITE_WORKER_GATEWAY_URL ?? 'https://api.agoradigital.io';
  const workerApiKey = import.meta.env.VITE_WORKER_API_KEY ?? 'staging-key-2026';

  try {
    // 1. organizationId es OBLIGATORIO: sin él la ruta quedaría "null/uploads/…",
    //    la política de storage la rechazaría y el usuario vería un error
    //    incomprensible. Fallar acá, claro, antes de subir nada.
    if (!organizationId) {
      return { success: false, error: 'No se pudo determinar la organización. Volvé a iniciar sesión.' };
    }

    // 2. Dentro de la carpeta de la organización, en `documents`.
    //    upsert:false — el jobId es un UUID nuevo en cada envío, no hay colisión
    //    posible, y así escribir no requiere ningún permiso de lectura.
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'zip';
    const storageKey = `${organizationId}/uploads/${jobId}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(storageKey, file, { upsert: false });

    if (uploadError) {
      return { success: false, error: `Error subiendo archivo: ${uploadError.message}` };
    }

    // 3. URL FIRMADA con vencimiento, no pública y eterna. 24 h alcanza para
    //    cualquier cadena de reintentos del worker (attempts:3 con backoff).
    const { data: signed, error: signError } = await supabase.storage
      .from('documents')
      .createSignedUrl(storageKey, 60 * 60 * 24);

    if (signError || !signed?.signedUrl) {
      return { success: false, error: `No se pudo firmar la URL: ${signError?.message ?? 'desconocido'}` };
    }

    // 4. Llamar al Worker Gateway
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
        file_url: signed.signedUrl,
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

