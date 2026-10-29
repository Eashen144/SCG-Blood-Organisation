// =====================================================================
// S.C.G Blood Organisation — admin-create-user Edge Function
// ---------------------------------------------------------------------
// Creates a Supabase Auth user and its admin_users row.
//
// Security model
//   • The caller must present a valid Supabase access token.
//   • The caller must have an ACTIVE admin_users row with role = 'owner'.
//     (This is the same rule the original function used; it is checked
//     here on the server with the service-role client, never in the
//     browser.)
//   • The service-role key exists only in this function's secrets.
//   • Input is validated and length-limited; responses never include
//     tokens, keys or stack traces.
//   • If the admin_users insert fails the freshly created auth user is
//     deleted again, so a half-created account cannot linger.
//
// Required secret (set in Supabase, never in git):
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=... --project-ref kyueuqzxckjsmgyrrehm
//   (SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.)
//
// Optional secret:
//   APP_ALLOWED_ORIGINS="https://eashen144.github.io,http://localhost:8099"
//   When unset, the function answers with a permissive CORS policy.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const MAX_BODY_BYTES = 4096;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 72; // bcrypt/Auth limit

function corsHeaders(request: Request): Record<string, string> {
  const configured = (Deno.env.get('APP_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = configured.length === 0
    ? '*'
    : (configured.includes(origin) ? origin : configured[0]);

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, request);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !anonKey || !serviceKey) {
    // Configuration problem — tell the operator, not the visitor.
    console.error('admin-create-user: missing environment secrets', {
      hasUrl: Boolean(url),
      hasAnon: Boolean(anonKey),
      hasService: Boolean(serviceKey),
    });
    return json({
      error: 'This function is not configured on the server yet. An administrator must set its secrets.',
      code: 'not_configured',
    }, 503, request);
  }

  // ---- 1. Authenticate the caller ----------------------------------
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return json({ error: 'Unauthorized', code: 'unauthorized' }, 401, request);
  }

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: 'Unauthorized', code: 'unauthorized' }, 401, request);
  }

  // ---- 2. Authorise: active owner only -----------------------------
  const adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile, error: profileError } = await adminClient
    .from('admin_users')
    .select('role, active')
    .eq('user_id', userData.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('admin-create-user: admin lookup failed', { code: profileError.code });
    return json({ error: 'Could not verify administrator access.', code: 'lookup_failed' }, 500, request);
  }

  if (!profile || profile.active !== true || profile.role !== 'owner') {
    return json({
      error: 'Only an active owner can create administrators.',
      code: 'forbidden',
    }, 403, request);
  }

  // ---- 3. Validate input -------------------------------------------
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'Request body is too large.', code: 'payload_too_large' }, 413, request);
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid JSON body.', code: 'invalid_json' }, 400, request);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ error: 'A valid email address is required.', code: 'invalid_email' }, 400, request);
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return json({
      error: `Password must be between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`,
      code: 'invalid_password',
    }, 400, request);
  }

  // ---- 4. Create the auth user -------------------------------------
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    const alreadyExists = /already registered|already exists|duplicate/i.test(createError?.message || '');
    return json({
      error: alreadyExists
        ? 'An account with this email already exists. Deactivate or update it instead.'
        : 'Could not create the account. Check the email and try again.',
      code: alreadyExists ? 'email_exists' : 'create_failed',
    }, alreadyExists ? 409 : 400, request);
  }

  // ---- 5. Grant admin access (rolled back on failure) --------------
  const { error: grantError } = await adminClient
    .from('admin_users')
    .insert({ user_id: created.user.id, email, role: 'admin', active: true });

  if (grantError) {
    console.error('admin-create-user: grant failed', { code: grantError.code });
    await adminClient.auth.admin.deleteUser(created.user.id).catch(() => {});
    return json({
      error: 'The account was created but admin access could not be granted, so it was removed again.',
      code: 'grant_failed',
    }, 500, request);
  }

  // No secrets, tokens or full error objects in the response.
  return json({ ok: true, email, role: 'admin' }, 200, request);
});
