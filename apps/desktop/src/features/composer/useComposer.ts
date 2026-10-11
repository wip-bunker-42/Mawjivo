import { useEffect, useRef, useState } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import {
  buildPlan,
  hashPlan,
  imageFilename,
  defaultSchedule,
  CapabilitySnapshotSchema,
  DraftSchema,
  SubmissionSchema,
} from '@mawjivo/core';
import type {
  CapabilitySnapshot,
  Draft,
  MediaAsset,
  MediaRecipe,
  Platform,
  PostPlan,
  PreparedAsset,
  Workspace,
} from '@mawjivo/core';
import {
  capabilities,
  composerContext,
  errorMessage,
  onUploadProgress,
  pickMedia,
  prepareMedia,
  probeMedia,
  restoreUploads,
  resumeUpload,
  saveDraft,
  startUpload,
  submitPublication,
  uploadedAsset,
} from '../../bridge';
import type { UploadProgress } from '../../bridge';
export const platformNames: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};
export interface MediaJob extends UploadProgress {
  key: string;
  fileId: string;
  sourceAssetId: string;
  recipeId: string | null;
  ready?: PreparedAsset | undefined;
  label: string;
}
interface Session {
  workspace: Workspace;
  windowId: string;
  draft: Draft;
  caps: CapabilitySnapshot;
  localSchedule: string;
  jobs: Map<string, MediaJob>;
  busy: Set<string>;
  message: string;
  persist: Promise<void>;
  lastSubmission?: string | undefined;
}
function localTime(instant: string, zone: string): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}
function defaults(workspace: Workspace, caps: CapabilitySnapshot): string[] {
  return workspace.defaultPlatforms.flatMap((platform) => {
    const ready = caps.channels.filter((c) => c.platform === platform && c.ready);
    const selected =
      ready.find((c) => c.id === workspace.preferredChannels?.[platform]) ??
      ready.find((c) => c.provider === 'meta') ??
      ready[0];
    return selected ? [selected.id] : [];
  });
}
function newDraft(workspace: Workspace, caps: CapabilitySnapshot): Draft {
  return {
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    workspaceVersion: workspace.version,
    timeZone: workspace.timeZone,
    revision: 1,
    text: '',
    title: '',
    assets: [],
    selections: defaults(workspace, caps),
    overrides: {},
    scheduleLocal: null,
    scheduleOffset: null,
    createdAt: new Date().toISOString(),
  };
}
const jobKey = (source: string, recipe: string | null) => JSON.stringify([source, recipe]);
function planError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return (
    (
      {
        VIDEO_TITLE_REQUIRED: 'اكتب عنوان الفيديو؛ نستخدمه أيضًا لاسم الملف.',
        EMPTY_POST: 'اكتب نصًا أو اختر وسائط.',
        MIXED_MEDIA: 'اختر صورًا معًا أو فيديو واحدًا.',
        SCHEDULE_IN_PAST: 'اختر موعدًا بعد الوقت الحالي.',
        SCHEDULE_TOO_FAR: 'يمكن الجدولة حتى سنة من الآن.',
        SCHEDULE_AMBIGUOUS: 'اختر إزاحة الوقت لتحديد الموعد المتكرر.',
        SCHEDULE_INVALID: 'راجع تاريخ النشر ومنطقته الزمنية.',
        EMPTY_THREAD_PART: 'اكتب نصًا لكل جزء في السلسلة.',
      } as Record<string, string>
    )[code] ?? errorMessage(error)
  );
}
export function useComposer(workspace: Workspace) {
  const sessions = useRef(new Map<string, Session>()),
    current = useRef<Session | null>(null),
    alive = useRef(true);
  const [, render] = useState(0),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(''),
    [review, setReview] = useState<{ plan: PostPlan; hash: string } | null>(null),
    [sending, setSending] = useState(false);
  const repaint = (session: Session) => {
    if (alive.current && current.current === session) render((n) => n + 1);
  };
  function message(session: Session, text: string) {
    session.message = text;
    repaint(session);
  }
  function persist(session: Session): void {
    const draft = structuredClone(session.draft);
    // Preserve order when a user switches workspaces while older writes are in flight.
    session.persist = session.persist
      .catch(() => {})
      .then(() => saveDraft(session.workspace.serviceProfileId, session.windowId, draft))
      .catch((error) => message(session, errorMessage(error)));
  }
  function update(session: Session, patch: Partial<Draft>): void {
    session.draft = { ...session.draft, ...patch, revision: session.draft.revision + 1 };
    session.message = '';
    session.lastSubmission = undefined;
    persist(session);
    repaint(session);
  }
  async function ready(session: Session, job: MediaJob): Promise<void> {
    const result = await uploadedAsset(job.jobId);
    if (result) {
      job.ready = result;
      job.phase = 'complete';
      job.completedBytes = job.totalBytes;
      repaint(session);
    }
  }
  async function upload(
    session: Session,
    asset: MediaAsset,
    fileId: string,
    recipe: MediaRecipe | null,
  ): Promise<void> {
    const key = jobKey(asset.id, recipe?.id ?? null);
    if (session.jobs.has(key) || session.busy.has(key)) return;
    session.busy.add(key);
    const job: MediaJob = {
      key,
      jobId: 'local-' + crypto.randomUUID(),
      fileId,
      sourceAssetId: asset.id,
      recipeId: recipe?.id ?? null,
      label: recipe ? 'نسخة مهيأة من ' + asset.originalName : asset.originalName,
      assetId: null,
      completedBytes: 0,
      totalBytes: asset.bytes,
      elapsedMs: 0,
      remainingMs: null,
      phase: recipe ? 'preparing' : 'pending',
    };
    session.jobs.set(key, job);
    repaint(session);
    try {
      const local = recipe ? await prepareMedia(fileId, recipe) : null;
      if (!session.draft.assets.some((a) => a.id === asset.id)) return;
      const mimeType = local?.mimeType ?? asset.mimeType,
        bytes = local?.bytes ?? asset.bytes;
      const name =
        asset.kind === 'image'
          ? imageFilename(asset.originalName, asset.mimeType, mimeType)
          : asset.originalName;
      job.fileId = local?.fileId ?? fileId;
      job.totalBytes = bytes;
      job.phase = 'pending';
      const manifest = {
        sourceAssetId: asset.id,
        recipeId: recipe?.id ?? null,
        originalName: name,
        kind: asset.kind,
        mimeType,
        bytes,
        ...(!recipe
          ? { width: asset.width, height: asset.height, durationMs: asset.durationMs }
          : {}),
      };
      job.jobId = await startUpload({
        profileId: session.workspace.serviceProfileId,
        workspaceId: session.workspace.id,
        fileId: job.fileId,
        sourceAssetId: asset.id,
        recipeId: job.recipeId,
        manifest,
      });
      job.phase = 'uploading';
      await ready(session, job);
    } catch (error) {
      job.phase = 'failed';
      job.error = { code: 'PREPARATION_FAILED', messageAr: errorMessage(error), retryable: true };
      repaint(session);
    } finally {
      session.busy.delete(key);
      repaint(session);
    }
  }
  function variants(session: Session): void {
    let plan: PostPlan;
    try {
      plan = buildPlan(session.draft, session.caps, new Date().toISOString());
    } catch {
      return;
    }
    for (const recipe of plan.mediaRecipes) {
      const source = session.draft.assets.find((a) => a.id === recipe.sourceAssetId);
      if (source) void upload(session, source, source.id, recipe);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true,
      unlisten: (() => void) | undefined;
    setReview(null);
    setLoadError('');
    setLoading(true);
    const key = workspace.serviceProfileId + ':' + workspace.id;
    const old = sessions.current.get(key);
    if (old) {
      current.current = old;
      setLoading(false);
      render((n) => n + 1);
    } else current.current = null;
    void (async () => {
      let session = old;
      if (!session) {
        const [context, snapshot] = await Promise.all([
          composerContext(workspace.serviceProfileId, workspace.id),
          capabilities(workspace),
        ]);
        if (!active) return;
        const caps = CapabilitySnapshotSchema.parse(snapshot),
          draft = context.draft ? DraftSchema.parse(context.draft) : newDraft(workspace, caps);
        session = {
          workspace,
          windowId: context.windowId,
          draft: { ...draft, workspaceVersion: workspace.version, timeZone: workspace.timeZone },
          caps,
          localSchedule:
            draft.scheduleLocal ?? localTime(defaultSchedule(draft.createdAt), workspace.timeZone),
          jobs: new Map(),
          busy: new Set(),
          message: '',
          persist: Promise.resolve(),
        };
        sessions.current.set(key, session);
        current.current = session;
        persist(session);
      }
      const selected = session;
      unlisten = await onUploadProgress(selected.windowId, (event) => {
        for (const candidate of sessions.current.values())
          for (const job of candidate.jobs.values())
            if (job.jobId === event.jobId) {
              Object.assign(job, event);
              if (event.phase === 'complete')
                void ready(candidate, job).catch((error) =>
                  message(candidate, errorMessage(error)),
                );
              repaint(candidate);
            }
      });
      if (!active) {
        unlisten();
        return;
      }
      if (!old && selected.draft.assets.length) {
        const jobs = await restoreUploads(
          workspace.serviceProfileId,
          workspace.id,
          selected.draft.assets.map((a) => a.id),
        );
        for (const job of jobs) {
          const source = selected.draft.assets.find((a) => a.id === job.sourceAssetId);
          if (!source) continue;
          selected.jobs.set(jobKey(job.sourceAssetId, job.recipeId), {
            ...job,
            key: jobKey(job.sourceAssetId, job.recipeId),
            label: job.recipeId ? 'نسخة مهيأة من ' + source.originalName : source.originalName,
            elapsedMs: 0,
            remainingMs: null,
            phase: 'pending',
          });
          await resumeUpload(job.jobId);
          await ready(selected, selected.jobs.get(jobKey(job.sourceAssetId, job.recipeId))!);
        }
        variants(selected);
      }
      if (active) {
        setLoading(false);
        repaint(selected);
      }
    })().catch((error) => {
      if (active) {
        setLoadError(errorMessage(error));
        setLoading(false);
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [workspace.id, workspace.serviceProfileId]);
  const session = current.current;
  async function pick(): Promise<void> {
    if (!session) return;
    const owner = session;
    try {
      const files = await pickMedia();
      if (current.current !== owner || !alive.current) return;
      for (const file of files) {
        const asset = await probeMedia(file.fileId);
        if (current.current !== owner || !alive.current) return;
        const existing = owner.draft.assets;
        if (
          existing.length >= 20 ||
          ((asset.kind === 'video' || existing.some((a) => a.kind === 'video')) &&
            existing.length + files.length > 1)
        ) {
          message(owner, 'اختر حتى 20 صورة معًا أو فيديو واحدًا.');
          return;
        }
        update(owner, { assets: [...existing, asset] });
        void upload(owner, asset, file.fileId, null);
      }
      variants(owner);
    } catch (error) {
      message(owner, errorMessage(error));
    }
  }
  function patch(value: Partial<Draft>): void {
    if (session) {
      update(session, value);
      variants(session);
    }
  }
  function choose(platform: Platform, checked: boolean, channelId?: string): void {
    if (!session) return;
    const selected =
      session.caps.channels.find((c) => c.id === channelId && c.platform === platform && c.ready) ??
      session.caps.channels.find(
        (c) =>
          c.platform === platform && c.ready && c.id === workspace.preferredChannels?.[platform],
      ) ??
      session.caps.channels.find(
        (c) => c.platform === platform && c.ready && c.provider === 'meta',
      ) ??
      session.caps.channels.find((c) => c.platform === platform && c.ready);
    patch({
      selections: [
        ...session.draft.selections.filter(
          (id) => session.caps.channels.find((c) => c.id === id)?.platform !== platform,
        ),
        ...(checked && selected ? [selected.id] : []),
      ],
    });
  }
  function override(platform: Platform, value: Partial<Draft['overrides'][Platform]>): void {
    if (session)
      patch({
        overrides: {
          ...session.draft.overrides,
          [platform]: { ...session.draft.overrides[platform], ...value },
        },
      });
  }
  function reorder(index: number, to: number): void {
    if (!session || to < 0 || to >= session.draft.assets.length) return;
    const assets = [...session.draft.assets];
    const [asset] = assets.splice(index, 1);
    assets.splice(to, 0, asset!);
    const overrides = { ...session.draft.overrides };
    for (const platform of Object.keys(overrides) as Platform[]) {
      const old = overrides[platform];
      if (old?.altTexts) {
        const alts = [...old.altTexts];
        const [alt] = alts.splice(index, 1);
        alts.splice(to, 0, alt ?? session.draft.text);
        overrides[platform] = { ...old, altTexts: alts };
      }
    }
    patch({ assets, overrides });
  }
  function remove(index: number): void {
    if (!session) return;
    const source = session.draft.assets[index]!,
      assets = session.draft.assets.filter((_, i) => i !== index),
      overrides = { ...session.draft.overrides };
    for (const platform of Object.keys(overrides) as Platform[]) {
      const old = overrides[platform];
      if (old?.altTexts)
        overrides[platform] = { ...old, altTexts: old.altTexts.filter((_, i) => i !== index) };
    }
    patch({ assets, overrides });
    for (const [key, job] of session.jobs)
      if (job.sourceAssetId === source.id) {
        session.jobs.delete(key);
        void cancelUploadSafely(session, job);
      }
  }
  async function cancelUploadSafely(owner: Session, job: MediaJob): Promise<void> {
    try {
      if (job.jobId.startsWith('local-')) {
        const { native } = await import('../../bridge');
        await native('cancel_media', { jobId: job.sourceAssetId });
      } else {
        const { cancelUpload } = await import('../../bridge');
        await cancelUpload(job.jobId);
      }
    } catch (error) {
      message(owner, errorMessage(error));
    }
  }
  async function resume(job: MediaJob): Promise<void> {
    if (!session) return;
    try {
      job.ready = undefined;
      if (job.jobId.startsWith('local-')) {
        const source = session.draft.assets.find((asset) => asset.id === job.sourceAssetId);
        if (!source) return;
        const recipe = job.recipeId
          ? buildPlan(session.draft, session.caps, new Date().toISOString()).mediaRecipes.find(
              (item) => item.id === job.recipeId,
            )
          : null;
        session.jobs.delete(job.key);
        if (job.recipeId && !recipe) {
          variants(session);
          repaint(session);
          return;
        }
        await upload(session, source, source.id, recipe ?? null);
        return;
      }
      job.phase = 'pending';
      job.error = null;
      repaint(session);
      await resumeUpload(job.jobId);
      await ready(session, job);
    } catch (error) {
      message(session, errorMessage(error));
    }
  }
  function schedule(enabled: boolean): void {
    if (session)
      patch({ scheduleLocal: enabled ? session.localSchedule : null, scheduleOffset: null });
  }
  function scheduleTime(value: string): void {
    if (session) {
      session.localSchedule = value;
      patch({ scheduleLocal: value, scheduleOffset: null });
    }
  }
  function split(platform: Platform): void {
    if (!session) return;
    const channel = session.caps.channels.find(
      (c) => c.platform === platform && session.draft.selections.includes(c.id),
    );
    if (!channel?.limits.threadParts) {
      message(session, 'اختر حسابًا يدعم السلاسل.');
      return;
    }
    try {
      let remaining = session.draft.overrides[platform]?.text ?? session.draft.text;
      const parts: string[] = [];
      while (remaining && parts.length < channel.limits.threadParts) {
        const draft = {
          ...session.draft,
          text: remaining,
          selections: [channel.id],
          overrides: { [platform]: { text: remaining } },
        };
        const prefix = buildPlan(draft, session.caps, new Date().toISOString()).targets[0]?.text;
        if (!prefix) break;
        parts.push(prefix);
        remaining = remaining.slice(prefix.length);
      }
      if (remaining) parts.push(remaining);
      override(platform, { threadParts: parts.length ? parts : [''] });
    } catch (error) {
      message(session, planError(error));
    }
  }
  async function openReview(): Promise<void> {
    if (!session) return;
    try {
      const plan = buildPlan(session.draft, session.caps, new Date().toISOString());
      variants(session);
      if (!plan.targets.length) {
        message(session, 'لا توجد منصة مؤهلة للنشر. راجع الاختيارات ونوع المحتوى.');
        return;
      }
      const hash = await hashPlan(plan);
      if (current.current === session) {
        setReview({ plan, hash });
        session.message = '';
      }
    } catch (error) {
      message(session, planError(error));
    }
  }
  const needed = review?.plan.targets.flatMap((t) => t.assets) ?? [];
  const assetsReady = Boolean(
    session &&
    needed.every((use) => session.jobs.get(jobKey(use.sourceAssetId, use.recipeId))?.ready),
  );
  async function confirm(): Promise<void> {
    if (!session || !review || sending || !assetsReady) return;
    const owner = session;
    setSending(true);
    try {
      const plan = buildPlan(owner.draft, owner.caps, new Date().toISOString()),
        hash = await hashPlan(plan);
      if (hash !== review.hash) {
        message(owner, 'تغيرت تفاصيل المنشور. افتح المراجعة مرة أخرى.');
        setReview(null);
        return;
      }
      const unique = new Map(
        plan.targets
          .flatMap((t) => t.assets)
          .map((use) => [jobKey(use.sourceAssetId, use.recipeId), use]),
      );
      const preparedAssets = [...unique.keys()].map((key) => owner.jobs.get(key)!.ready!);
      const submission = SubmissionSchema.parse({ plan, planHash: hash, preparedAssets });
      await owner.persist;
      await submitPublication(owner.workspace, submission);
      owner.lastSubmission = hash;
      message(
        owner,
        plan.dueAt
          ? 'تمت جدولة المنشور في Cloudflare.'
          : 'تم إرسال المنشور. ستتابع الخدمة نتائج المنصات.',
      );
      if (current.current === owner) setReview(null);
    } catch (error) {
      message(owner, errorMessage(error));
    } finally {
      if (alive.current) setSending(false);
    }
  }
  function reset(): void {
    if (session) {
      session.draft = newDraft(workspace, session.caps);
      session.jobs = new Map();
      session.localSchedule = localTime(
        defaultSchedule(session.draft.createdAt),
        workspace.timeZone,
      );
      session.message = '';
      session.lastSubmission = undefined;
      persist(session);
      repaint(session);
    }
  }
  return {
    draft: session?.draft ?? null,
    caps: session?.caps ?? null,
    jobs: session ? [...session.jobs.values()] : [],
    message: session?.message || loadError,
    loading,
    localSchedule: session?.localSchedule ?? '',
    review,
    sending,
    assetsReady,
    submitted: Boolean(session?.lastSubmission),
    pick,
    patch,
    choose,
    override,
    reorder,
    remove,
    resume,
    schedule,
    scheduleTime,
    split,
    openReview,
    closeReview: () => setReview(null),
    confirm,
    reset,
  };
}
