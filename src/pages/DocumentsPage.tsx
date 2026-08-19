import { useState, useEffect } from 'react';
import { useAllDocuments, fetchAllDocumentsForExport, DocumentFilters } from '../hooks/useAllDocuments';
import { useClients } from '../hooks/useClients';
import { DocumentsTable } from '../components/documents/DocumentsTable';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exportToCSV } from '../lib/csvExport';
import { exportDocumentsToXlsx } from '../utils/excelExport';

const PAGE_SIZE = 50;

export function DocumentsPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<DocumentFilters>({});
  const [searchText, setSearchText] = useState('');
  const [exporting, setExporting] = useState(false);

  const { clients, loading: clientsLoading } = useClients();
  const { documents, loading, error, totalCount, refetch } = useAllDocuments(filters, page, PAGE_SIZE);

  // DOCS-SEARCH-EXPORT-SERVER-SIDE: el buscador viaja al query con debounce (busca en TODO el
  // historial y pagina el resultado; antes filtraba solo los 50 visibles).
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(p => {
        const next = searchText.trim() || undefined;
        if (p.searchText === next) return p;
        return { ...p, searchText: next };
      });
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [searchText]);

  const handleFechaDesdeChange  = (v: string) => { setFilters(p => ({ ...p, fechaDesde: v || undefined })); setPage(1); };
  const handleFechaHastaChange  = (v: string) => { setFilters(p => ({ ...p, fechaHasta: v || undefined })); setPage(1); };
  const handleSearchChange      = (e: React.ChangeEvent<HTMLInputElement>) => setSearchText(e.target.value);
  const handleClearFilters      = () => { setFilters({}); setSearchText(''); setPage(1); };

  // Export: trae TODO lo filtrado (hasta 5000 facturas + sus OCs), no solo la pagina visible.
  const handleExport = async (kind: 'xlsx' | 'csv') => {
    try {
      setExporting(true);
      const { documents: allDocs, totalCount: tc, truncated } = await fetchAllDocumentsForExport(filters);
      if (!allDocs.length) { alert('No hay documentos para exportar'); return; }
      if (truncated) alert(`El export incluye las primeras 5000 facturas de ${tc} que matchean el filtro. Acotá con los filtros para exportar el resto.`);
      const name = `documentos_${new Date().toISOString().split('T')[0]}`;
      if (kind === 'xlsx') exportDocumentsToXlsx(allDocs, `${name}.xlsx`);
      else exportToCSV(allDocs, `${name}.csv`);
    } catch (e) {
      alert('Error al exportar: ' + (e instanceof Error ? e.message : 'error desconocido'));
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            Todos los{' '}
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#A347D1', color: '#ffffff' }}>documentos</span>
          </h1>
          <p className="text-sm text-muted-foreground">Listado consolidado de todos los comprobantes procesados.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button onClick={() => handleExport('xlsx')} disabled={exporting || totalCount === 0}>{exporting ? 'Exportando…' : 'Exportar a Excel'}</Button>
            <Button variant="outline" size="sm" onClick={() => handleExport('csv')} disabled={exporting || totalCount === 0}>{exporting ? 'Exportando…' : 'Exportar CSV'}</Button>
          </div>
          <p className="text-xs text-muted-foreground">Exporta TODOS los documentos que matchean los filtros</p>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Filtros</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div className="space-y-1.5">
              <Label>Fecha desde</Label>
              <DatePicker value={filters.fechaDesde || ''} onChange={handleFechaDesdeChange} />
            </div>
            <div className="space-y-1.5">
              <Label>Fecha hasta</Label>
              <DatePicker value={filters.fechaHasta || ''} onChange={handleFechaHastaChange} />
            </div>
            <div className="space-y-1.5">
              <Label>Cliente</Label>
              <Select value={filters.clientId || '__all__'} onValueChange={v => { setFilters(p => ({ ...p, clientId: v === '__all__' ? undefined : v })); setPage(1); }} disabled={clientsLoading}>
                <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos los clientes</SelectItem>
                  {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Buscador</Label>
              <Input type="text" placeholder="Buscar por proveedor, receptor, número, CUIT..." value={searchText} onChange={handleSearchChange} />
            </div>
          </div>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={handleClearFilters}>Limpiar filtros</Button>
          </div>
        </CardContent>
      </Card>

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}

      {!loading && !error && (
        <div className="space-y-4">
          <DocumentsTable documents={documents} onDocsChanged={refetch} />

          {totalPages > 1 && (
            <div className="flex justify-between items-center rounded-lg border bg-card px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, totalCount)} de {totalCount} documentos
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>Anterior</Button>
                <span className="text-sm text-muted-foreground px-2">Página {page} de {totalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Siguiente</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
