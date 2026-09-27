import { useI18n } from '../i18n/i18n';

/**
 * The master's own words in both languages. They live here, not in the shared catalog, so the whole feature can be
 * removed with its folder.
 */
export function useWords() {
  const { language } = useI18n();
  return (ko: string, en: string) => language === 'ko' ? ko : en;
}
