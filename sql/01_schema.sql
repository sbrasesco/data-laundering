-- Modelo en Supabase (adaptado a Data Laundering)

-- 1.1. Organizaciones y usuarios

-- Empresas / estudios contables
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- Perfiles de usuario (ligado a auth.users)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text,
  role text not null check (role in ('owner','user')),
  created_at timestamptz default now()
);

-- 1.2. Jobs de procesamiento PDF → Excel
create table public.pdf_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  input_file_url text not null,          -- ZIP o PDF en Supabase Storage
  output_file_url text,                  -- Excel final
  status text not null check (status in ('pending','processing','done','error')) default 'pending',
  error_message text,
  total_documents int,                   -- opcional: cantidad de PDFs dentro del ZIP
  created_at timestamptz default now(),
  finished_at timestamptz
);

