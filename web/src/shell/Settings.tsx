import type { Quality } from '../world3d';

type QualityOption = 'auto' | 'high' | 'medium' | 'low';

const OPTIONS: Array<{ value: QualityOption; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];

interface Props {
  dusk: boolean;
  onDusk: () => void;
  quality: 'auto' | Quality;
  autoLabel: string;
  onQuality: (q: 'auto' | Quality) => void;
}

export function Settings({ dusk, onDusk, quality, autoLabel, onQuality }: Props) {
  return (
    <div>
      <h3>画面</h3>
      <div class="tabs">
        <button type="button" aria-pressed={dusk ? 'true' : 'false'} onClick={onDusk}>
          黄昏
        </button>
      </div>
      <h3>画质</h3>
      <div class="tabs">
        {OPTIONS.map((option) => {
          return (
            <button
              key={option.value}
              type="button"
              data-quality={option.value}
              class={quality === option.value ? 'on' : undefined}
              onClick={() => onQuality(option.value)}
            >
              {option.value === 'auto' && autoLabel ? `${option.label} · ${autoLabel}` : option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
