
CREATE TABLE public.app_user_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  connection_key_ciphertext text NOT NULL,
  connected_email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, connector_id)
);
GRANT ALL ON public.app_user_connections TO service_role;
ALTER TABLE public.app_user_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.waiver_drive_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waiver_id uuid NOT NULL REFERENCES public.waivers(id) ON DELETE CASCADE,
  manager_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  drive_file_id text NOT NULL,
  drive_web_view_link text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (waiver_id, manager_user_id)
);
GRANT ALL ON public.waiver_drive_uploads TO service_role;
ALTER TABLE public.waiver_drive_uploads ENABLE ROW LEVEL SECURITY;
