import { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface EditRowModalProps {
  row: any | null;
  onClose: () => void;
  onSave: (rowId: number, updates: Record<string, any>) => Promise<void>;
  onSaveAndProcess?: (rowId: number, updates: Record<string, any>) => Promise<void>;
  saving: boolean;
}

const DOC_TYPE_OPTIONS = [
  'Factura A', 'Factura B', 'Factura C',
  'Nota de crédito A', 'Nota de crédito B', 'Nota de crédito C',
  'Presupuesto', 'Recibo', 'Ticket', 'Otro',
];

const FIELDS: { key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; options?: string[] }[] = [
  { key: 'proveedor',            label: 'Proveedor',         type: 'text' },
  { key: 'cuit',                 label: 'CUIT Emisor',       type: 'text' },
  { key: 'condicion_iva_emisor', label: 'Condición IVA',     type: 'text' },
  { key: 'tipo_documento',       label: 'Tipo Documento',    type: 'select', options: DOC_TYPE_OPTIONS },
  { key: 'codigo_afip',          label: 'Cód. AFIP',         type: 'text' },
  { key: 'punto_venta',          label: 'Punto de Venta',    type: 'text' },
  { key: 'numero_comprobante',   label: 'Nro. Comprobante',  type: 'text' },
  { key: 'fecha',                label: 'Fecha Emisión',     type: 'date' },
  { key: 'neto_gravado',         label: 'Neto Gravado',      type: 'number' },
  { key: 'iva_21',               label: 'IVA 21%',           type: 'number' },
  { key: 'iva_105',              label: 'IVA 10,5%',         type: 'number' },
  { key: 'iva_27',               label: 'IVA 27%',           type: 'number' },
  { key: 'monto_exento',         label: 'Monto Exento',      type: 'number' },
  { key: 'total',                label: 'Total',             type: 'number' },
  { key: 'nro_cae',              label: 'Nro. CAE',          type: 'text' },
  { key: 'fecha_vto_cae',        label: 'Vto. CAE',          type: 'date' },
];

export function EditRowModal({ row, onClose, onSave, onSaveAndProcess, saving }: EditRowModalProps) {
  const [values, setValues] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!row) return;
    const initial: Record<string, any> = {};
    FIELDS.forEach(f => { initial[f.key] = row[f.key] ?? ''; });
    setValues(initial);
  }, [row?.id]);

  if (!row) return null;

  const handleChange = (key: string, val: string) => {
    setValues(prev => ({ ...prev, [key]: val }));
  };

  const buildUpdates = () => {
    const updates: Record<string, any> = {};
    FIELDS.forEach(f => {
      const v = values[f.key];
      if (f.type === 'number') {
        const n = v === '' ? null : parseFloat(String(v));
        updates[f.key] = isNaN(n as number) ? null : n;
      } else {
        updates[f.key] = v === '' ? null : v;
      }
    });
    return updates;
  };

  const handleSave = async () => {
    await onSave(row.id, buildUpdates());
  };

  const handleSaveAndProcess = async () => {
    if (onSaveAndProcess) await onSaveAndProcess(row.id, buildUpdates());
  };

  return (
    <Dialog open={!!row} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar documento</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          {FIELDS.map(f => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`edit-${f.key}`} className="text-xs">{f.label}</Label>
              {f.type === 'select' ? (
                <select
                  id={`edit-${f.key}`}
                  value={values[f.key] ?? ''}
                  onChange={e => handleChange(f.key, e.target.value)}
                  disabled={saving}
                  className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">— Seleccionar —</option>
                  {values[f.key] && !f.options?.includes(values[f.key]) && (
                    <option value={values[f.key]}>{values[f.key]} (actual)</option>
                  )}
                  {f.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <Input
                  id={`edit-${f.key}`}
                  type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                  step={f.type === 'number' ? 'any' : undefined}
                  value={values[f.key] ?? ''}
                  onChange={e => handleChange(f.key, e.target.value)}
                  disabled={saving}
                  className="h-8 text-sm"
                />
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button variant="outline" onClick={handleSave} disabled={saving}>
            {saving ? 'Guardando...' : 'Guardar'}
          </Button>
          {onSaveAndProcess && (
            <Button onClick={handleSaveAndProcess} disabled={saving}>
              {saving ? 'Procesando...' : 'Guardar y Procesar'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
