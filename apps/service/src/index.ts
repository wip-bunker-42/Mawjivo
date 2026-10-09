import { authenticate } from './auth';
import { errorResponse, ServiceError } from './errors';
import { readControlJson } from './http';
import { initializeService } from './readiness';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  validateWorkspaceInput,
} from './workspaces';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname === '/health') {
        const initialized = await env.DB.prepare(
          "SELECT value_json FROM service_settings WHERE key='initialized'",
        ).first<{ value_json: string }>();
        if (initialized?.value_json === 'true')
          return Response.json({ state: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
        return Response.json(
          { state: 'unconfigured', messageAr: 'أكمل إعداد الخدمة قبل النشر.' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) {
        const auth = await authenticate(request, env);
        if (path === '/api/service/initialize' && request.method === 'POST')
          return Response.json(await initializeService(auth, env), {
            headers: { 'Cache-Control': 'no-store' },
          });
        if (path === '/api/workspaces' && request.method === 'GET')
          return Response.json(await listWorkspaces(auth, env), {
            headers: { 'Cache-Control': 'no-store' },
          });
        if (path === '/api/workspaces' && request.method === 'POST')
          return Response.json(
            await createWorkspace(
              auth,
              validateWorkspaceInput(await readControlJson(request)),
              env,
            ),
            { status: 201 },
          );
        const workspace = /^\/api\/workspaces\/([^/]+)$/.exec(path);
        if (workspace) {
          const id = decodeURIComponent(workspace[1]!);
          if (request.method === 'GET')
            return Response.json(await getWorkspace(auth, id, env), {
              headers: { 'Cache-Control': 'no-store' },
            });
          if (request.method === 'PATCH') {
            const input = await readControlJson(request);
            if (
              !input ||
              typeof input !== 'object' ||
              !('expectedVersion' in input) ||
              typeof input.expectedVersion !== 'number'
            )
              throw new ServiceError('INVALID_INPUT', 'حدّث بيانات المساحة قبل حفظها.');
            return Response.json(
              await updateWorkspace(
                auth,
                id,
                input.expectedVersion,
                validateWorkspaceInput(input),
                env,
              ),
            );
          }
        }
      }
      throw new ServiceError('NOT_FOUND', 'الصفحة غير موجودة.', 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
