import type { ReactElement } from 'react';
import type { MediaAsset } from '@mawjivo/core';
import type { MediaJob } from './useComposer';
const seconds = (ms: number) => Math.round(ms / 1000).toLocaleString('ar');
export function MediaPicker({
  assets,
  jobs,
  disabled,
  onPick,
  onRemove,
  onMove,
  onResume,
}: {
  assets: MediaAsset[];
  jobs: MediaJob[];
  disabled: boolean;
  onPick: () => void;
  onRemove: (index: number) => void;
  onMove: (index: number, to: number) => void;
  onResume: (job: MediaJob) => void;
}): ReactElement {
  return (
    <section aria-labelledby="media-heading">
      <h3 id="media-heading">الوسائط</h3>
      <button type="button" disabled={disabled} onClick={onPick}>
        اختيار صور أو فيديو
      </button>
      {assets.length > 0 && (
        <ol className="media-list">
          {assets.map((asset, index) => (
            <li key={asset.id}>
              <bdi>{asset.originalName}</bdi>{' '}
              <span>{asset.kind === 'video' ? 'فيديو' : 'صورة'}</span>
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => onMove(index, index - 1)}
                  disabled={index === 0}
                  aria-label={'نقل ' + asset.originalName + ' لأعلى'}
                >
                  لأعلى
                </button>
                <button
                  type="button"
                  onClick={() => onMove(index, index + 1)}
                  disabled={index === assets.length - 1}
                  aria-label={'نقل ' + asset.originalName + ' لأسفل'}
                >
                  لأسفل
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  aria-label={'إزالة ' + asset.originalName}
                >
                  إزالة
                </button>
              </div>
              {jobs
                .filter((job) => job.sourceAssetId === asset.id)
                .map((job) => (
                  <div key={job.key} className="upload-progress">
                    <label htmlFor={job.jobId}>
                      {job.label}:{' '}
                      {job.phase === 'preparing'
                        ? 'معالجة محلية'
                        : job.phase === 'complete'
                          ? 'اكتمل الرفع'
                          : job.phase === 'paused'
                            ? 'الرفع متوقف'
                            : job.phase === 'failed'
                              ? 'تعذر الرفع'
                              : 'جارٍ الرفع'}
                    </label>
                    <progress id={job.jobId} max={job.totalBytes} value={job.completedBytes} />
                    <span>
                      {Math.round((job.completedBytes / job.totalBytes) * 100).toLocaleString('ar')}
                      %؛ مضى {seconds(job.elapsedMs)} ثانية
                      {job.remainingMs !== null
                        ? '؛ المتبقي نحو ' + seconds(job.remainingMs) + ' ثانية'
                        : ''}
                    </span>
                    {job.error && <p className="operation-message">{job.error.messageAr}</p>}
                    {['paused', 'failed'].includes(job.phase) && (
                      <button type="button" onClick={() => onResume(job)}>
                        استئناف رفع {asset.originalName}
                      </button>
                    )}
                  </div>
                ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
