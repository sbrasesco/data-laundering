export function getJobStatusLabel(status: string) {
  switch (status) {
    case 'pending':
      return 'Procesando';
    case 'processing':
      return 'Procesando';
    case 'done':
      return 'Completado';
    case 'done_with_warnings':
      return 'Completado con advertencia';
    case 'error':
      return 'Error';
    default:
      return status;
  }
}

// Retorna variantes de shadcn Badge
export function getJobStatusVariant(status: string): 'secondary' | 'success' | 'destructive' | 'warning' | 'outline' {
  switch (status) {
    case 'pending':
    case 'processing':        return 'secondary';
    case 'done':              return 'success';
    case 'done_with_warnings':return 'warning';
    case 'error':             return 'destructive';
    default:                  return 'outline';
  }
}

