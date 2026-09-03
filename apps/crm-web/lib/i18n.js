'use client';

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** Small dictionary based i18n with real RTL support, not just translated strings. */
export const MESSAGES = {
  en: {
    'nav.executive': 'Executive',
    'nav.ready': 'Ready',
    'nav.offplan': 'Off-plan',
    'nav.leads': 'Leads',
    'nav.contacts': 'Contacts',
    'nav.deals': 'Deals',
    'nav.calendar': 'Calendar',
    'nav.communications': 'Communications',
    'nav.documents': 'Documents',
    'nav.reports': 'Reports',
    'nav.automations': 'Automations',
    'nav.integrations': 'Integrations',
    'nav.salesScreen': 'Sales Screen',
    'nav.settings': 'Settings',
    'action.create': 'Create',
    'action.save': 'Save',
    'action.cancel': 'Cancel',
    'action.search': 'Search',
    'action.export': 'Export',
    'action.filter': 'Filters',
    'common.loading': 'Loading…',
    'common.none': 'Nothing here yet',
    'common.signOut': 'Sign out',
    'common.language': 'Language',
    'common.theme': 'Theme',
  },
  ar: {
    'nav.executive': 'الإدارة التنفيذية',
    'nav.ready': 'الجاهزة',
    'nav.offplan': 'على الخارطة',
    'nav.leads': 'العملاء المحتملون',
    'nav.contacts': 'جهات الاتصال',
    'nav.deals': 'الصفقات',
    'nav.calendar': 'التقويم',
    'nav.communications': 'المراسلات',
    'nav.documents': 'المستندات',
    'nav.reports': 'التقارير',
    'nav.automations': 'الأتمتة',
    'nav.integrations': 'التكاملات',
    'nav.salesScreen': 'شاشة المبيعات',
    'nav.settings': 'الإعدادات',
    'action.create': 'إنشاء',
    'action.save': 'حفظ',
    'action.cancel': 'إلغاء',
    'action.search': 'بحث',
    'action.export': 'تصدير',
    'action.filter': 'عوامل التصفية',
    'common.loading': 'جارٍ التحميل…',
    'common.none': 'لا توجد بيانات بعد',
    'common.signOut': 'تسجيل الخروج',
    'common.language': 'اللغة',
    'common.theme': 'المظهر',
  },
};

const I18nContext = createContext({ locale: 'en', dir: 'ltr', t: (key) => key, setLocale: () => {} });

export function I18nProvider({ children, initialLocale = 'en' }) {
  const [locale, setLocale] = useState(initialLocale);

  useEffect(() => {
    const stored = window.localStorage.getItem('gvz.locale');
    if (stored && MESSAGES[stored]) setLocale(stored);
  }, []);

  useEffect(() => {
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    window.localStorage.setItem('gvz.locale', locale);
  }, [locale]);

  const value = useMemo(
    () => ({
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      intlLocale: locale === 'ar' ? 'ar-AE' : 'en-AE',
      setLocale,
      t: (key, fallback) => MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? fallback ?? key,
    }),
    [locale]
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useTheme() {
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    const stored = window.localStorage.getItem('gvz.theme') ?? 'light';
    setTheme(stored);
    document.documentElement.dataset.theme = stored;
  }, []);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem('gvz.theme', next);
      return next;
    });
  }, []);
  return { theme, toggle };
}
