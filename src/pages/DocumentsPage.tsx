import { useState, useMemo } from 'react';
import { useAllDocuments, DocumentFilters } from '../hooks/useAllDocuments';
import { useClients } from '../hooks/useClients';
import { DocumentsTable } from '../components/documents/DocumentsTable';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

  const { clients, loading: clientsLoading } = useClients();
  const { documents, loading, error, totalCount, refetch } = useAllDocuments(filters, page, PAGE_SIZE);

  const filteredDocuments = useMemo(() => {
    if (!searchText.trim()) return documents;
    const s = searchText.toLowerCase();
    return documents.filter((doc) =>
      doc.proveedor?.toLowerCase().includes(s) ||
      doc.receptor_nombre?.toLowerCase().includes(s) ||
      doc.numero_comprobante?.toLowerCase().includes(s) ||
      doc.cuit?.toLowerCase().includes(s) ||
      doc.receptor_cuit?.toLowerCase().includes(s)
    );
  }, [documents, searchText]);

  const handleFechaDesdeChange  = (e: React.ChangeEvent<HTMLInputElement>) => { setFilters(p => ({ ...p, fechaDesde: e.target.value || undefined })); setPage(1); };
  const handleFechaHastaChange  = (e: React.ChangeEvent<HTMLInputElement>) => { setFilters(p => ({ ...p, fechaHasta: e.target.value || undefined })); setPage(1); };
  const handleSearchChange      = (e: React.ChangeEvent<HTMLInputElement>) => setSearchText(e.target.value);
  const handleClearFilters      = () => { setFilters({}); setSearchText(''); setPage(1); };
  const handleExportToExcel     = () => { if (!filteredDocuments.length) { alert('No hay documentos para exportar'); return; } exportDocumentsToXlsx(filteredDocuments, `documentos_${new Date().toISOString().split('T')[0]}.xlsx`); };
  const handleExportToCSV       = () => { if (!filteredDocuments.length) { alert('No hay documentos para exportar'); return; } exportToCSV(filteredDocuments, `documentos_${new Date().toISOString().split('T')[0]}.csv`); };

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
            <Button onClick={handleExportToExcel} disabled={!filteredDocuments.length}>Exportar a Excel</Button>
            <Button variant="outline" size="sm" onClick={handleExportToCSV} disabled={!filteredDocuments.length}>Exportar CSV</Button>
          </div>
          <p className="text-xs text-muted-foreground">Exporta los documentos filtrados a Excel</p>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Filtros</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div className="space-y-1.5">
              <Label>Fecha desde</Label>
              <Input type="date" value={filters.fechaDesde || ''} onChange={handleFechaDesdeChange} />
            </div>
            <div className="space-y-1.5">
              <Label>Fecha hasta</Label>
              <Input type="date" value={filters.fechaHasta || ''} onChange={handleFechaHastaChange} />
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
          <DocumentsTable documents={filteredDocuments} onDocsChanged={refetch} />

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
