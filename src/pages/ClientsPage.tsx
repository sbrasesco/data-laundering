import { useState, FormEvent } from 'react';
import { useClients, Client } from '../hooks/useClients';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Switch } from '../components/ui/Switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const formatDate = (s: string) => new Date(s).toLocaleDateString('es-AR', { year: 'numeric', month: 'short', day: 'numeric' });

export function ClientsPage() {
  const { clients, loading, error, createClient, updateClient, toggleClientActive } = useClients();

  const [newName, setNewName] = useState('');
  const [newTaxId, setNewTaxId] = useState('');
  const [newExternalCode, setNewExternalCode] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [editForm, setEditForm] = useState({ name: '', tax_id: '', external_code: '', email: '' });

  const [submitting, setSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) { setSubmitError('El nombre es obligatorio'); return; }
    if (!newTaxId.trim()) { setSubmitError('El CUIT es obligatorio'); return; }
    if (!newEmail.trim()) { setSubmitError('El email es obligatorio'); return; }
    setSubmitting(true); setSubmitError(null); setSubmitSuccess(false);
    const { error: createError } = await createClient({ name: newName.trim(), tax_id: newTaxId.trim(), external_code: newExternalCode.trim() || undefined, email: newEmail.trim() });
    if (createError) { setSubmitError(createError); } else { setSubmitSuccess(true); setNewName(''); setNewTaxId(''); setNewExternalCode(''); setNewEmail(''); setShowForm(false); setTimeout(() => setSubmitSuccess(false), 3000); }
    setSubmitting(false);
  };

  const handleEditClick = (client: Client) => {
    setEditingClient(client);
    setEditForm({ name: client.name, tax_id: client.tax_id || '', external_code: client.external_code || '', email: client.email || '' });
  };

  const handleEditSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingClient) return;
    if (!editForm.name.trim()) { setEditError('El nombre es obligatorio'); return; }
    if (!editForm.tax_id.trim()) { setEditError('El CUIT es obligatorio'); return; }
    if (!editForm.email.trim()) { setEditError('El email es obligatorio'); return; }
    setEditSubmitting(true); setEditError(null);
    try {
      await updateClient(editingClient.id, { name: editForm.name.trim(), tax_id: editForm.tax_id.trim(), external_code: editForm.external_code.trim() || null, email: editForm.email.trim() });
      setEditingClient(null);
    } catch (err) { console.error(err); } finally { setEditSubmitting(false); }
  };

  const handleToggleActive = async (client: Client) => {
    setTogglingId(client.id);
    await toggleClientActive(client.id, client.is_active);
    setTogglingId(null);
  };

  const visibleClients = showInactive ? clients : clients.filter(c => c.is_active);

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#FED210', color: '#000000' }}>Clientes</span>
          </h1>
          <p className="text-sm text-muted-foreground">Gestión de clientes de la organización.</p>
        </div>
        <Button variant={showForm ? 'outline' : 'default'} onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancelar' : 'Nuevo cliente'}
        </Button>
      </div>

      {submitSuccess && <Alert variant="success"><AlertDescription>Cliente creado exitosamente</AlertDescription></Alert>}

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">Nuevo Cliente</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Nombre <span className="text-destructive">*</span></Label>
                <Input id="name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} required disabled={submitting} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="tax_id">CUIT / Tax ID <span className="text-destructive">*</span></Label>
                  <Input id="tax_id" type="text" value={newTaxId} onChange={(e) => setNewTaxId(e.target.value)} disabled={submitting} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="external_code">Código Externo</Label>
                  <Input id="external_code" type="text" value={newExternalCode} onChange={(e) => setNewExternalCode(e.target.value)} disabled={submitting} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email <span className="text-destructive">*</span></Label>
                <Input id="email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} disabled={submitting} />
              </div>
              {submitError && <ErrorMessage message={submitError} />}
              <div className="flex gap-3">
                <Button type="submit" disabled={submitting}>{submitting ? 'Creando...' : 'Crear cliente'}</Button>
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); setNewName(''); setNewTaxId(''); setNewExternalCode(''); setNewEmail(''); setSubmitError(null); }} disabled={submitting}>Cancelar</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading && <LoadingSpinner />}
      {error && <ErrorMessage message={error} />}

      {!loading && !error && (
        <div className="space-y-4">
          <div className="flex items-center">
            <Switch checked={showInactive} onChange={(v) => setShowInactive(v)} label="Mostrar clientes inactivos" />
          </div>

          {visibleClients.length === 0 ? (
            <Card><CardContent className="py-12 text-center"><p className="text-sm text-muted-foreground">{showInactive ? 'No hay clientes registrados.' : 'No hay clientes activos registrados.'}</p></CardContent></Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead><TableHead>CUIT</TableHead><TableHead>Código Externo</TableHead>
                    <TableHead>Email</TableHead><TableHead>Estado</TableHead><TableHead>Fecha Creación</TableHead><TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleClients.map((client) => (
                    <TableRow key={client.id}>
                      <TableCell className="font-medium text-sm">{client.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{client.tax_id || '-'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{client.external_code || '-'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{client.email || '-'}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch checked={client.is_active} onChange={() => handleToggleActive(client)} disabled={togglingId === client.id} />
                          <span className="text-sm text-muted-foreground">{client.is_active ? 'Activo' : 'Inactivo'}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(client.created_at)}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => handleEditClick(client)} disabled={submitting || editSubmitting || togglingId !== null}>Editar</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      )}

      <Dialog open={!!editingClient} onOpenChange={(open) => !open && setEditingClient(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Editar Cliente</DialogTitle></DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Nombre <span className="text-destructive">*</span></Label>
              <Input id="edit-name" type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required disabled={editSubmitting} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-tax_id">CUIT / Tax ID <span className="text-destructive">*</span></Label>
                <Input id="edit-tax_id" type="text" value={editForm.tax_id} onChange={(e) => setEditForm({ ...editForm, tax_id: e.target.value })} disabled={editSubmitting} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-external_code">Código Externo</Label>
                <Input id="edit-external_code" type="text" value={editForm.external_code} onChange={(e) => setEditForm({ ...editForm, external_code: e.target.value })} disabled={editSubmitting} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-email">Email <span className="text-destructive">*</span></Label>
              <Input id="edit-email" type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} disabled={editSubmitting} />
            </div>
            {editError && <ErrorMessage message={editError} />}
            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={editSubmitting}>{editSubmitting ? 'Guardando...' : 'Guardar cambios'}</Button>
              <Button type="button" variant="outline" onClick={() => setEditingClient(null)} disabled={editSubmitting}>Cancelar</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
