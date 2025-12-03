export function getJobStatusLabel(status: string) {
  switch (status) {
    case 'pending':
      return 'Procesando';
    case 'processing':
      return 'Procesando';
    case 'done':
      return 'Completado';
    case 'done_with_warnings':
      return 'Completado';
    case 'error':
      return 'Error';
    default:
      return status;
  }
}

export function getJobStatusClass(status: string) {
  switch (status) {
    case 'pending':
      return 'badge badge-secondary';
    case 'processing':
      return 'badge badge-info';
    case 'done':
      return 'badge badge-success';
    case 'done_with_warnings':
      return 'badge badge-success';
    case 'error':
      return 'badge badge-danger';
    default:
      return 'badge badge-secondary';
  }
}

