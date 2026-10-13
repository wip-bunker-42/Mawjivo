import { invoke, isTauri } from '@tauri-apps/api/core';
export interface ServiceProfile {
  id: string;
  baseUrl: string;
  serviceId: string;
  accountId: string;
  deviceCredentialRef: string;
  version: string;
}
export interface ProvisionInput {
  accountId: string;
  apiToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  zoneId: string | null;
  domain: string | null;
}
export interface NativeError {
  code: string;
  messageAr: string;
  retryable: boolean;
}
export function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'messageAr' in error &&
    typeof error.messageAr === 'string'
  )
    return error.messageAr;
  return 'تعذر إكمال العملية. حاول مرة أخرى.';
}
export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    throw {
      code: 'DESKTOP_REQUIRED',
      messageAr: 'افتح نسخة التطبيق المثبتة لتجهيز حسابك.',
      retryable: false,
    } satisfies NativeError;
  return invoke<T>(command, args);
}
export function provisionService(input: ProvisionInput): Promise<ServiceProfile> {
  return native('provision_service', { input });
}
export async function listProfiles(): Promise<ServiceProfile[]> {
  return isTauri() ? native('list_profiles') : [];
}
export interface TransferSummary {
  services: number;
  workspaces: number;
  connections: number;
}
export const exportSettings = () => native<TransferSummary | null>('export_settings');
export const importSettings = () => native<TransferSummary | null>('import_settings');
export function serviceRequest<T>(
  profileId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return native('service_request', { profileId, method, path, body: body ?? null });
}
import type {
  CapabilitySnapshot,
  Draft,
  MediaAsset,
  MediaRecipe,
  PreparedAsset,
  PublicationReceipt,
  PostPage,
  PostDetail,
  Summary,
  Submission,
  UploadInput,
  UploadManifest,
  Workspace,
} from '@mawjivo/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
export interface UpdateInfo {
  id: string;
  version: string;
  notesAr: string;
  bytes: number;
}
export interface UpdateProgress {
  updateId: string;
  completedBytes: number;
  totalBytes: number | null;
  phase: 'downloading' | 'verified';
}
export const checkUpdate = () => native<UpdateInfo | null>('check_update');
export const downloadUpdate = (updateId: string) => native<void>('download_update', { updateId });
export const installUpdate = (updateId: string) => native<void>('install_update', { updateId });
export interface ServicePackageInfo {
  id: string;
  version: string;
}
export const servicePackageInfo = () => native<ServicePackageInfo>('service_package_info');
export const upgradeService = (profileId: string, packageId: string) =>
  native<ServiceProfile>('upgrade_service', { profileId, packageId });
export function onUpdateFlush(callback: (ticketId: string) => void): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<{ ticketId: string }>('update-flush', (event) => callback(event.payload.ticketId), {
    target: { kind: 'Window', label: getCurrentWindow().label },
  });
}
export function onUpdateFlushRelease(callback: () => void): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen('update-flush-release', callback, {
    target: { kind: 'Window', label: getCurrentWindow().label },
  });
}
export const acknowledgeUpdateFlush = (ticketId: string, saved: boolean) =>
  native<void>('acknowledge_update_flush', { ticketId, saved });
export function onUpdateProgress(
  callback: (progress: UpdateProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<UpdateProgress>('update-progress', (event) => callback(event.payload), {
    target: { kind: 'Window', label: getCurrentWindow().label },
  });
}
export interface SelectedFile {
  fileId: string;
  originalName: string;
  bytes: number;
  mimeType: string;
}
export interface PreparedLocalAsset {
  fileId: string;
  sourceAssetId: string;
  recipeId: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}
export interface UploadProgress {
  jobId: string;
  assetId: string | null;
  completedBytes: number;
  totalBytes: number;
  elapsedMs: number;
  remainingMs: number | null;
  phase: string;
  error?: NativeError | null;
}
export interface UploadJob extends UploadProgress {
  fileId: string;
  sourceAssetId: string;
  recipeId: string | null;
}
export interface ComposerContext {
  windowId: string;
  draft: Draft | null;
}
export const composerContext = (profileId: string, workspaceId: string) =>
  native<ComposerContext>('composer_context', { profileId, workspaceId });
export const saveDraft = (profileId: string, windowId: string, draft: Draft) =>
  native<void>('save_draft', { profileId, windowId, draft });
export const loadDraft = (profileId: string, workspaceId: string, draftId: string) =>
  native<Draft | null>('load_draft', { profileId, workspaceId, draftId });
export const pickMedia = () => native<SelectedFile[]>('pick_media');
export const probeMedia = (fileId: string) => native<MediaAsset>('probe_media', { fileId });
export const prepareMedia = (fileId: string, recipe: MediaRecipe) =>
  native<PreparedLocalAsset>('prepare_media', { fileId, recipe });
export const startUpload = (input: UploadInput) => native<string>('start_upload', { input });
export const resumeUpload = (jobId: string) => native<void>('resume_upload', { jobId });
export const cancelUpload = (jobId: string) => native<void>('cancel_upload', { jobId });
export const uploadedAsset = (jobId: string) =>
  native<PreparedAsset | null>('uploaded_asset', { jobId });
export const listUploads = (profileId: string, workspaceId: string) =>
  native<UploadJob[]>('list_uploads', { profileId, workspaceId });
export const restoreUploads = (profileId: string, workspaceId: string, sourceAssetIds: string[]) =>
  native<UploadJob[]>('restore_uploads', { profileId, workspaceId, sourceAssetIds });
export const openComposerWindow = () => native<string>('open_composer_window');
export interface SavedComposer {
  windowId: string;
  draftId: string;
  preview: string;
  createdAt: string;
}
export const savedComposers = (profileId: string, workspaceId: string) =>
  native<SavedComposer[]>('list_saved_composers', { profileId, workspaceId });
export const openSavedComposer = (
  profileId: string,
  workspaceId: string,
  windowId: string,
  draftId: string,
) => native<string>('open_saved_composer', { profileId, workspaceId, windowId, draftId });
export function onUploadProgress(
  windowId: string,
  callback: (progress: UploadProgress) => void,
): Promise<() => void> {
  return listen<UploadProgress>('upload-progress', (event) => callback(event.payload), {
    target: { kind: 'Window', label: windowId },
  });
}
export const capabilities = (workspace: Workspace) =>
  serviceRequest<CapabilitySnapshot>(
    workspace.serviceProfileId,
    'GET',
    '/api/workspaces/' + workspace.id + '/capabilities',
  );
export const submitPublication = (workspace: Workspace, submission: Submission) =>
  serviceRequest<PublicationReceipt>(
    workspace.serviceProfileId,
    'POST',
    '/api/workspaces/' + workspace.id + '/posts',
    submission,
  );
export const publicationReceipt = (workspace: Workspace, postId: string) =>
  serviceRequest<PublicationReceipt>(
    workspace.serviceProfileId,
    'GET',
    '/api/workspaces/' + workspace.id + '/posts/' + postId,
  );
export const revisePublication = (
  workspace: Workspace,
  postId: string,
  expectedRevision: number,
  submission: Submission,
) =>
  serviceRequest<PublicationReceipt>(
    workspace.serviceProfileId,
    'PATCH',
    '/api/workspaces/' + workspace.id + '/posts/' + postId,
    { expectedRevision, submission },
  );
export const cancelPublication = (workspace: Workspace, postId: string, expectedRevision: number) =>
  serviceRequest<PublicationReceipt>(
    workspace.serviceProfileId,
    'POST',
    '/api/workspaces/' + workspace.id + '/posts/' + postId + '/cancel',
    { expectedRevision },
  );
export const retryPublication = (workspace: Workspace, postId: string, expectedRevision: number) =>
  serviceRequest<PublicationReceipt>(
    workspace.serviceProfileId,
    'POST',
    '/api/workspaces/' + workspace.id + '/posts/' + postId + '/retry',
    { expectedRevision },
  );
export const postList = (
  workspace: Workspace,
  filter: 'all' | 'scheduled' | 'needsAction',
  cursor?: string,
) =>
  serviceRequest<PostPage>(
    workspace.serviceProfileId,
    'GET',
    '/api/workspaces/' + workspace.id + '/posts/list/' + filter + (cursor ? '/' + cursor : ''),
  );
export const postDetail = (workspace: Workspace, postId: string) =>
  serviceRequest<PostDetail>(
    workspace.serviceProfileId,
    'GET',
    '/api/workspaces/' + workspace.id + '/posts/' + postId + '/details',
  );
export const draftPublication = (workspace: Workspace, draftId: string) =>
  serviceRequest<PublicationReceipt | null>(
    workspace.serviceProfileId,
    'GET',
    '/api/workspaces/' + workspace.id + '/posts/draft/' + draftId,
  );
export const workspaceSummary = (workspace: Workspace, localDate: string) =>
  serviceRequest<Summary>(
    workspace.serviceProfileId,
    'GET',
    '/api/workspaces/' + workspace.id + '/summary/' + localDate,
  );
