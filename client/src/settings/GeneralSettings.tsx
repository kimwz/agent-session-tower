import { Move, Waypoints } from 'lucide-react';
import { useI18n } from '../i18n/i18n';
import { useChatFontSize } from '../chat/chat-appearance';
import type { CanvasControls } from '../graph/canvas-controls-store';
import { SettingsPane } from './SettingsPane';

/** How the page looks: the canvas's layout and motion, hidden folders, language and the chat's text size. */
export function GeneralSettings({ canvas, showHidden, onShowHiddenChange }: { canvas: CanvasControls | null; showHidden: boolean; onShowHiddenChange: (showHidden: boolean) => void }) {
  const { t, language, setLanguage } = useI18n();
  const { fontSize, changeFontSize } = useChatFontSize();
  return <SettingsPane title={t('일반')} description={t('캔버스와 화면 표시 방식을 정합니다.')}>
    <h3 className="settings-group-title">{t('캔버스')}</h3>
    <div className="settings-group">
      <div className="settings-row"><span>{t('정렬')}</span>
        <div className="settings-segmented" role="group" aria-label={t('그래프 정렬 방식')}>
          <button type="button" aria-pressed={!canvas?.manual} disabled={!canvas} onClick={() => canvas?.setLayout('auto')} title={t('최근 활동 순서로 자동 정렬')}><Waypoints size={13} />{t('자동 정렬')}</button>
          <button type="button" aria-pressed={!!canvas?.manual} disabled={!canvas} onClick={() => canvas?.setLayout('manual')} title={t('폴더를 드래그해 위치 지정')}><Move size={13} />{t('수동 배치')}</button>
        </div></div>
      <label className="settings-row"><span>{t('연결선 애니메이션')}</span><input type="checkbox" role="switch" className="settings-switch" checked={!!canvas?.motion} disabled={!canvas} onChange={event => canvas?.setMotion(event.target.checked)} /></label>
      <label className="settings-row"><span>{t('전체보기')}<small>{t('숨긴 폴더 포함')} · <kbd>⇧A</kbd></small></span><input type="checkbox" role="switch" className="settings-switch" checked={showHidden} aria-keyshortcuts="Shift+A" onChange={event => onShowHiddenChange(event.target.checked)} /></label>
    </div>
    <h3 className="settings-group-title">{t('화면')}</h3>
    <div className="settings-group">
      <label className="settings-row"><span>{t('언어')}</span><select aria-label={t('언어')} value={language} onChange={event => setLanguage(event.target.value as 'ko' | 'en')}><option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option></select></label>
      <div className="settings-row"><span>{t('대화 글자 크기')}</span><div className="chat-font-controls" role="group" aria-label={t('대화 글자 크기')}>
        <button type="button" aria-label={t('글자 작게')} title={t('글자 작게')} disabled={fontSize <= 11} onClick={() => changeFontSize(fontSize - 1)}>A−</button>
        <output aria-live="polite">{fontSize}px</output>
        <button type="button" aria-label={t('글자 크게')} title={t('글자 크게')} disabled={fontSize >= 22} onClick={() => changeFontSize(fontSize + 1)}>A+</button>
      </div></div>
    </div>
  </SettingsPane>;
}
