import type { Page } from '@playwright/test';
export async function composerFixture(
  page: Page,
  options: {
    media?: 'image' | 'video';
    windowId?: string;
    deferredPick?: boolean;
    images?: number;
    prepareFailureOnce?: boolean;
    restoreError?: boolean;
    publicationState?: 'preparing' | 'scheduled' | 'accepted';
    history?: boolean;
    revisionConflict?: boolean;
    olderNativeDraft?: boolean;
  } = {},
): Promise<void> {
  await page.addInitScript((options) => {
    const windowId = options.windowId ?? 'main';
    const workspaces = ['a', 'b'].map((id, index) => ({
      id: 'space-' + id,
      name: index ? 'مساحة ثانية' : 'مساحتي',
      timeZone: 'Africa/Cairo',
      version: 1,
      defaultPlatforms: index ? ['threads'] : ['x', 'instagram', 'youtube'],
      serviceProfileId: 'profile-1',
      preferredChannels: {},
    }));
    const limits = {
      supportedKinds: ['text', 'image', 'video'],
      textMax: 500,
      textMetric: 'utf16',
      source: 'https://provider.test/rules',
      verifiedAt: '2026-10-10T00:00:00Z',
      altMax: 1000,
      altKinds: ['image'],
      image: { mimeTypes: ['image/jpeg', 'image/png'], maxBytes: 8000000, maxCount: 10 },
      video: { mimeTypes: ['video/mp4'], maxBytes: 512000000, maxCount: 1, maxDurationMs: 300000 },
      threadParts: 25,
    };
    const channels = ['x', 'instagram', 'youtube', 'threads', 'facebook', 'tiktok'].map(
      (platform) => ({
        id: 'ch-' + platform,
        connectionId: platform === 'instagram' ? 'meta' : 'buffer',
        platform,
        provider: platform === 'instagram' ? 'meta' : 'buffer',
        ready: true,
        displayName: platform,
        limits: {
          ...limits,
          ...(platform === 'x'
            ? { textMax: 280, video: { ...limits.video, maxDurationMs: 140000 } }
            : platform === 'youtube'
              ? {
                  supportedKinds: ['video'],
                  titleMax: 100,
                  video: { ...limits.video, maxDurationMs: 180000 },
                }
              : platform === 'instagram'
                ? {
                    supportedKinds: ['image', 'video'],
                    image: { ...limits.image, mimeTypes: ['image/jpeg'] },
                  }
                : {}),
        },
      }),
    );
    const calls: { command: string; args?: Record<string, unknown> }[] = [],
      drafts = new Map<string, any>(),
      jobs = new Map<string, any>(),
      callbacks = new Map<number, (event: unknown) => void>(),
      listeners = new Map<string, number[]>();
    let callbackId = 0,
      jobId = 0;
    const kind = options.media ?? 'image',
      source = {
        id: 'file-1',
        originalName: kind === 'image' ? 'صورتي.PNG' : 'الأصل.mp4',
        kind,
        bytes: 2000,
        mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
        width: 1080,
        height: 1920,
        ...(kind === 'video' ? { durationMs: 220000 } : {}),
      };
    const sources = Array.from({ length: options.images ?? 1 }, (_, index) => ({
      ...source,
      id: 'file-' + (index + 1),
      originalName: index ? 'الصورة-' + (index + 1) + '.PNG' : source.originalName,
    }));
    const selectedFiles = sources.map((item) => ({
      fileId: item.id,
      originalName: item.originalName,
      bytes: item.bytes,
      mimeType: item.mimeType,
    }));
    if (options.restoreError)
      drafts.set('space-a', {
        id: 'saved-draft',
        workspaceId: 'space-a',
        workspaceVersion: 1,
        revision: 1,
        createdAt: new Date().toISOString(),
        timeZone: 'Africa/Cairo',
        text: 'مسودة محفوظة',
        title: '',
        assets: sources,
        selections: ['ch-x'],
        overrides: {},
        scheduleLocal: null,
        scheduleOffset: null,
      });
    let preparationFailed = false;
    const emit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    };
    const finish = () => {
      for (const job of jobs.values()) {
        job.phase = 'complete';
        job.completedBytes = job.totalBytes;
        job.ready = {
          sourceAssetId: job.sourceAssetId,
          recipeId: job.recipeId,
          assetId: 'asset-' + job.jobId,
          sha256: 'a'.repeat(64),
        };
        emit('upload-progress', { ...job, elapsedMs: 4000, remainingMs: 0 });
      }
    };
    let resolvePick: ((value: unknown) => void) | undefined;
    const api = {
      calls,
      drafts,
      jobs,
      finish,
      progress: () => {
        for (const job of jobs.values())
          emit('upload-progress', {
            ...job,
            phase: 'uploading',
            completedBytes: 1000,
            elapsedMs: 2000,
            remainingMs: 2000,
          });
      },
      resolvePick: () =>
        resolvePick?.([
          {
            fileId: source.id,
            originalName: source.originalName,
            bytes: source.bytes,
            mimeType: source.mimeType,
          },
        ]),
    };
    const scheduledDraft = {
      id: 'scheduled-draft',
      workspaceId: 'space-a',
      workspaceVersion: 1,
      timeZone: 'Africa/Cairo',
      revision: 7,
      createdAt: new Date().toISOString(),
      text: 'نص مجدول محفوظ',
      title: '',
      assets: [],
      selections: ['ch-x'],
      overrides: {},
      scheduleLocal: null,
      scheduleOffset: null,
    };
    const scheduledPlan = {
      draftId: scheduledDraft.id,
      workspaceId: 'space-a',
      workspaceVersion: 1,
      timeZone: 'Africa/Cairo',
      revision: 3,
      policyVersion: '2026-10-11.2',
      capabilityVersion: 'cap-v1',
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      notes: [],
      excluded: [],
      mediaRecipes: [],
      targets: [
        {
          channelId: 'ch-x',
          connectionId: 'buffer',
          provider: 'buffer',
          platform: 'x',
          text: scheduledDraft.text,
          threadParts: [],
          altTexts: [],
          assets: [],
        },
      ],
    };
    let historyReceipt = {
      postId: 'scheduled-post',
      workspaceId: 'space-a',
      revision: 3,
      state: 'scheduled',
      dueAt: scheduledPlan.dueAt,
      targets: [{ channelId: 'ch-x', platform: 'x', state: 'ready' }],
    };
    if (options.history)
      drafts.set(
        'space-a',
        options.olderNativeDraft
          ? { ...scheduledDraft, revision: 1, text: 'نص قديم على الجهاز' }
          : scheduledDraft,
      );
    Object.assign(globalThis, {
      isTauri: true,
      __MAWJIVO_TEST__: api,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: windowId }, currentWebview: { label: windowId } },
        transformCallback: (callback: (event: unknown) => void) => {
          callbacks.set(++callbackId, callback);
          return callbackId;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === 'plugin:event|listen') {
            const event = String(args!.event),
              id = Number(args!.handler);
            listeners.set(event, [...(listeners.get(event) ?? []), id]);
            return id;
          }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'list_profiles')
            return [
              {
                id: 'profile-1',
                baseUrl: 'https://service.test',
                serviceId: 'synthetic',
                accountId: 'synthetic',
                deviceCredentialRef: 'synthetic',
                version: '0.1.0',
              },
            ];
          if (command === 'composer_context')
            return { windowId, draft: drafts.get(String(args!.workspaceId)) ?? null };
          if (command === 'save_draft') {
            drafts.set((args!.draft as any).workspaceId, structuredClone(args!.draft));
            return null;
          }
          if (command === 'load_draft') return drafts.get(String(args!.workspaceId)) ?? null;
          if (command === 'open_composer_window') return 'composer-' + crypto.randomUUID();
          if (command === 'pick_media')
            return options.deferredPick
              ? new Promise((resolve) => {
                  resolvePick = resolve;
                })
              : selectedFiles;
          if (command === 'probe_media') return sources.find((item) => item.id === args!.fileId);
          if (command === 'prepare_media') {
            if (options.prepareFailureOnce && !preparationFailed) {
              preparationFailed = true;
              throw {
                code: 'LOCAL_DISK_FULL',
                messageAr: 'المساحة المحلية لا تكفي لمعالجة هذا الملف.',
                retryable: true,
              };
            }
            const recipe = args!.recipe as any;
            return {
              fileId: 'derived-' + crypto.randomUUID(),
              sourceAssetId: recipe.sourceAssetId,
              recipeId: recipe.id,
              mimeType: recipe.outputMimeType,
              bytes: 1800,
              sha256: 'b'.repeat(64),
            };
          }
          if (command === 'start_upload') {
            const input = args!.input as any;
            const id = 'job-' + ++jobId;
            jobs.set(id, {
              jobId: id,
              fileId: input.fileId,
              sourceAssetId: input.sourceAssetId,
              recipeId: input.recipeId,
              phase: 'uploading',
              completedBytes: 0,
              totalBytes: input.manifest.bytes,
              manifest: input.manifest,
            });
            return id;
          }
          if (command === 'uploaded_asset') return jobs.get(String(args!.jobId))?.ready ?? null;
          if (command === 'list_uploads' || command === 'restore_uploads')
            if (options.restoreError)
              throw {
                code: 'SOURCE_CHANGED',
                messageAr: 'تغير الملف بعد اختياره؛ اختره مجددًا.',
                retryable: false,
              };
            else return [...jobs.values()];
          if (
            command === 'resume_upload' ||
            command === 'cancel_upload' ||
            command === 'cancel_media'
          )
            return null;
          if (command === 'service_request') {
            const path = String(args!.path);
            if (path.includes('/posts/draft/')) return options.history ? historyReceipt : null;
            if (options.history && path.includes('/posts/list/'))
              return {
                items:
                  path.includes('/space-b/') ||
                  (path.includes('/scheduled') && historyReceipt.state === 'cancelled')
                    ? []
                    : [historyReceipt],
                nextCursor: null,
              };
            if (options.history && path.includes('/summary'))
              return {
                localDate: path.split('/').at(-1),
                timeZone: 'Africa/Cairo',
                completePosts: 1,
                partialPosts: 1,
                failedPosts: 0,
                unknownPosts: 1,
                publishedTargets: 6,
                upcomingScheduled: historyReceipt.state === 'cancelled' ? 0 : 1,
              };
            if (options.history && path.endsWith('/scheduled-post/details'))
              return {
                receipt: historyReceipt,
                plan: scheduledPlan,
                sources: [],
                preparedAssets: [],
                editable: historyReceipt.state === 'scheduled',
              };
            if (options.history && path.endsWith('/scheduled-post/cancel')) {
              historyReceipt = {
                ...historyReceipt,
                state: 'cancelled',
                targets: [{ channelId: 'ch-x', platform: 'x', state: 'cancelled' }],
              };
              return historyReceipt;
            }
            if (options.history && path.endsWith('/scheduled-post') && args!.method === 'PATCH') {
              if (options.revisionConflict)
                throw {
                  code: 'REVISION_CONFLICT',
                  messageAr: 'تغير المنشور من نافذة أخرى. حدّثه قبل التعديل.',
                  retryable: false,
                };
              const submission = (args!.body as any).submission;
              historyReceipt = {
                ...historyReceipt,
                revision: submission.plan.revision,
                dueAt: submission.plan.dueAt,
              };
              return historyReceipt;
            }
            if (path === '/api/workspaces') return workspaces;
            if (path.endsWith('/capabilities'))
              return { version: 'cap-v1', fetchedAt: '2026-10-10T00:00:00Z', channels };
            if (path.endsWith('/posts') && args!.method === 'POST') {
              const submission = args!.body as any;
              return {
                postId: 'posted',
                workspaceId: submission.plan.workspaceId,
                revision: submission.plan.revision,
                state:
                  options.publicationState ?? (submission.plan.dueAt ? 'scheduled' : 'accepted'),
                dueAt: submission.plan.dueAt,
                targets: [],
              };
            }
          }
          throw new Error('Unexpected synthetic command ' + command);
        },
      },
    });
  }, options);
}
