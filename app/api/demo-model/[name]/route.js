import { readFile } from 'node:fs/promises';
import path from 'node:path';
import proxy from '../../../../lib/supabase-proxy.js';

/**
 * The bundled demo catalogue's 3D model — and only when there is no database.
 *
 * This file used to sit in /public/models, which made it a static download
 * on the production domain for anyone who knew or guessed the name: a
 * product's 3D model outside every access rule the rest of the site has.
 * It lives in data/models now, which is not served, and reaches a browser
 * only through here.
 *
 * WHEN IT ANSWERS
 * Only on a deployment with no Supabase configured. That is the offline /
 * demo mode, where the catalogue is the bundled one and there are no accounts
 * at all — there is nobody to authenticate and nothing to authorise against,
 * and the planner's gate opens for the same reason (app/plan/PlannerGate.js).
 *
 * On any deployment WITH a database, this refuses, even if the database is
 * momentarily down and the catalogue has fallen back to the bundled copy.
 * Failing closed there is the point: "the database did not answer" must
 * never turn into "the protected files are now public".
 */
export const dynamic = 'force-dynamic';

const NAME = /^[\w-]+\.glb$/;

export async function GET(request, context) {
  const { name } = await context.params;
  const headers = { 'Cache-Control': 'private, no-store' };

  if (!NAME.test(name || '')) {
    return Response.json({ code: 'bad_path' }, { status: 400, headers });
  }
  if (proxy.isConfigured()) {
    return Response.json({ code: 'unavailable' }, { status: 404, headers });
  }

  try {
    const bytes = await readFile(path.join(process.cwd(), 'data', 'models', name));
    return new Response(bytes, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch {
    return Response.json({ code: 'not_found' }, { status: 404, headers });
  }
}
