import * as XLSX from 'xlsx';
import { DocumentRow } from '../hooks/useAllDocuments';

/**
 * Exporta documentos a un archivo Excel (.xlsx)
 * @param documents Array de documentos a exportar
 * @param filename Nombre del archivo (por defecto 'documentos.xlsx')
 */
export function exportDocumentsToXlsx(
  documents: DocumentRow[],
  filename: string = 'documentos.xlsx'
): void {
  try {
    if (documents.length === 0) {
      alert('No hay documentos para exportar');
      return;
    }

    // Mapear documentos a formato plano para Excel
    const excelData = documents.map((doc) => {
      // Formatear fecha
      const formatDate = (dateString: string | null): string => {
        if (!dateString) return '';
        try {
          const date = new Date(dateString);
          if (isNaN(date.getTime())) return '';
          return date.toLocaleDateString('es-AR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          });
        } catch {
          return '';
        }
      };

      // Formatear moneda
      const formatMoneda = (): string => {
        if (doc.es_moneda_usd) return 'USD';
        if (doc.es_moneda_ars) return 'ARS';
        return doc.moneda || '';
      };

      // Formatear estado del proceso
      const formatStatus = (): string => {
        const statusMap: Record<string, string> = {
          pending: 'Pendiente',
          processing: 'Procesando',
          done: 'Exitoso',
          error: 'Fallido',
        };
        return doc.pdf_jobs?.status
          ? statusMap[doc.pdf_jobs.status] || doc.pdf_jobs.status
          : '';
      };

      // Formatear fecha del proceso
      const formatJobDate = (): string => {
        if (!doc.pdf_jobs?.created_at) return '';
        return formatDate(doc.pdf_jobs.created_at);
      };

      return {
        'Fecha Comprobante': formatDate(doc.fecha),
        'Cliente': doc.clients?.name || '',
        'Proveedor': doc.proveedor || '',
        'CUIT Proveedor': doc.cuit || '',
        'Receptor': doc.receptor_nombre || '',
        'CUIT Receptor': doc.receptor_cuit || '',
        'Número Comprobante': doc.numero_comprobante || '',
        'Tipo Documento': doc.tipo_documento || '',
        'Moneda': formatMoneda(),
        'Neto Gravado': doc.neto_gravado ?? null,
        'IVA': doc.iva ?? null,
        'Total': doc.total ?? null,
        'Estado del Proceso': formatStatus(),
        'ID de Proceso': doc.job_id || '',
        'Fecha de Proceso': formatJobDate(),
      };
    });

    // Crear workbook y worksheet
    const worksheet = XLSX.utils.json_to_sheet(excelData);

    // Configurar ancho de columnas (opcional, para mejor legibilidad)
    const columnWidths = [
      { wch: 15 }, // Fecha Comprobante
      { wch: 20 }, // Cliente
      { wch: 25 }, // Proveedor
      { wch: 15 }, // CUIT Proveedor
      { wch: 25 }, // Receptor
      { wch: 15 }, // CUIT Receptor
      { wch: 18 }, // Número Comprobante
      { wch: 15 }, // Tipo Documento
      { wch: 10 }, // Moneda
      { wch: 15 }, // Neto Gravado
      { wch: 12 }, // IVA
      { wch: 15 }, // Total
      { wch: 18 }, // Estado del Proceso
      { wch: 20 }, // ID de Proceso
      { wch: 15 }, // Fecha de Proceso
    ];
    worksheet['!cols'] = columnWidths;

    // Congelar la primera fila (encabezados)
    worksheet['!freeze'] = {
      xSplit: 0,
      ySplit: 1,
      topLeftCell: 'A2',
      activePane: 'bottomLeft',
      state: 'frozen'
    };

    // Crear workbook
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Documentos');

    // Generar archivo y descargar
    XLSX.writeFile(workbook, filename);
  } catch (error) {
    console.error('Error al exportar a Excel:', error);
    alert('Ocurrió un error al exportar los documentos. Por favor, intenta nuevamente.');
  }
}

