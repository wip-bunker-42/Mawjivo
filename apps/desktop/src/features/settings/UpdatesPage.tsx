import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  checkUpdate,
  downloadUpdate,
  installUpdate,
  onUpdateProgress,
  errorMessage,
} from '../../bridge';
import type { UpdateInfo, UpdateProgress } from '../../bridge';

export function UpdatesPage(): ReactElement {
  const [offer, setOffer] = useState<UpdateInfo | null>(null);
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<
    'idle' | 'checking' | 'available' | 'downloading' | 'verified' | 'invalid' | 'installing'
  >('idle');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const busy = useRef(false);
  const locked = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void onUpdateProgress((event) => {
      if (active) setProgress(event);
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  async function check(): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPhase('checking');
    setMessage('جارٍ فحص التحديثات…');
    try {
      const candidate = await checkUpdate();
      setOffer(candidate);
      setProgress(null);
      setPhase(candidate ? 'available' : 'idle');
      setMessage(candidate ? 'يتوفر تحديث. يمكنك تنزيله ثم تثبيته.' : 'تستخدم أحدث إصدار متاح.');
    } catch (error) {
      setPhase('invalid');
      setMessage(errorMessage(error));
    } finally {
      busy.current = false;
    }
  }
  async function download(): Promise<void> {
    if (!offer || busy.current || phase !== 'available') return;
    busy.current = true;
    setPhase('downloading');
    setMessage('جارٍ تنزيل التحديث والتحقق من توقيعه…');
    try {
      await downloadUpdate(offer.id);
      setPhase('verified');
      setMessage('تم التحقق من التحديث. يمكنك تثبيته الآن.');
    } catch (error) {
      setPhase('invalid');
      setMessage(errorMessage(error));
    } finally {
      busy.current = false;
    }
  }
  async function install(): Promise<void> {
    if (!offer || busy.current || phase !== 'verified') return;
    busy.current = true;
    setPhase('installing');
    setMessage('جارٍ التثبيت. سيغلق التطبيق ويُفتح بالإصدار الجديد.');
    try {
      await installUpdate(offer.id);
    } catch (error) {
      setPhase('verified');
      setMessage(errorMessage(error));
    } finally {
      busy.current = false;
    }
  }
  return (
    <section aria-labelledby="updates-heading">
      <h3 id="updates-heading">تحديث Mawjivo</h3>
      <p>يفحص التطبيق التحديثات عند طلبك. تُحفظ مساحاتك ومسوداتك عند الترقية.</p>
      <button type="button" aria-disabled={locked} onClick={() => void check()}>
        فحص التحديثات
      </button>
      {offer && (
        <>
          <p>
            الإصدار المتاح: <bdi>{offer.version}</bdi>
          </p>
          {offer.notesAr && <p>{offer.notesAr}</p>}
          {offer.bytes > 0 && (
            <p>
              حجم التنزيل: <bdi>{(offer.bytes / 1_048_576).toFixed(1)}</bdi> ميجابايت.
            </p>
          )}
          <button
            type="button"
            aria-disabled={phase !== 'available'}
            onClick={() => void download()}
          >
            تنزيل التحديث
          </button>
          <button type="button" aria-disabled={phase !== 'verified'} onClick={() => void install()}>
            تثبيت التحديث
          </button>
        </>
      )}
      {progress?.phase === 'downloading' && (
        <div>
          <label htmlFor="update-progress">تنزيل التحديث</label>
          <progress
            id="update-progress"
            max={progress.totalBytes ?? undefined}
            value={progress.totalBytes ? progress.completedBytes : undefined}
          />
          {progress.totalBytes && (
            <p>
              <bdi>{Math.floor((progress.completedBytes * 100) / progress.totalBytes)}%</bdi>
            </p>
          )}
        </div>
      )}
      {message && <p className="operation-message">{message}</p>}
    </section>
  );
}
