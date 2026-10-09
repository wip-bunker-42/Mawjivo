import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { SetupPage } from './features/setup/SetupPage';
import type { ServiceProfile } from './bridge';
import { listProfiles } from './bridge';

const pages = [
  { id: 'compose', label: 'منشور جديد' },
  { id: 'scheduled', label: 'المجدولة' },
  { id: 'summary', label: 'ملخص' },
  { id: 'settings', label: 'الإعدادات' },
] as const;
type PageId = (typeof pages)[number]['id'];

export function App(): ReactElement {
  const [page, setPage] = useState<PageId>('compose');
  const [profile, setProfile] = useState<ServiceProfile | null>(null);
  useEffect(() => {
    void listProfiles()
      .then((profiles) => {
        setProfile(profiles[0] ?? null);
      })
      .catch(() => {});
  }, []);
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
        <div className="workspace-field">
          <label htmlFor="workspace">مساحة العمل</label>
          <select id="workspace" disabled>
            <option>لم تُضف مساحة بعد</option>
          </select>
        </div>
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
        {page === 'settings' ? (
          <SetupPage onReady={setProfile} />
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
