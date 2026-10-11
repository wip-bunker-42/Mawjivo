import { authenticate } from './auth';
export { PublishWorkflow } from './workflows/publish';
import { errorResponse, ServiceError } from './errors';
import { readControlJson } from './http';
import { getSummary, listPosts, getPostDetail } from './history';
import {
  submitPost,
  revisePost,
  cancelPost,
  retryPost,
  postRow,
  getPublicationReceipt,
} from './posts';
import type { Submission } from '@mawjivo/core';
import { requireWorkspace } from './auth';
import {
  beginUpload,
  completeUpload,
  renewUpload,
  abortUpload,
  serveMedia,
  validateUpload,
} from './assets';
import { ownedAsset, assetDto } from './assets/model';
import type { UploadedPart } from '@mawjivo/core';
import { initializeService } from './readiness';
import {
  getCapabilities,
  listConnections,
  saveConnections,
  validateConnectionInputs,
} from './connections';
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
      const media = /^\/media\/([a-f0-9]{64})\/([^/]+)$/.exec(path);
      if (media) {
        let name: string;
        try {
          name = decodeURIComponent(media[2]!);
        } catch {
          throw new ServiceError('NOT_FOUND', 'الملف غير موجود.', 404);
        }
        return serveMedia(request, media[1]!, name, env);
      }
      if (path.startsWith('/api/')) {
        const auth = await authenticate(request, env);
        if (path === '/api/service/initialize' && request.method === 'POST')
          return Response.json(
            await initializeService(auth, env, fetch, new URL(request.url).origin),
            {
              headers: { 'Cache-Control': 'no-store' },
            },
          );
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
        const listingPath =
          /^\/api\/workspaces\/([A-Za-z0-9_-]{1,160})\/posts\/list\/(all|scheduled|needsAction)(?:\/([A-Za-z0-9_-]{1,160}))?$/.exec(
            path,
          );
        if (listingPath && request.method === 'GET')
          return Response.json(
            await listPosts(
              auth,
              listingPath[1]!,
              listingPath[2] as 'all' | 'scheduled' | 'needsAction',
              listingPath[3],
              env,
            ),
            { headers: { 'Cache-Control': 'no-store' } },
          );
        const summaryPath =
          /^\/api\/workspaces\/([A-Za-z0-9_-]{1,160})\/summary\/(\d{4}-\d{2}-\d{2})$/.exec(path);
        if (summaryPath && request.method === 'GET')
          return Response.json(await getSummary(auth, summaryPath[1]!, summaryPath[2]!, env), {
            headers: { 'Cache-Control': 'no-store' },
          });
        const draftPostPath =
          /^\/api\/workspaces\/([A-Za-z0-9_-]{1,160})\/posts\/draft\/([A-Za-z0-9_-]{1,160})$/.exec(
            path,
          );
        if (draftPostPath && request.method === 'GET') {
          await getWorkspace(auth, draftPostPath[1]!, env);
          const post = await env.DB.prepare(
            'SELECT id FROM posts WHERE workspace_id=? AND draft_id=? ORDER BY created_at_ms DESC LIMIT 1',
          )
            .bind(draftPostPath[1]!, draftPostPath[2]!)
            .first<{ id: string }>();
          return Response.json(post ? await getPublicationReceipt(auth, post.id, env) : null, {
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        const publicationPath =
          /^\/api\/workspaces\/([A-Za-z0-9_-]{1,160})\/posts(?:\/([A-Za-z0-9_-]{1,160})(?:\/(cancel|retry|details))?)?$/.exec(
            path,
          );
        if (publicationPath) {
          const workspaceId = publicationPath[1]!,
            id = publicationPath[2],
            action = publicationPath[3];
          requireWorkspace(auth, workspaceId);
          const headers = { 'Cache-Control': 'no-store' };
          if (!id && request.method === 'POST') {
            const submission = (await readControlJson(request)) as Submission;
            if (submission?.plan?.workspaceId !== workspaceId)
              throw new ServiceError('FORBIDDEN', 'المنشور لا يخص هذه المساحة.', 403);
            return Response.json(await submitPost(auth, submission, env), { status: 201, headers });
          }
          if (id) {
            const post = await postRow(auth, id, env);
            if (post.workspace_id !== workspaceId)
              throw new ServiceError('FORBIDDEN', 'المنشور لا يخص هذه المساحة.', 403);
            if (action === 'details' && request.method === 'GET')
              return Response.json(await getPostDetail(auth, id, env), { headers });
            if (!action && request.method === 'GET')
              return Response.json(await getPublicationReceipt(auth, id, env), { headers });
            if (
              (!action && request.method === 'PATCH') ||
              ((action === 'cancel' || action === 'retry') && request.method === 'POST')
            ) {
              const body = (await readControlJson(request)) as {
                expectedRevision?: unknown;
                submission?: Submission;
              };
              if (
                !body ||
                typeof body !== 'object' ||
                Array.isArray(body) ||
                Object.keys(body).some(
                  (key) => !['expectedRevision', ...(!action ? ['submission'] : [])].includes(key),
                ) ||
                typeof body.expectedRevision !== 'number' ||
                !Number.isSafeInteger(body.expectedRevision) ||
                body.expectedRevision < 1
              )
                throw new ServiceError(
                  'INVALID_INPUT',
                  'إصدار المنشور غير صالح. حدّثه قبل التغيير.',
                );
              const receipt =
                action === 'cancel'
                  ? await cancelPost(auth, id, body.expectedRevision, env)
                  : action === 'retry'
                    ? await retryPost(auth, id, body.expectedRevision, env)
                    : await revisePost(
                        auth,
                        id,
                        body.expectedRevision,
                        body.submission as Submission,
                        env,
                      );
              return Response.json(receipt, { headers });
            }
          }
        }
        const assetPath =
          /^\/api\/workspaces\/([A-Za-z0-9_-]{1,160})\/assets(?:\/([A-Za-z0-9_-]{1,160})(?:\/(renew|complete))?)?$/.exec(
            path,
          );
        if (assetPath) {
          const workspace = assetPath[1]!,
            id = assetPath[2],
            action = assetPath[3];
          requireWorkspace(auth, workspace);
          if (!id && request.method === 'POST')
            return Response.json(
              await beginUpload(
                auth,
                workspace,
                validateUpload(await readControlJson(request)),
                env,
              ),
              { status: 201, headers: { 'Cache-Control': 'no-store' } },
            );
          if (id) {
            const row = await ownedAsset(auth, id, env);
            if (row.workspace_id !== workspace)
              throw new ServiceError('FORBIDDEN', 'الملف لا يخص هذه المساحة.', 403);
            if (!action && request.method === 'GET')
              return Response.json(
                { state: row.state, ...(row.state === 'complete' ? { asset: assetDto(row) } : {}) },
                { headers: { 'Cache-Control': 'no-store' } },
              );
            if (!action && request.method === 'DELETE') {
              await abortUpload(auth, id, env);
              return new Response(null, { status: 204 });
            }
            if (request.method === 'POST') {
              const body = await readControlJson(request);
              if (!body || typeof body !== 'object' || Array.isArray(body))
                throw new ServiceError('INVALID_INPUT', 'بيانات الرفع غير صالحة.');
              if (action === 'renew') {
                if (Object.keys(body).some((key) => key !== 'partNumbers'))
                  throw new ServiceError('INVALID_INPUT', 'بيانات التجديد غير صالحة.');
                const numbers = (body as { partNumbers?: unknown }).partNumbers;
                if (
                  numbers !== undefined &&
                  (!Array.isArray(numbers) || numbers.some((n) => typeof n !== 'number'))
                )
                  throw new ServiceError('INVALID_UPLOAD_PARTS', 'أجزاء الرفع غير صالحة.');
                return Response.json(
                  await renewUpload(auth, id, env, numbers as number[] | undefined),
                  { headers: { 'Cache-Control': 'no-store' } },
                );
              }
              if (action === 'complete') {
                const complete = body as { parts?: unknown; sha256?: unknown };
                if (
                  Object.keys(body).some((key) => !['parts', 'sha256'].includes(key)) ||
                  !Array.isArray(complete.parts) ||
                  typeof complete.sha256 !== 'string'
                )
                  throw new ServiceError('INVALID_INPUT', 'بيانات الإكمال غير صالحة.');
                return Response.json(
                  await completeUpload(
                    auth,
                    id,
                    complete.parts as UploadedPart[],
                    complete.sha256,
                    env,
                  ),
                  { headers: { 'Cache-Control': 'no-store' } },
                );
              }
            }
          }
        }
        const connectionPath =
          /^\/api\/workspaces\/([A-Za-z0-9_-]{1,160})\/(connections|capabilities)$/.exec(path);
        if (connectionPath) {
          const workspaceId = connectionPath[1]!,
            resource = connectionPath[2];
          if (resource === 'connections' && request.method === 'GET')
            return Response.json(await listConnections(auth, workspaceId, env), {
              headers: { 'Cache-Control': 'no-store' },
            });
          if (resource === 'connections' && request.method === 'POST')
            return Response.json(
              await saveConnections(
                auth,
                workspaceId,
                validateConnectionInputs(await readControlJson(request)),
                env,
              ),
            );
          if (resource === 'capabilities' && request.method === 'GET')
            return Response.json(await getCapabilities(auth, workspaceId, env), {
              headers: { 'Cache-Control': 'no-store' },
            });
          if (resource === 'capabilities' && request.method === 'POST')
            return Response.json(await getCapabilities(auth, workspaceId, env, true), {
              headers: { 'Cache-Control': 'no-store' },
            });
        }
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
