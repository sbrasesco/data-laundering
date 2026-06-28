import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LoadingSpinner } from '../components/ui/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '../lib/supabase';
import { useAuthContext } from '../contexts/AuthContext';

// ─── Env ──────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID    = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const GOOGLE_REDIRECT_URI = import.meta.env.VITE_GOOGLE_REDIRECT_URI
  ?? 'http://localhost:3001/api/auth/google/callback';
const GOOGLE_SCOPE        = 'https://www.googleapis.com/auth/drive';

const GATEWAY_BASE_URL = (import.meta.env.VITE_WORKER_GATEWAY_URL as string ?? '');
const GATEWAY_API_KEY  = import.meta.env.VITE_WORKER_API_KEY as string ?? '';

// ─── Types ────────────────────────────────────────────────────────────────────
interface PollingIntervalTier {
  interval_minutes: number;
  label: string;
  cost_per_doc: number;
}

type IntegrationType = 'frontend_only' | 'google_drive' | 'ftp' | 'sftp' | 'remote_folder' | 'firebase_storage' | 'supabase_storage';
const SELECTABLE_TYPES: IntegrationType[] = ['google_drive', 'ftp', 'sftp', 'remote_folder', 'firebase_storage', 'supabase_storage'];

interface TenantIntegration {
  id: string;
  integration_type: IntegrationType;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  folder_path: string | null;
  is_active: boolean;
  polling_interval_minutes: number;
  last_polled_at: string | null;
  updated_at: string;
  output_enabled: boolean;
  output_folder_path: string | null;
  output_format: 'csv' | 'xlsx' | 'json';
}

interface DriveFolder { id: string; name: string; }
type CredentialFields = Record<string, string>;

// ─── Static config ────────────────────────────────────────────────────────────
const TYPE_LABELS: Record<IntegrationType, string> = {
  frontend_only: 'Subida manual', google_drive: 'Google Drive',
  ftp: 'FTP', sftp: 'SFTP', remote_folder: 'Carpeta de red', firebase_storage: 'Firebase Storage', supabase_storage: 'Supabase Storage',
};
const TYPE_ACCENTS: Record<IntegrationType, string> = {
  frontend_only: '#000000', google_drive: '#22C365', ftp: '#000000',
  sftp: '#A347D1', remote_folder: '#FED210', firebase_storage: '#e11d48', supabase_storage: '#3ECF8E',
};
const TYPE_ICON_FG: Record<IntegrationType, string> = {
  frontend_only: '#fff', google_drive: '#fff', ftp: '#fff',
  sftp: '#fff', remote_folder: '#000', firebase_storage: '#fff', supabase_storage: '#000',
};
const WORKER_STATUS: Record<IntegrationType, 'available' | 'coming_soon'> = {
  frontend_only: 'available', google_drive: 'available', ftp: 'available', sftp: 'available',
  remote_folder: 'available', firebase_storage: 'available', supabase_storage: 'available',
};
const CRED_FIELDS: Record<IntegrationType, Array<{ key: string; label: string; type?: string; placeholder?: string; required?: boolean; }>> = {
  frontend_only:    [],
  google_drive:     [],
  ftp:              [{ key: 'host', label: 'Host', placeholder: 'ftp.servidor.com', required: true }, { key: 'port', label: 'Puerto', placeholder: '21' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contrasena', type: 'password', required: true }],
  sftp:             [{ key: 'host', label: 'Host', placeholder: 'sftp.servidor.com', required: true }, { key: 'port', label: 'Puerto', placeholder: '22' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contrasena', type: 'password' }, { key: 'private_key', label: 'Clave privada (SSH)', type: 'textarea', placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...' }],
  remote_folder:    [{ key: 'server_path', label: 'Ruta del servidor', placeholder: '\\\\\\\\servidor\\\\compartido\\\\facturas', required: true }, { key: 'domain', label: 'Dominio (opcional)', placeholder: 'WORKGROUP' }, { key: 'username', label: 'Usuario', required: true }, { key: 'password', label: 'Contrasena', type: 'password', required: true }],
  firebase_storage: [{ key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', placeholder: '{ "type": "service_account", ... }', required: true }, { key: 'bucket_name', label: 'Nombre del bucket', placeholder: 'mi-proyecto.appspot.com', required: true }],
  supabase_storage: [{ key: 'project_url', label: 'URL del proyecto', placeholder: 'https://xxxxx.supabase.co', required: true }, { key: 'service_role_key', label: 'Service Role Key', type: 'password', placeholder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', required: true }, { key: 'bucket_name', label: 'Nombre del bucket', placeholder: 'facturas', required: true }],
};
const EMPTY_CREDS: Record<IntegrationType, CredentialFields> = {
  frontend_only: {}, google_drive: {},
  ftp: { host: '', port: '21', username: '', password: '' },
  sftp: { host: '', port: '22', username: '', password: '', private_key: '' },
  remote_folder: { server_path: '', domain: '', username: '', password: '' },
  firebase_storage: { service_account_json: '', bucket_name: '' },
  supabase_storage: { project_url: '', service_role_key: '', bucket_name: '' },
};

// ─── SVG Icons ────────────────────────────────────────────────────────────────
function IntegTypeIcon({ type, size = 18 }: { type: IntegrationType; size?: number }) {
  const p = { width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, viewBox: '0 0 24 24', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (type) {
    case 'google_drive':
      return <svg {...p}><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>;
    case 'ftp':
      return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case 'sftp':
      return <svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>;
    case 'remote_folder':
      return <svg {...p}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="13" x2="12" y2="17"/><polyline points="9 15 12 12 15 15"/></svg>;
    case 'firebase_storage':
      return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case 'supabase_storage':
      return <svg {...p}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
    default:
      return <svg {...p}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
  }
}

function IconFolder({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
}
function IconRefresh({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>;
}
function IconLink({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>;
}
function IconLock({ size = 14, open = false }: { size?: number; open?: boolean }) {
  if (open) return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>;
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
}
function IconUpload({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>;
}
function IconPlug({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/></svg>;
}

// ─── OAuth helpers ─────────────────────────────────────────────────────────────
function buildGoogleOAuthUrl(orgId: string, integrationId: string): string {
  const state = btoa(JSON.stringify({ orgId, integrationId }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code', scope: GOOGLE_SCOPE,
    access_type: 'offline', prompt: 'select_account consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
function hasDriveOAuth(i: TenantIntegration): boolean { return !!i.credentials?.oauth_refresh_token; }
function hasDriveFolder(i: TenantIntegration): boolean { return !!i.credentials?.folder_id; }

// ─── Componente ───────────────────────────────────────────────────────────────
export function IntegracionesPage() {
  const { organizationId } = useAuthContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const [integrations, setIntegrations] = useState<TenantIntegration[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [reinitMsg, setReinitMsg]   = useState<string | null>(null);
  const [showForm, setShowForm]     = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);

  const [selectedType, setSelectedType]       = useState<IntegrationType>('google_drive');
  const [credentials, setCredentials]         = useState<CredentialFields>({});
  const [folderPath, setFolderPath]           = useState('');
  const [pollingInterval, setPollingInterval] = useState(15);
  const [outputEnabled, setOutputEnabled]         = useState(false);
  const [outputFolder, setOutputFolder]           = useState('extracciones');
  const [outputFolderLocked, setOutputFolderLocked] = useState(true);
  const [outputFolderOptions, setOutputFolderOptions] = useState<DriveFolder[]>([]);
  const [loadingOutputFolders, setLoadingOutputFolders] = useState(false);
  const [outputFolderError, setOutputFolderError] = useState<string | null>(null);
  const [outputFormat, setOutputFormat]           = useState<'csv' | 'xlsx' | 'json'>('csv');
  const [showXlsxDisclosure, setShowXlsxDisclosure] = useState(false);

  // Comprobar conexión (test-connection) + carpetas listadas del bucket
  const [testing, setTesting]           = useState(false);
  const [testStatus, setTestStatus]     = useState<'idle' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg]           = useState<string | null>(null);
  const [folderOptions, setFolderOptions] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [pollingTiers, setPollingTiers] = useState<PollingIntervalTier[]>([]);
  const [masterFileCost, setMasterFileCost] = useState(0); // costo del Excel acumulativo (TASK-105)

  const [driveFolders, setDriveFolders]     = useState<Record<string, DriveFolder[]>>({});
  const [loadingFolders, setLoadingFolders] = useState<Record<string, boolean>>({});
  const [folderError, setFolderError]       = useState<Record<string, string>>({});
  const [selectedFolder, setSelectedFolder] = useState<Record<string, string>>({});
  const [changingFolder, setChangingFolder] = useState<Record<string, boolean>>({});
  const [newFolderName, setNewFolderName] = useState<Record<string, string>>({});
  const [creatingDriveFolder, setCreatingDriveFolder] = useState<Record<string, boolean>>({});
  const [savingFolder, setSavingFolder]     = useState<Record<string, boolean>>({});

  const loadIntegrations = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_my_integrations');
      if (rpcError) throw rpcError;
      setIntegrations((data as TenantIntegration[]) ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar integraciones');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  useEffect(() => {
    supabase
      .from('polling_interval_tiers')
      .select('interval_minutes, label, cost_per_doc')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .then(({ data }) => { if (data) setPollingTiers(data as PollingIntervalTier[]); });
  }, []);

  // Costo del Excel acumulativo (feature master_file) — precio dinámico (TASK-105)
  useEffect(() => {
    supabase
      .from('feature_pricing_multipliers')
      .select('cost_usd')
      .eq('feature_key', 'master_file')
      .eq('active', true)
      .maybeSingle()
      .then(({ data }) => { if (data) setMasterFileCost(Number(data.cost_usd) || 0); });
  }, []);

  useEffect(() => {
    const connected     = searchParams.get('google_connected');
    const integrationId = searchParams.get('integration_id');
    const oauthErr      = searchParams.get('google_error');
    if (connected === 'true') {
      setSearchParams({}, { replace: true });
      if (integrationId) {
        setChangingFolder(prev => ({ ...prev, [integrationId]: true }));
        supabase.rpc('toggle_tenant_integration', { p_integration_id: integrationId, p_active: true })
          .then(() => loadIntegrations());
      }
      setSuccessMsg('Google Drive conectado. Elegí o creá una carpeta dedicada para Agora.');
    } else if (oauthErr) {
      setError(`Error al conectar con Google Drive: ${oauthErr}`);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, loadIntegrations]);

  useEffect(() => {
    if (!organizationId) return;
    integrations.forEach((i) => {
      if (i.integration_type === 'google_drive' && hasDriveOAuth(i) && (!hasDriveFolder(i) || changingFolder[i.id])) {
        if (!driveFolders[i.id] && !loadingFolders[i.id]) fetchDriveFolders(i.id);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations, organizationId]);

  const fetchDriveFolders = async (integrationId: string) => {
    if (!organizationId) return;
    setLoadingFolders(prev => ({ ...prev, [integrationId]: true }));
    setFolderError(prev => ({ ...prev, [integrationId]: '' }));
    try {
      const res = await fetch(
        `${GATEWAY_BASE_URL}/api/drive/folders?integration_id=${integrationId}&org_id=${organizationId}`,
        { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error listando carpetas');
      setDriveFolders(prev => ({ ...prev, [integrationId]: data.folders ?? [] }));
    } catch (e: unknown) {
      setFolderError(prev => ({ ...prev, [integrationId]: e instanceof Error ? e.message : 'Error' }));
    } finally {
      setLoadingFolders(prev => ({ ...prev, [integrationId]: false }));
    }
  };

  const handleSetFolder = async (integration: TenantIntegration, folderIdArg?: string, folderNameArg?: string) => {
    const folderId = folderIdArg ?? selectedFolder[integration.id];
    if (!folderId || !organizationId) return;
    const folderName = folderNameArg ?? driveFolders[integration.id]?.find(f => f.id === folderId)?.name ?? folderId;
    setSavingFolder(prev => ({ ...prev, [integration.id]: true }));
    try {
      const res = await fetch(`${GATEWAY_BASE_URL}/api/drive/set-folder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_id: integration.id, org_id: organizationId, folder_id: folderId, folder_name: folderName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error guardando carpeta');
      setSuccessMsg(`Carpeta "${folderName}" configurada. La integracion esta lista.`);
      setChangingFolder(prev => ({ ...prev, [integration.id]: false }));
      await loadIntegrations();
    } catch (e: unknown) {
      setFolderError(prev => ({ ...prev, [integration.id]: e instanceof Error ? e.message : 'Error' }));
    } finally {
      setSavingFolder(prev => ({ ...prev, [integration.id]: false }));
    }
  };

  const resetForm = () => {
    setEditingId(null); setSelectedType('google_drive'); setCredentials({});
    setFolderPath(''); setPollingInterval(15); setOutputEnabled(false);
    setOutputFolder('extracciones'); setOutputFolderLocked(true); setOutputFormat('csv'); setSaveError(null);
    resetConnTest();
  };

  const openConfigureForm = (type: IntegrationType) => {
    resetForm(); setSelectedType(type); setCredentials({ ...EMPTY_CREDS[type] }); setSuccessMsg(null); setShowForm(true);
  };

  const openEditForm = (i: TenantIntegration) => {
    setEditingId(i.id); setSelectedType(i.integration_type);
    setCredentials(i.integration_type === 'google_drive' ? {} : { ...i.credentials });
    setFolderPath(i.folder_path ?? ''); setPollingInterval(i.polling_interval_minutes);
    setOutputEnabled(i.output_enabled ?? false);
    const savedFolder = i.output_folder_path ?? 'extracciones';
    setOutputFolder(savedFolder); setOutputFolderLocked(savedFolder === 'extracciones');
    setOutputFormat((i.output_format ?? 'csv') as 'csv' | 'xlsx' | 'json');
    setSaveError(null); setShowForm(true);
    resetConnTest();
    // Auto-comprobar conexión al editar una integración que soporta listado (trae el dropdown sin clic manual)
    if (supportsConnTest(i.integration_type) && i.credentials && Object.keys(i.credentials).length > 0) {
      void runConnTest(i.integration_type, i.credentials as CredentialFields);
    }
  };

  // Init folders en el storage del cliente — best-effort, no bloquea el flujo
  const callInitFolders = async (integrationId: string) => {
    if (!organizationId || !integrationId) return;
    try {
      await fetch(`${GATEWAY_BASE_URL}/api/integrations/init-folders`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_API_KEY}` },
        body:    JSON.stringify({ integration_id: integrationId, org_id: organizationId }),
      });
    } catch (_) { /* best-effort — no bloquear al usuario */ }
  };

  // Migrar carpetas (system folders + sueltos) al cambiar la ruta de escucha — best-effort
  const callMigrateFolders = async (integrationId: string, oldFolder: string, newFolder: string) => {
    if (!organizationId || !integrationId) return;
    try {
      await fetch(`${GATEWAY_BASE_URL}/api/integrations/migrate-folders`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_API_KEY}` },
        body:    JSON.stringify({ integration_id: integrationId, org_id: organizationId, old_folder_path: oldFolder, new_folder_path: newFolder }),
      });
    } catch (_) { /* best-effort */ }
  };

  // Tipos que soportan comprobación de conexión + listado de carpetas
  const supportsConnTest = (t: IntegrationType) => t === 'supabase_storage';

  const resetConnTest = () => { setTestStatus('idle'); setTestMsg(null); setFolderOptions([]); setCreatingFolder(false); };

  // Editar una credencial invalida el test previo (hay que re-comprobar)
  const updateCred = (key: string, val: string) => { setCredentials(c => ({ ...c, [key]: val })); resetConnTest(); };

  const runConnTest = async (type: IntegrationType, creds: CredentialFields) => {
    setTesting(true); setTestStatus('idle'); setTestMsg(null);
    try {
      const res = await fetch(`${GATEWAY_BASE_URL}/api/integrations/test-connection`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_API_KEY}` },
        body:    JSON.stringify({ integration_type: type, credentials: creds }),
      });
      const data = await res.json();
      if (data?.ok) {
        setTestStatus('ok');
        setFolderOptions(Array.isArray(data.folders) ? data.folders : []);
        setTestMsg('Conectado correctamente.');
      } else {
        setTestStatus('error');
        setFolderOptions([]);
        setTestMsg(data?.error ?? 'No se pudo conectar.');
      }
    } catch (e: unknown) {
      setTestStatus('error');
      setFolderOptions([]);
      setTestMsg(e instanceof Error ? e.message : 'Error de conexión');
    } finally { setTesting(false); }
  };

  const handleTestConnection = () => runConnTest(selectedType, credentials);

  // Confirmar el nombre de una carpeta nueva: la fija y la agrega al dropdown como seleccionada.
  // No la crea todavía — eso ocurre al Guardar (init/migrate la materializa en el bucket).
  const confirmNewFolder = () => {
    const name = folderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { setCreatingFolder(false); setFolderPath(''); return; }
    if (!folderOptions.includes(name)) setFolderOptions(opts => [...opts, name]);
    setFolderPath(name);
    setCreatingFolder(false);
  };

  const handleSave = async () => {
    setSaving(true); setSaveError(null);
    try {
      const prevFolder = editingId ? (integrations.find(i => i.id === editingId)?.folder_path ?? '') : '';
      const { data: integrationId, error: rpcError } = await supabase.rpc('upsert_tenant_integration', {
        p_type: selectedType, p_config: {}, p_credentials: credentials,
        p_folder_path: folderPath || null, p_interval: pollingInterval,
        p_output_enabled: outputEnabled,
        p_output_folder: outputEnabled ? (outputFolder || 'output') : null,
        p_output_format: outputFormat,
      });
      if (rpcError) throw rpcError;
      if (integrationId) {
        const idStr = integrationId as string;
        const folderChanged = !!editingId && (prevFolder ?? '') !== (folderPath ?? '');
        if (folderChanged && selectedType !== 'google_drive') {
          // Cambió la carpeta de escucha → migrar la estructura existente en vez de recrearla
          await callMigrateFolders(idStr, prevFolder ?? '', folderPath ?? '');
        } else {
          // Crear carpetas de sistema en el storage del cliente (supabase_storage, firebase_storage)
          await callInitFolders(idStr);
        }
      }
      setShowForm(false); await loadIntegrations();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Error al guardar');
    } finally { setSaving(false); }
  };

  // Re-inicializar carpetas sin re-guardar (botón en tarjeta activa)
  const handleReinitFolders = async (integration: TenantIntegration) => {
    if (!organizationId) return;
    setReinitMsg(null);
    try {
      const res = await fetch(`${GATEWAY_BASE_URL}/api/integrations/init-folders`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_API_KEY}` },
        body:    JSON.stringify({ integration_id: integration.id, org_id: organizationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setReinitMsg('Carpetas inicializadas correctamente.');
      setTimeout(() => setReinitMsg(null), 4000);
    } catch (e: unknown) {
      setReinitMsg(e instanceof Error ? e.message : 'Error al inicializar carpetas');
      setTimeout(() => setReinitMsg(null), 5000);
    }
  };

  const handleConnectGoogleDrive = async () => {
    if (!organizationId) { setSaveError('No se pudo obtener el ID de organizacion.'); return; }
    if (!GOOGLE_CLIENT_ID) { setSaveError('VITE_GOOGLE_CLIENT_ID no esta configurado.'); return; }
    setSaving(true); setSaveError(null);
    try {
      const { data: integrationId, error: rpcError } = await supabase.rpc('upsert_tenant_integration', {
        p_type: 'google_drive', p_config: {}, p_credentials: {},
        p_folder_path: null, p_interval: pollingInterval,
        p_output_enabled: outputEnabled,
        p_output_folder: outputEnabled ? (outputFolder || 'output') : null,
        p_output_format: outputFormat,
      });
      if (rpcError) throw rpcError;
      window.location.href = buildGoogleOAuthUrl(organizationId, integrationId as string);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Error al iniciar conexion');
      setSaving(false);
    }
  };

  const handleReconnectGoogle = (integration: TenantIntegration) => {
    if (!organizationId) { setSaveError('No se pudo obtener el ID de organizacion.'); return; }
    if (!GOOGLE_CLIENT_ID) { setSaveError('VITE_GOOGLE_CLIENT_ID no esta configurado en el frontend.'); return; }
    window.location.href = buildGoogleOAuthUrl(organizationId, integration.id);
  };

  const handleCreateFolder = async (integration: TenantIntegration) => {
    const name = (newFolderName[integration.id] ?? 'Agora').trim();
    if (!name || !organizationId) return;
    setCreatingDriveFolder(prev => ({ ...prev, [integration.id]: true }));
    setFolderError(prev => ({ ...prev, [integration.id]: '' }));
    try {
      const res = await fetch(`${GATEWAY_BASE_URL}/api/drive/create-folder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_id: integration.id, org_id: organizationId, folder_name: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error creando la carpeta');
      setNewFolderName(prev => ({ ...prev, [integration.id]: '' }));
      await handleSetFolder(integration, data.id, data.name);
    } catch (e: unknown) {
      setFolderError(prev => ({ ...prev, [integration.id]: e instanceof Error ? e.message : 'Error creando la carpeta' }));
    } finally {
      setCreatingDriveFolder(prev => ({ ...prev, [integration.id]: false }));
    }
  };

  const fetchOutputFolderOptions = async (integrationId: string) => {
    if (!organizationId) return;
    setLoadingOutputFolders(true); setOutputFolderOptions([]); setOutputFolderError(null);
    try {
      const res = await fetch(
        `${GATEWAY_BASE_URL}/api/drive/folders?integration_id=${integrationId}&org_id=${organizationId}`,
        { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setOutputFolderOptions(data.folders ?? []);
    } catch (e: unknown) {
      setOutputFolderError(e instanceof Error ? e.message : 'Error cargando carpetas');
    } finally { setLoadingOutputFolders(false); }
  };

  const [confirmActivate, setConfirmActivate] = useState<{ id: string; newType: string; currentType: string } | null>(null);

  const handleToggle = async (id: string, current: boolean, integrationType: string) => {
    if (!current) {
      const activeIntegration = integrations.find(i => i.is_active && i.id !== id);
      if (activeIntegration) {
        setConfirmActivate({
          id,
          newType: TYPE_LABELS[integrationType as IntegrationType] ?? integrationType,
          currentType: TYPE_LABELS[activeIntegration.integration_type] ?? activeIntegration.integration_type,
        });
        return;
      }
    }
    await doToggle(id, current);
  };

  const doToggle = async (id: string, current: boolean) => {
    try {
      const { error: rpcError } = await supabase.rpc('toggle_tenant_integration', { p_integration_id: id, p_active: !current });
      if (rpcError) throw rpcError;
      await loadIntegrations();
    } catch (e: unknown) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminar esta integracion?')) return;
    try {
      const { error: rpcError } = await supabase.rpc('delete_tenant_integration', { p_integration_id: id });
      if (rpcError) throw rpcError;
      await loadIntegrations();
    } catch (e: unknown) { console.error(e); }
  };


  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="inline-block px-2 py-0.5 rounded-lg" style={{ background: '#A347D1', color: '#ffffff' }}>Integraciones</span>
          </h1>
          <p className="text-sm text-muted-foreground">Configura desde donde el sistema busca archivos para procesar automaticamente.</p>
        </div>
      </div>

      {error      && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {successMsg && <Alert><AlertDescription>{successMsg}</AlertDescription></Alert>}

      {/* Layout: activa (izq) + resto (der) */}
      {(() => {
        const activeType   = SELECTABLE_TYPES.find(t => integrations.find(i => i.integration_type === t && i.is_active)) ?? null;
        const activeInteg  = activeType ? integrations.find(i => i.integration_type === activeType && i.is_active)! : null;
        const otherTypes   = SELECTABLE_TYPES.filter(t => t !== activeType);

        return (
          <div className="flex gap-5 items-start">

            {/* Columna izquierda: integración activa */}
            <div className="w-[340px] flex-shrink-0">
              {activeInteg && activeType ? (
                <Card className="overflow-hidden ring-2 ring-[#22C365]">
                  <CardContent className="p-0">

                    {/* Header */}
                    <div className="flex items-center gap-3 px-5 py-4">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                        style={{ background: TYPE_ACCENTS[activeType], color: TYPE_ICON_FG[activeType] }}>
                        <IntegTypeIcon type={activeType} size={20} />
                      </div>
                      <div>
                        <p className="font-semibold text-sm leading-tight">{TYPE_LABELS[activeType]}</p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Badge variant="success">Activa</Badge>
                          {activeType === 'google_drive' && (
                            hasDriveOAuth(activeInteg)
                              ? <Badge variant="info">OAuth conectado</Badge>
                              : <Badge variant="outline" className="text-orange-600 border-orange-300">Sin conectar</Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Entrada / Salida */}
                    <div className="border-t border-border divide-y divide-border">
                      <div className="px-5 py-3 space-y-1.5">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Entrada</p>
                        {changingFolder[activeInteg.id] ? (
                          <p className="text-xs text-muted-foreground italic">Elegí una carpeta abajo</p>
                        ) : activeInteg.folder_path ? (
                          <div className="flex items-start gap-1.5 text-xs">
                            <span className="text-muted-foreground flex-shrink-0 mt-px"><IconFolder /></span>
                            <span className="font-mono break-all">{activeInteg.folder_path}</span>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">Sin carpeta configurada</p>
                        )}
                        <p className="text-xs text-muted-foreground">Intervalo: cada {activeInteg.polling_interval_minutes} min</p>
                      </div>
                      <div className="px-5 py-3 space-y-1.5">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Salida</p>
                        {activeInteg.output_enabled ? (
                          <>
                            <div className="flex items-start gap-1.5 text-xs">
                              <span className="text-muted-foreground flex-shrink-0 mt-px"><IconUpload /></span>
                              <span>Formato <strong>{activeInteg.output_format?.toUpperCase()}</strong> carpeta <span className="font-mono">{activeInteg.output_folder_path ?? 'extracciones'}</span></span>
                            </div>
                            <p className="text-xs text-muted-foreground">Salida automatica habilitada</p>
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">Salida automatica deshabilitada</p>
                        )}
                      </div>
                    </div>

                    {/* Drive folder picker */}
                    {activeType === 'google_drive' && hasDriveOAuth(activeInteg) && (!hasDriveFolder(activeInteg) || changingFolder[activeInteg.id]) && (
                      <div className="border-t border-border px-5 py-3 space-y-2 bg-muted/20">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium text-muted-foreground">Carpeta raíz a monitorear</p>
                          {changingFolder[activeInteg.id] && hasDriveFolder(activeInteg) && (
                            <button type="button" onClick={() => setChangingFolder(prev => ({ ...prev, [activeInteg.id]: false }))} className="text-xs text-muted-foreground hover:text-foreground underline">Cancelar</button>
                          )}
                        </div>
                        {folderError[activeInteg.id] && <p className="text-xs text-destructive">{folderError[activeInteg.id]}</p>}
                        <Select value={selectedFolder[activeInteg.id] ?? '__new__'} onValueChange={(v) => setSelectedFolder(prev => ({ ...prev, [activeInteg.id]: v }))}>
                          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__new__">➕ Crear carpeta nueva para Agora</SelectItem>
                            {(driveFolders[activeInteg.id] ?? []).map(f => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {(selectedFolder[activeInteg.id] ?? '__new__') === '__new__' ? (
                          <div className="flex gap-2 items-center">
                            <Input value={newFolderName[activeInteg.id] ?? 'Agora'} onChange={(e) => setNewFolderName(prev => ({ ...prev, [activeInteg.id]: e.target.value }))} placeholder="Nombre de la carpeta" className="flex-1 h-9" />
                            <Button size="sm" disabled={!(newFolderName[activeInteg.id] ?? 'Agora').trim() || creatingDriveFolder[activeInteg.id]} onClick={() => handleCreateFolder(activeInteg)}>
                              {creatingDriveFolder[activeInteg.id] ? 'Creando...' : 'Crear y usar'}
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-2 items-center">
                            <Button size="sm" className="flex-1" disabled={savingFolder[activeInteg.id]} onClick={() => handleSetFolder(activeInteg)}>
                              {savingFolder[activeInteg.id] ? 'Guardando...' : 'Usar esta carpeta'}
                            </Button>
                            <button type="button" onClick={() => fetchDriveFolders(activeInteg.id)} title="Recargar carpetas" className="h-9 w-9 flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted transition-colors text-muted-foreground">
                              <IconRefresh />
                            </button>
                          </div>
                        )}
                        <p className="text-[11px] text-muted-foreground">Se crea una carpeta exclusiva para Agora; adentro se arman las subcarpetas de proceso por cliente.</p>
                      </div>
                    )}

                    {/* Carpeta Drive configurada */}
                    {activeType === 'google_drive' && hasDriveOAuth(activeInteg) && hasDriveFolder(activeInteg) && !changingFolder[activeInteg.id] && (
                      <div className="border-t border-border px-5 py-2 flex items-center gap-2 bg-muted/10">
                        <span className="text-xs text-muted-foreground flex items-center gap-1"><IconFolder /> Carpeta Drive:</span>
                        <span className="text-xs font-mono">{activeInteg.folder_path ?? activeInteg.credentials?.folder_id}</span>
                        <button type="button" onClick={() => { setChangingFolder(prev => ({ ...prev, [activeInteg.id]: true })); setDriveFolders(prev => { const n = {...prev}; delete n[activeInteg.id]; return n; }); fetchDriveFolders(activeInteg.id); }} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">
                          Cambiar
                        </button>
                      </div>
                    )}

                    {/* Acciones */}
                    <div className="border-t border-border px-5 py-3 flex items-center gap-3 bg-muted/20">
                      <button type="button" onClick={() => handleToggle(activeInteg.id, true, activeType)}
                        className="relative inline-flex h-5 w-9 items-center rounded-full bg-[#22C365] flex-shrink-0">
                        <span className="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow translate-x-4" />
                      </button>
                      <span className="text-xs text-muted-foreground">Activa</span>
                      <div className="ml-auto flex items-center gap-2">
                        {activeType === 'google_drive' && !hasDriveOAuth(activeInteg) && (
                          <Button size="sm" onClick={() => handleReconnectGoogle(activeInteg)} className="gap-1.5">
                            <IconLink size={13} /> Conectar
                          </Button>
                        )}
                        {activeType === 'google_drive' && hasDriveOAuth(activeInteg) && (
                          <button type="button" onClick={() => handleReconnectGoogle(activeInteg)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                            <IconRefresh size={12} /> Reconectar
                          </button>
                        )}
                        {(activeType === 'supabase_storage' || activeType === 'firebase_storage') && (
                          <button type="button" onClick={() => handleReinitFolders(activeInteg)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                            <IconRefresh size={12} /> Inicializar carpetas
                          </button>
                        )}
                        {reinitMsg && (
                          <span className="text-xs text-muted-foreground">{reinitMsg}</span>
                        )}
                        <Button size="sm" variant="outline" onClick={() => openEditForm(activeInteg)}>Editar</Button>
                      </div>
                    </div>

                  </CardContent>
                </Card>
              ) : (
                <Card className="overflow-hidden border-dashed">
                  <CardContent className="py-10 text-center space-y-2">
                    <div className="flex justify-center text-muted-foreground/30"><IconPlug size={36} /></div>
                    <p className="text-sm font-medium">Sin integracion activa</p>
                    <p className="text-xs text-muted-foreground">Activa una de las integraciones de la derecha.</p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Columna derecha: resto en grid 2x2 */}
            <div className="flex-1 grid grid-cols-2 gap-3 min-w-0 content-start">
              {otherTypes.map((type) => {
                const integration = integrations.find(i => i.integration_type === type) ?? null;
                const comingSoon = WORKER_STATUS[type] === 'coming_soon';
                return (
                  <Card key={type} className="overflow-hidden">
                    <CardContent className="p-0 flex flex-col h-full">
                      {/* Header */}
                      <div className="flex items-center gap-2.5 px-4 py-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: TYPE_ACCENTS[type], color: TYPE_ICON_FG[type] }}>
                          <IntegTypeIcon type={type} size={16} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-tight truncate">{TYPE_LABELS[type]}</p>
                          <p className="text-xs text-muted-foreground">
                            {comingSoon ? 'Proximamente' : integration ? 'Configurada' : 'Sin configurar'}
                          </p>
                        </div>
                      </div>
                      {/* Acciones */}
                      <div className="border-t border-border px-4 py-2.5 flex items-center gap-2 bg-muted/20 mt-auto">
                        <button
                          type="button"
                          disabled={!integration || comingSoon}
                          onClick={() => integration && !comingSoon && handleToggle(integration.id, integration.is_active, type)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                            integration?.is_active ? 'bg-[#22C365]' : 'bg-slate-300'
                          } ${(!integration || comingSoon) ? 'opacity-30 cursor-not-allowed' : ''}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${integration?.is_active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                        <div className="ml-auto">
                          {integration ? (
                            <Button size="sm" variant="outline" onClick={() => openEditForm(integration)}>Editar</Button>
                          ) : !comingSoon ? (
                            <Button size="sm" variant="outline" onClick={() => openConfigureForm(type)}>Configurar</Button>
                          ) : null}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

          </div>
        );
      })()}

      {/* Modal: formulario nueva/editar integracion */}
      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { setShowForm(false); resetForm(); } }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: TYPE_ACCENTS[selectedType], color: TYPE_ICON_FG[selectedType] }}>
                <IntegTypeIcon type={selectedType} size={18} />
              </div>
              <div>
                <DialogTitle>{editingId ? `Editar - ${TYPE_LABELS[selectedType]}` : `Configurar - ${TYPE_LABELS[selectedType]}`}</DialogTitle>
                <DialogDescription>
                  {editingId ? 'Modifica la configuracion de esta integracion.' : 'Configura los accesos para esta fuente.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-5 pt-1">

            {/* Aviso Google Drive */}
            {selectedType === 'google_drive' && (
              <Alert>
                <AlertDescription className="text-sm">
                  Configura el intervalo y luego hace click en <strong>"Conectar con Google Drive"</strong>. Despues de autorizar, podras seleccionar la carpeta a monitorear.
                </AlertDescription>
              </Alert>
            )}

            {/* Credenciales */}
            {CRED_FIELDS[selectedType].length > 0 && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">Credenciales</Label>
                {CRED_FIELDS[selectedType].map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <Label htmlFor={`cred-${field.key}`} className="text-sm">
                      {field.label}{field.required && <span className="text-destructive ml-1">*</span>}
                    </Label>
                    {field.type === 'textarea'
                      ? <textarea id={`cred-${field.key}`} value={credentials[field.key] ?? ''}
                          onChange={(e) => updateCred(field.key, e.target.value)}
                          placeholder={field.placeholder} rows={4}
                          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y" />
                      : <Input id={`cred-${field.key}`} type={field.type ?? 'text'}
                          value={credentials[field.key] ?? ''}
                          onChange={(e) => updateCred(field.key, e.target.value)}
                          placeholder={field.placeholder} />
                    }
                  </div>
                ))}
              </div>
            )}

            {/* Comprobar conexión (supabase_storage) */}
            {supportsConnTest(selectedType) && (
              <div className="space-y-2">
                <Button type="button" variant="outline" size="sm" onClick={handleTestConnection} disabled={testing} className="gap-1.5">
                  <IconLink size={13} /> {testing ? 'Comprobando...' : 'Comprobar conexion'}
                </Button>
                {testStatus === 'ok' && (
                  <p className="text-sm text-emerald-600 flex items-center gap-1">✓ {testMsg}</p>
                )}
                {testStatus === 'error' && (
                  <Alert variant="destructive"><AlertDescription className="text-sm">{testMsg}</AlertDescription></Alert>
                )}
              </div>
            )}

            {/* Carpeta + intervalo */}
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              {selectedType !== 'google_drive' && (
                <div className="space-y-1.5">
                  <Label>Carpeta a monitorear</Label>
                  {supportsConnTest(selectedType) && testStatus === 'ok' ? (
                    creatingFolder ? (
                      <div className="flex gap-1.5 items-center">
                        <Input type="text" value={folderPath} autoFocus placeholder="nombre-de-carpeta"
                          onChange={(e) => setFolderPath(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNewFolder(); } }} />
                        <button type="button" title="Confirmar nombre" disabled={!folderPath.trim()}
                          onClick={confirmNewFolder}
                          className="h-9 w-9 flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40">✓</button>
                        <button type="button" title="Cancelar"
                          onClick={() => { setCreatingFolder(false); setFolderPath(''); }}
                          className="h-9 w-9 flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted text-muted-foreground">✕</button>
                      </div>
                    ) : (
                      <Select
                        value={folderPath === '' ? '__root__' : (folderOptions.includes(folderPath) ? folderPath : '__new__')}
                        onValueChange={(v) => {
                          if (v === '__new__') { setCreatingFolder(true); setFolderPath(''); }
                          else if (v === '__root__') { setFolderPath(''); }
                          else setFolderPath(v);
                        }}>
                        <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__root__">(raiz del bucket)</SelectItem>
                          {folderOptions.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                          <SelectItem value="__new__">+ Crear carpeta nueva...</SelectItem>
                        </SelectContent>
                      </Select>
                    )
                  ) : (
                    <Input type="text" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="/facturas/entrantes" />
                  )}
                </div>
              )}
              <div className={`space-y-1.5 ${selectedType === 'google_drive' ? 'col-span-2 max-w-[240px]' : ''}`}>
                <Label>Intervalo de escucha</Label>
                <Select
                  value={String(pollingInterval)}
                  onValueChange={(v) => setPollingInterval(Number(v))}
                >
                  <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {pollingTiers.length > 0
                      ? pollingTiers.map((t) => (
                          <SelectItem key={t.interval_minutes} value={String(t.interval_minutes)}>
                            {t.label}{t.cost_per_doc > 0 ? ` (+$${t.cost_per_doc.toFixed(2)}/doc)` : ''}
                          </SelectItem>
                        ))
                      : <SelectItem value={String(pollingInterval)}>{pollingInterval} min</SelectItem>
                    }
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Salida automatica */}
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium flex items-center gap-1.5">
                    <IconUpload size={13} /> Salida automatica
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Depositar el resultado al terminar el procesamiento.</p>
                </div>
                <button type="button" onClick={() => { const next = !outputEnabled; setOutputEnabled(next); if (!next) setOutputFormat('csv'); }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${outputEnabled ? 'bg-primary' : 'bg-slate-300'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${outputEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {outputEnabled && (
                <div className="grid grid-cols-[2fr_1fr] gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Carpeta de salida</Label>
                    <div className="flex gap-1.5 items-center">
                      {outputFolderLocked ? (
                        <div className="flex flex-1 items-center gap-2 h-9 px-3 rounded-md border border-input bg-muted text-sm text-muted-foreground">
                          <IconFolder size={13} />
                          <span className="font-mono flex-1">{outputFolder}</span>
                        </div>
                      ) : selectedType === 'google_drive' && editingId ? (
                        loadingOutputFolders
                          ? <div className="flex flex-1 items-center h-9 px-3 text-sm text-muted-foreground">Cargando carpetas...</div>
                          : outputFolderError
                            ? <div className="flex flex-1 items-center gap-2 h-9 px-3 text-sm text-destructive">
                                <span>{outputFolderError}</span>
                                <button type="button" onClick={() => fetchOutputFolderOptions(editingId)} className="underline text-xs">Reintentar</button>
                              </div>
                            : (
                              <Select value={outputFolder} onValueChange={setOutputFolder}>
                                <SelectTrigger className="flex-1 h-9"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="extracciones">extracciones (default)</SelectItem>
                                  {outputFolderOptions.filter(f => f.name !== 'extracciones').map(f => <SelectItem key={f.id} value={f.name}>{f.name}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            )
                      ) : (
                        <Input className="flex-1" value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)} placeholder="extracciones" autoFocus />
                      )}
                      <button
                        type="button"
                        title={outputFolderLocked ? 'Cambiar carpeta de salida' : 'Volver al default'}
                        onClick={() => {
                          if (outputFolderLocked) {
                            setOutputFolderLocked(false);
                            if (selectedType === 'google_drive' && editingId) fetchOutputFolderOptions(editingId);
                          } else {
                            setOutputFolder('extracciones');
                            setOutputFolderLocked(true);
                          }
                        }}
                        className="h-9 w-9 flex items-center justify-center rounded-md border border-input bg-background hover:bg-muted transition-colors text-muted-foreground"
                      >
                        <IconLock size={14} open={!outputFolderLocked} />
                      </button>
                    </div>
                    {!outputFolderLocked && (
                      <p className="text-xs text-muted-foreground">
                        {selectedType === 'google_drive' ? 'Selecciona la carpeta destino en tu Drive.' : 'Ingresa el nombre de la carpeta de salida.'}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Formato</Label>
                    <Select
                      value={outputFormat}
                      onValueChange={(val) => {
                        const v = val as 'csv' | 'xlsx' | 'json';
                        if (v === 'xlsx' && !localStorage.getItem('dl_xlsx_disclosure_seen')) {
                          setShowXlsxDisclosure(true);
                        } else {
                          setOutputFormat(v);
                        }
                      }}
                    >
                      <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="csv">CSV</SelectItem>
                        <SelectItem value="xlsx">Excel acumulativo (.xlsx){selectedType === 'google_drive' && masterFileCost > 0 ? ` (+$${masterFileCost.toFixed(2)}/doc)` : ''}</SelectItem>
                        <SelectItem value="json">JSON (proximamente)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}

            {/* Botones */}
            <div className="flex gap-3 pt-1">
              {selectedType === 'google_drive' && !editingId ? (
                <Button onClick={handleConnectGoogleDrive} disabled={saving} className="gap-1.5">
                  <IconLink size={13} /> {saving ? 'Conectando...' : 'Conectar con Google Drive'}
                </Button>
              ) : (
                <Button onClick={handleSave} disabled={saving || (supportsConnTest(selectedType) && testStatus !== 'ok')}>{saving ? 'Guardando...' : 'Guardar'}</Button>
              )}
              <Button variant="outline" onClick={() => { setShowForm(false); resetForm(); }} disabled={saving}>Cancelar</Button>
            </div>
            {supportsConnTest(selectedType) && testStatus !== 'ok' && (
              <p className="text-xs text-muted-foreground">Comproba la conexion para poder guardar.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal: confirmar cambio de integracion activa */}
      {confirmActivate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl shadow-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h2 className="font-semibold text-base">Cambiar integracion activa</h2>
            <p className="text-sm text-muted-foreground">
              Tenes <strong>{confirmActivate.currentType}</strong> activa. Si continuas, se desactivara y se activara <strong>{confirmActivate.newType}</strong>.
            </p>
            <p className="text-xs text-muted-foreground">Solo puede haber una integracion activa a la vez.</p>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" onClick={() => setConfirmActivate(null)}>Cancelar</Button>
              <Button onClick={async () => {
                const { id } = confirmActivate;
                setConfirmActivate(null);
                await doToggle(id, false);
              }}>Confirmar</Button>
            </div>
          </div>
        </div>
      )}

      {/* Disclosure: costo incremental Excel */}
      <Dialog open={showXlsxDisclosure} onOpenChange={(open) => { if (!open) setShowXlsxDisclosure(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Formato Excel costo incremental</DialogTitle>
            <DialogDescription>
              Exportar en formato <strong>Excel (.xlsx)</strong> tiene un costo ligeramente mayor por documento procesado.
              El incremento exacto se aplica segun la tabla de precios vigente. Podes volver a CSV en cualquier momento.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowXlsxDisclosure(false)}>Cancelar</Button>
            <Button onClick={() => { localStorage.setItem('dl_xlsx_disclosure_seen', '1'); setOutputFormat('xlsx'); setShowXlsxDisclosure(false); }}>
              Entendido, usar Excel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
