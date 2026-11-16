import { langName, LANGS, setLangPref, useI18n } from '../i18n';
import type { Key, LangPref } from '../i18n';
import type { Quality, RenderSettings } from '../world3d';

type QualityOption = 'auto' | 'high' | 'medium' | 'low';

const OPTIONS: Array<{ value: QualityOption; label: Key }> = [
  { value: 'auto', label: 'settings.quality.auto' },
  { value: 'high', label: 'settings.quality.high' },
  { value: 'medium', label: 'settings.quality.medium' },
  { value: 'low', label: 'settings.quality.low' },
];

interface Props {
  dusk: boolean;
  onDusk: () => void;
  quality: 'auto' | Quality;
  autoSettings: RenderSettings | null;
  onQuality: (q: 'auto' | Quality) => void;
}

export function Settings({ dusk, onDusk, quality, autoSettings, onQuality }: Props) {
  const { t, pref } = useI18n();
  const languages: Array<{ value: LangPref; label: string }> = [
    { value: 'auto', label: t('settings.language.auto') },
    ...LANGS.map((value) => ({ value, label: langName(value) })),
  ];
  const detail = autoSettings
    ? t('settings.auto.detail', {
        scale: Math.round(autoSettings.scale * 100),
        grass: Math.round(autoSettings.grass * 100),
        shadow:
          autoSettings.shadow === 0
            ? t('settings.shadow.off')
            : t('settings.shadow.on', { n: autoSettings.shadow }),
      })
    : '';
  return (
    <div>
      <h3>{t('settings.language')}</h3>
      <div class="tabs">
        {languages.map((option) => (
          <button
            key={option.value}
            type="button"
            data-lang={option.value}
            aria-pressed={pref === option.value ? 'true' : 'false'}
            class={pref === option.value ? 'on' : undefined}
            onClick={() => setLangPref(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <h3>{t('settings.display')}</h3>
      <div class="tabs">
        <button type="button" aria-pressed={dusk ? 'true' : 'false'} onClick={onDusk}>
          {t('settings.dusk')}
        </button>
      </div>
      <h3>{t('settings.quality')}</h3>
      <div class="tabs">
        {OPTIONS.map((option) => {
          const label = t(option.label);
          return (
            <button
              key={option.value}
              type="button"
              data-quality={option.value}
              class={quality === option.value ? 'on' : undefined}
              onClick={() => onQuality(option.value)}
            >
              {option.value === 'auto' && autoSettings ? `${label} · ${detail}` : label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
