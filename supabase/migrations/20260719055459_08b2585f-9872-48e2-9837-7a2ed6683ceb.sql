
-- interest_registrations
CREATE TABLE public.interest_registrations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  uts_student BOOLEAN NOT NULL DEFAULT false,
  experience TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT INSERT ON public.interest_registrations TO anon, authenticated;
GRANT ALL ON public.interest_registrations TO service_role;
ALTER TABLE public.interest_registrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can submit interest" ON public.interest_registrations FOR INSERT TO anon, authenticated WITH CHECK (true);

-- waivers
CREATE TABLE public.waivers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  emergency_contact_name TEXT NOT NULL,
  emergency_contact_phone TEXT NOT NULL,
  medical_notes TEXT,
  acknowledgements JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_name TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT INSERT ON public.waivers TO anon, authenticated;
GRANT ALL ON public.waivers TO service_role;
ALTER TABLE public.waivers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can sign waiver" ON public.waivers FOR INSERT TO anon, authenticated WITH CHECK (true);

-- contact_messages
CREATE TABLE public.contact_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT INSERT ON public.contact_messages TO anon, authenticated;
GRANT ALL ON public.contact_messages TO service_role;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can send contact message" ON public.contact_messages FOR INSERT TO anon, authenticated WITH CHECK (true);
