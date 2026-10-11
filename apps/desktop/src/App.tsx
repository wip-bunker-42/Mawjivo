import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { SetupPage } from './features/setup/SetupPage';
import { ConnectionsPage } from './features/settings/ConnectionsPage';
import { WorkspaceSettings } from './features/settings/WorkspaceSettings';
import { TelegramPage } from './features/settings/TelegramPage';
import { ComposerPage } from './features/composer/ComposerPage';
import { ScheduledPage } from './features/history/ScheduledPage';
import { SummaryPage } from './features/history/SummaryPage';
import { WorkspaceSelect } from './features/workspaces/WorkspaceSelect';
import type { Workspace, PostDetail } from '@mawjivo/core';
import type { ServiceProfile } from './bridge';
import { listProfiles, serviceRequest, errorMessage, openComposerWindow } from './bridge';

const pages = [
  { id: 'compose', label: 'منشور جديد' },
  { id: 'scheduled', label: 'المجدولة' },
  { id: 'summary', label: 'ملخص' },
  { id: 'settings', label: 'الإعدادات' },
] as const;
type PageId = (typeof pages)[number]['id'];

export function App(): ReactElement {
  const [page, setPage] = useState<PageId>('compose');
  const [editing, setEditing] = useState<PostDetail | null>(null);
  const [profiles, setProfiles] = useState<ServiceProfile[]>([]),
    [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [workspaceId, setWorkspaceId] = useState('');
  const [settingsPage, setSettingsPage] = useState<
      'cloudflare' | 'workspaces' | 'connections' | 'telegram'
    >('cloudflare'),
    [message, setMessage] = useState('');
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  const profile =
    profiles.find((item) => item.id === workspace?.serviceProfileId) ?? profiles[0] ?? null;
  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyN' && !event.repeat) {
        event.preventDefault();
        void openComposerWindow().catch((error) => setMessage(errorMessage(error)));
      }
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    void listProfiles()
      .then((profiles) => {
        setProfiles(profiles);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all(
      profiles.map(async (item) => serviceRequest<Workspace[]>(item.id, 'GET', '/api/workspaces')),
    )
      .then((groups) => {
        if (active) {
          const items = groups.flat();
          setWorkspaces(items);
          setWorkspaceId((current) =>
            items.some((item) => item.id === current) ? current : (items[0]?.id ?? ''),
          );
        }
      })
      .catch((error) => {
        if (active) setMessage(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [profiles]);
  function savedWorkspace(saved: Workspace): void {
    setWorkspaces((current) => [...current.filter((item) => item.id !== saved.id), saved]);
    setWorkspaceId(saved.id);
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        انتقل إلى المحتوى
      </a>
      <header className="app-header">
        <div>
          <h1>
            <bdi>Mawjivo</bdi>
          </h1>
          <p className="subtitle">نشر واضح، من مكان واحد.</p>
        </div>
        <WorkspaceSelect
          workspaces={workspaces}
          value={workspaceId}
          onChange={(id) => {
            setEditing(null);
            setWorkspaceId(id);
          }}
        />
      </header>
      <nav aria-label="صفحات التطبيق" className="navigation">
        {pages.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={page === item.id}
            onClick={() => setPage(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        <h2>{pages.find((item) => item.id === page)?.label}</h2>
        {message && <p className="operation-message">{message}</p>}
        {page === 'settings' ? (
          <>
            <nav aria-label="أقسام الإعدادات" className="settings-navigation">
              {(
                [
                  { id: 'cloudflare', label: 'خدمة Cloudflare' },
                  { id: 'workspaces', label: 'مساحات العمل' },
                  { id: 'connections', label: 'حسابات النشر' },
                  { id: 'telegram', label: 'تليجرام والمراقبة' },
                ] as const
              ).map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={settingsPage === item.id}
                  onClick={() => setSettingsPage(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            {settingsPage === 'cloudflare' ? (
              <SetupPage
                onReady={(item) => {
                  setProfiles((current) => [...current.filter((p) => p.id !== item.id), item]);
                }}
              />
            ) : settingsPage === 'workspaces' ? (
              <WorkspaceSettings
                key={workspace?.id ?? 'new'}
                profile={profile}
                profiles={profiles}
                workspace={workspace}
                onSaved={savedWorkspace}
              />
            ) : settingsPage === 'telegram' ? (
              <TelegramPage key={workspace?.id ?? 'new'} workspace={workspace} />
            ) : (
              <ConnectionsPage
                key={workspace?.id ?? 'new'}
                profile={profile}
                workspace={workspace}
              />
            )}
          </>
        ) : page === 'compose' && workspace ? (
          <ComposerPage
            key={workspace.id + ':' + (editing?.receipt.postId ?? 'new')}
            workspace={workspace}
            editing={editing ?? undefined}
            onReset={() => setEditing(null)}
          />
        ) : page === 'scheduled' && workspace ? (
          <ScheduledPage
            key={workspace.id}
            workspace={workspace}
            onEdit={(detail) => {
              setEditing(detail);
              setPage('compose');
            }}
          />
        ) : page === 'summary' && workspace ? (
          <SummaryPage key={workspace.id} workspace={workspace} />
        ) : (
          <section className="setup-notice" aria-labelledby="setup-heading">
            <h3 id="setup-heading">أكمل الإعداد للبدء</h3>
            <p>
              {profile
                ? 'الخدمة جاهزة. أضف حسابات النشر لمساحتك.'
                : 'اربط Cloudflare وحسابات النشر، ثم اختر المنصات الافتراضية لمساحتك.'}
            </p>
            <button type="button" className="primary" onClick={() => setPage('settings')}>
              فتح الإعدادات
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
