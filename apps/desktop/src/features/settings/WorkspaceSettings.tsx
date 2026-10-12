import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { platforms } from '@mawjivo/core';
import type {
  CapabilitySnapshot,
  Platform,
  Workspace,
  WorkspaceInput,
  YoutubeCategoryId,
} from '@mawjivo/core';
import { YoutubeCategorySelect } from '../../components/YoutubeCategorySelect';
import { errorMessage, serviceRequest } from '../../bridge';
import type { ServiceProfile } from '../../bridge';
export function WorkspaceSettings({
  profile,
  profiles,
  workspace,
  onSaved,
}: {
  profile: ServiceProfile | null;
  profiles: ServiceProfile[];
  workspace: Workspace | null;
  onSaved: (workspace: Workspace) => void;
}): ReactElement {
  const [create, setCreate] = useState(!workspace),
    [name, setName] = useState(workspace?.name ?? ''),
    [timeZone, setTimeZone] = useState(workspace?.timeZone ?? 'Africa/Cairo');
  const [createProfileId, setCreateProfileId] = useState(profile?.id ?? '');
  const [youtubeCategory, setYoutubeCategory] = useState<YoutubeCategoryId | null>(
    workspace?.defaultYoutubeCategoryId ?? null,
  );
  const selectedProfile = create
    ? (profiles.find((item) => item.id === (createProfileId || profile?.id)) ?? null)
    : profile;
  const [defaults, setDefaults] = useState<Platform[]>(
    workspace?.defaultPlatforms ?? [...platforms],
  );
  const [preferred, setPreferred] = useState<Partial<Record<Platform, string>>>(
    workspace?.preferredChannels ?? {},
  );
  const [caps, setCaps] = useState<CapabilitySnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    if (profile && workspace)
      void serviceRequest<CapabilitySnapshot>(
        profile.id,
        'GET',
        `/api/workspaces/${workspace.id}/capabilities`,
      )
        .then((value) => {
          if (active) setCaps(value);
        })
        .catch((error) => {
          if (active) setMessage(errorMessage(error));
        });
    return () => {
      active = false;
    };
  }, [profile?.id, workspace?.id]);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedProfile || busy) return;
    setBusy(true);
    try {
      const input: WorkspaceInput = {
        name,
        timeZone,
        defaultPlatforms: defaults,
        serviceProfileId: selectedProfile.id,
        preferredChannels: create ? {} : preferred,
        defaultYoutubeCategoryId: youtubeCategory,
      };
      const saved = await serviceRequest<Workspace>(
        selectedProfile.id,
        create ? 'POST' : 'PATCH',
        create ? '/api/workspaces' : `/api/workspaces/${workspace!.id}`,
        create ? input : { ...input, expectedVersion: workspace!.version },
      );
      onSaved(saved);
      setCreate(false);
      setMessage('حُفظت إعدادات المساحة.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="workspace-settings-heading">
      <h3 id="workspace-settings-heading">{create ? 'إضافة مساحة عمل' : 'إعدادات مساحة العمل'}</h3>
      {!profile && <p>جهّز خدمة Cloudflare أولًا.</p>}
      {!create && (
        <button
          type="button"
          onClick={() => {
            setCreate(true);
            setName('');
            setTimeZone('Africa/Cairo');
            setDefaults([...platforms]);
            setPreferred({});
            setYoutubeCategory(null);
            setMessage('');
          }}
        >
          إضافة مساحة عمل
        </button>
      )}
      <form
        onSubmit={(event) => {
          void save(event);
        }}
        aria-busy={busy}
      >
        {create && (
          <div className="form-field">
            <label htmlFor="workspace-service-profile">خدمة Cloudflare لهذه المساحة</label>
            <select
              id="workspace-service-profile"
              value={createProfileId || profile?.id || ''}
              onChange={(event) => setCreateProfileId(event.target.value)}
              required
              disabled={busy}
            >
              {!profiles.length && <option value="">جهّز خدمة Cloudflare أولًا</option>}
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.baseUrl}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-field">
          <label htmlFor="workspace-name">اسم مساحة العمل</label>
          <input
            id="workspace-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
          />
        </div>
        <div className="form-field">
          <label htmlFor="workspace-timezone">المنطقة الزمنية</label>
          <input
            id="workspace-timezone"
            dir="ltr"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            required
            maxLength={100}
          />
        </div>
        <YoutubeCategorySelect
          id="workspace-youtube-category"
          label="فئة يوتيوب الافتراضية"
          value={youtubeCategory}
          onChange={(value) => setYoutubeCategory(value ?? null)}
          disabled={busy}
        />
        <fieldset>
          <legend>المنصات الافتراضية</legend>
          {platforms.map((platform) => (
            <div className="platform-setting" key={platform}>
              <label>
                <input
                  type="checkbox"
                  checked={defaults.includes(platform)}
                  onChange={(event) =>
                    setDefaults(
                      event.target.checked
                        ? [...defaults, platform]
                        : defaults.filter((value) => value !== platform),
                    )
                  }
                />{' '}
                <bdi>{platform}</bdi>
              </label>
              {!create && (
                <div className="form-field">
                  <label htmlFor={'preferred-' + platform}>حساب {platform} الافتراضي</label>
                  <select
                    id={'preferred-' + platform}
                    value={preferred[platform] ?? ''}
                    onChange={(event) => {
                      const updated = { ...preferred };
                      if (event.target.value) updated[platform] = event.target.value;
                      else delete updated[platform];
                      setPreferred(updated);
                    }}
                  >
                    <option value="">اختيار تلقائي لحساب جاهز</option>
                    {caps?.channels
                      .filter((channel) => channel.platform === platform)
                      .map((channel) => (
                        <option key={channel.id} value={channel.id} disabled={!channel.ready}>
                          {channel.displayName ?? platform} — {channel.provider}
                          {channel.ready ? '' : ' — يحتاج إصلاح الربط'}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>
          ))}
        </fieldset>
        <button type="submit" className="primary" disabled={!selectedProfile || busy}>
          حفظ إعدادات المساحة
        </button>
      </form>
      {message && <p className="operation-message">{message}</p>}
    </section>
  );
}
